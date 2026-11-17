// Runs one slice of the full `pnpm test` suite: the same plan list that
// scripts/test-projects-run.mts builds for a target-less run, taken
// round-robin by index, each plan through scripts/run-vitest.mjs.
// Usage (cwd = fork checkout): node --import ./scripts/tsx.mjs run-slice.mts <index> <count> <outDir> [planIndexes...]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [indexArg, countArg, outDir, ...explicit] = process.argv.slice(2);
const index = Number(indexArg);
const count = Number(countArg);
const support = await import(
  pathToFileURL(join(process.cwd(), "scripts/test-projects.test-support.mts")).href
);
const plans: Array<{ config: string; forwardedArgs: string[] }> =
  support.buildFullSuiteVitestRunPlans([], process.cwd());
mkdirSync(outDir, { recursive: true });
const selected =
  explicit.length > 0
    ? explicit.map(Number)
    : plans.map((_, i) => i).filter((i) => i % count === index);
console.log(`[slice] total plans ${plans.length}; running ${selected.length}`);
writeFileSync(join(outDir, "plan-count.txt"), String(plans.length));
const results: unknown[] = [];
for (const i of selected) {
  const plan = plans[i];
  const json = join(outDir, `plan-${i}.json`);
  const args = [
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    plan.config,
    ...plan.forwardedArgs,
    "--reporter=dot",
    "--reporter=json",
    `--outputFile.json=${json}`,
  ];
  const started = Date.now();
  // Same per-plan env adjustment test-projects-run applies (8 GB heap for full-extensions).
  const [{ env }] = support.applyFullExtensionsHeapBudget([{ config: plan.config, env: process.env }], {
    env: process.env,
  });
  console.log(`[slice] plan ${i} ${plan.config} NODE_OPTIONS=${env.NODE_OPTIONS ?? ""}`);
  const run = spawnSync(process.execPath, args, {
    stdio: "inherit",
    timeout: 90 * 60 * 1000,
    env,
  });
  let numTotalTests: number | null = null;
  let numFailedTests: number | null = null;
  let failedFiles: string[] = [];
  if (existsSync(json)) {
    try {
      const report = JSON.parse(readFileSync(json, "utf8"));
      numTotalTests = report.numTotalTests;
      numFailedTests = report.numFailedTests;
      failedFiles = (report.testResults ?? [])
        .filter((r: { status: string }) => r.status !== "passed")
        .map((r: { name: string }) => r.name.replace(process.cwd() + "/", ""));
    } catch {
      // keep nulls: an unreadable report is not a pass
    }
  }
  const entry = {
    i,
    config: plan.config,
    targets: plan.forwardedArgs.length,
    status: run.status,
    signal: run.signal,
    seconds: Math.round((Date.now() - started) / 1000),
    numTotalTests,
    numFailedTests,
    failedFiles,
  };
  console.log(`[slice] ${JSON.stringify(entry)}`);
  results.push(entry);
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 1));
}

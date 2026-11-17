// Runs one slice of the leaf plans (OPENCLAW_TEST_PROJECTS_LEAF_SHARDS=1, the
// same expansion `pnpm test` uses locally) that belong to the given full-* configs.
// Usage (cwd = fork checkout): node --import ./scripts/tsx.mjs run-leaf.mts <index> <count> <outDir> <fullConfigsCsv> [planIndexes...]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [indexArg, countArg, outDir, fullCsv, ...explicit] = process.argv.slice(2);
const index = Number(indexArg);
const count = Number(countArg);
process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = "1";
const url = (p: string) => pathToFileURL(join(process.cwd(), p)).href;
const support = await import(url("scripts/test-projects.test-support.mts"));
const { fullSuiteVitestShards } = await import(url("test/vitest/vitest.test-shards.mjs"));
const wanted = new Set(fullCsv.split(",").map((c) => `test/vitest/vitest.${c}.config.ts`));
const projects = new Set<string>(
  fullSuiteVitestShards
    .filter((s: { config: string }) => wanted.has(s.config))
    .flatMap((s: { projects: string[] }) => s.projects),
);
const all: Array<{ config: string; forwardedArgs: string[] }> =
  support.buildFullSuiteVitestRunPlans([], process.cwd());
const plans = all.map((p, i) => ({ ...p, i })).filter((p) => projects.has(p.config));
mkdirSync(outDir, { recursive: true });
const selected =
  explicit.length > 0
    ? plans.filter((p) => explicit.map(Number).includes(p.i))
    : plans.filter((_, k) => k % count === index);
console.log(`[leaf] ${[...wanted].join(",")}: ${projects.size} projects, ${plans.length} plans; running ${selected.length}`);
writeFileSync(join(outDir, "plan-count.txt"), `${all.length} ${plans.length}`);
const results: unknown[] = [];
for (const plan of selected) {
  const json = join(outDir, `plan-${plan.i}.json`);
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
  const run = spawnSync(process.execPath, args, {
    stdio: "inherit",
    timeout: Number(process.env.GATE_PLAN_TIMEOUT_MIN ?? 45) * 60 * 1000,
    env: process.env,
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
    i: plan.i,
    config: plan.config,
    targets: plan.forwardedArgs.length,
    status: run.status,
    signal: run.signal,
    seconds: Math.round((Date.now() - started) / 1000),
    numTotalTests,
    numFailedTests,
    failedFiles,
  };
  console.log(`[leaf] ${JSON.stringify(entry)}`);
  results.push(entry);
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 1));
}

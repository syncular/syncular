/**
 * Load runner CLI (load brief §4).
 *
 *   bun run load <scenario> [--smoke] [--vus N] [--duration S] [--dataset N]
 *   bun run load:smoke                 # tiny smoke sweep of every scenario
 *
 * From the repo root: `bun run load <scenario>` and `bun run load:smoke` (registered
 * in the root package.json). Each run prints a one-line human summary and
 * writes a machine-readable JSON result under load/results/. This suite is
 * stability/scale verification, NOT a benchmark (bench/ owns comparative
 * numbers).
 */
import { join } from 'node:path';
import { fmtMs } from './metrics';
import {
  type Scenario,
  type ScenarioProfile,
  type ScenarioResult,
  summaryLine,
} from './scenario';
import { bootstrapStorm } from './scenarios/bootstrap-storm';
import { maintenanceChurn } from './scenarios/maintenance-churn';
import { mixedSoak } from './scenarios/mixed-soak';
import { pushPull } from './scenarios/push-pull';
import { reconnectStorm } from './scenarios/reconnect-storm';

const SCENARIOS: readonly Scenario[] = [
  pushPull,
  bootstrapStorm,
  reconnectStorm,
  maintenanceChurn,
  mixedSoak,
];

function findScenario(name: string): Scenario {
  const found = SCENARIOS.find((s) => s.name === name);
  if (found === undefined) {
    const names = SCENARIOS.map((s) => s.name).join(', ');
    throw new Error(`unknown scenario "${name}" — choose one of: ${names}`);
  }
  return found;
}

interface Cli {
  readonly scenario: string | undefined;
  readonly smoke: boolean;
  readonly smokeSweep: boolean;
  readonly overrides: Partial<ScenarioProfile>;
}

function parseArgs(argv: readonly string[]): Cli {
  let scenario: string | undefined;
  let smoke = false;
  let smokeSweep = false;
  const overrides: { vus?: number; durationSec?: number; dataset?: number } =
    {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--smoke') smoke = true;
    else if (arg === '--smoke-sweep') smokeSweep = true;
    else if (arg === '--vus') overrides.vus = Number(argv[++i]);
    else if (arg === '--duration') overrides.durationSec = Number(argv[++i]);
    else if (arg === '--dataset') overrides.dataset = Number(argv[++i]);
    else if (!arg.startsWith('--')) scenario = arg;
  }
  return { scenario, smoke, smokeSweep, overrides };
}

function resolveConfig(
  scenario: Scenario,
  profile: 'smoke' | 'full',
  overrides: Partial<ScenarioProfile>,
): ScenarioProfile {
  const base = profile === 'smoke' ? scenario.smoke : scenario.full;
  return {
    vus: overrides.vus ?? base.vus,
    durationSec: overrides.durationSec ?? base.durationSec,
    dataset: overrides.dataset ?? base.dataset,
  };
}

function printResult(result: ScenarioResult): void {
  console.log(`\n${summaryLine(result)}`);
  console.log('  checks:');
  for (const check of result.checks) {
    console.log(
      `    ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.measured} (${check.threshold})`,
    );
  }
  console.log('  latencies:');
  for (const l of result.latencies) {
    if (l.count === 0) continue;
    console.log(
      `    ${l.name}: n=${l.count} p50=${fmtMs(l.p50)} p95=${fmtMs(l.p95)} p99=${fmtMs(l.p99)} max=${fmtMs(l.max)}`,
    );
  }
  if (Object.keys(result.extra).length > 0) {
    const extras = Object.entries(result.extra)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`  extra: ${extras}`);
  }
  console.log(
    `  server: reqs=${result.server.requests} errs=${result.server.requestErrors} ` +
      `req-p95=${fmtMs(result.server.requestDurationMs.p95)} ` +
      `seg built/reused=${result.server.segmentsBuilt}/${result.server.segmentsReused} ` +
      `prune-runs=${result.server.pruneRuns} peak-rss=${(result.server.peakRssBytes / 1_048_576).toFixed(0)}MB`,
  );
  if (result.errors.length > 0) {
    console.log('  first errors:');
    for (const e of result.errors.slice(0, 5)) console.log(`    - ${e}`);
  }
}

async function writeJson(result: ScenarioResult): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(
    import.meta.dir,
    '..',
    'results',
    `${result.scenario}-${result.profile}-${stamp}.json`,
  );
  await Bun.write(path, JSON.stringify(result, null, 2));
  return path;
}

async function runOne(
  scenario: Scenario,
  profile: 'smoke' | 'full',
  overrides: Partial<ScenarioProfile>,
): Promise<ScenarioResult> {
  const config = resolveConfig(scenario, profile, overrides);
  console.log(
    `\n=== ${scenario.name} (${profile}) — ${config.vus} VUs, ${config.durationSec}s, dataset ${config.dataset} ===`,
  );
  const result = await scenario.run({ profile, config });
  printResult(result);
  const path = await writeJson(result);
  console.log(`  wrote ${path}`);
  return result;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.smokeSweep) {
    console.log('load: smoke sweep — every scenario, tiny profile\n');
    const t0 = performance.now();
    const results: ScenarioResult[] = [];
    for (const scenario of SCENARIOS) {
      results.push(await runOne(scenario, 'smoke', {}));
    }
    const totalSec = (performance.now() - t0) / 1000;
    console.log('\n=== smoke sweep summary ===');
    for (const r of results) console.log(summaryLine(r));
    console.log(`\nsweep wall time: ${totalSec.toFixed(1)}s`);
    const failed = results.filter((r) => !r.pass);
    if (failed.length > 0) {
      console.error(`\n${failed.length} scenario(s) failed their thresholds.`);
      process.exit(1);
    }
    console.log('\nall smoke scenarios passed.');
    return;
  }

  if (cli.scenario === undefined) {
    const names = SCENARIOS.map((s) => s.name).join(', ');
    console.error(
      `usage: bun run load <scenario> [--smoke] [--vus N] [--duration S] [--dataset N]\n` +
        `       bun run load:smoke\n\nscenarios: ${names}`,
    );
    process.exit(2);
  }

  const scenario = findScenario(cli.scenario);
  const profile = cli.smoke ? 'smoke' : 'full';
  const result = await runOne(scenario, profile, cli.overrides);
  if (!result.pass) {
    console.error('\nscenario failed its thresholds.');
    process.exit(1);
  }
}

await main();

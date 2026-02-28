/**
 * Nightly macro load runner.
 *
 * Starts the load test server, executes selected k6 scenarios, writes
 * per-scenario summaries/logs, and fails if any scenario fails thresholds.
 */

import path from 'node:path';

type K6Metric = {
  thresholds?: Record<string, boolean | { ok?: boolean }>;
  [stat: string]: unknown;
};

type K6Summary = {
  metrics?: Record<string, K6Metric>;
};

interface ScenarioConfig {
  id: string;
  scriptPath: string;
  env?: Record<string, string>;
}

interface ScenarioResult {
  id: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  failedThresholds: string[];
  metrics: {
    httpReqs: number | null;
    httpP95: number | null;
    httpP99: number | null;
    httpErrorRate: number | null;
    syncLagP95: number | null;
    bootstrapRowsPerSecondAvg: number | null;
    reconnectConnectP95: number | null;
  };
  summaryPath: string;
  logPath: string;
}

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');
const RESULTS_DIR = path.resolve(
  REPO_ROOT,
  Bun.env.LOAD_NIGHTLY_RESULTS_DIR ?? '.tmp/load-nightly'
);
const LOAD_SERVER_PORT = Number.parseInt(
  Bun.env.LOAD_SERVER_PORT ?? '3001',
  10
);
const BASE_URL = Bun.env.BASE_URL ?? `http://127.0.0.1:${LOAD_SERVER_PORT}`;
const SMOKE_MODE = Bun.env.LOAD_NIGHTLY_SMOKE === 'true';
const OUTPUT_JSON = path.resolve(
  REPO_ROOT,
  Bun.env.LOAD_NIGHTLY_OUTPUT_JSON ?? 'load-nightly-summary.json'
);

const scenarios: ScenarioConfig[] = [
  {
    id: 'push-pull',
    scriptPath: 'tests/load/scripts/push-pull.js',
  },
  {
    id: 'reconnect-storm',
    scriptPath: 'tests/load/scripts/reconnect-storm.js',
  },
  {
    id: 'bootstrap-storm',
    scriptPath: 'tests/load/scripts/bootstrap-storm.js',
  },
  {
    id: 'maintenance-churn',
    scriptPath: 'tests/load/scripts/maintenance-churn.js',
  },
  {
    id: 'mixed-workload',
    scriptPath: 'tests/load/scripts/mixed-workload.js',
  },
];

const scenarioFilter = (Bun.env.LOAD_NIGHTLY_SCENARIOS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const selectedScenarios =
  scenarioFilter.length === 0
    ? scenarios
    : scenarios.filter((scenario) => scenarioFilter.includes(scenario.id));

function metricValue(
  summary: K6Summary,
  metric: string,
  stat: string
): number | null {
  const value = summary.metrics?.[metric]?.[stat];
  return Number.isFinite(value) ? Number(value) : null;
}

function findFailedThresholds(summary: K6Summary): string[] {
  const failures: string[] = [];

  for (const [metricName, metric] of Object.entries(summary.metrics ?? {})) {
    for (const [thresholdName, result] of Object.entries(
      metric.thresholds ?? {}
    )) {
      const failed =
        typeof result === 'boolean' ? result : result?.ok === false;
      if (failed) {
        failures.push(`${metricName}:${thresholdName}`);
      }
    }
  }

  return failures;
}

async function ensureDir(dir: string): Promise<void> {
  await Bun.$`mkdir -p ${dir}`;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until timeout.
    }
    await Bun.sleep(500);
  }

  throw new Error(`Timed out waiting for load server health at ${url}`);
}

async function runCommand(
  cmd: string[],
  env: Record<string, string>,
  logPath: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  await Bun.write(logPath, [stdout, stderr].filter(Boolean).join('\n'));

  return { exitCode, stdout, stderr };
}

async function runScenario(config: ScenarioConfig): Promise<ScenarioResult> {
  const summaryPath = path.join(RESULTS_DIR, `${config.id}.summary.json`);
  const logPath = path.join(RESULTS_DIR, `${config.id}.log.txt`);

  const commandEnv = {
    ...process.env,
    BASE_URL,
    K6_SMOKE: SMOKE_MODE ? 'true' : 'false',
    K6_NO_COLOR: 'true',
    ...(config.env ?? {}),
  } as Record<string, string>;

  const start = Date.now();
  const { exitCode, stdout, stderr } = await runCommand(
    ['k6', 'run', '--summary-export', summaryPath, config.scriptPath],
    commandEnv,
    logPath
  );

  if (stdout.trim().length > 0) {
    console.log(`\n### ${config.id} output`);
    console.log(stdout.slice(-4000));
  }

  if (stderr.trim().length > 0) {
    console.log(`\n### ${config.id} stderr`);
    console.log(stderr.slice(-2000));
  }

  let summary: K6Summary = {};
  const summaryFile = Bun.file(summaryPath);
  if (await summaryFile.exists()) {
    summary = await summaryFile.json();
  }

  const failedThresholds = findFailedThresholds(summary);
  const passed = exitCode === 0 && failedThresholds.length === 0;

  return {
    id: config.id,
    exitCode,
    passed,
    durationMs: Date.now() - start,
    failedThresholds,
    metrics: {
      httpReqs: metricValue(summary, 'http_reqs', 'count'),
      httpP95: metricValue(summary, 'http_req_duration', 'p(95)'),
      httpP99: metricValue(summary, 'http_req_duration', 'p(99)'),
      httpErrorRate:
        metricValue(summary, 'http_req_failed', 'rate') ??
        metricValue(summary, 'http_req_failed', 'value'),
      syncLagP95:
        metricValue(summary, 'sync_lag_ms', 'p(95)') ??
        metricValue(summary, 'writer_sync_lag_ms', 'p(95)') ??
        metricValue(summary, 'ws_data_sync_lag_ms', 'p(95)') ??
        metricValue(summary, 'reconnect_sync_lag_ms', 'p(95)'),
      bootstrapRowsPerSecondAvg:
        metricValue(summary, 'bootstrap_rows_per_second', 'avg') ??
        metricValue(summary, 'bootstrap_storm_rows', 'rate'),
      reconnectConnectP95: metricValue(
        summary,
        'reconnect_connect_time',
        'p(95)'
      ),
    },
    summaryPath,
    logPath,
  };
}

async function ensureK6Available(): Promise<void> {
  const { exitCode } = await runCommand(
    ['k6', 'version'],
    { ...process.env } as Record<string, string>,
    path.join(RESULTS_DIR, 'k6-version.log.txt')
  );

  if (exitCode !== 0) {
    throw new Error('k6 is not available in PATH');
  }
}

async function main() {
  await ensureDir(RESULTS_DIR);
  await ensureK6Available();

  const serverEnv = {
    ...process.env,
    PORT: `${LOAD_SERVER_PORT}`,
    LOAD_DB_DIALECT: Bun.env.LOAD_DB_DIALECT ?? 'sqlite',
    SQLITE_PATH: Bun.env.SQLITE_PATH ?? ':memory:',
    SEED_ROWS: Bun.env.SEED_ROWS ?? (SMOKE_MODE ? '10000' : '250000'),
    SEED_USERS: Bun.env.SEED_USERS ?? (SMOKE_MODE ? '100' : '800'),
    SEED_RANDOM_SEED: Bun.env.SEED_RANDOM_SEED ?? '42',
  } as Record<string, string>;

  const serverLogPath = path.join(RESULTS_DIR, 'load-server.log.txt');
  const serverProc = Bun.spawn(['bun', 'tests/load/server.ts'], {
    cwd: REPO_ROOT,
    env: serverEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const serverStdoutPromise = new Response(serverProc.stdout).text();
  const serverStderrPromise = new Response(serverProc.stderr).text();

  try {
    await waitForHealth(`${BASE_URL}/api/health`, 90_000);

    if (selectedScenarios.length === 0) {
      throw new Error(
        `No load scenarios selected. Requested: ${scenarioFilter.join(', ')}`
      );
    }

    const results: ScenarioResult[] = [];
    for (const scenario of selectedScenarios) {
      console.log(`\n## Running load scenario: ${scenario.id}`);
      const scenarioResult = await runScenario(scenario);
      results.push(scenarioResult);
    }

    const failedScenarios = results.filter((scenario) => !scenario.passed);

    const summary = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      smokeMode: SMOKE_MODE,
      scenarioCount: results.length,
      failedScenarioCount: failedScenarios.length,
      hasFailure: failedScenarios.length > 0,
      scenarios: results,
    };

    await Bun.write(OUTPUT_JSON, JSON.stringify(summary, null, 2));

    console.log('\n## Macro Load Summary');
    console.log(
      '| Scenario | Status | Duration | HTTP p95 | HTTP p99 | Error rate |'
    );
    console.log(
      '|----------|--------|----------|----------|----------|------------|'
    );
    for (const result of results) {
      const status = result.passed ? 'pass' : 'fail';
      const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
      const httpP95 =
        result.metrics.httpP95 == null
          ? 'N/A'
          : `${result.metrics.httpP95.toFixed(1)}ms`;
      const httpP99 =
        result.metrics.httpP99 == null
          ? 'N/A'
          : `${result.metrics.httpP99.toFixed(1)}ms`;
      const errorRate =
        result.metrics.httpErrorRate == null
          ? 'N/A'
          : `${(result.metrics.httpErrorRate * 100).toFixed(2)}%`;
      console.log(
        `| ${result.id} | ${status} | ${duration} | ${httpP95} | ${httpP99} | ${errorRate} |`
      );

      if (result.failedThresholds.length > 0) {
        console.log(
          `- ${result.id} failed thresholds: ${result.failedThresholds.join(', ')}`
        );
      }
    }

    console.log(`LOAD_NIGHTLY_TOTAL_SCENARIOS=${results.length}`);
    console.log(`LOAD_NIGHTLY_FAILED_SCENARIOS=${failedScenarios.length}`);
    console.log(
      `LOAD_NIGHTLY_HAS_FAILURE=${failedScenarios.length > 0 ? 'true' : 'false'}`
    );

    if (failedScenarios.length > 0) {
      process.exit(1);
    }
  } finally {
    serverProc.kill('SIGTERM');
    const exited = await Promise.race([
      serverProc.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);

    if (!exited) {
      serverProc.kill('SIGKILL');
      await serverProc.exited;
    }

    const serverStdout = await serverStdoutPromise;
    const serverStderr = await serverStderrPromise;
    await Bun.write(
      serverLogPath,
      [serverStdout, serverStderr].filter(Boolean).join('\n')
    );
  }
}

void main();

/**
 * Historical trend and change-point analysis for nightly load test summaries.
 *
 * Reads load test JSON summaries (per-scenario metrics: httpP95, httpP99,
 * httpErrorRate, syncLagP95) and applies robust Z-score change-point detection
 * to flag regressions across nightly runs.
 */

import path from 'node:path';
import {
  detectChangePoint,
  formatMs,
  formatPercent,
  formatRobustZ,
  mad,
  median,
  parseFloatOrDefault,
  parseIntOrDefault,
} from '../perf/trend-stats';

interface ScenarioMetrics {
  httpReqs: number | null;
  httpP95: number | null;
  httpP99: number | null;
  httpErrorRate: number | null;
  syncLagP95: number | null;
  bootstrapRowsPerSecondAvg: number | null;
  reconnectConnectP95: number | null;
}

interface ScenarioResult {
  id: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  failedThresholds: string[];
  metrics: ScenarioMetrics;
  summaryPath: string;
  logPath: string;
}

interface LoadNightlySummary {
  generatedAt: string;
  baseUrl: string;
  smokeMode: boolean;
  scenarioCount: number;
  failedScenarioCount: number;
  hasFailure: boolean;
  scenarios: ScenarioResult[];
}

interface TrendMetricResult {
  metric: string;
  current: number;
  historyCount: number;
  historyMedian: number | null;
  historyMad: number | null;
  robustZ: number | null;
  deltaPercent: number | null;
  insufficientHistory: boolean;
  regressionChangePoint: boolean;
  improvementChangePoint: boolean;
}

/** Tracked metrics per scenario. Error rate direction is inverted (higher = worse). */
const TRACKED_METRICS = [
  'httpP95',
  'httpP99',
  'httpErrorRate',
  'syncLagP95',
] as const;
type TrackedMetricKey = (typeof TRACKED_METRICS)[number];

function metricLabel(scenarioId: string, metricKey: string): string {
  return `${scenarioId}/${metricKey}`;
}

async function loadSummary(
  filePath: string
): Promise<LoadNightlySummary | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  try {
    return (await file.json()) as LoadNightlySummary;
  } catch {
    return null;
  }
}

async function collectHistorySummaries(
  historyDir: string
): Promise<LoadNightlySummary[]> {
  const glob = new Bun.Glob('*.json');
  const summaries: LoadNightlySummary[] = [];

  for await (const filePath of glob.scan({ cwd: historyDir })) {
    const absolutePath = path.join(historyDir, filePath);
    const summary = await loadSummary(absolutePath);
    if (!summary) continue;
    if (!Array.isArray(summary.scenarios)) continue;
    summaries.push(summary);
  }

  return summaries;
}

function extractMetricValue(
  scenario: ScenarioResult,
  key: TrackedMetricKey
): number | null {
  const value = scenario.metrics[key];
  return Number.isFinite(value) ? (value as number) : null;
}

async function main() {
  const repoRoot = path.resolve(import.meta.dir, '..', '..');
  const currentPath = path.resolve(
    repoRoot,
    Bun.env.LOAD_TREND_CURRENT_PATH ?? 'load-nightly-summary.json'
  );
  const historyDir = path.resolve(
    repoRoot,
    Bun.env.LOAD_TREND_HISTORY_DIR ?? 'load-history'
  );
  const outputPath = path.resolve(
    repoRoot,
    Bun.env.LOAD_TREND_OUTPUT_JSON ?? 'load-trend.json'
  );

  const minHistory = parseIntOrDefault(Bun.env.LOAD_TREND_MIN_HISTORY, 3);
  const deltaThreshold = parseFloatOrDefault(
    Bun.env.LOAD_TREND_DELTA_THRESHOLD,
    0.2
  );
  const robustZThreshold = parseFloatOrDefault(
    Bun.env.LOAD_TREND_ROBUST_Z_THRESHOLD,
    3
  );
  const failOnChange = Bun.env.LOAD_TREND_FAIL_ON_CHANGE === 'true';

  const currentSummary = await loadSummary(currentPath);
  if (!currentSummary) {
    throw new Error(`Unable to load current load summary at ${currentPath}`);
  }

  const historySummaries = await collectHistorySummaries(historyDir);

  // Build history map: "scenarioId/metricKey" -> number[]
  const historyByMetric = new Map<string, number[]>();

  for (const summary of historySummaries) {
    for (const scenario of summary.scenarios) {
      for (const key of TRACKED_METRICS) {
        const value = extractMetricValue(scenario, key);
        if (value == null) continue;
        const label = metricLabel(scenario.id, key);
        const existing = historyByMetric.get(label) ?? [];
        existing.push(value);
        historyByMetric.set(label, existing);
      }
    }
  }

  // Analyze current metrics against history
  const results: TrendMetricResult[] = [];

  for (const scenario of currentSummary.scenarios) {
    for (const key of TRACKED_METRICS) {
      const currentValue = extractMetricValue(scenario, key);
      if (currentValue == null) continue;

      const label = metricLabel(scenario.id, key);
      const historyValues = historyByMetric.get(label) ?? [];
      const historyCount = historyValues.length;
      const insufficientHistory = historyCount < minHistory;

      if (insufficientHistory) {
        results.push({
          metric: label,
          current: currentValue,
          historyCount,
          historyMedian: null,
          historyMad: null,
          robustZ: null,
          deltaPercent: null,
          insufficientHistory: true,
          regressionChangePoint: false,
          improvementChangePoint: false,
        });
        continue;
      }

      const historyMedian = median(historyValues);
      const historyMad = mad(historyValues, historyMedian);
      const changePoint = detectChangePoint(
        currentValue,
        historyMedian,
        historyMad,
        deltaThreshold,
        robustZThreshold
      );

      results.push({
        metric: label,
        current: currentValue,
        historyCount,
        historyMedian,
        historyMad,
        robustZ: changePoint.robustZ,
        deltaPercent: changePoint.deltaPercent,
        insufficientHistory: false,
        regressionChangePoint: changePoint.regressionChangePoint,
        improvementChangePoint: changePoint.improvementChangePoint,
      });
    }
  }

  const hasRegressionChangePoint = results.some(
    (result) => result.regressionChangePoint
  );
  const hasImprovementChangePoint = results.some(
    (result) => result.improvementChangePoint
  );
  const hasInsufficientHistory = results.some(
    (result) => result.insufficientHistory
  );

  const report = {
    generatedAt: new Date().toISOString(),
    currentSummaryPath: currentPath,
    historyDir,
    historySummaryCount: historySummaries.length,
    minHistory,
    deltaThreshold,
    robustZThreshold,
    hasRegressionChangePoint,
    hasImprovementChangePoint,
    hasInsufficientHistory,
    metrics: results,
  };

  await Bun.write(outputPath, JSON.stringify(report, null, 2));

  console.log('\n## Load Trend Analysis');
  console.log(
    '| Metric | Current | Hist Median | Delta | Robust Z | Hist N | Status |'
  );
  console.log(
    '|--------|---------|-------------|-------|----------|--------|--------|'
  );

  for (const result of results) {
    const isRate = result.metric.endsWith('/httpErrorRate');
    const currentFmt = isRate
      ? formatPercent(result.current)
      : formatMs(result.current);
    const medianFmt = isRate
      ? formatPercent(result.historyMedian)
      : formatMs(result.historyMedian);

    const status = result.insufficientHistory
      ? 'insufficient-history'
      : result.regressionChangePoint
        ? 'regression-change-point'
        : result.improvementChangePoint
          ? 'improvement-change-point'
          : 'stable';

    console.log(
      `| ${result.metric} | ${currentFmt} | ${medianFmt} | ${formatPercent(result.deltaPercent)} | ${formatRobustZ(result.robustZ)} | ${result.historyCount} | ${status} |`
    );
  }

  console.log(`LOAD_TREND_HISTORY_FILES=${historySummaries.length}`);
  console.log(
    `LOAD_TREND_CHANGE_POINT=${hasRegressionChangePoint ? 'true' : 'false'}`
  );
  console.log(
    `LOAD_TREND_INSUFFICIENT_HISTORY=${hasInsufficientHistory ? 'true' : 'false'}`
  );

  if (hasRegressionChangePoint && failOnChange) {
    process.exit(1);
  }
}

void main();

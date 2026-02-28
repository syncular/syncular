/**
 * Historical trend and change-point analysis for stable perf summaries.
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
} from './trend-stats';

interface StableMetricSummary {
  metric: string;
  baseline: number | null;
  aggregatedMedian: number;
  min: number;
  max: number;
  runs: number[];
  changePercent: number | null;
}

interface StablePerfSummary {
  generatedAt: string;
  runCount: number;
  hasRegression: boolean;
  hasMissingBaseline: boolean;
  metrics: StableMetricSummary[];
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

async function loadStableSummary(
  filePath: string
): Promise<StablePerfSummary | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  try {
    return (await file.json()) as StablePerfSummary;
  } catch {
    return null;
  }
}

async function collectHistorySummaries(
  historyDir: string
): Promise<StablePerfSummary[]> {
  const glob = new Bun.Glob('*.json');
  const summaries: StablePerfSummary[] = [];

  for await (const filePath of glob.scan({ cwd: historyDir })) {
    const absolutePath = path.join(historyDir, filePath);
    const summary = await loadStableSummary(absolutePath);
    if (!summary) continue;
    if (!Array.isArray(summary.metrics)) continue;
    summaries.push(summary);
  }

  return summaries;
}

async function main() {
  const repoRoot = path.resolve(import.meta.dir, '..', '..');
  const currentPath = path.resolve(
    repoRoot,
    Bun.env.PERF_TREND_CURRENT_PATH ?? 'perf-nightly-summary.json'
  );
  const historyDir = path.resolve(
    repoRoot,
    Bun.env.PERF_TREND_HISTORY_DIR ?? 'perf-history'
  );
  const outputPath = path.resolve(
    repoRoot,
    Bun.env.PERF_TREND_OUTPUT_JSON ?? 'perf-trend.json'
  );

  const minHistory = parseIntOrDefault(Bun.env.PERF_TREND_MIN_HISTORY, 3);
  const deltaThreshold = parseFloatOrDefault(
    Bun.env.PERF_TREND_DELTA_THRESHOLD,
    0.2
  );
  const robustZThreshold = parseFloatOrDefault(
    Bun.env.PERF_TREND_ROBUST_Z_THRESHOLD,
    3
  );
  const failOnChange = Bun.env.PERF_TREND_FAIL_ON_CHANGE === 'true';

  const currentSummary = await loadStableSummary(currentPath);
  if (!currentSummary) {
    throw new Error(`Unable to load current perf summary at ${currentPath}`);
  }

  const historySummaries = await collectHistorySummaries(historyDir);
  const historyByMetric = new Map<string, number[]>();

  for (const summary of historySummaries) {
    for (const metric of summary.metrics) {
      if (!Number.isFinite(metric.aggregatedMedian)) continue;
      const existing = historyByMetric.get(metric.metric) ?? [];
      existing.push(metric.aggregatedMedian);
      historyByMetric.set(metric.metric, existing);
    }
  }

  const results: TrendMetricResult[] = currentSummary.metrics.map((metric) => {
    const historyValues = historyByMetric.get(metric.metric) ?? [];
    const historyCount = historyValues.length;
    const insufficientHistory = historyCount < minHistory;

    if (insufficientHistory) {
      return {
        metric: metric.metric,
        current: metric.aggregatedMedian,
        historyCount,
        historyMedian: null,
        historyMad: null,
        robustZ: null,
        deltaPercent: null,
        insufficientHistory: true,
        regressionChangePoint: false,
        improvementChangePoint: false,
      };
    }

    const historyMedian = median(historyValues);
    const historyMad = mad(historyValues, historyMedian);
    const changePoint = detectChangePoint(
      metric.aggregatedMedian,
      historyMedian,
      historyMad,
      deltaThreshold,
      robustZThreshold
    );

    return {
      metric: metric.metric,
      current: metric.aggregatedMedian,
      historyCount,
      historyMedian,
      historyMad,
      robustZ: changePoint.robustZ,
      deltaPercent: changePoint.deltaPercent,
      insufficientHistory: false,
      regressionChangePoint: changePoint.regressionChangePoint,
      improvementChangePoint: changePoint.improvementChangePoint,
    };
  });

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

  console.log('\n## Perf Trend Analysis');
  console.log(
    '| Metric | Current | Hist Median | Delta | Robust Z | Hist N | Status |'
  );
  console.log(
    '|--------|---------|-------------|-------|----------|--------|--------|'
  );

  for (const result of results) {
    const status = result.insufficientHistory
      ? 'insufficient-history'
      : result.regressionChangePoint
        ? 'regression-change-point'
        : result.improvementChangePoint
          ? 'improvement-change-point'
          : 'stable';

    console.log(
      `| ${result.metric} | ${formatMs(result.current)} | ${formatMs(result.historyMedian)} | ${formatPercent(result.deltaPercent)} | ${formatRobustZ(result.robustZ)} | ${result.historyCount} | ${status} |`
    );
  }

  console.log(`PERF_TREND_HISTORY_FILES=${historySummaries.length}`);
  console.log(
    `PERF_TREND_CHANGE_POINT=${hasRegressionChangePoint ? 'true' : 'false'}`
  );
  console.log(
    `PERF_TREND_INSUFFICIENT_HISTORY=${hasInsufficientHistory ? 'true' : 'false'}`
  );

  if (hasRegressionChangePoint && failOnChange) {
    process.exit(1);
  }
}

void main();

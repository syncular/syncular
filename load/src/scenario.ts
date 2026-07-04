/**
 * Scenario contract: each scenario declares a config (VUs, duration,
 * dataset), a smoke profile (tiny — ~5 VUs, seconds — for the `load:smoke`
 * sweep), pass/fail thresholds (p95 latencies, zero protocol errors, RSS
 * ceiling), and a `run` that returns a machine-readable result + a one-line
 * human summary (load brief §2). This suite is stability/scale verification,
 * NOT a benchmark — bench/ owns comparative numbers.
 */

import type { ServerMetrics } from './harness';
import type { LatencySeries } from './metrics';

export interface ScenarioProfile {
  /** Peak concurrent virtual users. */
  readonly vus: number;
  /** Wall-clock cap in seconds (the ramp + steady window). */
  readonly durationSec: number;
  /** Rows seeded into the storm project (bootstrap datasets). */
  readonly dataset: number;
}

export interface CustomCheckInput {
  readonly extra: Record<string, number>;
  readonly server: ServerMetrics;
}

export interface ScenarioThresholds {
  /** p95 ceilings per named latency series, in ms. */
  readonly latencyP95Ms?: Record<string, number>;
  /** Max tolerated protocol-error VUs (error budget; default 0). */
  readonly maxFailedVus?: number;
  /** Server RSS ceiling in MB (peak). */
  readonly rssCeilingMb?: number;
  /** Scenario-specific checks over the scalar extras / server counters. */
  readonly customChecks?: (input: CustomCheckInput) => ThresholdCheck[];
}

export interface ThresholdCheck {
  readonly name: string;
  readonly threshold: string;
  readonly measured: string;
  readonly ok: boolean;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly profile: 'smoke' | 'full';
  readonly config: ScenarioProfile;
  readonly wallMs: number;
  readonly completedVus: number;
  readonly failedVus: number;
  readonly errors: readonly string[];
  readonly latencies: readonly LatencySeries[];
  /** Scenario-specific scalar metrics (rows/sec, reuse count, catch-up ms…). */
  readonly extra: Record<string, number>;
  readonly server: ServerMetrics;
  readonly checks: readonly ThresholdCheck[];
  readonly pass: boolean;
}

export interface ScenarioContext {
  readonly profile: 'smoke' | 'full';
  readonly config: ScenarioProfile;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly full: ScenarioProfile;
  readonly smoke: ScenarioProfile;
  readonly thresholds: (profile: 'smoke' | 'full') => ScenarioThresholds;
  run(ctx: ScenarioContext): Promise<ScenarioResult>;
}

/** Apply thresholds to a raw result, producing checks + a pass verdict. */
export function evaluate(
  scenario: Scenario,
  profile: 'smoke' | 'full',
  config: ScenarioProfile,
  raw: {
    wallMs: number;
    completedVus: number;
    failedVus: number;
    errors: readonly string[];
    latencies: readonly LatencySeries[];
    extra: Record<string, number>;
    server: ServerMetrics;
  },
): ScenarioResult {
  const t = scenario.thresholds(profile);
  const checks: ThresholdCheck[] = [];

  const maxFailed = t.maxFailedVus ?? 0;
  checks.push({
    name: 'protocol errors (zero-error budget)',
    threshold: `<= ${maxFailed} failed VUs`,
    measured: `${raw.failedVus} failed`,
    ok: raw.failedVus <= maxFailed,
  });

  if (t.latencyP95Ms !== undefined) {
    for (const [series, ceiling] of Object.entries(t.latencyP95Ms)) {
      const found = raw.latencies.find((l) => l.name === series);
      const p95 = found?.p95 ?? Number.NaN;
      checks.push({
        name: `${series} p95`,
        threshold: `<= ${ceiling}ms`,
        measured: Number.isNaN(p95) ? 'no samples' : `${p95.toFixed(1)}ms`,
        ok: Number.isFinite(p95) && p95 <= ceiling,
      });
    }
  }

  if (t.rssCeilingMb !== undefined) {
    const peakMb = raw.server.peakRssBytes / 1_048_576;
    checks.push({
      name: 'server peak RSS',
      threshold: `<= ${t.rssCeilingMb}MB`,
      measured: `${peakMb.toFixed(1)}MB`,
      ok: peakMb <= t.rssCeilingMb,
    });
  }

  if (t.customChecks !== undefined) {
    checks.push(...t.customChecks({ extra: raw.extra, server: raw.server }));
  }

  return {
    scenario: scenario.name,
    profile,
    config,
    wallMs: raw.wallMs,
    completedVus: raw.completedVus,
    failedVus: raw.failedVus,
    errors: raw.errors,
    latencies: raw.latencies,
    extra: raw.extra,
    server: raw.server,
    checks,
    pass: checks.every((c) => c.ok),
  };
}

/** The one-line human summary (load brief §2). */
export function summaryLine(result: ScenarioResult): string {
  const verdict = result.pass ? 'PASS' : 'FAIL';
  const parts: string[] = [
    `[${verdict}] ${result.scenario}/${result.profile}`,
    `${result.config.vus}vu ${(result.wallMs / 1000).toFixed(1)}s`,
    `${result.completedVus} iters`,
    `${result.failedVus} err`,
  ];
  for (const l of result.latencies) {
    if (l.count > 0) parts.push(`${l.name} p95=${l.p95.toFixed(0)}ms`);
  }
  parts.push(
    `reuse=${result.server.segmentsReused}/${result.server.segmentsBuilt}`,
  );
  parts.push(`rss=${(result.server.peakRssBytes / 1_048_576).toFixed(0)}MB`);
  return parts.join(' · ');
}

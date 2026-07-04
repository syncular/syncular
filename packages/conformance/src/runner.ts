/**
 * The conformance runner: executes the scenario catalog against one
 * (ClientDriver, ServerDriver, CodecDriver) pairing and reports
 * per-scenario pass/fail with spec refs.
 *
 * `knownDiscrepancy` protocol: a scenario that exposes a real divergence
 * between an implementation and the SPEC stays in the catalog, marked
 * with the spec ref of the violated rule. The runner then expects it to
 * fail (`expected-fail`); if it starts passing the runner reports
 * `unexpected-pass` so the marker gets removed. Scenarios are never
 * weakened to make a pairing green.
 */
import type { Pairing } from './driver';
import { createScenarioContext, type Scenario } from './scenario';

export type ScenarioStatus =
  | 'pass'
  | 'fail'
  | 'expected-fail'
  | 'unexpected-pass'
  | 'skipped';

export interface ScenarioResult {
  readonly name: string;
  readonly specRefs: readonly string[];
  readonly status: ScenarioStatus;
  readonly error?: string;
  readonly knownDiscrepancy?: string;
  /** Why the scenario was skipped (missing optional capability). */
  readonly skippedBecause?: string;
}

export interface CatalogReport {
  readonly pairing: string;
  readonly results: readonly ScenarioResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export async function runScenario(
  scenario: Scenario,
  pairing: Pairing,
): Promise<ScenarioResult> {
  const missing = (scenario.requires ?? []).filter(
    (capability) => !pairing.server.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    return {
      name: scenario.name,
      specRefs: scenario.specRefs,
      status: 'skipped',
      skippedBecause: `server driver lacks capability: ${missing.join(', ')}`,
    };
  }

  let error: string | undefined;
  const ctx = await createScenarioContext(scenario, pairing);
  try {
    await scenario.run(ctx);
  } catch (thrown) {
    error =
      thrown instanceof Error
        ? `${thrown.name}: ${thrown.message}`
        : String(thrown);
  } finally {
    await ctx.close();
  }

  if (scenario.knownDiscrepancy !== undefined) {
    return {
      name: scenario.name,
      specRefs: scenario.specRefs,
      status: error === undefined ? 'unexpected-pass' : 'expected-fail',
      knownDiscrepancy: scenario.knownDiscrepancy,
      ...(error !== undefined ? { error } : {}),
    };
  }
  return {
    name: scenario.name,
    specRefs: scenario.specRefs,
    status: error === undefined ? 'pass' : 'fail',
    ...(error !== undefined ? { error } : {}),
  };
}

export async function runCatalog(
  scenarios: readonly Scenario[],
  pairing: Pairing,
): Promise<CatalogReport> {
  const names = new Set<string>();
  for (const scenario of scenarios) {
    if (names.has(scenario.name)) {
      throw new Error(`duplicate scenario name ${scenario.name}`);
    }
    names.add(scenario.name);
  }
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, pairing));
  }
  const passed = results.filter(
    (r) => r.status === 'pass' || r.status === 'expected-fail',
  ).length;
  const failed = results.filter(
    (r) => r.status === 'fail' || r.status === 'unexpected-pass',
  ).length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  return {
    pairing: `${pairing.client.name} × ${pairing.server.name} (codec: ${pairing.codec.name})`,
    results,
    passed,
    failed,
    skipped,
  };
}

/** One-line-per-scenario report (spec refs included), for CI logs. */
export function formatReport(report: CatalogReport): string {
  const lines = [`conformance: ${report.pairing}`];
  for (const result of report.results) {
    const refs = result.specRefs.join(' ');
    const suffix =
      result.status === 'expected-fail'
        ? ` [known discrepancy: ${result.knownDiscrepancy}]`
        : result.status === 'skipped'
          ? ` [${result.skippedBecause}]`
          : result.error !== undefined
            ? ` — ${result.error}`
            : '';
    lines.push(
      `  ${result.status.padEnd(15)} ${result.name} (${refs})${suffix}`,
    );
  }
  lines.push(
    `  ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
  );
  return lines.join('\n');
}

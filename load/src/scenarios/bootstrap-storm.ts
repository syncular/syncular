/**
 * bootstrap-storm — THE named scale scenario (REVISE.md). M fresh clients
 * bootstrap simultaneously against a seeded storm dataset (100k rows in the
 * full profile). All clients read the SAME storm project scope, so the
 * server builds each snapshot segment ONCE and reuses it for the rest —
 * the §5.3 build-once/reuse-M-times rule. The assertion reads the events
 * seam: `segmentsReused` must dominate `segmentsBuilt` (proof the storm
 * doesn't rebuild per client). Measures per-client bootstrap wall time
 * (p50/p95) and rows/sec.
 */

import { STORM_PROJECT } from '../fixture';
import { runRamp, spawnServer } from '../harness';
import { Histogram, seriesOf } from '../metrics';
import {
  evaluate,
  type Scenario,
  type ScenarioContext,
  type ScenarioResult,
} from '../scenario';
import { HttpVClient } from '../vclient';

async function run(ctx: ScenarioContext): Promise<ScenarioResult> {
  const { config, profile } = ctx;
  const server = await spawnServer({ seedRows: config.dataset });
  const bootstrapHist = new Histogram();
  const pageHist = new Histogram();
  let totalBootstraps = 0;
  let totalRows = 0;

  try {
    // All M clients start (near-)simultaneously and each bootstraps the
    // full storm dataset exactly once — a storm, not a steady loop.
    const rampResult = await runRamp(
      server,
      {
        // Fast ramp to full concurrency, then hold so every VU gets at
        // least one full bootstrap iteration within the window.
        stages: [
          { target: config.vus, durationMs: 500 },
          { target: config.vus, durationMs: config.durationSec * 1000 - 500 },
        ],
        maxDurationMs: config.durationSec * 1000,
      },
      async ({ vu, baseUrl, signal }) => {
        if (signal.aborted) return;
        const client = new HttpVClient({
          baseUrl,
          clientId: `boot-${vu}-${totalBootstraps}`,
        });
        client.subscribe('storm', 'tasks', { project_id: [STORM_PROJECT] });
        // The §5.3 image lane (accept bit 2) is what the storm rule exercises:
        // the first client builds+stores the whole-table image, the rest
        // reuse it per (scope, pin). Keep the page limit below the dataset so
        // the table is image-eligible (§5.3 needs snapshot > one page).
        const boot = await client.bootstrap({
          imageLane: true,
          limitSnapshotRows: Math.max(1000, Math.floor(config.dataset / 2)),
        });
        bootstrapHist.add(boot.wallMs);
        for (const l of boot.pageLatenciesMs) pageHist.add(l);
        totalBootstraps += 1;
        totalRows += boot.totalRows;
      },
    );

    const serverMetrics = await server.metrics();
    const rowsPerSec =
      totalRows > 0 ? totalRows / (rampResult.wallMs / 1000) : 0;
    return evaluate(bootstrapStorm, profile, config, {
      wallMs: rampResult.wallMs,
      completedVus: rampResult.completedVus,
      failedVus: rampResult.failedVus,
      errors: rampResult.errors,
      latencies: [
        seriesOf('bootstrap', bootstrapHist),
        seriesOf('page', pageHist),
      ],
      extra: {
        bootstraps: totalBootstraps,
        rowsPerSec: Math.round(rowsPerSec),
        segmentsBuilt: serverMetrics.segmentsBuilt,
        segmentsReused: serverMetrics.segmentsReused,
      },
      server: serverMetrics,
    });
  } finally {
    await server.stop();
  }
}

export const bootstrapStorm: Scenario = {
  name: 'bootstrap-storm',
  description:
    'M fresh clients bootstrap the same seeded dataset at once; segment reuse must dominate.',
  full: { vus: 50, durationSec: 60, dataset: 100_000 },
  smoke: { vus: 5, durationSec: 8, dataset: 2_000 },
  thresholds: (profile) => ({
    maxFailedVus: 0,
    // A single storm-project segment is built once (per page) then reused
    // for every other client, so p95 whole-bootstrap wall time stays low
    // even at 100k. Ceilings sized with generous shared-runner headroom.
    latencyP95Ms: { bootstrap: profile === 'smoke' ? 3000 : 15000 },
    rssCeilingMb: profile === 'smoke' ? 400 : 900,
    // The headline assertion (§5.3): with M clients on one shared scope,
    // reused segments must dominate built ones. Requires ≥2 VUs to have a
    // built segment to reuse; the reuse ratio proves build-once/reuse-M.
    customChecks: ({ server }) => [
      {
        name: 'segment reuse dominates (§5.3 build-once)',
        threshold: 'reused > built (M clients, 1 dataset)',
        measured: `${server.segmentsReused} reused / ${server.segmentsBuilt} built`,
        ok:
          server.segmentsBuilt > 0 &&
          server.segmentsReused > server.segmentsBuilt,
      },
    ],
  }),
  run,
};

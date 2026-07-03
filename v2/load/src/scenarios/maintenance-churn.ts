/**
 * maintenance-churn — steady push/pull traffic while prune cycles run
 * repeatedly against the same partition. This races commit-log pruning
 * (§4.6) against live writes and reads: the invariant under test is that
 * clients keep syncing cleanly (zero protocol errors) while the horizon
 * advances underneath them. A background driver hits the server's prune
 * control endpoint on an interval; the scenario reports how many prune
 * runs fired and how many commits they removed.
 */

import { clientProject } from '../fixture';
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
  const roundHist = new Histogram();
  let totalRounds = 0;

  // Background prune driver: fire a prune every ~200ms for the window.
  const pruneStop = { done: false };
  let pruneRuns = 0;
  const pruner = (async () => {
    while (!pruneStop.done) {
      try {
        await server.prune();
        pruneRuns += 1;
      } catch {
        // prune failures show up in the server error counter
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  try {
    const rampResult = await runRamp(
      server,
      {
        stages: [
          { target: config.vus, durationMs: 1000 },
          { target: config.vus, durationMs: config.durationSec * 1000 - 1000 },
        ],
        maxDurationMs: config.durationSec * 1000,
      },
      async ({ vu, baseUrl, signal }) => {
        // Mixed readers + writers: even VUs write, odd VUs read.
        const project = clientProject(vu % 8); // 8 shared projects = churn
        const client = new HttpVClient({ baseUrl, clientId: `mc-${vu}` });
        client.subscribe('tasks', 'tasks', { project_id: [project] });
        await client.pull();
        let seq = 0;
        while (!signal.aborted) {
          if (vu % 2 === 0) {
            const result = await client.pushPull(
              `${project}-w${seq % 30}`,
              project,
            );
            roundHist.add(result.latencyMs);
          } else {
            const result = await client.pull();
            roundHist.add(result.latencyMs);
          }
          totalRounds += 1;
          seq += 1;
        }
      },
    );

    pruneStop.done = true;
    await pruner;
    const serverMetrics = await server.metrics();
    return evaluate(maintenanceChurn, profile, config, {
      wallMs: rampResult.wallMs,
      completedVus: rampResult.completedVus,
      failedVus: rampResult.failedVus,
      errors: rampResult.errors,
      latencies: [seriesOf('round', roundHist)],
      extra: {
        totalRounds,
        pruneRuns,
        pruneRemovedCommits: serverMetrics.pruneRemovedCommits,
      },
      server: serverMetrics,
    });
  } finally {
    pruneStop.done = true;
    await pruner.catch(() => undefined);
    await server.stop();
  }
}

export const maintenanceChurn: Scenario = {
  name: 'maintenance-churn',
  description:
    'Push/pull traffic racing repeated prune cycles; clients must keep syncing cleanly.',
  full: { vus: 30, durationSec: 20, dataset: 5_000 },
  smoke: { vus: 5, durationSec: 5, dataset: 500 },
  thresholds: (profile) => ({
    maxFailedVus: 0,
    latencyP95Ms: { round: profile === 'smoke' ? 1000 : 600 },
    rssCeilingMb: profile === 'smoke' ? 400 : 700,
    // Prune must actually run during the window (else the race isn't
    // exercised); removing commits is expected but not required every run.
    customChecks: ({ extra }) => [
      {
        name: 'prune cycles fired',
        threshold: '>= 1 prune run',
        measured: `${extra.pruneRuns ?? 0} runs`,
        ok: (extra.pruneRuns ?? 0) >= 1,
      },
    ],
  }),
  run,
};

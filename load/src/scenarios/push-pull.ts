/**
 * push-pull — steady mixed write/read load. N virtual clients each own a
 * distinct project scope, loop push+pull rounds over HTTP for the run
 * window, and observe their own writes coming back. Measures round p50/p95/
 * p99 and sustained ops/s: steady throughput and push-to-visibility on
 * the SSP2/HTTP stack.
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

  try {
    const rampResult = await runRamp(
      server,
      {
        stages: [
          { target: config.vus, durationMs: 1500 },
          { target: config.vus, durationMs: config.durationSec * 1000 - 1500 },
        ],
        maxDurationMs: config.durationSec * 1000,
      },
      async ({ vu, baseUrl, signal }) => {
        const project = clientProject(vu);
        const client = new HttpVClient({
          baseUrl,
          clientId: `pp-${vu}`,
        });
        client.subscribe('tasks', 'tasks', { project_id: [project] });
        // Bootstrap this VU's (empty) project once, then steady push+pull.
        await client.pull();
        let seq = 0;
        while (!signal.aborted) {
          const rowId = `${project}-r${seq % 20}`;
          const result = await client.pushPull(rowId, project);
          roundHist.add(result.latencyMs);
          totalRounds += 1;
          seq += 1;
        }
      },
    );

    const serverMetrics = await server.metrics();
    const opsPerSec = totalRounds / (rampResult.wallMs / 1000);
    return evaluate(pushPull, profile, config, {
      wallMs: rampResult.wallMs,
      completedVus: rampResult.completedVus,
      failedVus: rampResult.failedVus,
      errors: rampResult.errors,
      latencies: [seriesOf('round', roundHist)],
      extra: {
        totalRounds,
        opsPerSec: Math.round(opsPerSec),
      },
      server: serverMetrics,
    });
  } finally {
    await server.stop();
  }
}

export const pushPull: Scenario = {
  name: 'push-pull',
  description:
    'Steady mixed write/read load: N clients loop push+pull rounds over HTTP.',
  full: { vus: 50, durationSec: 20, dataset: 0 },
  smoke: { vus: 5, durationSec: 4, dataset: 0 },
  thresholds: (profile) => ({
    maxFailedVus: 0,
    // p95 ceilings sized off local runs with generous headroom for shared
    // runners: a push+pull round is a commit + a scan, ~single-digit ms
    // in-process; 500ms full / 1000ms smoke catches a real regression
    // (a sleep/poll in the loop) without flapping on a busy laptop.
    latencyP95Ms: { round: profile === 'smoke' ? 1000 : 500 },
    rssCeilingMb: profile === 'smoke' ? 400 : 700,
  }),
  run,
};

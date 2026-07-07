/**
 * reconnect-storm — N realtime clients connect, catch up over the socket,
 * then all drop and reconnect within a tight window while a writer keeps
 * pushing. Each reconnect drives a fresh §8.7 socket round to catch up;
 * the scenario measures reconnect+catch-up latency per client and the
 * wall-clock time for the WHOLE fleet to be caught up again after a drop,
 * on the WS-native loop (Direction decision 1).
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
import { HttpVClient, RealtimeVClient, VClientError } from '../vclient';

async function run(ctx: ScenarioContext): Promise<ScenarioResult> {
  const { config, profile } = ctx;
  const server = await spawnServer({ seedRows: config.dataset });
  const catchupHist = new Histogram();
  const reconnectHist = new Histogram();
  let reconnects = 0;

  // A background writer keeps the storm scope changing so every reconnect
  // has real catch-up work. It runs for the whole scenario window.
  const writerStop = { done: false };
  const writer = (async () => {
    const client = new HttpVClient({
      baseUrl: server.baseUrl,
      clientId: 'rc-writer',
    });
    client.subscribe('storm', 'tasks', { project_id: [STORM_PROJECT] });
    let seq = 0;
    while (!writerStop.done) {
      try {
        await client.pushPull(
          `${STORM_PROJECT}-hot-${seq % 50}`,
          STORM_PROJECT,
        );
      } catch {
        // writer errors are surfaced via the server error counter below
      }
      seq += 1;
      await new Promise((r) => setTimeout(r, 10));
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
        // First connection + full catch-up (the "already connected" fleet).
        let client = new RealtimeVClient({ baseUrl, clientId: `rc-${vu}` });
        client.subscribe('storm', 'tasks', { project_id: [STORM_PROJECT] });
        await client.connect();
        await client.bootstrap();
        // Repeated drop/reconnect cycles for the window: measure the
        // WS handshake + one catch-up round each time.
        while (!signal.aborted) {
          client.close();
          client = new RealtimeVClient({ baseUrl, clientId: `rc-${vu}` });
          client.subscribe('storm', 'tasks', { project_id: [STORM_PROJECT] });
          const t0 = performance.now();
          await client.connect();
          const connectMs = performance.now() - t0;
          const catchup = await client.syncRound();
          catchupHist.add(catchup.latencyMs);
          reconnectHist.add(connectMs + catchup.latencyMs);
          reconnects += 1;
          if (signal.aborted) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        client.close();
      },
    );

    writerStop.done = true;
    await writer;
    const serverMetrics = await server.metrics();
    return evaluate(reconnectStorm, profile, config, {
      wallMs: rampResult.wallMs,
      completedVus: rampResult.completedVus,
      failedVus: rampResult.failedVus,
      errors: rampResult.errors,
      latencies: [
        seriesOf('reconnect', reconnectHist),
        seriesOf('catchup', catchupHist),
      ],
      extra: { reconnects },
      server: serverMetrics,
    });
  } catch (error) {
    writerStop.done = true;
    await writer.catch(() => undefined);
    if (error instanceof VClientError) throw error;
    throw error;
  } finally {
    await server.stop();
  }
}

export const reconnectStorm: Scenario = {
  name: 'reconnect-storm',
  description:
    'N realtime clients repeatedly drop + reconnect while writes flow; catch-up over the §8.7 socket.',
  full: { vus: 40, durationSec: 20, dataset: 2_000 },
  smoke: { vus: 5, durationSec: 5, dataset: 500 },
  thresholds: (profile) => ({
    maxFailedVus: 0,
    // Reconnect = a WS handshake + one catch-up round. Ceilings absorb WS
    // setup cost and shared-runner noise; a regression (e.g. catch-up
    // re-bootstrapping the whole scope) blows well past these.
    latencyP95Ms: {
      reconnect: profile === 'smoke' ? 2000 : 1500,
      catchup: profile === 'smoke' ? 1500 : 1000,
    },
    rssCeilingMb: profile === 'smoke' ? 400 : 700,
  }),
  run,
};

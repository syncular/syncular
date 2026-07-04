/**
 * mixed-soak — the interleaved soak: readers, writers, and realtime clients
 * run together for a long window (minutes, in the full profile) while a
 * background pruner churns the log. The point is stability over time, not
 * peak throughput: RSS is watched (a leak shows as peak RSS creeping past
 * the ceiling), and the zero-protocol-error budget must hold for the whole
 * duration. Ports v1's mixed-soak intent.
 */

import { clientProject, STORM_PROJECT } from '../fixture';
import { runRamp, spawnServer } from '../harness';
import { Histogram, seriesOf } from '../metrics';
import {
  evaluate,
  type Scenario,
  type ScenarioContext,
  type ScenarioResult,
} from '../scenario';
import { HttpVClient, RealtimeVClient } from '../vclient';

async function run(ctx: ScenarioContext): Promise<ScenarioResult> {
  const { config, profile } = ctx;
  const server = await spawnServer({ seedRows: config.dataset });
  const readHist = new Histogram();
  const writeHist = new Histogram();
  const rtHist = new Histogram();
  let rounds = 0;

  // Background pruner: soak the maintenance path too.
  const pruneStop = { done: false };
  let pruneRuns = 0;
  const pruner = (async () => {
    while (!pruneStop.done) {
      try {
        await server.prune();
        pruneRuns += 1;
      } catch {
        // counted via server errors
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  // RSS trace: sample the server's peak RSS periodically so we can report
  // whether it climbed (a leak) versus plateaued (healthy).
  const rssTrace: number[] = [];
  const rssStop = { done: false };
  const rssSampler = (async () => {
    while (!rssStop.done) {
      try {
        const m = await server.metrics();
        rssTrace.push(m.rssBytes);
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  try {
    const rampResult = await runRamp(
      server,
      {
        stages: [
          { target: config.vus, durationMs: 2000 },
          { target: config.vus, durationMs: config.durationSec * 1000 - 2000 },
        ],
        maxDurationMs: config.durationSec * 1000,
      },
      async ({ vu, baseUrl, signal }) => {
        const role = vu % 5; // 0-2 readers, 3 writer, 4 realtime
        if (role === 4) {
          const rt = new RealtimeVClient({
            baseUrl,
            clientId: `soak-rt-${vu}`,
          });
          rt.subscribe('storm', 'tasks', { project_id: [STORM_PROJECT] });
          await rt.connect();
          await rt.bootstrap();
          while (!signal.aborted) {
            const r = await rt.syncRound();
            rtHist.add(r.latencyMs);
            rounds += 1;
            await new Promise((res) => setTimeout(res, 30));
          }
          rt.close();
          return;
        }
        const project = role === 3 ? clientProject(vu % 8) : STORM_PROJECT;
        const client = new HttpVClient({ baseUrl, clientId: `soak-${vu}` });
        const subScope = role === 3 ? project : STORM_PROJECT;
        client.subscribe('sub', 'tasks', { project_id: [subScope] });
        await client.pull();
        let seq = 0;
        while (!signal.aborted) {
          if (role === 3) {
            const r = await client.pushPull(`${project}-s${seq % 40}`, project);
            writeHist.add(r.latencyMs);
          } else {
            const r = await client.pull();
            readHist.add(r.latencyMs);
          }
          rounds += 1;
          seq += 1;
          await new Promise((res) => setTimeout(res, 15));
        }
      },
    );

    pruneStop.done = true;
    rssStop.done = true;
    await pruner;
    await rssSampler;
    const serverMetrics = await server.metrics();
    const rssStartMb = (rssTrace[0] ?? serverMetrics.rssBytes) / 1_048_576;
    const rssEndMb =
      (rssTrace[rssTrace.length - 1] ?? serverMetrics.rssBytes) / 1_048_576;
    return evaluate(mixedSoak, profile, config, {
      wallMs: rampResult.wallMs,
      completedVus: rampResult.completedVus,
      failedVus: rampResult.failedVus,
      errors: rampResult.errors,
      latencies: [
        seriesOf('read', readHist),
        seriesOf('write', writeHist),
        seriesOf('realtime', rtHist),
      ],
      extra: {
        rounds,
        pruneRuns,
        rssStartMb: Math.round(rssStartMb),
        rssEndMb: Math.round(rssEndMb),
        rssGrowthMb: Math.round(rssEndMb - rssStartMb),
      },
      server: serverMetrics,
    });
  } finally {
    pruneStop.done = true;
    rssStop.done = true;
    await pruner.catch(() => undefined);
    await rssSampler.catch(() => undefined);
    await server.stop();
  }
}

export const mixedSoak: Scenario = {
  name: 'mixed-soak',
  description:
    'Readers + writers + realtime + prune, interleaved for a long window; RSS watched for leaks.',
  full: { vus: 30, durationSec: 120, dataset: 20_000 },
  smoke: { vus: 5, durationSec: 6, dataset: 500 },
  thresholds: (profile) => ({
    maxFailedVus: 0,
    latencyP95Ms: {
      read: profile === 'smoke' ? 1000 : 600,
      write: profile === 'smoke' ? 1000 : 800,
    },
    // A soak's RSS ceiling is the leak tripwire — a flat server should sit
    // well under it for the whole window.
    rssCeilingMb: profile === 'smoke' ? 400 : 900,
  }),
  run,
};

/**
 * B6 bench spot-check (`bun run bench` from the repo root or bench/).
 *
 * Measures, on the bun:sqlite loopback lane (client core + real server
 * library, in-process bytes — the conformance-loopback philosophy):
 *   a. bootstrap wall time at 1k and 100k rows (fresh client → fully
 *      applied local rows), median of repeated runs, rows/sec;
 *   b. online propagation through the RealtimeHub (mutate on A → row
 *      applied+acked on B), p50/p95 over ≥200 iterations, plus write-ack;
 *   c. peak RSS delta during the 100k bootstrap;
 * and the browser bundle size (minified JS + the external sqlite3.wasm).
 *
 * Output: bench/RESULTS.md, the curated results record.
 */
import { join } from 'node:path';
import { fmtKb, fmtMs, median, percentile, rowId, TABLE } from './fixture';
import {
  createBenchClient,
  createBenchServer,
  seedServerRows,
} from './loopback';
import { reportPgLane, runPgLane } from './pg-lane';
import { reportWindowShard, runWindowShardLane } from './window-lane';

// accept 0b0011 pins the rows lane (the client's default now advertises
// sqlite images, §4.2) — the rows number stays comparable across runs.
const BOOTSTRAP_LIMITS = {
  limitSnapshotRows: 50_000,
  maxSnapshotPages: 50,
  accept: 0b0011,
};

// The §5.3 sqlite-image lane: default page size (1000) keeps the table
// image-eligible at every measured row count; bit 2 advertises support.
const IMAGE_LIMITS = {
  accept: 0b0111,
};

// -- CI mode & workloads ----------------------------------------------------
//
// `bun run bench` (local, default): full workloads, writes RESULTS.md —
// the curated gate record. `--ci` (or SYNCULAR_BENCH_CI=1): reduced but
// meaningful workloads sized to keep the job under ~3 minutes, asserts
// BUDGETS and exits nonzero on breach, and never touches RESULTS.md.
// Every count is env-overridable for one-off experiments.

const CI_MODE =
  process.env.SYNCULAR_BENCH_CI === '1' || process.argv.includes('--ci');

function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

const WORKLOAD = {
  smallRows: envCount('SYNCULAR_BENCH_SMALL_ROWS', 1_000),
  smallRuns: envCount('SYNCULAR_BENCH_SMALL_RUNS', CI_MODE ? 3 : 7),
  bigRows: envCount(
    'SYNCULAR_BENCH_BOOTSTRAP_ROWS',
    CI_MODE ? 25_000 : 100_000,
  ),
  bigRuns: envCount('SYNCULAR_BENCH_BOOTSTRAP_RUNS', CI_MODE ? 3 : 5),
  propIterations: envCount(
    'SYNCULAR_BENCH_PROP_ITERATIONS',
    CI_MODE ? 100 : 200,
  ),
} as const;

/**
 * CI perf budgets (asserted only in CI mode). Each is derived from the
 * 2026-07-03 local baseline in RESULTS.md (Bun 1.3.14, darwin/arm64) —
 * regenerate the baseline with a plain `bun run bench` before retuning.
 *
 * - `bootstrapRowsPerSecFloor` 90,000/s: the local 100k bootstrap runs at
 *   ~274–278k rows/s. The floor sits ~3× below that to absorb slower
 *   shared CI runners, yet still catches an apply-path regression toward
 *   a naive row-by-row rate (~125k rows/s locally ⇒ well under 90k/s on
 *   a CI runner). Rows/sec normalizes across the reduced CI row count.
 * - `imageBootstrapRowsPerSecFloor` 300,000/s: the §5.3 sqlite-image
 *   lane (warm/storm case — stored image reused per scopes+pin) runs at
 *   ~3.2M rows/s locally at 100k (31.5 ms). The floor sits ~10× below
 *   that — extra headroom because the CI workload (25k rows) makes the
 *   per-run fixed costs a larger share — and still catches the lane
 *   silently degrading to row-by-row application (the rows lane's
 *   ~275k/s local rate lands well under 300k/s on a shared runner).
 *   Asserted on the warm median: the §5.3 reuse rule is part of what
 *   the budget pins.
 * - `propagationP95CeilingMs` 20 ms: local in-process p95 is 0.2 ms. A
 *   100× allowance absorbs runner noise; breaching 20 ms in-process means
 *   a sleep/poll crept into the sync/realtime loop.
 * - `ownJsRawCeilingBytes` 82 KB: syncular's own JS (core + codec) is
 *   77.7 KB raw today. Bundle bytes are deterministic — no runner noise —
 *   so this stays tight (~5% headroom: enough that a one-KB innocent
 *   change doesn't trip, small enough to catch real bloat). RAISED from
 *   72 KB
 *   (2026-07-05): client-side E2EE (SPEC §5.11) — the AEAD envelope +
 *   value serializer in `@syncular/core` and the encrypt/decrypt seam in
 *   `encryption.ts` — added ~+7 KB raw (this proxy inlines it, though
 *   E2EE is opt-in behind `await import()` and code-splits OUT of any
 *   real app that doesn't configure a keyProvider; the proxy counts it
 *   on purpose as the conservative tripwire). Legitimate growth (a
 *   shipped security feature), re-derived per the standing rule. RAISED
 *   from 66 KB
 *   (2026-07-04, ROADMAP block 3 / DESIGN-eviction W1): windowed sync —
 *   the `window.ts` registry + the `setWindow`/`windowState`/eviction/
 *   pending-drain logic in `client.ts` and `evictScopedRows` in `apply.ts`
 *   (the differentiator, SPEC §4.8) — added +6.12 KB raw (62.98 → 69.10 KB)
 *   but only +1.65 KB gzip (18.94 → 20.59 KB): the wire cost is small; the
 *   raw growth is the value-sharded window family logic (SQL builders,
 *   diff, deterministic sub-id derivation) that minifies but does not
 *   compress away. 72 KB re-pins the raw line with working headroom above
 *   the shipped feature. This is legitimate growth (a shipped
 *   differentiator), not bloat — re-derived per the standing rule. Earlier
 *   raise, from 60 KB (2026-07-03, TODO 3.1): the live-query invalidation
 *   choke point added +1.84 KB raw (61.14 → 62.98 KB) / +0.49 KB gzip.
 *   Note: `totalGzipCeilingBytes` is the shipped-size
 *   gate; own-JS raw is the anti-bloat tripwire, and the feature trips it by
 *   design intent, not accident.
 * - `totalGzipCeilingBytes` 600 KB: total shipped payload (own JS +
 *   sqlite-wasm glue + sqlite3.wasm) is 474.2 KB gzip today. Also
 *   deterministic; ~25% headroom covers a vendor SQLite bump without
 *   letting the payload drift unbounded.
 */
const BUDGETS = {
  bootstrapRowsPerSecFloor: 90_000,
  imageBootstrapRowsPerSecFloor: 300_000,
  propagationP95CeilingMs: 20,
  ownJsRawCeilingBytes: 82 * 1024,
  totalGzipCeilingBytes: 600 * 1024,
} as const;

interface BootstrapResult {
  readonly rows: number;
  readonly runs: number;
  readonly medianMs: number;
  readonly allMs: readonly number[];
  readonly rowsPerSec: number;
  readonly peakRssDeltaBytes: number;
  /**
   * The discarded warm-up run's wall time. On the image lane this is the
   * cold number: it includes building + storing the image server-side;
   * later runs hit the §5.3 reuse rule (the bootstrap-storm case).
   */
  readonly coldMs: number;
}

async function runBootstrap(
  rows: number,
  runs: number,
  sampleRss: boolean,
  limits: Record<string, number> = BOOTSTRAP_LIMITS,
): Promise<BootstrapResult> {
  const server = createBenchServer();
  await seedServerRows(server, rows);

  const timings: number[] = [];
  let coldMs = 0;
  let peakRssDelta = 0;
  for (let run = 0; run < runs + 1; run++) {
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    const sampler = sampleRss
      ? setInterval(() => {
          rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        }, 2)
      : undefined;

    const t0 = performance.now();
    const handle = await createBenchClient(server, { limits });
    await handle.client.syncUntilIdle();
    const elapsed = performance.now() - t0;

    if (sampler !== undefined) clearInterval(sampler);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);

    const count = handle.client.query(`SELECT count(*) AS n FROM "${TABLE}"`)[0]
      ?.n;
    if (Number(count) !== rows) {
      throw new Error(`bootstrap incomplete: ${String(count)} of ${rows}`);
    }
    await handle.close();
    if (run === 0) {
      coldMs = elapsed; // warm-up: excluded from stats, kept as the cold number
      continue;
    }
    timings.push(elapsed);
    peakRssDelta = Math.max(peakRssDelta, rssPeak - rssBefore);
  }
  server.close();
  const med = median(timings);
  return {
    rows,
    runs,
    medianMs: med,
    allMs: timings,
    rowsPerSec: Math.round(rows / (med / 1000)),
    peakRssDeltaBytes: peakRssDelta,
    coldMs,
  };
}

interface PropagationResult {
  readonly iterations: number;
  readonly propP50: number;
  readonly propP95: number;
  readonly ackP50: number;
  readonly ackP95: number;
}

async function runPropagation(iterations: number): Promise<PropagationResult> {
  const server = createBenchServer();
  await seedServerRows(server, 100);

  const a = await createBenchClient(server, { limits: BOOTSTRAP_LIMITS });
  const b = await createBenchClient(server, {
    limits: BOOTSTRAP_LIMITS,
    realtime: true,
  });
  await a.client.syncUntilIdle();
  await b.client.syncUntilIdle();
  await b.client.connectRealtime();

  const propagation: number[] = [];
  const writeAck: number[] = [];
  let seq = await server.storage.getMaxCommitSeq(
    (server.ctx as { partition: string }).partition,
  );
  const warmup = 20;
  for (let i = 0; i < iterations + warmup; i++) {
    const t0 = performance.now();
    a.client.mutate([
      {
        table: TABLE,
        op: 'upsert',
        values: {
          id: rowId(1_000_000 + i),
          project_id: 'p-1',
          title: `propagation ${i}`,
          done: false,
          priority: i % 5,
          updated_at_ms: Date.now(),
        },
      },
    ]);
    await a.client.sync();
    const tAck = performance.now();
    seq += 1;
    await b.waitForAck(seq);
    const tProp = performance.now();
    if (i < warmup) continue;
    writeAck.push(tAck - t0);
    propagation.push(tProp - t0);
  }
  const rowInB = b.client.query(`SELECT 1 FROM "${TABLE}" WHERE id = ?`, [
    rowId(1_000_000 + iterations + warmup - 1),
  ]);
  if (rowInB.length !== 1) throw new Error('propagation row missing in B');
  await a.close();
  await b.close();
  server.close();

  propagation.sort((x, y) => x - y);
  writeAck.sort((x, y) => x - y);
  return {
    iterations,
    propP50: percentile(propagation, 50),
    propP95: percentile(propagation, 95),
    ackP50: percentile(writeAck, 50),
    ackP95: percentile(writeAck, 95),
  };
}

interface BundleResult {
  readonly jsRaw: number;
  readonly jsGzip: number;
  readonly ownJsRaw: number;
  readonly ownJsGzip: number;
  readonly wasmRaw: number;
  readonly wasmGzip: number;
}

async function measureBundle(): Promise<BundleResult> {
  // Conservative single-chunk measurement (no splitting): everything the entry
  // statically-or-dynamically reaches, inlined — the upper bound. Real apps'
  // bundlers code-split opt-in features (E2EE crypto is behind `await import()`
  // so it splits out in any real build); this proxy counts it anyway, on
  // purpose, as the anti-bloat tripwire.
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, 'bundle-entry.ts')],
    target: 'browser',
    // The size gate measures syncular's TS source via the `bun` condition
    // (the published `browser` condition points at compiled dist and needs
    // a `build:packages` first, RFC 0002 §1.1).
    conditions: ['bun'],
    minify: true,
    sourcemap: 'none',
  });
  const js = build.outputs.find((o) => o.path.endsWith('.js'));
  if (js === undefined) throw new Error('bundle build produced no JS output');
  const jsBytes = new Uint8Array(await js.arrayBuffer());
  // Same entry with the sqlite-wasm package external: what remains is
  // syncular's own code (client core + codec) — the bytes we own.
  const ownBuild = await Bun.build({
    entrypoints: [join(import.meta.dir, 'bundle-entry.ts')],
    target: 'browser',
    conditions: ['bun'],
    minify: true,
    sourcemap: 'none',
    external: ['@sqlite.org/sqlite-wasm'],
  });
  const ownJs = ownBuild.outputs.find((o) => o.path.endsWith('.js'));
  if (ownJs === undefined) {
    throw new Error('own-code bundle build produced no JS output');
  }
  const ownJsBytes = new Uint8Array(await ownJs.arrayBuffer());
  const wasmPath = join(
    Bun.resolveSync('@sqlite.org/sqlite-wasm', import.meta.dir),
    '..',
    'sqlite3.wasm',
  );
  const wasmBytes = await Bun.file(wasmPath).bytes();
  return {
    jsRaw: jsBytes.length,
    jsGzip: Bun.gzipSync(jsBytes).length,
    ownJsRaw: ownJsBytes.length,
    ownJsGzip: Bun.gzipSync(ownJsBytes).length,
    wasmRaw: wasmBytes.length,
    wasmGzip: Bun.gzipSync(wasmBytes).length,
  };
}

// -- CI budget assertions ---------------------------------------------------

interface BudgetCheck {
  readonly name: string;
  readonly budget: string;
  readonly measured: string;
  readonly ok: boolean;
}

function checkBudgets(
  big: BootstrapResult,
  image: BootstrapResult,
  prop: PropagationResult,
  bundle: BundleResult,
): BudgetCheck[] {
  const totalGzip = bundle.jsGzip + bundle.wasmGzip;
  return [
    {
      name: `bootstrap rows/sec (${big.rows.toLocaleString('en-US')} rows)`,
      budget: `>= ${BUDGETS.bootstrapRowsPerSecFloor.toLocaleString('en-US')}/s`,
      measured: `${big.rowsPerSec.toLocaleString('en-US')}/s`,
      ok: big.rowsPerSec >= BUDGETS.bootstrapRowsPerSecFloor,
    },
    {
      name: `image-lane bootstrap rows/sec (${image.rows.toLocaleString('en-US')} rows, warm)`,
      budget: `>= ${BUDGETS.imageBootstrapRowsPerSecFloor.toLocaleString('en-US')}/s`,
      measured: `${image.rowsPerSec.toLocaleString('en-US')}/s`,
      ok: image.rowsPerSec >= BUDGETS.imageBootstrapRowsPerSecFloor,
    },
    {
      name: 'propagation p95 (in-process loopback)',
      budget: `<= ${BUDGETS.propagationP95CeilingMs.toFixed(0)} ms`,
      measured: fmtMs(prop.propP95),
      ok: prop.propP95 <= BUDGETS.propagationP95CeilingMs,
    },
    {
      name: 'own JS bundle, raw (core + codec)',
      budget: `<= ${fmtKb(BUDGETS.ownJsRawCeilingBytes)}`,
      measured: fmtKb(bundle.ownJsRaw),
      ok: bundle.ownJsRaw <= BUDGETS.ownJsRawCeilingBytes,
    },
    {
      name: 'total bundle, gzip (incl. vendor sqlite)',
      budget: `<= ${fmtKb(BUDGETS.totalGzipCeilingBytes)}`,
      measured: fmtKb(totalGzip),
      ok: totalGzip <= BUDGETS.totalGzipCeilingBytes,
    },
  ];
}

// -- report ---------------------------------------------------------------------

function fmtMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function report(
  b1k: BootstrapResult,
  b100k: BootstrapResult,
  image: BootstrapResult,
  prop: PropagationResult,
  bundle: BundleResult,
  shard: import('./window-lane').WindowShardResult,
): string {
  const totalRaw = bundle.jsRaw + bundle.wasmRaw;
  const totalGzip = bundle.jsGzip + bundle.wasmGzip;
  const glueRaw = bundle.jsRaw - bundle.ownJsRaw;
  const glueGzip = bundle.jsGzip - bundle.ownJsGzip;
  const now = new Date().toISOString();

  return `# bench — curated results

Generated by \`bun run bench\` on ${now} (Bun ${Bun.version},
${process.platform}/${process.arch}). Deterministic seeded row data; timings
vary run to run.

**Lane**: bun:sqlite loopback — the TS client core and the real
server library exchange in-process SSP2 bytes (transport, segment download
and realtime are direct function calls / RealtimeHub callbacks). Same
philosophy as the conformance loopback: no sockets, no HTTP stack, no
browser — and the client runs on bun:sqlite, not sqlite-wasm. Read every
number as the in-process best case: a real deployment adds network and
serialization costs this lane does not have.

## a. Bootstrap wall time (fresh client → fully-applied local rows)

| Case | Median | Rows/sec | Runs |
|---|---|---|---|
| 1k rows (rows lane) | ${fmtMs(b1k.medianMs)} | ${b1k.rowsPerSec.toLocaleString('en-US')} | ${b1k.runs} |
| 100k rows (rows lane) | ${fmtMs(b100k.medianMs)} | ${b100k.rowsPerSec.toLocaleString('en-US')} | ${b100k.runs} |
| 100k rows (**sqlite image**, §5.3) | ${fmtMs(image.medianMs)} | ${image.rowsPerSec.toLocaleString('en-US')} | ${image.runs} |

The image lane's median is the warm/storm case: the server reuses the
stored image per (scopes, pin) — §5.3's build-once rule — so every
client after the first downloads and imports at file-copy speed. The
cold first bootstrap, which also builds and stores the image
server-side, took ${fmtMs(image.coldMs)}. The rows lane uses no
precomputed artifact at all: segments are scanned, encoded, and
hash-verified per bootstrap.

All runs (ms), after one discarded warm-up:
- 1k rows lane: ${b1k.allMs.map((v) => v.toFixed(1)).join(', ')}
- 100k rows lane: ${b100k.allMs.map((v) => v.toFixed(1)).join(', ')}
- 100k image lane: ${image.allMs.map((v) => v.toFixed(1)).join(', ')} (cold ${image.coldMs.toFixed(1)})

## b. Online propagation (RealtimeHub, 2 clients, ${prop.iterations} iterations)

Measured from \`mutate()\` on client A to client B's post-apply ack of the
commit (B applies the binary delta to its local DB, then acks — §8.2).

| Metric | Measured |
|---|---|
| Propagation p50 | ${fmtMs(prop.propP50)} |
| Propagation p95 | ${fmtMs(prop.propP95)} |
| Write-ack p50 (A's push+pull round) | ${fmtMs(prop.ackP50)} |
| Write-ack p95 | ${fmtMs(prop.ackP95)} |

${fmtMs(prop.propP95)} p95 is loopback-fast; over a real socket expect
network latency to dominate.

## b2. Windowed sync value-sharding (§4.8, W1)

A window replace \`{A,B}→{B,C}\` must re-download **only C** — the
intersection B is neither re-bootstrapped nor evicted. Measured on the
rows-lane segment counter (${shard.perProjectRows} rows per project):

| Step | Bootstrap rows applied |
|---|---|
| Initial window \`{A,B}\` | ${shard.initialApplied} (= 2 projects) |
| Replace \`{A,B}→{B,C}\` | **${shard.replaceApplied}** (only C) |
| Naive "re-download the whole window" | ${shard.naiveApplied} (A+B+C) |

The replace applies exactly one project's worth of rows, not three — the
value-sharded subscription family means the cost of a window change is
proportional to the *delta*, not the window size. This is the
differentiator claim, on a counter:
${
  shard.replaceApplied === shard.perProjectRows
    ? 'PASS — B was not re-downloaded.'
    : 'FAIL — the intersection was re-downloaded.'
}

## c. Server memory (100k bootstrap)

| Metric | Measured |
|---|---|
| Peak RSS delta during 100k bootstrap | ${fmtMb(b100k.peakRssDeltaBytes)} |

Caveat: server and client share one process in this lane, so the delta
includes the client's local SQLite writes too — it is an upper bound on
the server share. Sampled at ~2 ms.

## Bundle size (browser client)

\`bun build --minify --target=browser\` of a minimal entry importing
\`SyncClient\` + the sqlite-wasm database backend. The \`sqlite3.wasm\`
binary is external (fetched at runtime), measured as shipped by
\`@sqlite.org/sqlite-wasm\`.

| Artifact | Raw | Gzip | Whose bytes |
|---|---|---|---|
| syncular client code (core + codec) | ${fmtKb(bundle.ownJsRaw)} | ${fmtKb(bundle.ownJsGzip)} | **ours** |
| sqlite-wasm JS glue | ${fmtKb(glueRaw)} | ${fmtKb(glueGzip)} | vendor (SQLite) |
| sqlite3.wasm (external asset) | ${fmtKb(bundle.wasmRaw)} | ${fmtKb(bundle.wasmGzip)} | vendor (SQLite) |
| **Total** | **${fmtKb(totalRaw)}** | **${fmtKb(totalGzip)}** | |

The size budget gates OUR bytes (decision 2026-07-03): vendor engine
bytes don't gate — every wasm-SQLite product ships the stock SQLite
distribution. Total reported for context: ${fmtKb(totalRaw)} raw /
${fmtKb(totalGzip)} gzip.
`;
}

async function main(): Promise<void> {
  if (CI_MODE) {
    console.log(
      'bench: CI mode — reduced workloads, budget assertions, RESULTS.md untouched',
    );
  }
  console.log(
    `bench: bootstrap ${WORKLOAD.smallRows.toLocaleString('en-US')} rows…`,
  );
  const small = await runBootstrap(
    WORKLOAD.smallRows,
    WORKLOAD.smallRuns,
    false,
  );
  console.log(`  median ${fmtMs(small.medianMs)}`);
  console.log(
    `bench: bootstrap ${WORKLOAD.bigRows.toLocaleString('en-US')} rows…`,
  );
  const big = await runBootstrap(WORKLOAD.bigRows, WORKLOAD.bigRuns, true);
  console.log(
    `  median ${fmtMs(big.medianMs)} (${big.rowsPerSec.toLocaleString('en-US')} rows/s)`,
  );
  console.log(
    `bench: bootstrap ${WORKLOAD.bigRows.toLocaleString('en-US')} rows via sqlite image…`,
  );
  const image = await runBootstrap(
    WORKLOAD.bigRows,
    WORKLOAD.bigRuns,
    false,
    IMAGE_LIMITS,
  );
  console.log(
    `  median ${fmtMs(image.medianMs)} (${image.rowsPerSec.toLocaleString('en-US')} rows/s), cold ${fmtMs(image.coldMs)} incl. server-side build`,
  );
  console.log('bench: propagation…');
  const prop = await runPropagation(WORKLOAD.propIterations);
  console.log(
    `  p50 ${fmtMs(prop.propP50)} p95 ${fmtMs(prop.propP95)} ack p50 ${fmtMs(prop.ackP50)}`,
  );
  console.log('bench: bundle size…');
  const bundle = await measureBundle();
  console.log(
    `  js ${fmtKb(bundle.jsRaw)} (gzip ${fmtKb(bundle.jsGzip)}), wasm ${fmtKb(bundle.wasmRaw)}`,
  );

  // §4.8 value-sharding proof (cheap): replace {A,B}→{B,C} re-downloads only
  // C. Small workload — the point is the segment-counter invariant, not time.
  console.log('bench: window value-sharding…');
  const shard = await runWindowShardLane(CI_MODE ? 100 : 500);
  console.log(reportWindowShard(shard));
  const shardOk = shard.replaceApplied === shard.perProjectRows;

  // Env-gated Postgres lane (§4.1): the production database path. Never part
  // of CI budgets — it needs a real Postgres at SYNCULAR_PG_URL — so it runs
  // for information only and skips cleanly when unconfigured.
  console.log('bench: pg lane…');
  const pg = await runPgLane(WORKLOAD.bigRows, WORKLOAD.propIterations);
  console.log(reportPgLane(pg));

  if (CI_MODE) {
    // Budgets gate; RESULTS.md stays the curated full-workload record.
    const checks = checkBudgets(big, image, prop, bundle);
    // §4.8: the sharding invariant is a correctness budget — a replace that
    // re-downloads more than the delta unit is a regression, not a slowdown.
    checks.push({
      name: 'window value-sharding (replace re-downloads only the delta)',
      budget: `== ${shard.perProjectRows} rows (C only)`,
      measured: `${shard.replaceApplied} rows`,
      ok: shardOk,
    });
    console.log('\nbudget checks:');
    for (const check of checks) {
      console.log(
        `  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.measured} (budget ${check.budget})`,
      );
    }
    const breached = checks.filter((check) => !check.ok);
    if (breached.length > 0) {
      console.error(
        `\n${breached.length} budget breach(es) — failing the job.`,
      );
      process.exit(1);
    }
    console.log('\nall budgets green.');
    return;
  }

  const markdown = report(small, big, image, prop, bundle, shard);
  const outPath = join(import.meta.dir, '..', 'RESULTS.md');
  await Bun.write(outPath, markdown);
  console.log(`\nwrote ${outPath}`);
}

await main();

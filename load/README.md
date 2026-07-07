# @syncular-load — load & scale verification

A **bun-native, dependency-light** load suite for syncular. It spawns
**one real server process** (Hono adapter, real HTTP + WebSocket on
localhost, `bun:sqlite` storage by default) and drives **N lightweight,
protocol-level virtual clients** — encoded SSP2 rounds over the real wire,
built on the reference codec (`@syncular/core`), not a full `SyncClient`
per VU. That is the k6-VU equivalent at roughly 100× less per-VU overhead.

Zero new runtime dependencies (no k6, no Docker). Runnable by a human before
a real deployment. **Not in CI by default** (see [What this is not](#what-this-is-not)).

## What this is NOT

- **Not a benchmark.** `bench/` owns the comparative, curated numbers
  (rows/sec, bundle size, propagation p95 vs the 0.1.3 reference). This suite is
  **stability/scale verification**: does the server stay up, correct, and
  memory-flat under many concurrent clients, storms, churn, and soak? The
  numbers here are pass/fail against thresholds, not a leaderboard.
- **Not a per-VU real client.** Virtual clients speak the protocol directly
  and keep no local SQLite; they verify bootstrap completion by counting
  applied rows out of the response and draining `bootstrapState`. Client-side
  apply performance is a `bench/` and `web-client` concern.
- **Not in the default `bun test` sweep.** The scenario smokes spawn server
  processes and take ~30s all told (well over the ~10s CI budget), so
  `load/` is path-ignored by the root `test` script. Only the sub-second
  pure-logic unit tests (`load/src/*.test.ts`) run, via `bun test` in this
  workspace. See [CI later?](#ci-later).

## Running

From the repo root:

```bash
bun run load <scenario> [--smoke] [--vus N] [--duration S] [--dataset N]
bun run load:smoke          # tiny smoke profile of every scenario
```

Scenarios: `push-pull`, `bootstrap-storm`, `reconnect-storm`,
`maintenance-churn`, `mixed-soak`.

Examples:

```bash
bun run load bootstrap-storm                    # full profile (50 VUs / 100k)
bun run load bootstrap-storm --vus 100 --dataset 200000
bun run load push-pull --smoke                  # ~4s smoke
bun run load mixed-soak --duration 600          # 10-minute soak
```

Each run prints a one-line human summary + per-check verdicts and writes a
machine-readable JSON result to `load/results/<scenario>-<profile>-<ts>.json`.

### Postgres lane

By default storage is in-memory `bun:sqlite`. To target a real Postgres —
the production database path (TODO §4.1), where a hard-won production lesson lives —
set `SYNCULAR_PG_URL`:

```bash
SYNCULAR_PG_URL=postgres://user:pass@localhost:5432/db bun run load bootstrap-storm
```

The server process wires `Bun.SQL` as the `PgExecutor` (the same
production-shape adapter the bench PG lane uses) and clears its partition
before each run. Everything else is identical, so the scope-fanout index and
the storm reuse rule are exercised end to end against real Postgres.

## Scenarios & thresholds

Every scenario has a **full** profile and a **smoke** profile (~5 VUs,
seconds). Thresholds: **zero protocol errors** (any in-band `ERROR` frame,
non-200, or decode failure fails a VU), **p95 latency ceilings**, and a
**server peak-RSS ceiling**. Ceilings are sized off local runs with generous
headroom for shared/busy machines — they catch a *regression* (a sleep/poll
in a loop, a re-bootstrap on catch-up, a rebuild-per-client storm, an RSS
leak), not a busy laptop.

| Scenario | Intent | Full profile | Key thresholds |
|---|---|---|---|
| `push-pull` | Steady mixed write/read; N clients loop push+pull, sustained ops/s | 50 VU / 20s | round p95 ≤ 500ms; 0 errors; RSS ≤ 700MB |
| `bootstrap-storm` | **The scale scenario.** M fresh clients bootstrap the same seeded 100k dataset at once | 50 VU / 60s / 100k | **reused > built** (§5.3); bootstrap p95 ≤ 15s; 0 errors; RSS ≤ 900MB |
| `reconnect-storm` | N realtime clients repeatedly drop + reconnect while writes flow; §8.7 socket catch-up | 40 VU / 20s | reconnect p95 ≤ 1.5s; catch-up p95 ≤ 1s; 0 errors |
| `maintenance-churn` | Push/pull traffic racing repeated prune cycles; clients must keep syncing cleanly | 30 VU / 20s | round p95 ≤ 600ms; ≥1 prune run; 0 errors |
| `mixed-soak` | Readers + writers + realtime + prune interleaved, minutes-long; RSS watched | 30 VU / 120s / 20k | read/write p95; 0 errors; RSS ≤ 900MB (leak tripwire) |

### Why `bootstrap-storm` is the headline

REVISE.md names bootstrap-storm as *the* scale scenario, and the §5.3
sqlite-image reuse rule is what should shine: with M clients on **one shared
scope**, the server builds the whole-table snapshot image **once** and every
other client **reuses** it (per `partition, table, schemaVersion, scopeDigest,
pin`). The scenario advertises accept bit 2 (the image lane) and asserts,
**via the events seam**, that `segmentsReused > segmentsBuilt` — the
build-once/reuse-M proof, not a latency guess. (A tiny build count > 0 is
expected: the very first client — or a few racing at t=0 — build before the
image is stored; every client after reuses.)

## How to read a result

The one-line summary:

```
[PASS] bootstrap-storm/full · 50vu 60.0s · 50 iters · 0 err · bootstrap p95=…ms · reuse=…/… · rss=…MB
```

- `iters` — VUs that completed their loop; `err` — VUs that hit a protocol
  error (must be 0).
- `reuse=R/B` — server segments **reused / built** (the storm proof).
- `rss` — server **peak** RSS (the memory ceiling / leak tripwire).

The JSON result carries the full latency histograms (p50/p95/p99/max per
named series), scenario-specific extras (ops/sec, rows/sec, reconnect count,
prune counts, RSS trace endpoints for the soak), the server-side metrics
snapshot (request durations, segment build/reuse, prune counts, realtime
counters), and every threshold check with its measured value.

### Metrics, without a metrics stack

- **Client-side latency histograms** (`metrics.ts`): round p50/p95/p99 per
  series, kept in-process and sorted on read.
- **Server-side metrics** ride the **events seam** (`SyncularServerEvents`):
  the server process folds structured events (`request.handled`,
  `pull.served` segment origins, `push.*`, `realtime.*`, `prune.completed`)
  into counters and exposes them plus process RSS at an internal
  `GET /__load/metrics` endpoint the harness polls. No Prometheus, no infra.
- **RSS** is sampled in-process on a steady tick; the soak also traces it
  over time to distinguish a plateau (healthy) from a climb (leak).

## Layout

```
src/
  index.ts            CLI runner (bun run load … / load:smoke)
  harness.ts          spawn the server process, VU ramp, server-metrics reader
  server.ts           the spawned server process (HTTP + WS + metrics tap)
  vclient.ts          protocol-level virtual clients (HTTP + WebSocket)
  wire.ts             wire constants (core-only, no server import)
  fixture.ts          deterministic table shape + seeding (mirrors bench)
  metrics.ts          histograms + percentiles
  scenario.ts         scenario contract, threshold evaluation, summary line
  scenarios/*.ts      the five scenarios
  *.test.ts           sub-second unit tests (ramp math, histograms)
results/              JSON run artifacts (gitignored except .gitkeep)
```

## CI later?

The smoke sweep (`bun run load:smoke`) runs every scenario at a tiny profile
and is fast + stable locally (~30s wall, all green, zero protocol errors on
repeated runs). It is a plausible **nightly / pre-deploy** gate, but it is
**deliberately not wired into the default `bun run check`** now: ~30s of
process-spawning work is above the CI budget the default sweep holds to, and
scale verification belongs on a slower cadence than every push. Wire it as a
dedicated job (its own workflow, `bun run load:smoke`, non-blocking first)
when there's appetite — the exit code already gates on thresholds.

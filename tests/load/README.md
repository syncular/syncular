# Load Testing with k6

This directory contains k6 load tests for the current Syncular API (`POST /sync`, realtime `/sync/realtime`, snapshot chunk downloads).

## Prerequisites

### Install k6

macOS:
```bash
brew install k6
```

Linux:
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

Windows:
```bash
winget install k6 --source winget
```

## Quick Start

From repo root:

1. Start load-test server:
```bash
bun run test:load:server
```

2. Run a scenario:
```bash
bun run test:load:push-pull
```

## Available Commands

From repo root:

| Command | Description |
|---|---|
| `bun run test:load:server` | Start standalone load server |
| `bun run test:load:server:sqlite` | Start standalone server with SQLite dialect |
| `bun run test:load:server:sqlite:large` | Start SQLite server with large seed profile |
| `bun run test:load:push-pull` | HTTP push/pull throughput |
| `bun run test:load:websocket` | WebSocket wake-up delivery |
| `bun run test:load:bootstrap` | Bootstrap + snapshot chunk flow |
| `bun run test:load:bootstrap-storm` | Concurrent first-sync bootstrap storm |
| `bun run test:load:reconnect-storm` | Reconnect storm with repeated WS reconnect + catchup |
| `bun run test:load:reconnect-soak` | Long reconnect soak (`K6_SOAK=true`) |
| `bun run test:load:maintenance-churn` | Mixed traffic while prune/compact execute repeatedly |
| `bun run test:load:mixed` | Readers/writers/realtime mixed workload |
| `bun run test:load:mixed-soak` | Long mixed workload soak (`K6_SOAK=true`) |
| `bun run test:load:nightly` | Start load server + run macro scenario suite with JSON artifacts |
| `bun run test:load:dashboard` | Mixed workload with dashboard output |

Directly from `tests/load`:

| Command | Description |
|---|---|
| `bun run server` | Start standalone load server |
| `bun run k6:push-pull` | HTTP push/pull throughput |
| `bun run k6:websocket` | WebSocket wake-up delivery |
| `bun run k6:bootstrap` | Bootstrap + snapshot chunk flow |
| `bun run k6:bootstrap-storm` | Concurrent first-sync bootstrap storm |
| `bun run k6:reconnect-storm` | Reconnect storm with repeated WS reconnect + catchup |
| `bun run k6:reconnect-soak` | Long reconnect soak profile |
| `bun run k6:maintenance-churn` | Mixed traffic while prune/compact execute repeatedly |
| `bun run k6:mixed` | Mixed workload |
| `bun run k6:mixed-soak` | Long mixed workload soak profile |
| `bun run nightly` | Macro suite runner (server + scenarios + summary JSON) |
| `bun run k6:dashboard` | Mixed workload + dashboard |

## Scenarios

### Push/Pull (`scripts/push-pull.js`)

- Uses combined `POST /api/sync` for push and pull
- Maintains per-VU pull cursor/bootstrap state
- Tracks pending pushed rows until they are observed in pull responses
- Measures push-to-visibility lag (`sync_lag_ms`)
- Thresholds:
  - `push_latency` p95 < 500ms
  - `pull_latency` p95 < 200ms
  - `sync_lag_ms` p95 < `SYNC_LAG_SLO_MS` (default 5000ms)
  - push/pull error rates < 1%
  - sync convergence errors < 1%

### WebSocket (`scripts/websocket.js`)

- Primes scopes using pull for each websocket `clientId`
- Connects to `/api/sync/realtime?userId=...&clientId=...`
- Uses separate writer `clientId` to trigger wake-ups
- Measures sync wake-up latency from server message timestamps
- Pulls after wake-ups to verify pushed rows are visible to the listener
- Measures push-to-visibility lag for websocket listeners (`ws_data_sync_lag_ms`)

### Bootstrap (`scripts/bootstrap.js`)

- Iterative pull with cursor + bootstrap state continuation
- Downloads referenced snapshot chunks (`/api/sync/snapshot-chunks/:chunkId`)
- Uses `/api/stats/user/:userId` when available for expected-row throughput
- `BOOTSTRAP_MIN_ROWS_PER_SECOND` controls throughput threshold (default `50`)

### Mixed (`scripts/mixed-workload.js`)

- 80% readers, 20% writers
- Separate websocket listener scenario for realtime wake-ups
- Tracks reader/writer latency + websocket connection/message/error metrics
- Writer flow tracks whether pushed rows are later visible in pull responses
- Measures writer push-to-visibility lag (`writer_sync_lag_ms`)
- Supports a soak profile with `K6_SOAK=true`
- Soak tuning vars: `MIXED_SOAK_DURATION`, `MIXED_SOAK_READERS`, `MIXED_SOAK_WRITERS`, `MIXED_SOAK_WEBSOCKETS`

### Reconnect Storm (`scripts/reconnect-storm.js`)

- Repeated websocket connect/disconnect cycles under concurrent writes
- Pull catch-up after each reconnect while preserving per-VU cursor state
- Tracks reconnect latency, reconnect pull latency, and push-to-visibility lag
- Supports a soak profile with `K6_SOAK=true`
- Soak tuning vars: `RECONNECT_STORM_SOAK_VUS`, `RECONNECT_STORM_SOAK_DURATION`

### Bootstrap Storm (`scripts/bootstrap-storm.js`)

- Many concurrent first-time clients bootstrap from cursor `-1`
- Repeated pull paging until `bootstrapState` completes
- Tracks per-client bootstrap duration, pull latency, and rows/pages processed

### Maintenance Churn (`scripts/maintenance-churn.js`)

- Concurrent reader and writer traffic while maintenance endpoints run in-loop
- Calls `/api/maintenance/compact` and `/api/maintenance/prune`
- Tracks maintenance operation latency and failure rates alongside sync traffic

## Server Configuration

The load server supports:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |
| `LOAD_DB_DIALECT` | `sqlite` | `sqlite` (DO-like) or `pglite` |
| `SQLITE_PATH` | `:memory:` | SQLite file path for `LOAD_DB_DIALECT=sqlite` |
| `SEED_ROWS` | `10000` | Total seeded rows |
| `SEED_USERS` | `100` | Number of generated users per prefix |
| `SEED_RANDOM_SEED` | _(unset)_ | Deterministic seed for row randomness |
| `MAINTENANCE_PRUNE_ACTIVE_WINDOW_MS` | `1209600000` | Prune active client window in ms |
| `MAINTENANCE_PRUNE_FALLBACK_MAX_AGE_MS` | `2592000000` | Prune fallback age cap in ms |
| `MAINTENANCE_PRUNE_KEEP_NEWEST_COMMITS` | `1000` | Minimum newest commits to retain |
| `MAINTENANCE_COMPACT_FULL_HISTORY_HOURS` | `168` | Full-history retention before compaction |

Example:

```bash
LOAD_DB_DIALECT=sqlite SEED_ROWS=1000000 SEED_USERS=1200 SEED_RANDOM_SEED=42 bun run test:load:server
```

Recommended for higher-pressure runs:
- Set `SEED_USERS` at or above max expected VUs per scenario so each VU has seeded data.
- Increase `SEED_ROWS` until per-user bootstrap spans multiple pages/chunks.

## Custom k6 Runs

```bash
# Override target URL
k6 run -e BASE_URL=http://localhost:8080 tests/load/scripts/push-pull.js

# Short smoke run
k6 run --stage 10s:10 --stage 5s:0 tests/load/scripts/websocket.js

# Script-defined smoke mode (short built-in scenarios)
k6 run -e K6_SMOKE=true tests/load/scripts/mixed-workload.js

# Bootstrap with stricter throughput target
k6 run -e BOOTSTRAP_MIN_ROWS_PER_SECOND=200 tests/load/scripts/bootstrap.js

# Save raw output
k6 run --out json=tests/load/results/push-pull.json tests/load/scripts/push-pull.js
```

## Notes

- Macro load suites are wired into nightly CI (`load-macro-nightly`) and still runnable on-demand locally.
- Weekly soak lane is wired in `.github/workflows/weekly-soak.yml`.
- Integration load coverage (`tests/integration/__tests__/load.test.ts`) is separate from k6 stress tests.

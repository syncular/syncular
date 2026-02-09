# Load Testing with k6

This directory contains k6-based load tests for stress-testing the @syncular sync system with many concurrent clients and large data volumes.

## Prerequisites

### Install k6

**macOS:**
```bash
brew install k6
```

**Linux:**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**Windows:**
```bash
winget install k6 --source winget
```

**Docker:**
```bash
docker pull grafana/k6
```

For more options, see: https://grafana.com/docs/k6/latest/set-up/install-k6/

## Quick Start

1. **Start the load test server** (in one terminal):
   ```bash
   cd tests
   bun run load:server
   ```

2. **Run a load test** (in another terminal):
   ```bash
   cd tests
   bun run load:push-pull
   ```

## Available Scripts

From the `tests/` directory:

| Script | Description |
|--------|-------------|
| `bun run load:server` | Start the standalone load test server |
| `bun run load:push-pull` | Run push/pull throughput test |
| `bun run load:websocket` | Run WebSocket connection test |
| `bun run load:bootstrap` | Run large data bootstrap test |
| `bun run load:mixed` | Run mixed workload (realistic) test |
| `bun run load:dashboard` | Run mixed workload with live dashboard |

## Test Scenarios

### Scenario 1: Push/Pull (`push-pull.js`)

Tests sync API throughput with concurrent push and pull operations.

- **Ramp pattern**: 100 → 500 → 1000 → 0 VUs
- **Duration**: ~3 minutes
- **Thresholds**:
  - Push latency p95 < 500ms
  - Pull latency p95 < 200ms
  - Error rate < 1%

### Scenario 2: WebSocket (`websocket.js`)

Tests realtime notification system under load.

- **Connections**: 100 → 500 → 1000
- **Duration**: ~3 minutes
- **Thresholds**:
  - Connection time p95 < 1s
  - Message latency p95 < 100ms
  - Error rate < 5%

### Scenario 3: Bootstrap (`bootstrap.js`)

Tests initial sync with large datasets.

- **Data sizes**: Small (1K), Medium (10K), Large (50K+ rows)
- **Concurrent clients**: 10 → 25 → 50
- **Thresholds**:
  - Bootstrap time p95 < 30s
  - Throughput > 1000 rows/second

### Scenario 4: Mixed Workload (`mixed-workload.js`)

Simulates real-world usage patterns.

- **Distribution**: 80% readers, 20% writers
- **WebSocket**: All clients connected
- **Total VUs**: Up to 1000
- **Duration**: 5 minutes

## Server Configuration

The load test server accepts these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |
| `SEED_ROWS` | 10000 | Exact total rows to seed across all generated users |
| `SEED_USERS` | 100 | Number of test users |
| `SEED_RANDOM_SEED` | _(unset)_ | Optional deterministic seed for generated row randomness |

Example with custom seeding:
```bash
SEED_ROWS=100000 SEED_USERS=1000 SEED_RANDOM_SEED=42 bun run load:server
```

## Running with Custom Options

Override k6 defaults with command-line flags:

```bash
# Run with specific VU count and duration
k6 run --vus 200 --duration 2m load/scripts/push-pull.js

# Run with custom server URL
k6 run -e BASE_URL=http://localhost:8080 load/scripts/push-pull.js

# Run with live dashboard (opens browser)
k6 run --out dashboard load/scripts/mixed-workload.js

# Save results to JSON
k6 run --out json=results/output.json load/scripts/push-pull.js
```

## Viewing Results

### Live Dashboard

Run any test with `--out dashboard` to open a live metrics dashboard:
```bash
k6 run --out dashboard load/scripts/mixed-workload.js
```
This opens http://localhost:5665 with real-time graphs.

### JSON Output

Save detailed results for later analysis:
```bash
k6 run --out json=load/results/run-$(date +%Y%m%d-%H%M%S).json load/scripts/push-pull.js
```

### Cloud Dashboard (Grafana Cloud k6)

For hosted dashboards and historical comparison:
```bash
k6 cloud load/scripts/mixed-workload.js
```
Requires a Grafana Cloud k6 account.

## Custom Metrics

The tests track these custom metrics:

| Metric | Description |
|--------|-------------|
| `push_latency` | Time to complete push operations |
| `pull_latency` | Time to complete pull operations |
| `push_errors` | Push operation failure rate |
| `pull_errors` | Pull operation failure rate |
| `ws_connect_time` | WebSocket connection establishment time |
| `ws_message_latency` | Time from send to receive for WS messages |
| `bootstrap_latency` | Full bootstrap completion time |
| `bootstrap_rows_per_second` | Bootstrap throughput |

## File Structure

```
tests/load/
├── README.md              # This file
├── server.ts              # Standalone load test server
├── lib/
│   ├── sync-client.js     # k6 sync API helpers
│   └── data-generator.js  # Test data factories
├── scripts/
│   ├── push-pull.js       # Scenario 1: HTTP throughput
│   ├── websocket.js       # Scenario 2: WebSocket load
│   ├── bootstrap.js       # Scenario 3: Large data sync
│   └── mixed-workload.js  # Scenario 4: Realistic mix
└── results/               # Output directory (gitignored)
```

## Troubleshooting

### "Server not available" error

Make sure the load test server is running:
```bash
bun run load:server
```

### WebSocket connections failing

Check that WebSocket support is enabled in the server and that you're using the correct port.

### High error rates

- Reduce VU count to find sustainable load level
- Check server logs for errors
- Ensure database can handle the connection count

### k6 not found

Install k6 following the instructions in Prerequisites above.

## CI Integration

The load tests are designed to run on-demand, not as part of the regular CI pipeline. See `.github/workflows/load-test.yml` for the GitHub Actions workflow that can be triggered manually.

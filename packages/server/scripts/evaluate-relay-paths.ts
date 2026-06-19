import {
  assertRelayAppPathEvaluation,
  evaluateRelayAppPaths,
} from '../src/relay/evaluation/relay-paths';

const iterations = positiveIntegerFromEnv(
  process.env.SYNCULAR_RELAY_PATH_ITERATIONS
);
const warmupIterations = positiveIntegerFromEnv(
  process.env.SYNCULAR_RELAY_PATH_WARMUP_ITERATIONS
);
const realtimeConnections = positiveIntegerFromEnv(
  process.env.SYNCULAR_RELAY_REALTIME_CONNECTIONS
);

const result = await evaluateRelayAppPaths({
  iterations,
  warmupIterations,
  realtimeConnections,
});

assertRelayAppPathEvaluation(result);
console.log(JSON.stringify(result, null, 2));

function positiveIntegerFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer env value, received ${value}`);
  }
  return parsed;
}

import {
  assertRelayRustBoundaryEvaluation,
  evaluateRelayRustBoundary,
} from '../src/evaluation/rust-boundary';

const iterations = positiveIntegerFromEnv(
  process.env.SYNCULAR_RELAY_RUST_BOUNDARY_ITERATIONS
);
const warmupIterations = positiveIntegerFromEnv(
  process.env.SYNCULAR_RELAY_RUST_BOUNDARY_WARMUP_ITERATIONS
);

const result = evaluateRelayRustBoundary({
  iterations,
  warmupIterations,
});

assertRelayRustBoundaryEvaluation(result);
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

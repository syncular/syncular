/**
 * The Rust pairing: the SAME catalog on (Rust client × TS server), with
 * the ssp2 codec driving the golden-vector stage — the "two cores, one
 * written protocol" proof (REVISE stage 2).
 *
 * Hermetic by default: this file is inert unless SYNCULAR_RUST_CONFORMANCE=1
 * (which builds the shim via cargo if needed) or the shim binary already
 * exists (`rust/target/{debug,release}/conformance-shim`, or
 * SYNCULAR_RUST_CLIENT_BIN). TS-only environments stay green without a
 * Rust toolchain.
 */
import { describe, expect, test } from 'bun:test';
import { CATALOG, type Pairing, runScenario, tsServerDriver } from '../src';
import {
  ensureRustShim,
  rustClientDriver,
  rustCodecDriver,
  rustShimBinaryPath,
} from '../src/drivers/rust-client';

const requested = process.env.SYNCULAR_RUST_CONFORMANCE === '1';
const available = rustShimBinaryPath() !== undefined;

if (!requested && !available) {
  describe('conformance: rust-client × ts-server', () => {
    test.skip('skipped — set SYNCULAR_RUST_CONFORMANCE=1 (or prebuild rust conformance-shim)', () => {});
  });
} else {
  // One-time build when explicitly requested and not yet built.
  ensureRustShim({ build: requested });

  const pairing: Pairing = {
    server: tsServerDriver,
    client: rustClientDriver,
    codec: rustCodecDriver,
  };

  describe('conformance: rust-client × ts-server', () => {
    for (const scenario of CATALOG) {
      const label = `${scenario.name} (${scenario.specRefs.join(' ')})`;
      test(label, async () => {
        const result = await runScenario(scenario, pairing);
        if (result.status === 'skipped') return;
        if (scenario.knownDiscrepancy !== undefined) {
          expect(result.status).toBe('expected-fail');
          return;
        }
        expect(result.error ?? 'none').toBe('none');
        expect(result.status).toBe('pass');
      });
    }
  });
}

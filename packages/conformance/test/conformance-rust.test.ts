/**
 * The Rust pairing: the SAME catalog on (Rust client × TS server), with
 * the ssp2 codec driving the golden-vector stage — the "two cores, one
 * written protocol" proof. The §12 local-authority scenarios (Appendix B.24)
 * also run with both client cores against the Rust authority, and the whole
 * catalog runs with both client cores against the Rust authority acting as
 * the server: every scenario inside the §12.2 profile runs, and the runner
 * skips the ones that require a capability outside it.
 *
 * Hermetic by default: this file is inert unless SYNCULAR_RUST_CONFORMANCE=1
 * (which builds the shim via cargo if needed) or the shim binary already
 * exists (`rust/target/{debug,release}/conformance-shim`, or
 * SYNCULAR_RUST_CLIENT_BIN). TS-only environments stay green without a
 * Rust toolchain.
 */
import { describe, expect, test } from 'bun:test';
import {
  CATALOG,
  type Pairing,
  runScenario,
  type Scenario,
  tsClientDriver,
  tsServerDriver,
} from '../src';
import {
  ensureRustShim,
  rustAuthorityDriver,
  rustAuthorityServerDriver,
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

  const lanes: readonly {
    readonly name: string;
    readonly pairing: Pairing;
    readonly scenarios: readonly Scenario[];
  }[] = [
    { name: 'rust-client × ts-server', pairing, scenarios: CATALOG },
    ...[rustClientDriver, tsClientDriver].map((client) => ({
      name: `${client.name} × rust-authority`,
      pairing: { ...pairing, server: rustAuthorityServerDriver, client },
      scenarios: CATALOG.filter((scenario) =>
        scenario.requires?.includes('local-authority'),
      ),
    })),
    ...[rustClientDriver, tsClientDriver].map((client) => ({
      name: `${client.name} × rust-authority-server`,
      pairing: { ...pairing, server: rustAuthorityDriver, client },
      scenarios: CATALOG,
    })),
  ];

  for (const lane of lanes) {
    describe(`conformance: ${lane.name}`, () => {
      for (const scenario of lane.scenarios) {
        const label = `${scenario.name} (${scenario.specRefs.join(' ')})`;
        test(label, async () => {
          const result = await runScenario(scenario, lane.pairing);
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
}

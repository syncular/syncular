/**
 * @syncular-v2/testing — the app-developer test kit (TODO §2).
 *
 * A small, documented surface over the shipped Syncular core: an in-memory
 * server, N real clients on bun:sqlite through an in-process loopback (no
 * HTTP), a shared virtual clock, per-client offline/online, and the
 * conformance harness's transport-fault vocabulary. Designed for APP tests
 * (readable, minimal) — not conformance (no driver/pairing machinery).
 *
 * The React helper lives behind `@syncular-v2/testing/react` so the core
 * pulls in no React. See README.md for paste-ready examples.
 */

export type {
  TestClient,
  TestClientOptions,
} from './client';
export {
  createVirtualClock,
  DEFAULT_EPOCH_MS,
  type VirtualClock,
} from './clock';
export {
  type CreateTestSyncOptions,
  createTestSync,
  type TestClientOverrides,
  type TestSync,
} from './create-test-sync';
// The transport-fault controller, re-exported from the conformance harness
// (never duplicated) — the SAME vocabulary the reference pairing arms.
export {
  seededRandom,
  seedFromName,
  TransportFault,
  TransportFaults,
} from './faults';
export {
  allowAllScopes,
  createTestServer,
  DEFAULT_ACTOR,
  DEFAULT_PARTITION,
  type TestServer,
  type TestServerOptions,
} from './server';

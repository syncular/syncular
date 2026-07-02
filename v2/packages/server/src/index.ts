/**
 * @syncular-v2/server — framework-free embeddable SSP2 protocol library
 * (SPEC.md is normative; REVISE.md B2 is the architectural mandate).
 *
 * Core surface: `handleSyncRequest(bytes, ctx) → bytes` over host-provided
 * storage / scope-resolution / segment-store interfaces, plus a
 * transport-agnostic realtime session (§8), the direct segment download
 * handler (§5.5), and signed-URL token issuance/verification (§5.4).
 */
export * from './context';
export * from './errors';
export * from './frame-bytes';
export * from './handler';
export * from './prune';
export * from './pull';
export * from './push';
export * from './realtime';
export * from './schema';
export * from './scopes';
export * from './segment-download';
export * from './segment-store';
export * from './signed-url';
export * from './sqlite-storage';
export * from './storage';

/**
 * @syncular-v2/web-client — the B3 TypeScript client protocol core
 * (SPEC.md is normative; REVISE.md B3 is the architectural mandate).
 *
 * Browser-safe root: database backends live behind subpath exports
 * (`./bun` for bun:sqlite tests, `./wasm` for sqlite-wasm + OPFS).
 */
export * from './apply';
export * from './client';
export * from './content-type';
export * from './database';
export * from './errors';
export * from './http';
export * from './leader-lock';
export * from './outbox';
export * from './schema';
export * from './state';
export * from './transport';

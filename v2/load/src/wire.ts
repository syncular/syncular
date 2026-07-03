/**
 * Wire constants the virtual client needs, kept separate from `fixture.ts`
 * so the client module depends only on `@syncular-v2/core` (not the server
 * package). SSP2_CONTENT_TYPE is duplicated from the server context (§1.1) —
 * a one-line protocol constant, not worth a server import for a load client.
 */
export { COLUMNS, SCHEMA, TABLE } from './fixture';

/** SSP2 body content type (§1.1) — matches the server's SSP2_CONTENT_TYPE. */
export const SSP2_CONTENT_TYPE = 'application/vnd.syncular.sync.v2';

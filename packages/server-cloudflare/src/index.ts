/**
 * @syncular/server-cloudflare - Cloudflare adapters for Syncular
 *
 * Two deployment modes:
 * - Worker (polling only): `@syncular/server-cloudflare/worker`
 * - Durable Object (WebSocket + polling): `@syncular/server-cloudflare/durable-object`
 *
 * Blob storage:
 * - R2 native: `@syncular/server-cloudflare/r2`
 *
 * Dialect is user-provided:
 * - D1 + SQLite: `@syncular/dialect-d1` + `@syncular/server-dialect-sqlite`
 * - Neon + Postgres: `@syncular/dialect-neon` + `@syncular/server-dialect-postgres`
 */

export * from './durable-object';
export * from './r2';
export * from './worker';

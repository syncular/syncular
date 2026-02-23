/**
 * Capture native fetch before happy-dom replaces it.
 *
 * When running from root `bun test`, the happy-dom preload replaces
 * globalThis.fetch with a CORS-enforcing polyfill. This module saves
 * a reference so integration tests can pass it to openapi-fetch.
 */

// @ts-expect-error -- attaching to globalThis for cross-module access
globalThis.__nativeFetch = globalThis.fetch;

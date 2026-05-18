/**
 * Capture native fetch before happy-dom replaces it.
 *
 * When running from root `bun test`, the happy-dom preload replaces
 * globalThis.fetch with a CORS-enforcing polyfill. This module saves
 * a reference so integration tests can pass it to openapi-fetch.
 */

const nativeGlobals = globalThis as Record<string, unknown>;

nativeGlobals.__nativeFetch = globalThis.fetch;
nativeGlobals.__nativeHeaders = globalThis.Headers;
nativeGlobals.__nativeRequest = globalThis.Request;
nativeGlobals.__nativeResponse = globalThis.Response;

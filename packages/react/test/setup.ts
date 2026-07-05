/**
 * Test lifecycle helper: give a test file a happy-dom global environment so
 * `@testing-library/react` can render into a real DOM under bun's test runner.
 * This is the ONLY reason happy-dom is a devDep (justified: hook semantics —
 * mount/effect/re-render — need a renderer, and RTL is the standard,
 * low-ceremony harness for that).
 *
 * CRITICAL — shared-process isolation. `bun run test` runs the whole monorepo
 * in ONE process. `GlobalRegistrator.register()` swaps process-global
 * `Headers`/`Response`/`fetch`/`window`, so if it is left registered it leaks
 * into unrelated packages — notably `@syncular-v2/web-client`'s `http.test.ts`,
 * whose `new Headers(...)` iteration silently drops entries under happy-dom's
 * Headers, and its `worker-rpc.test.ts`. bun runs test files SEQUENTIALLY
 * (a file's `beforeAll` → tests → `afterAll` complete before the next file
 * starts), so the fix is to scope the DOM to exactly the file that needs it:
 * register in that file's `beforeAll`, restore native globals in its
 * `afterAll`. Every DOM-needing file must call `installHappyDom()` at top level.
 *
 * Why a FUNCTION and not top-level hooks: this module is import-cached, so
 * top-level `beforeAll`/`afterAll` would fire for the first importing file
 * only and every later file would run with the wrong globals. Calling
 * `installHappyDom()` from each file registers a fresh, file-scoped hook pair.
 */
import { afterAll, beforeAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * Register happy-dom for the calling test file and tear it down afterwards.
 * Call once at the top level of any test file that mounts React components.
 */
export function installHappyDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register();
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
}

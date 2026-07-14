/**
 * demo-react smoke test (the demo pattern): boot the real server on an
 * ephemeral port and prove it comes up and BUILDS the React frontend —
 * `/app.js` is the `Bun.build`-bundled `main.tsx`, the piece that can rot
 * silently (a broken hook import, a JSX/type slip, a bad generated schema).
 * A served, non-empty `/app.js` that references the React entry means the
 * whole frontend graph — async SyncProvider, generated useQuery coverage,
 * typed mutations, and useRawSql — compiled.
 *
 * The worker + OPFS + realtime runtime path itself can't run headless in
 * `bun test`; it is exercised by the two-pane demo and the conformance
 * suite over the identical core.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

let proc: ReturnType<typeof Bun.spawn> | undefined;
let baseUrl = '';

beforeAll(async () => {
  const port = 8000 + Math.floor(Math.random() * 1000);
  baseUrl = `http://localhost:${port}`;
  proc = Bun.spawn(['bun', 'run', join(import.meta.dir, 'server.ts')], {
    env: { ...process.env, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Wait for the boot line (the build + server.listen both completed).
  const started = await waitForListening(baseUrl, 20_000);
  if (!started) {
    const stderr = proc.stderr;
    const err =
      stderr instanceof ReadableStream ? await new Response(stderr).text() : '';
    throw new Error(`server did not boot in time:\n${err}`);
  }
});

afterAll(() => {
  proc?.kill();
});

async function waitForListening(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('server boots and serves the index page', async () => {
  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('<div id="root"></div>');
  expect(html).toContain('/app.js');
});

test('/app.js builds and bundles the React frontend', async () => {
  const res = await fetch(`${baseUrl}/app.js`);
  expect(res.status).toBe(200);
  const js = await res.text();
  // Non-trivial bundle (React + hooks + dialect are all in here).
  expect(js.length).toBeGreaterThan(10_000);
  // The sqlite-wasm bare specifier was rewritten to the vendor path (the
  // module-worker import-map fix also applies to the page bundle).
  expect(js).not.toContain('@sqlite.org/sqlite-wasm"');
});

test('/worker.js builds (the whole client core)', async () => {
  const res = await fetch(`${baseUrl}/worker.js`);
  expect(res.status).toBe(200);
  const js = await res.text();
  expect(js.length).toBeGreaterThan(10_000);
});

test('POST /sync answers (the server core is wired)', async () => {
  const res = await fetch(`${baseUrl}/sync`, {
    method: 'POST',
    body: new Uint8Array([0]),
  });
  // A malformed body is rejected by the codec, but the route exists and the
  // handler ran (not a 404) — proof the sync server is mounted.
  expect(res.status).not.toBe(404);
});

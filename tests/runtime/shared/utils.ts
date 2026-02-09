/**
 * Runtime test utilities — port allocation, health checks, process management.
 */

import net from 'node:net';

/**
 * Get the native fetch function (saved before happy-dom replaces it).
 * Falls back to globalThis.fetch if the preload hasn't run.
 */
export function getNativeFetch(): typeof globalThis.fetch {
  const native = (globalThis as Record<string, unknown>).__nativeFetch as
    | typeof globalThis.fetch
    | undefined;
  return native ?? globalThis.fetch;
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('failed to pick free port')));
    });
  });
}

export async function waitForHealthy(
  url: string,
  timeoutMs = 30_000
): Promise<void> {
  const _fetch = getNativeFetch();
  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${url}/health`);
    }
    try {
      const res = await _fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function shutdown(
  proc: ReturnType<typeof Bun.spawn>
): Promise<void> {
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }
  const startedAt = Date.now();
  while (true) {
    if (proc.exitCode != null) return;
    if (Date.now() - startedAt > 5000) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
}

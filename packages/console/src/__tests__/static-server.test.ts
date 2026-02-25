import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONSOLE_BASEPATH_META,
  CONSOLE_SERVER_URL_META,
  CONSOLE_TOKEN_META,
} from '../runtime-config';
import { createConsoleStaticResponder } from '../static-server';

const tempDirs: string[] = [];

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

async function createStaticFixture(): Promise<string> {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'syncular-console-'));
  tempDirs.push(staticDir);

  await mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await writeFile(
    path.join(staticDir, 'index.html'),
    `<!doctype html>
<html>
  <head>
    <meta name="${CONSOLE_BASEPATH_META}" content="/old-basepath" />
    <meta name="${CONSOLE_SERVER_URL_META}" content="https://old.example/api" />
    <meta name="${CONSOLE_TOKEN_META}" content="old-token" />
    <link rel="stylesheet" href="/assets/console.css" />
  </head>
  <body>
    <script type="module" src="/assets/main.js"></script>
  </body>
</html>`
  );
  await writeFile(
    path.join(staticDir, 'assets', 'main.js'),
    'console.log(1);\n'
  );
  await writeFile(path.join(staticDir, 'assets', 'console.css'), 'body{}\n');

  return staticDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('createConsoleStaticResponder', () => {
  it('serves index with prefilled meta tags and rewrites rooted asset paths', async () => {
    const staticDir = await createStaticFixture();
    const responder = createConsoleStaticResponder({
      mountPath: '/console',
      staticDir,
      defaultPrefill: {
        serverUrl: 'https://api.example.com',
        token: 'default-token',
      },
    });

    const response = await responder(new Request('http://localhost/console'));
    if (!response) {
      throw new Error('Expected console index response.');
    }

    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain(
      `<meta name="${CONSOLE_BASEPATH_META}" content="/console" />`
    );
    expect(html).toContain(
      `<meta name="${CONSOLE_SERVER_URL_META}" content="https://api.example.com" />`
    );
    expect(html).toContain(
      `<meta name="${CONSOLE_TOKEN_META}" content="default-token" />`
    );
    expect(html).toContain('href="/console/assets/console.css"');
    expect(html).toContain('src="/console/assets/main.js"');

    expect(
      countMatches(html, new RegExp(`name="${CONSOLE_BASEPATH_META}"`, 'g'))
    ).toBe(1);
    expect(
      countMatches(html, new RegExp(`name="${CONSOLE_SERVER_URL_META}"`, 'g'))
    ).toBe(1);
    expect(
      countMatches(html, new RegExp(`name="${CONSOLE_TOKEN_META}"`, 'g'))
    ).toBe(1);
  });

  it('applies request-level prefill overrides when serving index', async () => {
    const staticDir = await createStaticFixture();
    const responder = createConsoleStaticResponder({
      mountPath: '/console',
      staticDir,
      defaultPrefill: {
        basePath: '/console',
        serverUrl: 'https://default.example/api',
        token: 'default-token',
      },
    });

    const response = await responder(
      new Request('http://localhost/console/app'),
      {
        prefill: {
          basePath: '/ops',
          serverUrl: 'https://ops.example/api',
          token: 'request-token',
        },
      }
    );
    if (!response) {
      throw new Error('Expected console index response.');
    }

    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(
      `<meta name="${CONSOLE_BASEPATH_META}" content="/ops" />`
    );
    expect(html).toContain(
      `<meta name="${CONSOLE_SERVER_URL_META}" content="https://ops.example/api" />`
    );
    expect(html).toContain(
      `<meta name="${CONSOLE_TOKEN_META}" content="request-token" />`
    );
    expect(html).toContain('href="/ops/assets/console.css"');
    expect(html).toContain('src="/ops/assets/main.js"');
  });

  it('serves static assets, blocks traversal, and handles missing assets', async () => {
    const staticDir = await createStaticFixture();
    const responder = createConsoleStaticResponder({
      mountPath: '/console',
      staticDir,
    });

    const assetResponse = await responder(
      new Request('http://localhost/console/assets/main.js')
    );
    if (!assetResponse) {
      throw new Error('Expected static asset response.');
    }
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8'
    );
    expect(assetResponse.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable'
    );
    expect(await assetResponse.text()).toContain('console.log(1);');

    const forbidden = await responder(
      new Request('http://localhost/console/%2e%2e%2fsecret.js')
    );
    if (!forbidden) {
      throw new Error('Expected forbidden response.');
    }
    expect(forbidden.status).toBe(403);

    const missing = await responder(
      new Request('http://localhost/console/assets/missing.js')
    );
    if (!missing) {
      throw new Error('Expected missing response.');
    }
    expect(missing.status).toBe(404);
  });

  it('returns null for unsupported methods and non-matching mount paths', async () => {
    const staticDir = await createStaticFixture();
    const responder = createConsoleStaticResponder({
      mountPath: '/console',
      staticDir,
    });

    const postResponse = await responder(
      new Request('http://localhost/console', { method: 'POST' })
    );
    const otherPathResponse = await responder(
      new Request('http://localhost/admin')
    );

    expect(postResponse).toBeNull();
    expect(otherPathResponse).toBeNull();
  });
});

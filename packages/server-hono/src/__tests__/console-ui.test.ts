import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONSOLE_BASEPATH_META,
  CONSOLE_SERVER_URL_META,
  CONSOLE_TOKEN_META,
} from '@syncular/console/runtime-config';
import { Hono } from 'hono';
import { mountConsoleUi } from '../console/ui';

const tempDirs: string[] = [];

async function createStaticFixture(): Promise<string> {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'syncular-console-ui-'));
  tempDirs.push(staticDir);

  await mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await writeFile(
    path.join(staticDir, 'index.html'),
    `<!doctype html>
<html>
  <head>
    <meta name="${CONSOLE_BASEPATH_META}" content="" />
    <meta name="${CONSOLE_SERVER_URL_META}" content="" />
    <meta name="${CONSOLE_TOKEN_META}" content="" />
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

describe('mountConsoleUi', () => {
  it('serves console UI with default prefill derived from mount/api paths', async () => {
    const staticDir = await createStaticFixture();
    const app = new Hono();

    mountConsoleUi(app, {
      mountPath: 'console',
      apiBasePath: 'api',
      staticDir,
    });

    const response = await app.request('http://example.test/console');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(
      `<meta name="${CONSOLE_BASEPATH_META}" content="/console" />`
    );
    expect(html).toContain(
      `<meta name="${CONSOLE_SERVER_URL_META}" content="http://example.test/api" />`
    );
    expect(html).toContain(`<meta name="${CONSOLE_TOKEN_META}" content="" />`);
    expect(html).toContain('href="/console/assets/console.css"');
    expect(html).toContain('src="/console/assets/main.js"');

    const asset = await app.request(
      'http://example.test/console/assets/main.js'
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('console.log(1);');
  });

  it('merges resolvePrefill and allows resolveToken to override token', async () => {
    const staticDir = await createStaticFixture();
    const app = new Hono();

    mountConsoleUi(app, {
      mountPath: '/ops-console',
      apiBasePath: '/api/internal',
      staticDir,
      resolvePrefill: async () => ({
        basePath: '/prefilled',
        serverUrl: 'https://prefill.example/api',
        token: 'prefill-token',
      }),
      resolveToken: async () => 'resolver-token',
    });

    const response = await app.request('http://localhost/ops-console');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(
      `<meta name="${CONSOLE_BASEPATH_META}" content="/prefilled" />`
    );
    expect(html).toContain(
      `<meta name="${CONSOLE_SERVER_URL_META}" content="https://prefill.example/api" />`
    );
    expect(html).toContain(
      `<meta name="${CONSOLE_TOKEN_META}" content="resolver-token" />`
    );
    expect(html).toContain('href="/prefilled/assets/console.css"');
    expect(html).toContain('src="/prefilled/assets/main.js"');
  });
});

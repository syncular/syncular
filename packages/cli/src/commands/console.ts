import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import process from 'node:process';
import {
  CONSOLE_BASEPATH_META,
  CONSOLE_SERVER_URL_META,
  CONSOLE_TOKEN_META,
  normalizeBasePath,
} from '@syncular/console/runtime-config';
import type { ParsedArgs } from '../types';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.manifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function parsePort(value: string | undefined): number | null {
  if (!value) return DEFAULT_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

function normalizeToken(args: ParsedArgs): string | undefined {
  const directToken = args.flagValues.get('--token')?.trim();
  if (directToken) return directToken;

  const tokenEnvName = args.flagValues.get('--token-env')?.trim();
  if (!tokenEnvName) return undefined;

  const token = process.env[tokenEnvName]?.trim();
  if (!token) {
    throw new Error(
      `Environment variable ${tokenEnvName} is empty or undefined`
    );
  }

  return token;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function withMetaTag(html: string, name: string, value: string): string {
  const escapedValue = escapeHtmlAttribute(value);
  const pattern = new RegExp(`<meta name="${name}" content="[^"]*"\\s*/?>`);
  if (pattern.test(html)) {
    return html.replace(
      pattern,
      `<meta name="${name}" content="${escapedValue}" />`
    );
  }

  return html.replace(
    '</head>',
    `  <meta name="${name}" content="${escapedValue}" />\n  </head>`
  );
}

function isWithinDirectory(baseDir: string, targetPath: string): boolean {
  return targetPath === baseDir || targetPath.startsWith(`${baseDir}${sep}`);
}

function contentTypeFor(pathname: string): string {
  const ext = extname(pathname).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function normalizeHost(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_HOST;
}

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function browserHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host;
}

function resolveStaticDir(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@syncular/console/static/index.html');
  return dirname(entry);
}

async function openInBrowser(url: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let command = '';
    let commandArgs: string[] = [];

    if (process.platform === 'darwin') {
      command = 'open';
      commandArgs = [url];
    } else if (process.platform === 'win32') {
      command = 'cmd';
      commandArgs = ['/c', 'start', '', url];
    } else {
      command = 'xdg-open';
      commandArgs = [url];
    }

    const child = spawn(command, commandArgs, {
      stdio: 'ignore',
      detached: true,
    });

    child.once('error', rejectPromise);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}

export async function runConsole(args: ParsedArgs): Promise<number> {
  if (args.subcommand !== null) {
    console.error(`Unknown console subcommand: ${args.subcommand}`);
    console.error('Use: syncular console');
    return 1;
  }

  const host = normalizeHost(args.flagValues.get('--host'));
  const port = parsePort(args.flagValues.get('--port'));
  if (port === null) {
    console.error('Invalid --port value. Use an integer from 0 to 65535.');
    return 1;
  }

  const serverUrl = args.flagValues.get('--server-url')?.trim();
  if (serverUrl) {
    try {
      new URL(serverUrl);
    } catch {
      console.error(`Invalid --server-url: ${serverUrl}`);
      return 1;
    }
  }

  let token: string | undefined;
  try {
    token = normalizeToken(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }

  let staticDir = '';
  try {
    staticDir = resolveStaticDir();
  } catch {
    console.error('Unable to resolve @syncular/console static assets.');
    console.error(
      'If you are in the monorepo, run: bun --cwd packages/console build:web'
    );
    return 1;
  }

  const indexPath = resolve(staticDir, 'index.html');
  if (!existsSync(indexPath)) {
    console.error(`Console distributable missing: ${indexPath}`);
    console.error('Run: bun --cwd packages/console build:web');
    return 1;
  }

  const baseDir = resolve(staticDir);
  const template = readFileSync(indexPath, 'utf8');
  const renderedIndex = withMetaTag(
    withMetaTag(
      withMetaTag(template, CONSOLE_BASEPATH_META, normalizeBasePath('/')),
      CONSOLE_SERVER_URL_META,
      serverUrl ?? ''
    ),
    CONSOLE_TOKEN_META,
    token ?? ''
  );

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    const requestUrl = req.url ?? '/';
    const parsedUrl = new URL(
      requestUrl,
      `http://${req.headers.host ?? 'localhost'}`
    );
    const pathname = decodeURIComponent(parsedUrl.pathname);

    const sendIndex = () => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(method === 'HEAD' ? '' : renderedIndex);
    };

    if (pathname === '/' || pathname === '/index.html') {
      sendIndex();
      return;
    }

    const candidatePath = resolve(baseDir, `.${pathname}`);
    if (!isWithinDirectory(baseDir, candidatePath)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
      res.statusCode = 200;
      res.setHeader('Content-Type', contentTypeFor(candidatePath));
      if (method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(candidatePath).pipe(res);
      return;
    }

    if (extname(pathname).length > 0) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    sendIndex();
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start console server: ${message}`);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    console.error('Failed to resolve console server address.');
    server.close();
    return 1;
  }

  const localUrl = `http://${formatHostForUrl(host)}:${address.port}`;
  console.log(`Console running at ${localUrl}`);

  if (serverUrl) {
    console.log(`Using API server: ${serverUrl}`);
  } else {
    console.log(
      'No API server configured. Set --server-url to preconfigure connection.'
    );
  }

  if (token) {
    console.log('Using preconfigured token.');
  }

  if (args.flags.has('--open')) {
    const openUrl = `http://${browserHost(host)}:${address.port}`;
    try {
      await openInBrowser(openUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Unable to open browser automatically: ${message}`);
      console.error(`Open manually: ${openUrl}`);
    }
  }

  await new Promise<void>((resolvePromise) => {
    const shutdown = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      server.close(() => resolvePromise());
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

  return 0;
}

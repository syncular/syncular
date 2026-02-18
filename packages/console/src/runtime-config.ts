export const CONSOLE_BASEPATH_META = 'syncular-console-basepath';
export const CONSOLE_SERVER_URL_META = 'syncular-console-server-url';
export const CONSOLE_TOKEN_META = 'syncular-console-token';

interface ConsoleConnectionConfig {
  serverUrl: string;
  token: string;
}

interface MetaElementLike {
  getAttribute: (name: string) => string | null;
}

interface MetaDocumentLike {
  querySelector: (selector: string) => MetaElementLike | null;
}

function cleanValue(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readMeta(name: string): string | undefined {
  const documentLike = (globalThis as { document?: MetaDocumentLike }).document;
  if (!documentLike) return undefined;

  const value = documentLike
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute('content');

  return cleanValue(value);
}

export function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === '/') return '/';
  const withLeadingSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withLeadingSlash.replace(/\/+$/g, '') || '/';
}

export function resolveConsoleBasePathFromMeta(): string {
  return normalizeBasePath(readMeta(CONSOLE_BASEPATH_META));
}

export function resolveConsoleConnectionConfigFromMeta(): ConsoleConnectionConfig | null {
  const serverUrl = readMeta(CONSOLE_SERVER_URL_META);
  const token = readMeta(CONSOLE_TOKEN_META);
  if (!serverUrl || !token) return null;
  return { serverUrl, token };
}

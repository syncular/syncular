const ABSOLUTE_URL_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/, '');

export function normalizeSyncBaseUrl(url: string): string {
  const trimmed = trimTrailingSlashes(url.trim());
  if (!trimmed.endsWith('/sync')) return trimmed;
  const baseUrl = trimmed.slice(0, -'/sync'.length);
  return baseUrl.length > 0 ? baseUrl : '/';
}

export function resolveUrlFromBase(
  baseUrl: string,
  path: string,
  origin?: string
): string {
  const normalizedPath = path.replace(/^\/+/, '');
  const normalizedBaseUrl = trimTrailingSlashes(baseUrl);
  if (ABSOLUTE_URL_SCHEME_REGEX.test(baseUrl)) {
    return new URL(
      normalizedPath,
      baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    ).toString();
  }
  if (origin)
    return new URL(`${normalizedBaseUrl}/${normalizedPath}`, origin).toString();
  return `${normalizedBaseUrl}/${normalizedPath}`;
}

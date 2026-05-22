const READONLY_SQL_START = new Set(['select', 'with', 'pragma', 'explain']);
const TRANSACTION_SQL_START = new Set([
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
]);

export function assertSyncularReadonlySql(sql: string): void {
  if (isSyncularReadonlySql(sql)) return;
  throw new Error(
    'Syncular public SQL is read-only. Use generated Syncular mutations for synced writes.'
  );
}

export function isSyncularReadonlySql(sql: string): boolean {
  const normalized = stripLeadingSqlComments(sql).trimStart();
  if (!normalized) return true;
  if (hasMultipleSqlStatements(normalized)) return false;
  const keyword = firstSqlKeyword(normalized);
  if (!keyword) return true;
  if (TRANSACTION_SQL_START.has(keyword)) return true;
  if (!READONLY_SQL_START.has(keyword)) return false;
  if (keyword === 'pragma') return isReadonlyPragma(normalized);
  return true;
}

function stripLeadingSqlComments(sql: string): string {
  let rest = sql;
  for (;;) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith('--')) {
      const newline = trimmed.indexOf('\n');
      rest = newline < 0 ? '' : trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      rest = end < 0 ? '' : trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

function hasMultipleSqlStatements(sql: string): boolean {
  const firstSemicolon = sql.indexOf(';');
  if (firstSemicolon < 0) return false;
  return sql.slice(firstSemicolon + 1).trim().length > 0;
}

function firstSqlKeyword(sql: string): string | null {
  const match = /^[a-zA-Z_]+/.exec(sql);
  return match?.[0]?.toLowerCase() ?? null;
}

function isReadonlyPragma(sql: string): boolean {
  const withoutTrailingSemicolon = sql.trim().replace(/;+$/, '').trim();
  return !withoutTrailingSemicolon.includes('=');
}

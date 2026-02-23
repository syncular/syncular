/**
 * @syncular/server - Mutation Detector
 *
 * Detects whether a SQL query is a mutation (INSERT/UPDATE/DELETE).
 */

import type { SyncOp } from '@syncular/core';

export interface DetectedMutation {
  /** Operation type */
  operation: SyncOp;
  /** Table name being modified */
  tableName: string;
}

function isWordStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isWordPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function skipLeadingNoise(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    while (index < sql.length && /[\s;]/.test(sql[index]!)) {
      index += 1;
    }

    if (sql.startsWith('--', index)) {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) return '';
      index = end + 2;
      continue;
    }

    break;
  }

  return sql.slice(index);
}

function extractMainStatement(sql: string): string {
  const normalized = skipLeadingNoise(sql);
  if (!normalized.toLowerCase().startsWith('with')) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  const rootKeywords = new Set(['insert', 'update', 'delete', 'select']);

  let index = 0;
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < normalized.length) {
    const ch = normalized[index]!;
    const next = normalized[index + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (inSingleQuote) {
      if (ch === "'" && next === "'") {
        index += 2;
        continue;
      }
      if (ch === "'") inSingleQuote = false;
      index += 1;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      index += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      index += 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth -= 1;
      index += 1;
      continue;
    }

    if (depth === 0 && isWordStart(ch)) {
      const tokenStart = index;
      index += 1;
      while (index < normalized.length && isWordPart(normalized[index]!)) {
        index += 1;
      }
      const token = lower.slice(tokenStart, index);
      if (
        token !== 'with' &&
        token !== 'recursive' &&
        rootKeywords.has(token)
      ) {
        return normalized.slice(tokenStart);
      }
      continue;
    }

    index += 1;
  }

  return normalized;
}

function parseIdentifier(
  input: string,
  startIndex: number
): { name: string; nextIndex: number } | null {
  let index = startIndex;
  while (index < input.length && /\s/.test(input[index]!)) {
    index += 1;
  }
  if (index >= input.length) return null;

  if (input[index] === '"') {
    index += 1;
    let value = '';
    while (index < input.length) {
      const ch = input[index]!;
      if (ch === '"' && input[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }
      if (ch === '"') {
        index += 1;
        return { name: value, nextIndex: index };
      }
      value += ch;
      index += 1;
    }
    return null;
  }

  if (!isWordStart(input[index]!)) return null;
  const first = index;
  index += 1;
  while (index < input.length && isWordPart(input[index]!)) {
    index += 1;
  }
  return { name: input.slice(first, index), nextIndex: index };
}

function parseTargetTable(input: string): string | null {
  const first = parseIdentifier(input, 0);
  if (!first) return null;

  let index = first.nextIndex;
  while (index < input.length && /\s/.test(input[index]!)) {
    index += 1;
  }
  if (input[index] !== '.') {
    return first.name;
  }

  const second = parseIdentifier(input, index + 1);
  if (!second) return null;
  return second.name;
}

/**
 * Detect if a SQL query is a mutation and extract table info.
 *
 * @param sql - The SQL query string
 * @returns Mutation info if detected, null for read queries
 */
export function detectMutation(sql: string): DetectedMutation | null {
  const statement = extractMainStatement(sql).trimStart();
  const lower = statement.toLowerCase();

  if (lower.startsWith('insert')) {
    const tableName = parseTargetTable(
      statement.replace(/^insert\s+into\s+/i, '')
    );
    if (!tableName) return null;
    return { operation: 'upsert', tableName };
  }

  if (lower.startsWith('update')) {
    const tableName = parseTargetTable(statement.replace(/^update\s+/i, ''));
    if (!tableName) return null;
    return { operation: 'upsert', tableName };
  }

  if (lower.startsWith('delete')) {
    const tableName = parseTargetTable(
      statement.replace(/^delete\s+from\s+/i, '')
    );
    if (!tableName) return null;
    return { operation: 'delete', tableName };
  }

  return null;
}

/**
 * Check if SQL already has a RETURNING clause.
 */
export function hasReturningClause(sql: string): boolean {
  // Simple check - look for RETURNING keyword not in a string
  return /\bRETURNING\b/i.test(sql);
}

/**
 * Check if SQL has a wildcard RETURNING clause (RETURNING * or alias.*).
 */
export function hasReturningWildcard(sql: string): boolean {
  const match = sql.match(/\bRETURNING\b([\s\S]*)$/i);
  if (!match) return false;
  return /(^|,)\s*(?:[A-Za-z_][A-Za-z0-9_$]*\.)?\*/i.test(match[1]);
}

/**
 * Append RETURNING * to a mutation query if not already present.
 *
 * @param sql - The SQL query string
 * @returns Modified SQL with RETURNING *
 */
export function appendReturning(sql: string): string {
  if (hasReturningClause(sql)) {
    return sql;
  }

  // Remove trailing semicolon if present
  const trimmed = sql.trim().replace(/;\s*$/, '');
  return `${trimmed} RETURNING *`;
}

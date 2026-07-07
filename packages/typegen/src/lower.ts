/**
 * Projection lowering (DESIGN-queries.md §5): rewrite a query's top-level
 * SELECT list so the runtime result keys ARE the language-facing names —
 * `select created_at from todos` lowers to
 * `select created_at as createdAt from todos` under camelCase naming, so
 * drivers return camel keys with no runtime mapping loop. Author-written
 * aliases are the SQL-truth result name and convention-map like any column.
 *
 * The rewrite is text-surgical and verbatim-preserving: we locate the
 * outermost (paren-depth-0) `SELECT … FROM` span with a string/comment-aware
 * scan, split the list on top-level commas keeping each item's original
 * text, and only touch the alias tail of items whose result name changes.
 * `*` / `t.*` items are EXPANDED from the schema IR (single-table `*` only)
 * — which also pins the projection against hidden local columns. After the
 * rewrite the query is re-checked by SQLite; a projection this pass cannot
 * rewrite (and that needs rewriting) is a generate-time error pointing at
 * the manual-alias escape hatch.
 */
import { TypegenError } from './errors';
import type { IrDocument } from './ir';

/** One top-level SELECT-list item, verbatim. */
interface ProjectionItem {
  /** The item's exact source text, trimmed. */
  readonly text: string;
}

interface ProjectionSpan {
  /** Offset of the first list character (after SELECT [DISTINCT|ALL]). */
  readonly start: number;
  /** Offset just past the list (at the `FROM` keyword). */
  readonly end: number;
  readonly items: readonly ProjectionItem[];
}

const WORD_RE = /[A-Za-z_]/;

/**
 * Scan `sql` for the outermost SELECT list: the first paren-depth-0 `SELECT`
 * keyword up to the first depth-0 `FROM` after it. String literals, quoted
 * identifiers, and comments are skipped; a CTE's inner selects sit at depth
 * ≥ 1 so `WITH … SELECT a FROM x` resolves to the outer list. Returns null
 * when there is no depth-0 SELECT…FROM shape (e.g. `SELECT 1`).
 */
export function findProjection(sql: string): ProjectionSpan | null {
  let depth = 0;
  let i = 0;
  let listStart = -1;
  let seenSelect = false;
  const itemBounds: number[] = []; // top-level comma offsets within the list
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) j += 2;
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && ch === ',' && seenSelect && listStart !== -1) {
      itemBounds.push(i);
      i += 1;
      continue;
    }
    if (WORD_RE.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] as string)) j += 1;
      const word = sql.slice(i, j).toUpperCase();
      if (depth === 0 && !seenSelect && word === 'SELECT') {
        seenSelect = true;
        // Skip an immediate DISTINCT / ALL quantifier.
        let k = j;
        while (k < sql.length && /\s/.test(sql[k] as string)) k += 1;
        let m = k;
        while (m < sql.length && /[A-Za-z]/.test(sql[m] as string)) m += 1;
        const quant = sql.slice(k, m).toUpperCase();
        listStart = quant === 'DISTINCT' || quant === 'ALL' ? m : j;
        i = listStart;
        continue;
      }
      if (depth === 0 && seenSelect && listStart !== -1 && word === 'FROM') {
        const items: ProjectionItem[] = [];
        let prev = listStart;
        for (const comma of itemBounds) {
          items.push({ text: sql.slice(prev, comma).trim() });
          prev = comma + 1;
        }
        items.push({ text: sql.slice(prev, i).trim() });
        return { start: listStart, end: i, items };
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * The main verb of a `WITH …` statement (uppercased): SQLite allows a
 * with-clause before SELECT and before INSERT/UPDATE/DELETE. CTE bodies live
 * inside parentheses and a bare keyword cannot be a CTE name, so the first
 * paren-depth-0 keyword after `WITH` is the main verb.
 */
export function mainVerbAfterWith(sql: string): string | undefined {
  const MAIN_VERBS = new Set([
    'SELECT',
    'VALUES',
    'INSERT',
    'UPDATE',
    'DELETE',
    'REPLACE',
  ]);
  let depth = 0;
  let i = 0;
  let sawWith = false;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== ch) j += 1;
      i = j + 1;
    } else if (ch === '(') {
      depth += 1;
      i += 1;
    } else if (ch === ')') {
      depth -= 1;
      i += 1;
    } else if (WORD_RE.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] as string)) j += 1;
      const word = sql.slice(i, j).toUpperCase();
      if (depth === 0) {
        if (!sawWith && word === 'WITH') sawWith = true;
        else if (sawWith && MAIN_VERBS.has(word)) return word;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return undefined;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const EXPLICIT_ALIAS_RE = new RegExp(`^([\\s\\S]*?)\\s+AS\\s+(${IDENT})$`, 'i');
const TRAILING_IDENT_RE = new RegExp(`^([\\s\\S]*?)\\s+(${IDENT})$`);
const STAR_RE = new RegExp(`^(?:(${IDENT})\\.)?\\*$`);

/** A `FROM`/`JOIN` base-table reference the caller already resolved. */
export interface LowerTableRef {
  readonly table: string;
  readonly alias: string;
}

/**
 * Expand `*` / `t.*` items from the IR: `t.*` uses the alias's table; a bare
 * `*` requires exactly one referenced table (multi-table `*` is a
 * generate-time error under camel naming — write the projection out).
 */
function expandStar(
  item: ProjectionItem,
  qualifier: string | undefined,
  refs: readonly LowerTableRef[],
  ir: IrDocument,
  location: string,
): string[] {
  let tableName: string;
  if (qualifier !== undefined) {
    const ref = refs.find((r) => r.alias === qualifier);
    if (ref === undefined) {
      throw new TypegenError(
        location,
        `cannot expand ${JSON.stringify(item.text)} — unknown table alias ${JSON.stringify(qualifier)}`,
      );
    }
    tableName = ref.table;
  } else {
    if (refs.length !== 1) {
      throw new TypegenError(
        location,
        `camelCase naming cannot expand a bare \`*\` over ${refs.length} tables — list the columns explicitly (or set "naming": "preserve")`,
      );
    }
    tableName = (refs[0] as LowerTableRef).table;
  }
  const table = ir.tables.find((t) => t.name === tableName);
  if (table === undefined) {
    throw new TypegenError(
      location,
      `cannot expand ${JSON.stringify(item.text)} — ${JSON.stringify(tableName)} is not a synced table`,
    );
  }
  const prefix = qualifier !== undefined ? `${qualifier}.` : '';
  return table.columns.map((c) => `${prefix}${c.name}`);
}

export interface LoweredProjection {
  /** The rewritten SQL (identical to the input when nothing needed
   * aliasing). */
  readonly sql: string;
  /** Whether any item was rewritten or expanded. */
  readonly changed: boolean;
  /** Pre-rewrite result names — the SQL-truth names the IR records. */
  readonly sqlNames: readonly string[];
  /** Post-rewrite result names — index-aligned with `sqlNames`. */
  readonly langNames: readonly string[];
}

/**
 * Rewrite the top-level projection of `sql` so every result column's runtime
 * key equals its language-facing name. `analyze` prepares a candidate SQL
 * and returns its result column names; `buildMap` maps the star-expanded
 * projection's SQL-truth result names to language names (owning the §12
 * collision/keyword checks). Re-checking the returned SQL is the caller's
 * job.
 */
export function lowerProjection(
  sql: string,
  refs: readonly LowerTableRef[],
  ir: IrDocument,
  location: string,
  analyze: (sql: string) => readonly string[],
  buildMap: (sqlNames: readonly string[]) => readonly string[],
): LoweredProjection {
  const span = findProjection(sql);
  if (span === null) {
    // No rewritable SELECT list (`SELECT 1`-shaped). If nothing needs
    // renaming the query passes through; the caller's no-tables check
    // rejects the degenerate shapes first.
    const names = analyze(sql);
    const langNames = buildMap(names);
    if (langNames.every((langName, i) => langName === names[i])) {
      return { sql, changed: false, sqlNames: names, langNames };
    }
    throw new TypegenError(
      location,
      'camelCase naming could not locate this query\'s SELECT list to alias it — alias the snake_case result columns explicitly (e.g. `created_at AS createdAt`) or set "naming": "preserve"',
    );
  }

  // Star expansion first, so items align 1:1 with SQLite's result columns.
  let expanded = false;
  const flatItems: string[] = [];
  for (const item of span.items) {
    const star = STAR_RE.exec(item.text);
    if (star !== null) {
      flatItems.push(...expandStar(item, star[1], refs, ir, location));
      expanded = true;
    } else {
      flatItems.push(item.text);
    }
  }
  const expandedSql = expanded
    ? `${sql.slice(0, span.start)} ${flatItems.join(', ')} ${sql.slice(span.end)}`
    : sql;
  const names = analyze(expandedSql);
  if (names.length !== flatItems.length) {
    throw new TypegenError(
      location,
      `camelCase naming could not align this query's SELECT list (${flatItems.length} items) with its ${names.length} result columns — alias the snake_case result columns explicitly or set "naming": "preserve"`,
    );
  }
  const langNames = buildMap(names);

  let changed = expanded;
  const rewritten = flatItems.map((text, index) => {
    const resultName = names[index] as string;
    const langName = langNames[index] as string;
    if (langName === resultName) return text;
    changed = true;
    const explicit = EXPLICIT_ALIAS_RE.exec(text);
    if (explicit !== null && explicit[2] === resultName) {
      return `${(explicit[1] as string).trim()} AS ${langName}`;
    }
    const implicit = TRAILING_IDENT_RE.exec(text);
    if (implicit !== null && implicit[2] === resultName) {
      // Implicit alias (`expr name`) — swap the trailing identifier.
      return `${(implicit[1] as string).trim()} AS ${langName}`;
    }
    return `${text} AS ${langName}`;
  });
  if (!changed) {
    return { sql, changed: false, sqlNames: names, langNames };
  }
  const span2 = expanded ? findProjection(expandedSql) : span;
  if (span2 === null) throw new Error('unreachable: projection vanished');
  return {
    sql: `${expandedSql.slice(0, span2.start)} ${rewritten.join(', ')} ${expandedSql.slice(span2.end)}`,
    changed: true,
    sqlNames: names,
    langNames,
  };
}

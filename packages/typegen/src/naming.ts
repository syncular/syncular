/**
 * The pinned naming-map algorithm (DESIGN-queries.md §5, §12): SQL stays
 * snake_case; emitters render their language's convention. The IR carries
 * SQL-truth names plus a derived, collision-checked map — this module is
 * that derivation.
 *
 * `snake_case → camelCase`, pinned:
 * 1. A leading run of `_` is preserved as a prefix, a trailing run as a
 *    suffix (they carry intent — privacy markers, disambiguation).
 * 2. The middle splits on `_`; empty segments from doubled underscores drop.
 * 3. First segment verbatim; each later segment upper-cases its first
 *    character, rest verbatim. No acronym awareness (`id_url` → `idUrl`).
 * 4. Prefix/suffix re-attach. `created_at`→`createdAt`, `col_2`→`col2`,
 *    `_internal`→`_internal`, `__foo_bar`→`__fooBar`, `row_`→`row_`.
 *
 * Collisions and hazards are generate-time ERRORS, not warnings: two SQL
 * names mapping to one language name, a mapped name hitting a target-language
 * keyword, or a leading underscore on the Dart target (library-private).
 */
import { TypegenError } from './errors';

/** Manifest `"naming"`: camelCase emission (default) or SQL-truth names. */
export type NamingMode = 'camel' | 'preserve';

/** A name the mapper touches: a plain (optionally underscore-framed)
 * snake_case identifier. Expression-shaped result names (`count(*)`) pass
 * through unmapped. */
const MAPPABLE_RE = /^_*[A-Za-z][A-Za-z0-9_]*$/;

/** The pinned §12 snake→camel conversion. Non-identifier names (computed
 * result columns like `count(*)`) are returned unchanged. */
export function snakeToCamel(name: string): string {
  if (!MAPPABLE_RE.test(name)) return name;
  const lead = /^_*/.exec(name)?.[0] ?? '';
  const bare = name.slice(lead.length);
  const trail = /_*$/.exec(bare)?.[0] ?? '';
  const middle = bare.slice(0, bare.length - trail.length);
  const segments = middle.split('_').filter((s) => s.length > 0);
  if (segments.length === 0) return name;
  const first = segments[0] as string;
  const rest = segments
    .slice(1)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return lead + first + rest.join('') + trail;
}

/** The emitter targets whose keyword sets we police. `ts` is included for
 * completeness (its emitters can quote any property, so its list is the
 * small set that breaks generated FUNCTION/const identifiers). */
export type NamingTarget = 'ts' | 'swift' | 'kotlin' | 'dart';

/** Reserved words that cannot be a generated field/property name on each
 * target. Deliberately the core keyword lists — mechanical and predictable
 * beats exhaustive; an escape hatch (`AS` alias / "preserve") always exists. */
const TARGET_KEYWORDS: Readonly<Record<NamingTarget, ReadonlySet<string>>> = {
  // TS interface properties/object keys may be quoted, so only names that
  // would break generated code paths matter; keep the ES reserved core.
  ts: new Set([
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'new',
    'null',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
  ]),
  swift: new Set([
    'associatedtype',
    'class',
    'deinit',
    'enum',
    'extension',
    'fileprivate',
    'func',
    'import',
    'init',
    'inout',
    'internal',
    'let',
    'open',
    'operator',
    'private',
    'protocol',
    'public',
    'rethrows',
    'static',
    'struct',
    'subscript',
    'typealias',
    'var',
    'break',
    'case',
    'continue',
    'default',
    'defer',
    'do',
    'else',
    'fallthrough',
    'for',
    'guard',
    'if',
    'in',
    'repeat',
    'return',
    'switch',
    'where',
    'while',
    'as',
    'catch',
    'false',
    'is',
    'nil',
    'super',
    'self',
    'throw',
    'throws',
    'true',
    'try',
  ]),
  kotlin: new Set([
    'as',
    'break',
    'class',
    'continue',
    'do',
    'else',
    'false',
    'for',
    'fun',
    'if',
    'in',
    'interface',
    'is',
    'null',
    'object',
    'package',
    'return',
    'super',
    'this',
    'throw',
    'true',
    'try',
    'typealias',
    'typeof',
    'val',
    'var',
    'when',
    'while',
  ]),
  dart: new Set([
    'assert',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'default',
    'do',
    'else',
    'enum',
    'extends',
    'false',
    'final',
    'finally',
    'for',
    'if',
    'in',
    'is',
    'new',
    'null',
    'rethrow',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'var',
    'void',
    'while',
    'with',
  ]),
};

/** One naming-map entry: the SQL-truth name and its language-facing name. */
export interface NameMapping {
  readonly sqlName: string;
  readonly langName: string;
}

/**
 * Map a set of SQL names to language names under `mode`, enforcing the §12
 * hard errors within the scope (one table's columns / one query's projection
 * / one query's params). `context` and `scope` name the error location
 * (e.g. `queries/list.sql`, `table todos`); `targets` are the emitters this
 * run generates — keyword hazards are only real on targets that exist.
 */
export function buildNamingMap(
  sqlNames: readonly string[],
  mode: NamingMode,
  context: string,
  scope: string,
  targets: readonly NamingTarget[],
): NameMapping[] {
  if (mode === 'preserve') {
    return sqlNames.map((sqlName) => ({ sqlName, langName: sqlName }));
  }
  const bySqlName = new Map<string, string>();
  const byLangName = new Map<string, string>();
  for (const sqlName of sqlNames) {
    const langName = snakeToCamel(sqlName);
    const clash = byLangName.get(langName);
    if (clash !== undefined && clash !== sqlName) {
      throw new TypegenError(
        context,
        `${scope}: ${JSON.stringify(clash)} and ${JSON.stringify(sqlName)} both map to ${JSON.stringify(langName)} under camelCase naming — rename one, alias it in SQL (AS), or set "naming": "preserve" in syncular.json`,
      );
    }
    for (const target of targets) {
      if (TARGET_KEYWORDS[target].has(langName)) {
        throw new TypegenError(
          context,
          `${scope}: ${JSON.stringify(sqlName)} maps to ${JSON.stringify(langName)}, a reserved word on the ${target} target — rename it, alias it in SQL (AS), or set "naming": "preserve" in syncular.json`,
        );
      }
      if (target === 'dart' && langName.startsWith('_')) {
        throw new TypegenError(
          context,
          `${scope}: ${JSON.stringify(sqlName)} maps to ${JSON.stringify(langName)} — a leading underscore is library-private on the dart target. Alias it in SQL (AS) or set "naming": "preserve" in syncular.json`,
        );
      }
    }
    bySqlName.set(sqlName, langName);
    byLangName.set(langName, sqlName);
  }
  return sqlNames.map((sqlName) => ({
    sqlName,
    langName: bySqlName.get(sqlName) as string,
  }));
}

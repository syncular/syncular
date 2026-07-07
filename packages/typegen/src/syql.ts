/**
 * The `.syql` frontend (DESIGN-queries.md §3–§7): a functional CONTAINER —
 * GraphQL-style signatures + SQLDelight-style inference — around SQL
 * expressions. A file holds any number of `query` and `fragment`
 * declarations:
 *
 * ```text
 * fragment visibleIn(listId) {
 *   list_id = :listId and archived_at is null
 * }
 *
 * query listTodos(listId, status?, from+to?, unassigned?: flag)
 *   orderBy position | created_at | title default position
 *   limit max 200 default 50
 * {
 *   select id, title, done, created_at
 *   from todos
 *   where @visibleIn(:listId)
 *     and status = :status
 *     and created_at between :from and :to
 *     and if (:unassigned) { assignee_id is null }
 * }
 * ```
 *
 * Everything composes at GENERATE time: fragments splice textually (values
 * only — args are `:param` refs), optional params lower to §7 neutralization
 * guards (`:p IS NULL OR (…)`), knobs lower to a checked allowlist
 * (orderBy) and a bound+clamped param (limit), and the result is ONE plain
 * SQL statement that rides the exact same SQLite-check + naming-lowering
 * pipeline as the `.sql` tier. Nothing below the produced `AnalyzedQuery`
 * knows which frontend a query came from (§1).
 *
 * Conditional rules (§4, recommendation B with A as primitive):
 * - AUTO-GUARD: a top-level WHERE conjunct that mentions optional params
 *   applies only when ALL of them are provided.
 * - B1: an optional param outside a top-level conjunct (projection, FROM,
 *   subquery, or under an OR inside its conjunct) is a loud error telling
 *   the author to write an explicit `if` guard or make it required.
 * - B2: `if (:p, …) { predicate }` is the explicit primitive — required for
 *   flag params (which never appear in a predicate as written).
 */
import { TypegenError } from './errors';
import type { IrDocument } from './ir';
import { snakeToCamel } from './naming';
import {
  type AnalyzedQuery,
  analyzeStatement,
  type QueryDb,
  type QueryNamingOptions,
  type QueryParam,
  validateOverrideName,
} from './query';

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export interface SyqlParamDecl {
  readonly name: string;
  readonly optional: boolean;
  /** `from+to?` pairing: both params share the group key. */
  readonly group?: string;
  /** `name?: flag` — a boolean guard param (§3). */
  readonly flag: boolean;
}

export interface SyqlOrderBy {
  readonly allowed: readonly string[];
  readonly defaultColumn: string;
  readonly defaultDir: 'asc' | 'desc';
}

export interface SyqlLimit {
  readonly max?: number;
  readonly default?: number;
}

export interface SyqlFragmentDecl {
  readonly name: string;
  readonly params: readonly SyqlParamDecl[];
  /** The predicate body (raw SQL expression text). */
  readonly body: string;
}

export interface SyqlQueryDecl {
  readonly name: string;
  readonly params: readonly SyqlParamDecl[];
  readonly orderBy?: SyqlOrderBy;
  readonly limit?: SyqlLimit;
  /** The SQL-shaped body (may contain @fragment refs and if-guards). */
  readonly body: string;
}

export interface SyqlFile {
  readonly fragments: readonly SyqlFragmentDecl[];
  readonly queries: readonly SyqlQueryDecl[];
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// File parser
// ---------------------------------------------------------------------------

/** Cursor over the file with comment/whitespace skipping. */
class Cursor {
  i = 0;
  constructor(
    readonly src: string,
    readonly file: string,
  ) {}

  fail(message: string): never {
    const line = this.src.slice(0, this.i).split('\n').length;
    throw new TypegenError(`${this.file}:${line}`, message);
  }

  /** Skip whitespace and `--`/`/* *​/` comments. */
  skip(): void {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i] as string))
        this.i += 1;
      if (this.src.startsWith('--', this.i)) {
        const nl = this.src.indexOf('\n', this.i);
        this.i = nl === -1 ? this.src.length : nl + 1;
      } else if (this.src.startsWith('/*', this.i)) {
        const end = this.src.indexOf('*/', this.i + 2);
        this.i = end === -1 ? this.src.length : end + 2;
      } else {
        return;
      }
    }
  }

  atEnd(): boolean {
    this.skip();
    return this.i >= this.src.length;
  }

  /** Read one identifier-shaped word. */
  word(what: string): string {
    this.skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    if (m === null) this.fail(`expected ${what}`);
    this.i += m[0].length;
    return m[0];
  }

  /** Peek the next identifier-shaped word without consuming. */
  peekWord(): string | null {
    this.skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    return m === null ? null : m[0];
  }

  /** Consume one exact character. */
  expect(ch: string): void {
    this.skip();
    if (this.src[this.i] !== ch) {
      this.fail(`expected ${JSON.stringify(ch)}`);
    }
    this.i += 1;
  }

  peekChar(): string | undefined {
    this.skip();
    return this.src[this.i];
  }

  /** Read a non-negative integer literal. */
  int(what: string): number {
    this.skip();
    const m = /^\d+/.exec(this.src.slice(this.i));
    if (m === null) this.fail(`expected ${what} (an integer)`);
    this.i += m[0].length;
    return Number.parseInt(m[0], 10);
  }

  /** Read a balanced `{ … }` block (string/comment aware); returns the
   * INNER text. */
  braceBlock(): string {
    this.expect('{');
    const start = this.i;
    let depth = 1;
    while (this.i < this.src.length) {
      const ch = this.src[this.i] as string;
      if (ch === "'") {
        this.i += 1;
        while (this.i < this.src.length) {
          if (this.src[this.i] === "'") {
            if (this.src[this.i + 1] === "'") this.i += 2;
            else {
              this.i += 1;
              break;
            }
          } else this.i += 1;
        }
      } else if (this.src.startsWith('--', this.i)) {
        const nl = this.src.indexOf('\n', this.i);
        this.i = nl === -1 ? this.src.length : nl + 1;
      } else if (this.src.startsWith('/*', this.i)) {
        const end = this.src.indexOf('*/', this.i + 2);
        this.i = end === -1 ? this.src.length : end + 2;
      } else if (ch === '{') {
        depth += 1;
        this.i += 1;
      } else if (ch === '}') {
        depth -= 1;
        this.i += 1;
        if (depth === 0) return this.src.slice(start, this.i - 1);
      } else {
        this.i += 1;
      }
    }
    this.fail('unterminated { … } block');
  }
}

function parseSignature(cur: Cursor, owner: string): SyqlParamDecl[] {
  cur.expect('(');
  const params: SyqlParamDecl[] = [];
  const seen = new Set<string>();
  const push = (p: SyqlParamDecl) => {
    if (!IDENT_RE.test(p.name)) {
      cur.fail(`${owner}: invalid param name ${JSON.stringify(p.name)}`);
    }
    if (seen.has(p.name)) {
      cur.fail(`${owner}: duplicate param ${JSON.stringify(p.name)}`);
    }
    seen.add(p.name);
    params.push(p);
  };
  cur.skip();
  if (cur.peekChar() === ')') {
    cur.expect(')');
    return params;
  }
  for (;;) {
    const first = cur.word(`${owner}: param name`);
    cur.skip();
    if (cur.peekChar() === '+') {
      // `from+to?` — an optional GROUP: both provided or both omitted.
      cur.expect('+');
      const second = cur.word(`${owner}: second param of the ${first}+ group`);
      cur.skip();
      if (cur.peekChar() !== '?') {
        cur.fail(
          `${owner}: a ${first}+${second} group must be optional — write ${first}+${second}?`,
        );
      }
      cur.expect('?');
      const group = first;
      push({ name: first, optional: true, group, flag: false });
      push({ name: second, optional: true, group, flag: false });
    } else {
      let optional = false;
      if (cur.peekChar() === '?') {
        cur.expect('?');
        optional = true;
      }
      let flag = false;
      cur.skip();
      if (cur.peekChar() === ':') {
        cur.expect(':');
        const anno = cur.word(`${owner}: param annotation`);
        if (anno !== 'flag') {
          cur.fail(
            `${owner}: unknown annotation ${JSON.stringify(anno)} — \`: flag\` is the only param annotation (§3); every other type is inferred`,
          );
        }
        if (!optional) {
          cur.fail(`${owner}: a flag param is a guard — write ${first}?: flag`);
        }
        flag = true;
      }
      push({ name: first, optional, flag });
    }
    cur.skip();
    if (cur.peekChar() === ',') {
      cur.expect(',');
      continue;
    }
    cur.expect(')');
    return params;
  }
}

function parseKnobs(
  cur: Cursor,
  owner: string,
): { orderBy?: SyqlOrderBy; limit?: SyqlLimit } {
  let orderBy: SyqlOrderBy | undefined;
  let limit: SyqlLimit | undefined;
  for (;;) {
    const word = cur.peekWord();
    if (word === 'orderBy') {
      if (orderBy !== undefined) cur.fail(`${owner}: duplicate orderBy knob`);
      cur.word('orderBy');
      const allowed: string[] = [];
      allowed.push(cur.word(`${owner}: orderBy column`));
      cur.skip();
      while (cur.peekChar() === '|') {
        cur.expect('|');
        allowed.push(cur.word(`${owner}: orderBy column`));
        cur.skip();
      }
      const kw = cur.word(`${owner}: orderBy default`);
      if (kw !== 'default') {
        cur.fail(
          `${owner}: orderBy needs \`default <column>\` after the allowlist`,
        );
      }
      const defaultColumn = cur.word(`${owner}: orderBy default column`);
      if (!allowed.includes(defaultColumn)) {
        cur.fail(
          `${owner}: orderBy default ${JSON.stringify(defaultColumn)} is not in the allowlist (${allowed.join(' | ')})`,
        );
      }
      let defaultDir: 'asc' | 'desc' = 'asc';
      const dir = cur.peekWord();
      if (dir === 'asc' || dir === 'desc') {
        cur.word('direction');
        defaultDir = dir;
      }
      const dup = new Set<string>();
      for (const col of allowed) {
        if (dup.has(col)) {
          cur.fail(`${owner}: orderBy lists ${JSON.stringify(col)} twice`);
        }
        dup.add(col);
      }
      orderBy = { allowed, defaultColumn, defaultDir };
    } else if (word === 'limit') {
      if (limit !== undefined) cur.fail(`${owner}: duplicate limit knob`);
      cur.word('limit');
      let max: number | undefined;
      let def: number | undefined;
      for (;;) {
        const part = cur.peekWord();
        if (part === 'max' && max === undefined) {
          cur.word('max');
          max = cur.int(`${owner}: limit max`);
        } else if (part === 'default' && def === undefined) {
          cur.word('default');
          def = cur.int(`${owner}: limit default`);
        } else {
          break;
        }
      }
      if (max === undefined && def === undefined) {
        cur.fail(`${owner}: limit needs \`max <n>\` and/or \`default <n>\``);
      }
      if (max !== undefined && def !== undefined && def > max) {
        cur.fail(`${owner}: limit default ${def} exceeds max ${max}`);
      }
      limit = {
        ...(max !== undefined ? { max } : {}),
        ...(def !== undefined ? { default: def } : {}),
      };
    } else {
      return {
        ...(orderBy !== undefined ? { orderBy } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
    }
  }
}

/** Parse one `.syql` file into its declarations (no lowering yet). */
export function parseSyqlFile(file: string, content: string): SyqlFile {
  const cur = new Cursor(content, file);
  const fragments: SyqlFragmentDecl[] = [];
  const queries: SyqlQueryDecl[] = [];
  const names = new Set<string>();
  while (!cur.atEnd()) {
    const kw = cur.word('`query` or `fragment`');
    if (kw !== 'query' && kw !== 'fragment') {
      cur.fail(
        `expected \`query\` or \`fragment\`, found ${JSON.stringify(kw)}`,
      );
    }
    const name = cur.word(`${kw} name`);
    validateOverrideName(name, file);
    if (names.has(name)) {
      cur.fail(`duplicate declaration ${JSON.stringify(name)} in ${file}`);
    }
    names.add(name);
    const owner = `${kw} ${name}`;
    const params = parseSignature(cur, owner);
    if (kw === 'fragment') {
      cur.skip();
      const body = cur.braceBlock().trim();
      if (body.length === 0) cur.fail(`${owner}: empty fragment body`);
      fragments.push({ name, params, body });
    } else {
      const knobs = parseKnobs(cur, owner);
      cur.skip();
      const body = cur.braceBlock().trim();
      if (body.length === 0) cur.fail(`${owner}: empty query body`);
      queries.push({ name, params, ...knobs, body });
    }
  }
  return { fragments, queries };
}

// ---------------------------------------------------------------------------
// SQL-shape scanning helpers (string/comment aware)
// ---------------------------------------------------------------------------

/** Blank out strings and comments (preserving length) so scans are safe. */
function blank(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += ' '.repeat(end - i);
      i = end;
    } else if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += ' '.repeat(end - i);
      i = end;
    } else if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      out += ' '.repeat(j - i);
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** All `:param` names in `text` (strings/comments already blanked). */
function scanParams(text: string): string[] {
  const out: string[] = [];
  for (const m of blank(text).matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1] as string;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

interface WhereSpan {
  /** Offset just after the `where` keyword. */
  readonly start: number;
  /** Offset of the clause end (next top-level clause keyword or EOS). */
  readonly end: number;
}

const CLAUSE_ENDERS = new Set(['group', 'having', 'order', 'limit', 'window']);

/** Locate the MAIN statement's WHERE clause at paren depth 0. */
function findWhere(body: string): WhereSpan | null {
  const b = blank(body);
  let depth = 0;
  let i = 0;
  let start = -1;
  while (i < b.length) {
    const ch = b[i] as string;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < b.length && /[A-Za-z0-9_]/.test(b[j] as string)) j += 1;
      const word = b.slice(i, j).toLowerCase();
      if (depth === 0) {
        if (start === -1 && word === 'where') {
          start = j;
        } else if (start !== -1 && CLAUSE_ENDERS.has(word)) {
          return { start, end: i };
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return start === -1 ? null : { start, end: body.length };
}

/**
 * Split a WHERE expression into top-level conjuncts on `AND` — paren-aware,
 * and BETWEEN-aware (the `AND` closing a `BETWEEN` is not a conjunction).
 */
function splitConjuncts(expr: string): string[] {
  const b = blank(expr);
  const parts: string[] = [];
  let depth = 0;
  let braceDepth = 0;
  let pendingBetween = 0;
  let start = 0;
  let i = 0;
  while (i < b.length) {
    const ch = b[i] as string;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth -= 1;
    else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < b.length && /[A-Za-z0-9_]/.test(b[j] as string)) j += 1;
      const word = b.slice(i, j).toLowerCase();
      if (depth === 0 && braceDepth === 0) {
        if (word === 'between') pendingBetween += 1;
        else if (word === 'and') {
          if (pendingBetween > 0) pendingBetween -= 1;
          else {
            parts.push(expr.slice(start, i));
            start = j;
          }
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

const FRAGMENT_REF_RE = /@([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/;

interface ParamInfo {
  optional: boolean;
  group?: string;
  flag: boolean;
  declared: boolean;
}

/**
 * Splice `@fragment(:arg, …)` refs (iteratively — fragments may use other
 * fragments; cycles are caught by a depth cap). Fragment params rename to
 * the caller's arg names; a fragment's OPTIONAL params propagate their
 * optionality into `paramInfo` (GraphQL-fragment variable propagation, §3)
 * unless the query declares the arg itself (the declaration wins).
 */
function spliceFragments(
  body: string,
  fragments: ReadonlyMap<string, SyqlFragmentDecl>,
  paramInfo: Map<string, ParamInfo>,
  location: string,
): string {
  let out = body;
  for (let round = 0; ; round += 1) {
    if (round > 10) {
      throw new TypegenError(
        location,
        'fragment expansion exceeded depth 10 — fragments must not reference each other cyclically',
      );
    }
    const blanked = blank(out);
    const m = FRAGMENT_REF_RE.exec(blanked);
    if (m === null) return out;
    const [, name, argText] = m as unknown as [string, string, string];
    const fragment = fragments.get(name);
    if (fragment === undefined) {
      throw new TypegenError(
        location,
        `unknown fragment @${name} — fragments are declared in the same .syql file`,
      );
    }
    const args = argText
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (args.length !== fragment.params.length) {
      throw new TypegenError(
        location,
        `@${name} takes ${fragment.params.length} arg(s) (${fragment.params.map((p) => p.name).join(', ')}), got ${args.length}`,
      );
    }
    const rename = new Map<string, string>();
    fragment.params.forEach((param, index) => {
      const arg = args[index] as string;
      const argMatch = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(arg);
      if (argMatch === null) {
        throw new TypegenError(
          location,
          `@${name}: arg ${index + 1} must be a \`:param\` reference (values only, I1), got ${JSON.stringify(arg)}`,
        );
      }
      const argName = argMatch[1] as string;
      rename.set(param.name, argName);
      // Propagate the fragment param's optionality unless the query
      // declared this param itself.
      const existing = paramInfo.get(argName);
      if (existing === undefined) {
        paramInfo.set(argName, {
          optional: param.optional,
          flag: param.flag,
          declared: false,
          ...(param.group !== undefined
            ? { group: `${name}.${param.group}` }
            : {}),
        });
      } else if (!existing.declared && param.optional && !existing.optional) {
        existing.optional = true;
      }
    });
    // Substitute the fragment body's params, then splice parenthesized.
    let pred = fragment.body;
    const fragmentParams = new Set(fragment.params.map((p) => p.name));
    for (const used of scanParams(pred)) {
      if (!fragmentParams.has(used)) {
        throw new TypegenError(
          location,
          `fragment ${name} uses :${used}, which is not among its params (${[...fragmentParams].join(', ')}) — fragments are closed over their signature`,
        );
      }
    }
    pred = pred.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, p: string) => {
      const to = rename.get(p);
      return to === undefined ? whole : `:${to}`;
    });
    out = `${out.slice(0, m.index)}(${pred})${out.slice(m.index + m[0].length)}`;
  }
}

const IF_GUARD_RE = /^if\s*\(([^)]*)\)\s*\{([\s\S]*)\}$/;

/** Guard SQL for one param: value params test provision; flags test truth. */
function guardTerm(name: string, info: ParamInfo | undefined): string {
  if (info?.flag === true) return `coalesce(:${name}, 0) = 0`;
  return `:${name} is null`;
}

export interface LoweredSyqlQuery {
  /** The lowered single SQL statement (named params, no knob tails). */
  readonly sql: string;
  /** Params discovered/declared, in signature-then-first-use order. */
  readonly paramInfo: ReadonlyMap<string, ParamInfo>;
}

/**
 * Lower one query body: splice fragments, auto-guard optional conjuncts,
 * expand `if` guards, enforce B1. Returns plain SQL (knob tails are the
 * caller's job).
 */
export function lowerSyqlBody(
  decl: SyqlQueryDecl,
  fragments: ReadonlyMap<string, SyqlFragmentDecl>,
  location: string,
): LoweredSyqlQuery {
  const paramInfo = new Map<string, ParamInfo>();
  for (const p of decl.params) {
    paramInfo.set(p.name, {
      optional: p.optional,
      flag: p.flag,
      declared: true,
      ...(p.group !== undefined ? { group: p.group } : {}),
    });
  }

  if (blank(decl.body).includes(';')) {
    throw new TypegenError(
      location,
      'a query body is exactly one SELECT statement — remove the `;`',
    );
  }

  const spliced = spliceFragments(decl.body, fragments, paramInfo, location);

  const isOptional = (name: string): boolean =>
    paramInfo.get(name)?.optional === true;

  const where = findWhere(spliced);
  const conjuncts: string[] = [];
  let loweredWhere = '';
  if (where !== null) {
    const expr = spliced.slice(where.start, where.end);
    for (const conjunct of splitConjuncts(expr)) {
      const ifMatch = IF_GUARD_RE.exec(conjunct);
      if (ifMatch !== null) {
        // B2 — the explicit primitive: if (:a, :b) { predicate }.
        const guardParams = (ifMatch[1] as string)
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a.length > 0)
          .map((a) => {
            const pm = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(a);
            if (pm === null) {
              throw new TypegenError(
                location,
                `if (…) guards take \`:param\` refs, got ${JSON.stringify(a)}`,
              );
            }
            return pm[1] as string;
          });
        if (guardParams.length === 0) {
          throw new TypegenError(location, 'if () needs at least one :param');
        }
        const pred = (ifMatch[2] as string).trim();
        if (pred.length === 0) {
          throw new TypegenError(location, 'if (…) { } has an empty predicate');
        }
        for (const g of guardParams) {
          const info = paramInfo.get(g);
          if (info === undefined) {
            throw new TypegenError(
              location,
              `if (:${g}): param ${g} is not declared in the signature`,
            );
          }
          if (!info.optional) {
            throw new TypegenError(
              location,
              `if (:${g}): ${g} is required — an if-guard on a required param never varies; drop the guard or mark the param optional (${g}?)`,
            );
          }
        }
        const guards = guardParams
          .map((g) => guardTerm(g, paramInfo.get(g)))
          .join(' or ');
        conjuncts.push(`(${guards} or (${pred}))`);
        continue;
      }

      const used = scanParams(conjunct);
      const optionals = used.filter(isOptional);
      const flags = used.filter((p) => paramInfo.get(p)?.flag === true);
      if (flags.length > 0) {
        throw new TypegenError(
          location,
          `flag param :${flags[0]} cannot appear in a predicate (§3 — it never binds as written). Use \`if (:${flags[0]}) { … }\`.`,
        );
      }
      if (optionals.length === 0) {
        conjuncts.push(conjunct);
        continue;
      }
      // B1 placement validator: inside its conjunct, an optional param must
      // not sit under an OR or inside a subquery — semantics get murky;
      // demand the explicit primitive.
      const blankedConjunct = blank(conjunct).toLowerCase();
      if (/\bor\b/.test(blankedConjunct)) {
        throw new TypegenError(
          location,
          `optional param :${optionals[0]} sits under an OR — auto-guarding a disjunction is ambiguous (B1). Write \`if (:${optionals[0]}) { … }\` or make the param required.`,
        );
      }
      if (/\bselect\b/.test(blankedConjunct)) {
        throw new TypegenError(
          location,
          `optional param :${optionals[0]} sits inside a subquery — auto-guarding cannot see through it (B1). Write \`if (:${optionals[0]}) { … }\` or make the param required.`,
        );
      }
      // Auto-guard (§4 B): the conjunct applies iff ALL its optional params
      // (including every member of a touched group) are provided.
      const governing = new Set<string>(optionals);
      for (const p of optionals) {
        const group = paramInfo.get(p)?.group;
        if (group !== undefined) {
          for (const [other, info] of paramInfo) {
            if (info.group === group) governing.add(other);
          }
        }
      }
      const guards = [...governing]
        .map((g) => guardTerm(g, paramInfo.get(g)))
        .join(' or ');
      conjuncts.push(`(${guards} or (${conjunct}))`);
    }
    loweredWhere = conjuncts.join(' and ');
  }

  // B1 (rest of statement): optional params may ONLY live in the WHERE.
  const outsideWhere =
    where === null
      ? spliced
      : spliced.slice(0, where.start) + spliced.slice(where.end);
  for (const used of scanParams(outsideWhere)) {
    if (isOptional(used)) {
      throw new TypegenError(
        location,
        `optional param :${used} appears outside the WHERE clause (B1) — optional params only guard top-level WHERE conjuncts; make it required or restructure`,
      );
    }
  }

  // Declared params must actually be used (flags are used by their guards —
  // which splice into the WHERE — so this covers them too).
  const usedAnywhere = new Set(scanParams(spliced));
  for (const p of decl.params) {
    if (!usedAnywhere.has(p.name)) {
      throw new TypegenError(
        location,
        `param ${p.name} is declared but never used in the body`,
      );
    }
  }

  const sql =
    where === null
      ? spliced
      : `${spliced.slice(0, where.start)} ${loweredWhere}${spliced.slice(where.end).length > 0 ? ` ${spliced.slice(where.end).trimStart()}` : ''}`;

  return { sql: sql.replace(/\s+/g, ' ').trim(), paramInfo };
}

// ---------------------------------------------------------------------------
// Analysis (parse → lower → the shared SQLite-check pipeline)
// ---------------------------------------------------------------------------

/** Analyze every query of one `.syql` file into `AnalyzedQuery` units —
 * byte-compatible with the `.sql` frontend's output (§1: nothing below the
 * IR knows the frontend). */
export function analyzeSyqlFile(
  relPath: string,
  content: string,
  ir: IrDocument,
  db: QueryDb,
  naming?: QueryNamingOptions,
): AnalyzedQuery[] {
  const parsed = parseSyqlFile(relPath, content);
  const fragments = new Map(parsed.fragments.map((f) => [f.name, f] as const));
  if (parsed.queries.length === 0 && parsed.fragments.length > 0) {
    throw new TypegenError(
      relPath,
      'this .syql file declares only fragments — fragments are file-scoped, so at least one query must use them here',
    );
  }
  return parsed.queries.map((decl) => {
    const location = `${relPath} (query ${decl.name})`;
    const lowered = lowerSyqlBody(decl, fragments, location);
    const blanked = blank(lowered.sql).toLowerCase();

    // Knob preconditions on the BODY (the knob owns the tail).
    if (decl.orderBy !== undefined && /\border\s+by\b/.test(blanked)) {
      throw new TypegenError(
        location,
        'the body has an ORDER BY and the query declares an orderBy knob — one or the other',
      );
    }
    if (decl.limit !== undefined && /\blimit\b/.test(blanked)) {
      throw new TypegenError(
        location,
        'the body has a LIMIT and the query declares a limit knob — one or the other',
      );
    }
    if (
      (decl.limit !== undefined || decl.orderBy !== undefined) &&
      lowered.paramInfo.has('limit')
    ) {
      throw new TypegenError(
        location,
        'a query with a limit/orderBy knob cannot also declare a param named `limit`',
      );
    }

    // Check every orderBy allowlist column against the schema FIRST (each
    // variant is a real prepared statement — §6) so a bad column errors as
    // "orderBy column …", not as the default-tail check.
    if (decl.orderBy !== undefined) {
      for (const column of decl.orderBy.allowed) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
          throw new TypegenError(
            location,
            `orderBy column ${JSON.stringify(column)} is not a plain identifier`,
          );
        }
        try {
          db.analyze(`${lowered.sql} order by ${column} asc`);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new TypegenError(
            location,
            `orderBy column ${JSON.stringify(column)} rejected by SQLite: ${message}`,
          );
        }
      }
    }

    // Assemble the checked statement: default knob tails baked in, `-- param`
    // headers typing what inference cannot see (flags, the limit bind). The
    // limit's default + clamp live IN the SQL (`min(coalesce(:limit, d), m)`)
    // so an absent runtime value is a no-op — the same neutralization idea
    // as the §7 guards — and every emitter just binds `limit ?? null`.
    const headers: string[] = [];
    for (const [name, info] of lowered.paramInfo) {
      if (info.flag) headers.push(`-- param :${name} boolean`);
    }
    let limitTail = '';
    if (decl.limit !== undefined) {
      const fallback = decl.limit.default ?? decl.limit.max;
      const inner = `coalesce(:limit, ${fallback})`;
      limitTail = ` limit ${
        decl.limit.max !== undefined
          ? `min(${inner}, ${decl.limit.max})`
          : inner
      }`;
      headers.push('-- param :limit integer');
    }
    let sqlWithTails = lowered.sql;
    if (decl.orderBy !== undefined) {
      sqlWithTails += ` order by ${decl.orderBy.defaultColumn} ${decl.orderBy.defaultDir}`;
    }
    sqlWithTails += limitTail;
    const statementText = [...headers, sqlWithTails].join('\n');

    const base = analyzeStatement(
      decl.name,
      location,
      statementText,
      ir,
      db,
      naming,
    );

    // Attach optionality/group/flag + knob metadata to the checked unit.
    const params: QueryParam[] = base.params.map((param) => {
      if (param.name === 'limit' && decl.limit !== undefined) {
        return { ...param, optional: true };
      }
      const info = lowered.paramInfo.get(param.name);
      if (info === undefined) return param;
      return {
        ...param,
        ...(info.optional ? { optional: true } : {}),
        ...(info.group !== undefined ? { group: info.group } : {}),
        ...(info.flag ? { flag: true } : {}),
      };
    });

    const mode = naming?.naming ?? 'camel';
    const mapCol = (name: string): string =>
      mode === 'preserve' ? name : snakeToCamel(name);

    const orderBy =
      decl.orderBy === undefined
        ? undefined
        : {
            allowed: decl.orderBy.allowed.map((name) => ({
              name,
              langName: mapCol(name),
            })),
            defaultColumn: decl.orderBy.defaultColumn,
            defaultDir: decl.orderBy.defaultDir,
          };

    // The static base (positional) emitters compose dynamic tails onto:
    // positionalSql minus the default tails we appended above. Sliced from
    // the positional form itself so `?` vs `?N` numbering is preserved
    // (the appended tails are by construction the LAST clauses).
    let positionalSqlBase: string | undefined;
    let positionalLimitTail: string | undefined;
    if (decl.orderBy !== undefined) {
      const orderIdx = base.positionalSql.lastIndexOf(' order by ');
      if (orderIdx === -1) {
        throw new TypegenError(
          location,
          'internal: lowered SQL lost its appended order-by tail',
        );
      }
      positionalSqlBase = base.positionalSql.slice(0, orderIdx);
      if (decl.limit !== undefined) {
        const limitIdx = base.positionalSql.lastIndexOf(' limit ');
        if (limitIdx <= orderIdx) {
          throw new TypegenError(
            location,
            'internal: lowered SQL lost its appended limit tail',
          );
        }
        positionalLimitTail = base.positionalSql.slice(limitIdx);
      }
    }

    return {
      ...base,
      sourceSql: decl.body.trim(),
      // Drop the internal `-- param` typing headers from the exposed
      // (projection-lowered) SQL.
      sql: base.sql.replace(/^(?:\s*-- param :[^\n]*\n)+/, '').trimStart(),
      params,
      ...(orderBy !== undefined ? { orderBy } : {}),
      ...(decl.limit !== undefined ? { limit: decl.limit } : {}),
      ...(positionalSqlBase !== undefined ? { positionalSqlBase } : {}),
      ...(positionalLimitTail !== undefined && decl.orderBy !== undefined
        ? { positionalLimitTail }
        : {}),
    };
  });
}

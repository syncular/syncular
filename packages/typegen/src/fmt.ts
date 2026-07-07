/**
 * `syncular fmt` — the canonical `.syql` formatter (DESIGN-queries.md §10,
 * §12). One style, no options:
 *
 * - SQL keywords lowercase; identifier casing preserved (SQL-truth).
 * - one space after commas; collapsed whitespace elsewhere.
 * - one clause per line in the body; WHERE conjuncts one per line,
 *   `and`-prefixed and indented under the `where`.
 * - declarations separated by one blank line; knobs on their own lines.
 * - comments are preserved: a declaration's leading comment block stays
 *   above it; comments inside bodies stay on their own lines.
 *
 * The formatter is built on the same parser as the generator (`.syql` that
 * does not parse does not format), and formatting is semantics-preserving
 * by construction — `fmt` output re-parses to the same declarations.
 */
import { TypegenError } from './errors';
import { parseSyqlFile, type SyqlQueryDecl } from './syql';

/** SQL keywords the canon lowercases (a pragmatic core set — identifiers
 * that collide with these would need quoting anyway). */
const SQL_KEYWORDS = new Set(
  (
    'select from where group by having order limit offset window and or not ' +
    'in is null like glob between exists case when then else end as on using ' +
    'join left right full outer inner cross natural union all except ' +
    'intersect distinct values with recursive asc desc collate cast'
  ).split(' '),
);

interface Token {
  readonly kind: 'word' | 'string' | 'comment' | 'punct' | 'param' | 'fragment';
  readonly text: string;
}

/** Tokenize a body: strings/comments verbatim, words, `:params`,
 * `@fragment` refs, single punctuation chars. */
function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (body.startsWith('--', i)) {
      const nl = body.indexOf('\n', i);
      const end = nl === -1 ? body.length : nl;
      tokens.push({ kind: 'comment', text: body.slice(i, end).trimEnd() });
      i = end;
      continue;
    }
    if (body.startsWith('/*', i)) {
      const close = body.indexOf('*/', i + 2);
      const end = close === -1 ? body.length : close + 2;
      tokens.push({ kind: 'comment', text: body.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= body.length) break;
        if (body[j] === "'") {
          if (body[j + 1] === "'") j += 2;
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      tokens.push({ kind: 'string', text: body.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === ':' && /[A-Za-z_]/.test(body[i + 1] ?? '')) {
      let j = i + 1;
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j] as string)) j += 1;
      tokens.push({ kind: 'param', text: body.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '@' && /[A-Za-z_]/.test(body[i + 1] ?? '')) {
      let j = i + 1;
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j] as string)) j += 1;
      tokens.push({ kind: 'fragment', text: body.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j] as string)) j += 1;
      tokens.push({ kind: 'word', text: body.slice(i, j) });
      i = j;
      continue;
    }
    // Multi-char operators stay one token (`||`, `>=`, `<=`, `<>`, `!=`, `==`).
    const two = body.slice(i, i + 2);
    if (['||', '>=', '<=', '<>', '!=', '=='].includes(two)) {
      tokens.push({ kind: 'punct', text: two });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'punct', text: ch });
    i += 1;
  }
  return tokens;
}

/** Render tokens back to one line with canonical spacing + keyword case. */
function render(tokens: readonly Token[]): string {
  let out = '';
  let prev: Token | undefined;
  for (const token of tokens) {
    let text = token.text;
    if (token.kind === 'word' && SQL_KEYWORDS.has(text.toLowerCase())) {
      text = text.toLowerCase();
    }
    const glueLeft =
      token.kind === 'punct' &&
      (text === ',' || text === ')' || text === ';' || text === '.');
    const glueRight =
      prev !== undefined &&
      ((prev.kind === 'punct' && (prev.text === '(' || prev.text === '.')) ||
        prev.kind === 'fragment');
    if (out.length > 0 && !glueLeft && !glueRight) out += ' ';
    out += text;
    prev = token;
  }
  return out;
}

/** Clause keywords that start a new line at paren depth 0. */
const CLAUSE_STARTERS = new Set([
  'select',
  'from',
  'where',
  'group',
  'having',
  'order',
  'limit',
  'window',
  'union',
  'except',
  'intersect',
]);

/** Format a body: one clause per line; WHERE conjuncts one per line. */
function formatBody(body: string): string[] {
  const tokens = tokenize(body);
  const lines: string[] = [];
  let current: Token[] = [];
  let depth = 0;
  let braceDepth = 0;
  let inWhere = false;
  let pendingBetween = 0;
  const flush = (): void => {
    if (current.length > 0) lines.push(render(current));
    current = [];
  };
  for (const token of tokens) {
    if (token.kind === 'comment') {
      flush();
      lines.push(token.text);
      continue;
    }
    if (token.kind === 'punct') {
      if (token.text === '(') depth += 1;
      else if (token.text === ')') depth -= 1;
      else if (token.text === '{') braceDepth += 1;
      else if (token.text === '}') braceDepth -= 1;
    }
    if (token.kind === 'word' && depth === 0 && braceDepth === 0) {
      const word = token.text.toLowerCase();
      if (CLAUSE_STARTERS.has(word)) {
        flush();
        inWhere = word === 'where';
        pendingBetween = 0;
      } else if (inWhere) {
        if (word === 'between') pendingBetween += 1;
        else if (word === 'and') {
          if (pendingBetween > 0) pendingBetween -= 1;
          else flush();
        }
      }
    }
    current.push(token);
  }
  flush();
  // Indent: clauses flush-left; WHERE continuation (`and …`) indented 2.
  return lines.map((line) =>
    /^(and|or)\b/.test(line) || line.startsWith('--') ? `  ${line}` : line,
  );
}

function formatSignature(decl: {
  readonly params: SyqlQueryDecl['params'];
}): string {
  const parts: string[] = [];
  const seenGroups = new Set<string>();
  for (const param of decl.params) {
    if (param.group !== undefined) {
      if (seenGroups.has(param.group)) continue;
      seenGroups.add(param.group);
      const members = decl.params.filter((p) => p.group === param.group);
      parts.push(`${members.map((p) => p.name).join('+')}?`);
      continue;
    }
    if (param.flag) parts.push(`${param.name}?: flag`);
    else parts.push(`${param.name}${param.optional ? '?' : ''}`);
  }
  return parts.join(', ');
}

/** The leading comment block (verbatim lines) before each declaration. */
function leadingComments(source: string): Map<number, string[]> {
  // Map from declaration index (0-based, in order of appearance) to its
  // preceding comment lines.
  const out = new Map<number, string[]>();
  let pending: string[] = [];
  let declIndex = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('--', i)) {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? source.length : nl;
      pending.push(source.slice(i, end).trimEnd());
      i = end;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      pending.push(source.slice(i, end));
      i = end;
      continue;
    }
    // A declaration keyword: attach pending comments, then skip through its
    // brace block.
    if (pending.length > 0) {
      out.set(declIndex, pending);
      pending = [];
    }
    declIndex += 1;
    const brace = source.indexOf('{', i);
    if (brace === -1) break;
    let depth = 0;
    let j = brace;
    while (j < source.length) {
      const c = source[j] as string;
      if (c === "'") {
        j += 1;
        while (j < source.length && source[j] !== "'") j += 1;
      } else if (source.startsWith('--', j)) {
        const nl = source.indexOf('\n', j);
        j = nl === -1 ? source.length : nl;
      } else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
      j += 1;
    }
    i = j;
  }
  return out;
}

/** Format one `.syql` source file into its canonical form. Throws
 * {@link TypegenError} when the source does not parse. */
export function formatSyql(file: string, source: string): string {
  const parsed = parseSyqlFile(file, source);
  const comments = leadingComments(source);
  const decls: { order: number; text: string }[] = [];

  // Re-derive declaration order (fragments/queries interleave in-source);
  // parseSyqlFile keeps per-kind order, so re-scan the source for kind
  // keywords to interleave faithfully.
  const orderRe = /\b(query|fragment)\s+([A-Za-z][A-Za-z0-9]*)/g;
  const blanked = source
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
  const sequence: { kind: string; name: string }[] = [];
  let braceDepth = 0;
  let lastIndex = 0;
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '{') braceDepth += 1;
    else if (c === '}') braceDepth -= 1;
    else if (braceDepth === 0) {
      orderRe.lastIndex = i;
      const m = orderRe.exec(blanked);
      if (m !== null && m.index === i) {
        sequence.push({ kind: m[1] as string, name: m[2] as string });
        i = orderRe.lastIndex - 1;
        lastIndex = orderRe.lastIndex;
      }
    }
  }
  void lastIndex;

  sequence.forEach((entry, index) => {
    const lines: string[] = [];
    const leading = comments.get(index);
    if (leading !== undefined) lines.push(...leading);
    if (entry.kind === 'fragment') {
      const decl = parsed.fragments.find((f) => f.name === entry.name);
      if (decl === undefined) return;
      lines.push(`fragment ${decl.name}(${formatSignature(decl)}) {`);
      for (const line of formatBody(decl.body)) lines.push(`  ${line}`);
      lines.push('}');
    } else {
      const decl = parsed.queries.find((q) => q.name === entry.name);
      if (decl === undefined) return;
      const knobs: string[] = [];
      if (decl.orderBy !== undefined) {
        const dir = decl.orderBy.defaultDir === 'desc' ? ' desc' : '';
        knobs.push(
          `  orderBy ${decl.orderBy.allowed.join(' | ')} default ${decl.orderBy.defaultColumn}${dir}`,
        );
      }
      if (decl.limit !== undefined) {
        const parts: string[] = [];
        if (decl.limit.max !== undefined) parts.push(`max ${decl.limit.max}`);
        if (decl.limit.default !== undefined) {
          parts.push(`default ${decl.limit.default}`);
        }
        knobs.push(`  limit ${parts.join(' ')}`);
      }
      if (decl.variants === true) knobs.push('  variants');
      lines.push(
        `query ${decl.name}(${formatSignature(decl)})${knobs.length > 0 ? `\n${knobs.join('\n')}\n{` : ' {'}`,
      );
      for (const line of formatBody(decl.body)) lines.push(`  ${line}`);
      lines.push('}');
    }
    decls.push({ order: index, text: lines.join('\n') });
  });

  return `${decls.map((d) => d.text).join('\n\n')}\n`;
}

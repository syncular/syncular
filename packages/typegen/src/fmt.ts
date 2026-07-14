/** Canonical revision-1 SYQL formatter (§19).
 *
 * Formatting is a lossless-token rewrite: semantic/atomic tokens and comments
 * keep their order and exact spelling, while trivia is regenerated. The pass
 * parses both sides and refuses output unless their normalized semantic ASTs
 * agree. This keeps the formatter on the same lexer/parser contract as codegen.
 */
import { TypegenError } from './errors';
import { type SyqlSemanticFile, toSyqlSemanticAst } from './syql-ast';
import type { SyqlToken } from './syql-lexer';
import {
  parseSyqlSyntaxFile,
  type SyqlSyntaxFile,
  type SyqlTemplate,
} from './syql-parser';

const SQL_KEYWORDS = new Set(
  (
    'abort action add after all alter analyze and as asc attach autoincrement ' +
    'before begin between by cascade case cast check collate column commit ' +
    'conflict constraint create cross current current_date current_time ' +
    'current_timestamp database default deferrable deferred delete desc ' +
    'detach distinct do drop each else end escape except exclude exclusive ' +
    'exists explain fail filter first following for foreign from full ' +
    'generated glob group groups having if ignore immediate in index indexed ' +
    'initially inner insert instead intersect into is isnull join key last ' +
    'left like limit match materialized natural no not nothing notnull null ' +
    'nulls of offset on or order others outer over partition plan pragma ' +
    'preceding primary query raise range recursive references regexp reindex ' +
    'release rename replace restrict returning right rollback row rows savepoint ' +
    'select set table temp temporary then ties to transaction trigger ' +
    'unbounded union unique update using vacuum values view virtual when where ' +
    'window with without asc desc'
  ).split(/\s+/),
);

const CLAUSE_STARTERS = new Set([
  'select',
  'from',
  'where',
  'group',
  'having',
  'order',
  'limit',
  'offset',
  'window',
  'union',
  'except',
  'intersect',
]);

function templates(file: SyqlSyntaxFile): readonly SyqlTemplate[] {
  return file.declarations.flatMap((declaration) => {
    if (declaration.kind === 'predicate') return [declaration.body];
    return [
      declaration.statement,
      ...(declaration.sort?.profiles.map((profile) => profile.order) ?? []),
    ];
  });
}

function inTemplate(
  ranges: readonly SyqlTemplate[],
  token: SyqlToken,
): boolean {
  return ranges.some(
    (template) =>
      token.span.start.offset >= template.span.start.offset &&
      token.span.end.offset <= template.span.end.offset,
  );
}

function normalizedAst(ast: SyqlSemanticFile): unknown {
  return JSON.parse(
    JSON.stringify(ast, (_key, value: unknown) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        'kind' in value &&
        'text' in value &&
        (value as { kind?: unknown }).kind === 'identifier' &&
        typeof (value as { text?: unknown }).text === 'string'
      ) {
        const token = value as { readonly kind: string; readonly text: string };
        const lower = token.text.toLowerCase();
        return {
          kind: token.kind,
          text: SQL_KEYWORDS.has(lower) ? lower : token.text,
        };
      }
      return value;
    }),
  );
}

function comments(file: SyqlSyntaxFile): readonly string[] {
  return file.tokens
    .filter(
      (token) =>
        token.kind === 'line-comment' || token.kind === 'block-comment',
    )
    .map((token) => token.text);
}

class TokenWriter {
  readonly #lines: string[] = [''];
  readonly #blockIndents: {
    readonly close: number;
    readonly parent: number;
  }[] = [];
  #indent = 0;
  #nextIndent = 0;

  get line(): string {
    return this.#lines[this.#lines.length - 1] as string;
  }

  #setLine(value: string): void {
    this.#lines[this.#lines.length - 1] = value;
  }

  write(text: string, spaceBefore: boolean): void {
    if (this.line.length === 0) {
      this.#setLine('  '.repeat(this.#indent + this.#nextIndent));
      this.#nextIndent = 0;
    }
    if (
      spaceBefore &&
      this.line.trim().length > 0 &&
      !this.line.endsWith(' ')
    ) {
      this.#setLine(`${this.line} `);
    }
    this.#setLine(`${this.line}${text}`);
  }

  comment(text: string): void {
    if (this.line.trim().length > 0) this.write('', true);
    const pieces = text.split('\n');
    this.write(pieces[0] ?? '', false);
    for (const piece of pieces.slice(1)) {
      this.newline();
      // Internal block-comment indentation is part of the token. Do not add
      // formatter indentation before its continuation text.
      this.#setLine(piece);
    }
    this.newline();
  }

  newline(extraIndent = 0): void {
    this.#setLine(this.line.trimEnd());
    if (this.line.length > 0 || this.#lines.length === 1) this.#lines.push('');
    this.#nextIndent = extraIndent;
  }

  blankline(): void {
    this.newline();
    while (
      this.#lines.length >= 2 &&
      this.#lines[this.#lines.length - 2] === ''
    ) {
      this.#lines.pop();
    }
    if (this.#lines[this.#lines.length - 1] !== '') this.#lines.push('');
    this.#lines.push('');
  }

  openBlock(): void {
    const parentIndent = this.#indent;
    this.write('{', true);
    const leadingSpaces = this.line.length - this.line.trimStart().length;
    this.#blockIndents.push({
      close: leadingSpaces / 2,
      parent: parentIndent,
    });
    this.#indent = leadingSpaces / 2 + 1;
    this.newline();
  }

  indent(): void {
    this.#indent += 1;
  }

  dedent(): void {
    this.#indent -= 1;
  }

  closeBlock(): void {
    const block = this.#blockIndents.pop();
    if (block === undefined) {
      throw new Error('formatter block indentation stack underflow');
    }
    if (this.line.trim().length > 0) this.newline();
    this.#indent = block.close;
    this.write('}', false);
    this.#indent = block.parent;
  }

  finish(): string {
    while (this.#lines.length > 0 && this.#lines.at(-1)?.trim() === '') {
      this.#lines.pop();
    }
    return `${this.#lines.join('\n')}\n`;
  }
}

interface DeclarationParameters {
  readonly depth: number;
  readonly multiline: boolean;
}

function declarationParametersMultiline(
  tokens: readonly SyqlToken[],
  openIndex: number,
  prefixLength: number,
): boolean {
  let depth = 0;
  let parameters = 0;
  let hasContent = false;
  let length = prefixLength + 1;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] as SyqlToken;
    if (token.kind === 'line-comment' || token.kind === 'block-comment') {
      return true;
    }
    if (token.text === '(') depth += 1;
    if (token.text === ')') {
      if (depth === 0) {
        if (hasContent) parameters += 1;
        return parameters >= 4 || length + 1 > 88;
      }
      depth -= 1;
    }
    if (depth === 0 && token.text === ',') {
      parameters += 1;
      hasContent = false;
    } else if (depth === 0) {
      hasContent = true;
    }
    length += token.text.length + 1;
  }
  return false;
}

function needsSpace(
  previous: SyqlToken | undefined,
  token: SyqlToken,
): boolean {
  if (previous === undefined) return false;
  if ([',', ')', ']', ';', '.', '?', ':'].includes(token.text)) return false;
  if (['(', '[', '.', '@'].includes(previous.text)) return false;
  if (token.text === '(') return false;
  if (previous.text === ':') return true;
  if (token.kind === 'operator' || previous.kind === 'operator') return true;
  return true;
}

function formatTokens(parsed: SyqlSyntaxFile): string {
  const writer = new TokenWriter();
  const ranges = templates(parsed);
  const tokens = parsed.tokens.filter(
    (token) => token.kind !== 'whitespace' && token.kind !== 'eof',
  );
  let previous: SyqlToken | undefined;
  let braceDepth = 0;
  let parenDepth = 0;
  let importList = false;
  let justClosedImportList = false;
  let seenTopLevel = false;
  let pendingBetween = 0;
  let inlineParameterRecord = false;
  let justClosedInlineParameterRecord = false;

  let declarationParameters: DeclarationParameters | undefined;
  let awaitsDeclarationParameters = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as SyqlToken;
    const lower = token.text.toLowerCase();
    const template = inTemplate(ranges, token);
    const topLevelDeclaration =
      braceDepth === 0 &&
      token.kind === 'identifier' &&
      (lower === 'import' ||
        lower === 'predicate' ||
        lower === 'query' ||
        lower === 'sync') &&
      !(lower === 'query' && previous?.text === 'sync');
    if (topLevelDeclaration) {
      if (seenTopLevel) writer.blankline();
      seenTopLevel = true;
      previous = undefined;
      awaitsDeclarationParameters = lower === 'predicate' || lower === 'query';
    } else if (
      braceDepth === 0 &&
      lower === 'query' &&
      previous?.text === 'sync'
    ) {
      awaitsDeclarationParameters = true;
    } else if (
      previous?.text === '}' &&
      !justClosedImportList &&
      !justClosedInlineParameterRecord &&
      token.text !== ';' &&
      token.text !== ','
    ) {
      writer.newline();
      previous = undefined;
    }

    if (token.kind === 'line-comment' || token.kind === 'block-comment') {
      writer.comment(token.text);
      previous = undefined;
      continue;
    }

    if (
      template &&
      parenDepth === 0 &&
      token.kind === 'identifier' &&
      CLAUSE_STARTERS.has(lower) &&
      writer.line.trim().length > 0
    ) {
      writer.newline();
      previous = undefined;
      pendingBetween = 0;
    }
    if (template && parenDepth === 0 && lower === 'and') {
      if (pendingBetween > 0) pendingBetween -= 1;
      else {
        writer.newline(1);
        previous = undefined;
      }
    } else if (template && lower === 'between') {
      pendingBetween += 1;
    }

    if (token.text === '{') {
      if (previous?.kind === 'identifier' && previous.text === 'import') {
        writer.write('{', true);
        importList = true;
      } else if (
        declarationParameters !== undefined &&
        previous?.text === ':'
      ) {
        writer.write('{', true);
        inlineParameterRecord = true;
      } else {
        writer.openBlock();
        braceDepth += 1;
      }
      previous = token;
      continue;
    }
    if (token.text === '}') {
      if (inlineParameterRecord) {
        writer.write('}', true);
        inlineParameterRecord = false;
        justClosedInlineParameterRecord = true;
      } else if (importList && braceDepth === 0) {
        writer.write('}', true);
        importList = false;
        justClosedImportList = true;
      } else {
        writer.closeBlock();
        braceDepth -= 1;
      }
      previous = token;
      continue;
    }
    justClosedInlineParameterRecord = false;
    justClosedImportList = false;

    if (token.text === '(') {
      parenDepth += 1;
      const multiline =
        awaitsDeclarationParameters &&
        declarationParametersMultiline(tokens, index, writer.line.length);
      if (awaitsDeclarationParameters) {
        declarationParameters = { depth: parenDepth, multiline };
        awaitsDeclarationParameters = false;
      }
      writer.write(token.text, needsSpace(previous, token));
      if (multiline) {
        writer.indent();
        writer.newline();
      }
      previous = token;
      continue;
    }

    if (
      token.text === ',' &&
      declarationParameters?.depth === parenDepth &&
      !inlineParameterRecord
    ) {
      const next = tokens[index + 1];
      if (!(declarationParameters.multiline === false && next?.text === ')')) {
        writer.write(',', false);
        if (declarationParameters.multiline) writer.newline();
      }
      previous = token;
      continue;
    }

    if (token.text === ')' && declarationParameters?.depth === parenDepth) {
      if (declarationParameters.multiline) {
        if (previous?.text !== ',') writer.write(',', false);
        writer.dedent();
        if (writer.line.trim().length > 0) writer.newline();
      }
      writer.write(')', false);
      declarationParameters = undefined;
      parenDepth -= 1;
      previous = token;
      continue;
    }

    if (token.text === ')') parenDepth -= 1;

    const text =
      template && token.kind === 'identifier' && SQL_KEYWORDS.has(lower)
        ? lower
        : token.text;
    writer.write(text, needsSpace(previous, token));
    if (token.text === ';') {
      writer.newline();
      previous = undefined;
    } else {
      previous = token;
    }
  }
  return writer.finish();
}

/** Format one `.syql` source. Invalid or non-equivalent output is rejected so
 * the CLI never writes a partially understood file. */
export function formatSyql(file: string, source: string): string {
  const before = parseSyqlSyntaxFile(file, source);
  const formatted = formatTokens(before);
  const after = parseSyqlSyntaxFile(file, formatted);
  if (
    JSON.stringify(normalizedAst(toSyqlSemanticAst(before))) !==
      JSON.stringify(normalizedAst(toSyqlSemanticAst(after))) ||
    JSON.stringify(comments(before)) !== JSON.stringify(comments(after))
  ) {
    throw new TypegenError(
      file,
      'SYQL8001_FORMATTER_EQUIVALENCE: formatter output changed the revision-1 semantic AST or comment order',
    );
  }
  return formatted;
}

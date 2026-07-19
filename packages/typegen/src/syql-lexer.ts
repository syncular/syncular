/**
 * Lossless lexer for the revision-1 SYQL frontend (`docs/SYQL.md` §2).
 *
 * The lexer owns the SQLite atomic-token boundary used by parsing, formatting,
 * bind discovery, predicate expansion, and editor tooling. It never rewrites
 * source text: concatenating every non-EOF token reproduces the input exactly.
 */
import { TypegenError } from './errors';

export interface SyqlSourcePosition {
  /** UTF-16 source offset, suitable for slicing the JavaScript source string. */
  readonly offset: number;
  /** One-based source line. */
  readonly line: number;
  /** One-based Unicode-scalar column. */
  readonly column: number;
}

export interface SyqlSourceSpan {
  readonly file: string;
  readonly start: SyqlSourcePosition;
  /** Exclusive end position. */
  readonly end: SyqlSourcePosition;
}

export type SyqlTokenKind =
  | 'whitespace'
  | 'line-comment'
  | 'block-comment'
  | 'identifier'
  | 'number'
  | 'string'
  | 'quoted-identifier'
  | 'import-path'
  | 'blob'
  | 'bind'
  | 'at-identifier'
  | 'punctuation'
  | 'operator'
  | 'eof';

export interface SyqlToken {
  readonly kind: SyqlTokenKind;
  /** Exact source spelling. */
  readonly text: string;
  readonly span: SyqlSourceSpan;
}

export type SyqlLexErrorCode =
  | 'SYQL1001_UNTERMINATED_STRING'
  | 'SYQL1002_UNTERMINATED_IDENTIFIER'
  | 'SYQL1003_UNTERMINATED_COMMENT'
  | 'SYQL1004_UNTERMINATED_IMPORT_PATH';

/** A source-spanned, stable-code error shared by the lexer and parser. */
export class SyqlFrontendError extends TypegenError {
  readonly code: string;
  /** Human-readable diagnostic without the location/code prefix in `message`. */
  readonly detail: string;
  readonly span: SyqlSourceSpan;
  readonly sourceFile: string;

  constructor(code: string, span: SyqlSourceSpan, message: string) {
    super(
      `${span.file}:${span.start.line}:${span.start.column}`,
      `${code}: ${message}`,
    );
    this.name = 'SyqlFrontendError';
    this.code = code;
    this.detail = message;
    this.span = span;
    this.sourceFile = span.file;
  }
}

export function isSyqlTrivia(token: SyqlToken): boolean {
  return (
    token.kind === 'whitespace' ||
    token.kind === 'line-comment' ||
    token.kind === 'block-comment'
  );
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiHex(code: number): boolean {
  return (
    isAsciiDigit(code) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isIdentifierStart(code: number): boolean {
  // SQLite treats non-ASCII characters as alphabetic identifier characters.
  return code === 0x5f || isAsciiLetter(code) || code >= 0x80;
}

function isIdentifierContinue(code: number): boolean {
  return isIdentifierStart(code) || isAsciiDigit(code);
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function isPunctuation(ch: string): boolean {
  return '(){}[],.;?'.includes(ch);
}

const THREE_CHAR_OPERATORS = new Set(['->>']);
const TWO_CHAR_OPERATORS = new Set([
  '->',
  '||',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '<>',
]);

function scanDigitRun(
  source: string,
  start: number,
  predicate: (code: number) => boolean,
): number {
  let i = start;
  let consumed = false;
  while (i < source.length) {
    const code = source.charCodeAt(i);
    if (predicate(code)) {
      consumed = true;
      i += 1;
      continue;
    }
    // SQLite 3.46 permits one underscore between digits.
    if (
      consumed &&
      code === 0x5f &&
      i + 1 < source.length &&
      predicate(source.charCodeAt(i + 1))
    ) {
      i += 2;
      consumed = true;
      continue;
    }
    break;
  }
  return i;
}

class Lexer {
  readonly #source: string;
  readonly #file: string;
  readonly #tokens: SyqlToken[] = [];
  #offset = 0;
  #line = 1;
  #column = 1;
  #braceDepth = 0;
  #expectImportPath = false;
  readonly #recognizeImportPaths: boolean;

  constructor(file: string, source: string, recognizeImportPaths = true) {
    this.#file = file;
    this.#source = source;
    this.#recognizeImportPaths = recognizeImportPaths;
  }

  lex(): readonly SyqlToken[] {
    while (this.#offset < this.#source.length) this.#next();
    const atEnd = this.#position();
    this.#tokens.push({
      kind: 'eof',
      text: '',
      span: { file: this.#file, start: atEnd, end: atEnd },
    });
    return this.#tokens;
  }

  #position(): SyqlSourcePosition {
    return {
      offset: this.#offset,
      line: this.#line,
      column: this.#column,
    };
  }

  #advanceTo(end: number): void {
    while (this.#offset < end) {
      const code = this.#source.charCodeAt(this.#offset);
      if (code === 0x0d) {
        if (
          this.#offset + 1 < end &&
          this.#source.charCodeAt(this.#offset + 1) === 0x0a
        ) {
          this.#offset += 2;
        } else {
          this.#offset += 1;
        }
        this.#line += 1;
        this.#column = 1;
      } else if (code === 0x0a) {
        this.#offset += 1;
        this.#line += 1;
        this.#column = 1;
      } else {
        const point = this.#source.codePointAt(this.#offset) as number;
        this.#offset += point > 0xffff ? 2 : 1;
        this.#column += 1;
      }
    }
  }

  #emit(kind: SyqlTokenKind, end: number): void {
    const start = this.#position();
    const text = this.#source.slice(this.#offset, end);
    this.#advanceTo(end);
    const token: SyqlToken = {
      kind,
      text,
      span: { file: this.#file, start, end: this.#position() },
    };
    this.#tokens.push(token);
    this.#afterSignificant(token);
  }

  #afterSignificant(token: SyqlToken): void {
    if (isSyqlTrivia(token)) return;

    if (token.kind === 'punctuation') {
      if (token.text === '{') this.#braceDepth += 1;
      else if (token.text === '}')
        this.#braceDepth = Math.max(0, this.#braceDepth - 1);
    }

    if (
      this.#recognizeImportPaths &&
      token.kind === 'identifier' &&
      token.text === 'from' &&
      this.#braceDepth === 0
    ) {
      this.#expectImportPath = true;
      return;
    }

    if (this.#expectImportPath) this.#expectImportPath = false;
  }

  #fail(
    code: SyqlLexErrorCode,
    start: SyqlSourcePosition,
    end: number,
    message: string,
  ): never {
    this.#advanceTo(end);
    throw new SyqlFrontendError(
      code,
      { file: this.#file, start, end: this.#position() },
      message,
    );
  }

  #next(): void {
    const startOffset = this.#offset;
    const code = this.#source.charCodeAt(startOffset);
    const ch = this.#source[startOffset] as string;

    if (startOffset === 0 && code === 0xfeff) {
      this.#emit('whitespace', startOffset + 1);
      return;
    }

    if (isAsciiWhitespace(code)) {
      let end = startOffset + 1;
      while (
        end < this.#source.length &&
        isAsciiWhitespace(this.#source.charCodeAt(end))
      ) {
        end += 1;
      }
      this.#emit('whitespace', end);
      return;
    }

    if (this.#source.startsWith('--', startOffset)) {
      let end = startOffset + 2;
      while (end < this.#source.length) {
        const current = this.#source.charCodeAt(end);
        if (current === 0x0a || current === 0x0d) break;
        end += 1;
      }
      this.#emit('line-comment', end);
      return;
    }

    if (this.#source.startsWith('/*', startOffset)) {
      const close = this.#source.indexOf('*/', startOffset + 2);
      if (close === -1) {
        this.#fail(
          'SYQL1003_UNTERMINATED_COMMENT',
          this.#position(),
          this.#source.length,
          'unterminated block comment',
        );
      }
      this.#emit('block-comment', close + 2);
      return;
    }

    if (this.#expectImportPath && ch === '"') {
      this.#scanImportPath();
      return;
    }

    if ((ch === 'x' || ch === 'X') && this.#source[startOffset + 1] === "'") {
      this.#scanDelimited("'", 'blob', 'SYQL1001_UNTERMINATED_STRING');
      return;
    }

    if (ch === "'") {
      this.#scanDelimited("'", 'string', 'SYQL1001_UNTERMINATED_STRING');
      return;
    }

    if (ch === '"' || ch === '`') {
      this.#scanDelimited(
        ch,
        'quoted-identifier',
        'SYQL1002_UNTERMINATED_IDENTIFIER',
      );
      return;
    }

    if (ch === '[') {
      const close = this.#source.indexOf(']', startOffset + 1);
      if (close === -1) {
        this.#fail(
          'SYQL1002_UNTERMINATED_IDENTIFIER',
          this.#position(),
          this.#source.length,
          'unterminated bracketed identifier',
        );
      }
      this.#emit('quoted-identifier', close + 1);
      return;
    }

    if (ch === ':') {
      const next = this.#source.charCodeAt(startOffset + 1);
      if (isIdentifierStart(next)) {
        let end = startOffset + 2;
        while (
          end < this.#source.length &&
          isIdentifierContinue(this.#source.charCodeAt(end))
        ) {
          end += 1;
        }
        this.#emit('bind', end);
      } else {
        this.#emit('operator', startOffset + 1);
      }
      return;
    }

    if (ch === '@') {
      const next = this.#source.charCodeAt(startOffset + 1);
      if (isIdentifierStart(next)) {
        let end = startOffset + 2;
        while (
          end < this.#source.length &&
          isIdentifierContinue(this.#source.charCodeAt(end))
        ) {
          end += 1;
        }
        this.#emit('at-identifier', end);
      } else {
        this.#emit('operator', startOffset + 1);
      }
      return;
    }

    if (
      isAsciiDigit(code) ||
      (ch === '.' && isAsciiDigit(this.#source.charCodeAt(startOffset + 1)))
    ) {
      this.#emit('number', this.#scanNumber(startOffset));
      return;
    }

    if (isIdentifierStart(code)) {
      let end = startOffset + 1;
      while (
        end < this.#source.length &&
        isIdentifierContinue(this.#source.charCodeAt(end))
      ) {
        end += 1;
      }
      this.#emit('identifier', end);
      return;
    }

    if (isPunctuation(ch)) {
      this.#emit('punctuation', startOffset + 1);
      return;
    }

    const three = this.#source.slice(startOffset, startOffset + 3);
    if (THREE_CHAR_OPERATORS.has(three)) {
      this.#emit('operator', startOffset + 3);
      return;
    }
    const two = this.#source.slice(startOffset, startOffset + 2);
    if (TWO_CHAR_OPERATORS.has(two)) {
      this.#emit('operator', startOffset + 2);
      return;
    }

    // Keep unknown SQLite punctuation lossless and let the parser/reference
    // SQLite validator issue the contextual error later.
    this.#emit('operator', startOffset + 1);
  }

  #scanDelimited(
    delimiter: "'" | '"' | '`',
    kind: 'string' | 'quoted-identifier' | 'blob',
    code: SyqlLexErrorCode,
  ): void {
    const start = this.#position();
    const contentStart = kind === 'blob' ? this.#offset + 2 : this.#offset + 1;
    let end = contentStart;
    while (end < this.#source.length) {
      if (this.#source[end] !== delimiter) {
        end += 1;
        continue;
      }
      if (this.#source[end + 1] === delimiter) {
        end += 2;
        continue;
      }
      this.#emit(kind, end + 1);
      return;
    }
    this.#fail(
      code,
      start,
      this.#source.length,
      kind === 'string' || kind === 'blob'
        ? 'unterminated SQL string literal'
        : 'unterminated quoted identifier',
    );
  }

  #scanImportPath(): void {
    const start = this.#position();
    let end = this.#offset + 1;
    while (end < this.#source.length) {
      const code = this.#source.charCodeAt(end);
      if (code === 0x0a || code === 0x0d) break;
      if (code === 0x5c) {
        end += 2;
        continue;
      }
      if (code === 0x22) {
        this.#emit('import-path', end + 1);
        return;
      }
      end += 1;
    }
    this.#fail(
      'SYQL1004_UNTERMINATED_IMPORT_PATH',
      start,
      Math.min(end, this.#source.length),
      'unterminated JSON import path',
    );
  }

  #scanNumber(start: number): number {
    if (
      this.#source[start] === '0' &&
      (this.#source[start + 1] === 'x' || this.#source[start + 1] === 'X') &&
      isAsciiHex(this.#source.charCodeAt(start + 2))
    ) {
      return scanDigitRun(this.#source, start + 2, isAsciiHex);
    }

    let end = start;
    if (this.#source[end] !== '.') {
      end = scanDigitRun(this.#source, end, isAsciiDigit);
    }
    if (this.#source[end] === '.') {
      end += 1;
      end = scanDigitRun(this.#source, end, isAsciiDigit);
    }
    if (this.#source[end] === 'e' || this.#source[end] === 'E') {
      let exponent = end + 1;
      if (this.#source[exponent] === '+' || this.#source[exponent] === '-') {
        exponent += 1;
      }
      const exponentEnd = scanDigitRun(this.#source, exponent, isAsciiDigit);
      if (exponentEnd > exponent) end = exponentEnd;
    }
    return end;
  }
}

/** Lex one complete `.syql` source file, including trivia and an EOF token. */
export function lexSyqlSource(
  file: string,
  source: string,
): readonly SyqlToken[] {
  return new Lexer(file, source).lex();
}

/** Lex an isolated SQL/template string without import-path contextual rules. */
export function lexSyqlSqlSource(
  file: string,
  source: string,
): readonly SyqlToken[] {
  return new Lexer(file, source, false).lex();
}

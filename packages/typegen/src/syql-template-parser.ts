/** Embedded SQL-template node parser for revision-1 SYQL (§§6, 8, and 10). */
import {
  isSyqlTrivia,
  SyqlFrontendError,
  type SyqlSourceSpan,
  type SyqlToken,
} from './syql-lexer';

export type SyqlTemplateMode =
  | 'statement'
  | 'predicate'
  | 'condition'
  | 'order';

export interface SyqlRawTemplateNode {
  readonly kind: 'raw';
  readonly text: string;
  readonly tokens: readonly SyqlToken[];
  readonly span: SyqlSourceSpan;
}

export interface SyqlBindReference {
  readonly kind: 'bind-reference';
  readonly name: string;
  readonly token: SyqlToken;
  readonly span: SyqlSourceSpan;
}

export interface SyqlPredicateCall {
  readonly kind: 'predicate-call';
  readonly name: string;
  readonly arguments: readonly SyqlBindReference[];
  readonly tokens: readonly SyqlToken[];
  readonly span: SyqlSourceSpan;
}

export interface SyqlWhenExpression {
  readonly kind: 'when';
  readonly controls: readonly string[];
  /** True when the author wrote present(control); bare optional controls have
   * the same semantics and therefore normally keep this false. */
  readonly explicitPresence: readonly boolean[];
  readonly controlSpans: readonly SyqlSourceSpan[];
  readonly body: SyqlEmbeddedTemplate;
  readonly tokens: readonly SyqlToken[];
  readonly span: SyqlSourceSpan;
}

export type SyqlEmbeddedNode =
  | SyqlRawTemplateNode
  | SyqlPredicateCall
  | SyqlWhenExpression;

export interface SyqlEmbeddedTemplate {
  readonly kind: 'template';
  readonly mode: SyqlTemplateMode;
  readonly nodes: readonly SyqlEmbeddedNode[];
  readonly span: SyqlSourceSpan;
}

export type SyqlTemplateParseErrorCode =
  | 'SYQL3001_EXPECTED_EMBEDDED_TOKEN'
  | 'SYQL3002_INVALID_BIND'
  | 'SYQL3003_INVALID_PREDICATE_CALL'
  | 'SYQL3004_INVALID_WHEN'
  | 'SYQL3005_INVALID_REACTIVE_DIRECTIVE'
  | 'SYQL3006_FORBIDDEN_TEMPLATE_NODE'
  | 'SYQL3007_UNEXPECTED_BRACE'
  | 'SYQL3008_FORBIDDEN_PARAMETER_FORM';

const CAMEL_IDENT_RE = /^[a-z][A-Za-z0-9]*$/;

interface IndexedToken {
  readonly index: number;
  readonly token: SyqlToken;
}

function spanBetween(start: SyqlToken, end: SyqlToken): SyqlSourceSpan {
  return {
    file: start.span.file,
    start: start.span.start,
    end: end.span.end,
  };
}

function emptySpanAtStart(span: SyqlSourceSpan): SyqlSourceSpan {
  return { file: span.file, start: span.start, end: span.start };
}

class EmbeddedParser {
  readonly #file: string;
  readonly #tokens: readonly SyqlToken[];
  readonly #span: SyqlSourceSpan;
  readonly #mode: SyqlTemplateMode;
  readonly #rangeNames: ReadonlySet<string>;
  #index = 0;

  constructor(
    file: string,
    tokens: readonly SyqlToken[],
    span: SyqlSourceSpan,
    mode: SyqlTemplateMode,
    rangeNames: ReadonlySet<string>,
  ) {
    this.#file = file;
    this.#tokens = tokens;
    this.#span = span;
    this.#mode = mode;
    this.#rangeNames = rangeNames;
  }

  parse(): SyqlEmbeddedTemplate {
    const nodes: SyqlEmbeddedNode[] = [];
    let rawStart = 0;

    while (this.#index < this.#tokens.length) {
      const next = this.#peek();
      if (next === undefined) break;
      this.#index = next.index;

      const embeddedKind = this.#embeddedKind(next.token);
      if (embeddedKind !== undefined) {
        this.#pushRaw(nodes, rawStart, next.index);
        if (embeddedKind === 'when') nodes.push(this.#parseWhen());
        else {
          nodes.push(this.#parsePredicateCall());
        }
        rawStart = this.#index;
        continue;
      }

      this.#validateRawToken(next.token);
      this.#index = next.index + 1;
    }

    this.#pushRaw(nodes, rawStart, this.#tokens.length);
    return { kind: 'template', mode: this.#mode, nodes, span: this.#span };
  }

  #embeddedKind(token: SyqlToken): 'when' | 'predicate-call' | undefined {
    if (
      token.kind === 'identifier' &&
      token.text === 'when' &&
      this.#peekAfter(token)?.token.text === '('
    ) {
      return 'when';
    }
    if (token.kind === 'identifier' && this.#isCallCandidate(token)) {
      return 'predicate-call';
    }
    return undefined;
  }

  #isCallCandidate(token: SyqlToken): boolean {
    let next = this.#peekAfter(token);
    if (next?.token.text !== '(') return false;
    next = this.#peek(next.index + 1);
    if (next?.token.text === ')') return true;
    for (;;) {
      if (next?.token.kind !== 'bind') return false;
      next = this.#peek(next.index + 1);
      if (next?.token.text === ')') return true;
      if (next?.token.text !== ',') return false;
      next = this.#peek(next.index + 1);
      if (next?.token.text === ')') return true;
    }
  }

  #parsePredicateCall(): SyqlPredicateCall {
    const startIndex = this.#index;
    const nameToken = this.#take() as SyqlToken;
    const name = nameToken.text;
    this.#expectText('(', 'after predicate name');
    const args: SyqlBindReference[] = [];
    if (this.#peek()?.token.text !== ')') {
      for (;;) {
        args.push(this.#parseBindReference());
        if (this.#peek()?.token.text !== ',') break;
        this.#take();
        if (this.#peek()?.token.text === ')') break;
      }
    }
    const close = this.#expectText(')', 'to close predicate call');
    return {
      kind: 'predicate-call',
      name,
      arguments: args,
      tokens: this.#tokens.slice(startIndex, this.#index),
      span: spanBetween(nameToken, close),
    };
  }

  #parseWhen(): SyqlWhenExpression {
    const startIndex = this.#index;
    const start = this.#take() as SyqlToken;
    if (this.#mode !== 'statement') {
      this.#fail(
        'SYQL3006_FORBIDDEN_TEMPLATE_NODE',
        start,
        `when is not allowed in a ${this.#mode} template`,
      );
    }
    this.#expectText('(', 'after when');
    const controls: string[] = [];
    const explicitPresenceFlags: boolean[] = [];
    const controlSpans: SyqlSourceSpan[] = [];
    const seen = new Set<string>();
    if (this.#peek()?.token.text === ')') {
      this.#fail(
        'SYQL3004_INVALID_WHEN',
        this.#peek()?.token ?? start,
        'when requires at least one control',
      );
    }
    for (;;) {
      let explicitPresence = false;
      let control: SyqlToken;
      const candidate = this.#peek()?.token;
      if (
        candidate?.kind === 'identifier' &&
        candidate.text === 'present' &&
        this.#peekAfter(candidate)?.token.text === '('
      ) {
        this.#take();
        this.#expectText('(', 'after present');
        control = this.#expectIdentifier('present control');
        this.#expectText(')', 'after present control');
        explicitPresence = true;
      } else {
        control = this.#expectIdentifier('when control');
      }
      this.#validateCamel(control, 'when control', 'SYQL3004_INVALID_WHEN');
      if (seen.has(control.text)) {
        this.#fail(
          'SYQL3004_INVALID_WHEN',
          control,
          `duplicate when control ${JSON.stringify(control.text)}`,
        );
      }
      seen.add(control.text);
      controls.push(control.text);
      explicitPresenceFlags.push(explicitPresence);
      controlSpans.push(control.span);
      if (this.#peek()?.token.text !== ',') break;
      this.#take();
      if (this.#peek()?.token.text === ')') break;
    }
    this.#expectText(')', 'after when controls');
    let close: SyqlToken;
    let bodyTokens: readonly SyqlToken[];
    if (this.#peek()?.token.text === '{') {
      const open = this.#expectText('{', 'to open when body');
      const closeIndex = this.#matchingBraceIndex(open);
      close = this.#tokens[closeIndex] as SyqlToken;
      bodyTokens = this.#tokens.slice(this.#index, closeIndex);
      this.#index = closeIndex + 1;
    } else {
      const closeIndex = this.#singleWhenBodyEndIndex();
      bodyTokens = this.#tokens.slice(this.#index, closeIndex);
      const significant = bodyTokens.filter((token) => !isSyqlTrivia(token));
      close = significant[significant.length - 1] ?? start;
      this.#index = closeIndex;
    }
    if (bodyTokens.every(isSyqlTrivia)) {
      this.#fail('SYQL3004_INVALID_WHEN', close, 'when body must not be empty');
    }
    const bodySpan: SyqlSourceSpan = {
      file: this.#file,
      start: bodyTokens[0]?.span.start ?? close.span.start,
      end: bodyTokens[bodyTokens.length - 1]?.span.end ?? close.span.start,
    };
    const body = parseSyqlEmbeddedTemplate(
      this.#file,
      bodyTokens,
      bodySpan,
      'condition',
      this.#rangeNames,
    );
    return {
      kind: 'when',
      controls,
      explicitPresence: explicitPresenceFlags,
      controlSpans,
      body,
      tokens: this.#tokens.slice(startIndex, this.#index),
      span: spanBetween(start, close),
    };
  }

  #singleWhenBodyEndIndex(): number {
    let depth = 0;
    let pendingBetween = false;
    let rangeBetween = false;
    const clauseEnders = new Set([
      'group',
      'having',
      'order',
      'limit',
      'offset',
      'window',
      'union',
      'intersect',
      'except',
    ]);
    for (let cursor = this.#index; cursor < this.#tokens.length; cursor += 1) {
      const token = this.#tokens[cursor] as SyqlToken;
      if (isSyqlTrivia(token)) continue;
      if (token.text === '(') depth += 1;
      else if (token.text === ')') depth -= 1;
      if (depth !== 0) continue;
      const lower = token.text.toLowerCase();
      if (token.kind === 'identifier' && lower === 'between') {
        const next = this.#peek(cursor + 1)?.token;
        pendingBetween = true;
        rangeBetween =
          next?.kind === 'bind' && this.#rangeNames.has(next.text.slice(1));
        continue;
      }
      if (token.kind === 'identifier' && lower === 'and') {
        if (pendingBetween && !rangeBetween) {
          pendingBetween = false;
          continue;
        }
        return this.#leadingTriviaIndex(cursor);
      }
      if (token.text === '}' || clauseEnders.has(lower))
        return this.#leadingTriviaIndex(cursor);
    }
    return this.#tokens.length;
  }

  #leadingTriviaIndex(index: number): number {
    let cursor = index;
    while (
      cursor > this.#index &&
      isSyqlTrivia(this.#tokens[cursor - 1] as SyqlToken)
    )
      cursor -= 1;
    return cursor;
  }

  #parseBindReference(): SyqlBindReference {
    const token = this.#take();
    if (token?.kind !== 'bind') {
      this.#fail(
        'SYQL3002_INVALID_BIND',
        token ?? this.#tokens[this.#tokens.length - 1],
        'expected a :camelCase bind reference',
      );
    }
    const name = token.text.slice(1);
    if (!CAMEL_IDENT_RE.test(name) || name.toLowerCase().startsWith('__syql')) {
      this.#fail(
        'SYQL3002_INVALID_BIND',
        token,
        `bind ${JSON.stringify(token.text)} must match :[a-z][A-Za-z0-9]* and not use __syql`,
      );
    }
    return { kind: 'bind-reference', name, token, span: token.span };
  }

  #validateRawToken(token: SyqlToken): void {
    if (token.kind === 'at-identifier') {
      this.#fail(
        'SYQL3006_FORBIDDEN_TEMPLATE_NODE',
        token,
        `${token.text} uses removed directive/call syntax; use ordinary SQL predicates or a normal predicate call`,
      );
    }
    if (token.kind === 'bind') {
      if (this.#mode === 'order') {
        this.#fail(
          'SYQL3006_FORBIDDEN_TEMPLATE_NODE',
          token,
          'binds are not allowed in sort profiles',
        );
      }
      const name = token.text.slice(1);
      if (
        !CAMEL_IDENT_RE.test(name) ||
        name.toLowerCase().startsWith('__syql')
      ) {
        this.#fail(
          'SYQL3002_INVALID_BIND',
          token,
          `bind ${JSON.stringify(token.text)} must match :[a-z][A-Za-z0-9]* and not use __syql`,
        );
      }
    }
    if (token.kind === 'punctuation' && token.text === '?') {
      this.#fail(
        'SYQL3008_FORBIDDEN_PARAMETER_FORM',
        token,
        'SQLite ? parameters are forbidden; declare and use a :camelCase bind',
      );
    }
    if (
      token.kind === 'operator' &&
      (token.text === '$' || token.text === '@')
    ) {
      this.#fail(
        'SYQL3008_FORBIDDEN_PARAMETER_FORM',
        token,
        `SQLite ${token.text} parameters are forbidden in SYQL templates`,
      );
    }
    if (
      token.kind === 'punctuation' &&
      (token.text === '{' || token.text === '}')
    ) {
      this.#fail(
        'SYQL3007_UNEXPECTED_BRACE',
        token,
        'a template brace must belong to a when(...) { ... } node',
      );
    }
  }

  #validateCamel(
    token: SyqlToken,
    label: string,
    code: SyqlTemplateParseErrorCode,
  ): void {
    if (
      !CAMEL_IDENT_RE.test(token.text) ||
      token.text.toLowerCase().startsWith('__syql')
    ) {
      this.#fail(
        code,
        token,
        `${label} must match [a-z][A-Za-z0-9]* and not use __syql`,
      );
    }
  }

  #matchingBraceIndex(open: SyqlToken): number {
    let depth = 1;
    for (let cursor = this.#index; cursor < this.#tokens.length; cursor += 1) {
      const token = this.#tokens[cursor] as SyqlToken;
      if (token.kind !== 'punctuation') continue;
      if (token.text === '{') depth += 1;
      else if (token.text === '}') {
        depth -= 1;
        if (depth === 0) return cursor;
      }
    }
    this.#fail(
      'SYQL3001_EXPECTED_EMBEDDED_TOKEN',
      open,
      'expected } to close when body',
    );
  }

  #pushRaw(nodes: SyqlEmbeddedNode[], start: number, end: number): void {
    if (start >= end) return;
    const tokens = this.#tokens.slice(start, end);
    const first = tokens[0] as SyqlToken;
    const last = tokens[tokens.length - 1] as SyqlToken;
    nodes.push({
      kind: 'raw',
      text: tokens.map((token) => token.text).join(''),
      tokens,
      span: spanBetween(first, last),
    });
  }

  #peek(from = this.#index): IndexedToken | undefined {
    let index = from;
    while (index < this.#tokens.length) {
      const token = this.#tokens[index] as SyqlToken;
      if (!isSyqlTrivia(token)) return { index, token };
      index += 1;
    }
    return undefined;
  }

  #peekAfter(token: SyqlToken): IndexedToken | undefined {
    const index = this.#tokens.indexOf(token, this.#index);
    return index < 0 ? undefined : this.#peek(index + 1);
  }

  #take(): SyqlToken | undefined {
    const next = this.#peek();
    if (next === undefined) {
      this.#index = this.#tokens.length;
      return undefined;
    }
    this.#index = next.index + 1;
    return next.token;
  }

  #expectText(text: string, context: string): SyqlToken {
    const token = this.#take();
    if (token?.text !== text) {
      this.#fail(
        'SYQL3001_EXPECTED_EMBEDDED_TOKEN',
        token ?? this.#tokens[this.#tokens.length - 1],
        `expected ${JSON.stringify(text)} ${context}`,
      );
    }
    return token;
  }

  #expectIdentifier(label: string): SyqlToken {
    const token = this.#take();
    if (token?.kind !== 'identifier') {
      this.#fail(
        'SYQL3001_EXPECTED_EMBEDDED_TOKEN',
        token ?? this.#tokens[this.#tokens.length - 1],
        `expected ${label}`,
      );
    }
    return token;
  }

  #fail(
    code: SyqlTemplateParseErrorCode,
    token: SyqlToken | undefined,
    message: string,
  ): never {
    throw new SyqlFrontendError(
      code,
      token?.span ?? emptySpanAtStart(this.#span),
      message,
    );
  }
}

/** Parse embedded nodes from one already-delimited lossless template. */
export function parseSyqlEmbeddedTemplate(
  file: string,
  tokens: readonly SyqlToken[],
  span: SyqlSourceSpan,
  mode: SyqlTemplateMode,
  rangeNames: ReadonlySet<string> = new Set(),
): SyqlEmbeddedTemplate {
  return new EmbeddedParser(file, tokens, span, mode, rangeNames).parse();
}

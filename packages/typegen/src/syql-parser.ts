/** Revision-1 SYQL container parser (`docs/SYQL.md` §3). */
import {
  isSyqlTrivia,
  lexSyqlSource,
  SyqlFrontendError,
  type SyqlSourceSpan,
  type SyqlToken,
} from './syql-lexer';
import {
  parseSyqlEmbeddedTemplate,
  type SyqlEmbeddedTemplate,
  type SyqlTemplateMode,
} from './syql-template-parser';

export type SyqlBaseType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'json'
  | 'bytes'
  | 'blob_ref'
  | 'crdt';

export interface SyqlValueType {
  readonly base: SyqlBaseType;
  readonly nullable: boolean;
  readonly span: SyqlSourceSpan;
}

export interface SyqlValueParameter {
  readonly kind: 'value';
  readonly name: string;
  readonly optional: boolean;
  readonly type?: SyqlValueType;
  readonly span: SyqlSourceSpan;
  readonly nameSpan: SyqlSourceSpan;
}

export interface SyqlSwitchParameter {
  readonly kind: 'switch';
  readonly name: string;
  readonly optional: true;
  readonly span: SyqlSourceSpan;
  readonly nameSpan: SyqlSourceSpan;
}

export interface SyqlGroupMember {
  readonly name: string;
  readonly type?: SyqlValueType;
  readonly span: SyqlSourceSpan;
  readonly nameSpan: SyqlSourceSpan;
}

export interface SyqlGroupParameter {
  readonly kind: 'group';
  readonly name: string;
  readonly optional: true;
  readonly members: readonly SyqlGroupMember[];
  readonly span: SyqlSourceSpan;
  readonly nameSpan: SyqlSourceSpan;
}

export type SyqlQueryParameter =
  | SyqlValueParameter
  | SyqlSwitchParameter
  | SyqlGroupParameter;

export interface SyqlPredicateParameter {
  readonly name: string;
  readonly type?: SyqlValueType;
  readonly span: SyqlSourceSpan;
  readonly nameSpan: SyqlSourceSpan;
}

/** A lossless SQL token template between a pair of container braces. */
export interface SyqlTemplate {
  readonly text: string;
  readonly tokens: readonly SyqlToken[];
  /** Structurally parsed SYQL nodes embedded in the otherwise-lossless SQL. */
  readonly tree: SyqlEmbeddedTemplate;
  /** Span of the inner text, excluding braces. */
  readonly span: SyqlSourceSpan;
}

export interface SyqlImportItem {
  readonly imported: string;
  readonly local: string;
  readonly span: SyqlSourceSpan;
}

export interface SyqlImportDeclaration {
  readonly kind: 'import';
  readonly items: readonly SyqlImportItem[];
  /** Decoded JSON path. */
  readonly path: string;
  readonly span: SyqlSourceSpan;
}

export interface SyqlPredicateDeclaration {
  readonly kind: 'predicate';
  readonly name: string;
  readonly parameters: readonly SyqlPredicateParameter[];
  readonly body: SyqlTemplate;
  readonly span: SyqlSourceSpan;
  readonly nameSpan: SyqlSourceSpan;
}

export interface SyqlSqlSection {
  readonly kind: 'sql';
  readonly body: SyqlTemplate;
  readonly span: SyqlSourceSpan;
}

export interface SyqlSortProfile {
  readonly name: string;
  readonly order: SyqlTemplate;
  readonly span: SyqlSourceSpan;
  readonly nameSpan: SyqlSourceSpan;
}

export interface SyqlSortSection {
  readonly kind: 'sort';
  readonly control: string;
  readonly defaultProfile: string;
  readonly profiles: readonly SyqlSortProfile[];
  readonly span: SyqlSourceSpan;
  readonly controlSpan: SyqlSourceSpan;
}

export interface SyqlPageDeclaration {
  readonly kind: 'page';
  readonly control: string;
  readonly defaultSize: number;
  readonly maxSize: number;
  readonly span: SyqlSourceSpan;
  readonly controlSpan: SyqlSourceSpan;
}

export interface SyqlIdentityDeclaration {
  readonly kind: 'identity';
  readonly fields: readonly string[];
  readonly span: SyqlSourceSpan;
}

export interface SyqlQueryDeclaration {
  readonly kind: 'query';
  readonly name: string;
  readonly parameters: readonly SyqlQueryParameter[];
  readonly sql: SyqlSqlSection;
  readonly sort?: SyqlSortSection;
  readonly page?: SyqlPageDeclaration;
  readonly identity?: SyqlIdentityDeclaration;
  readonly span: SyqlSourceSpan;
  readonly nameSpan: SyqlSourceSpan;
}

export type SyqlDeclaration = SyqlPredicateDeclaration | SyqlQueryDeclaration;

export interface SyqlSyntaxFile {
  readonly kind: 'file';
  readonly file: string;
  readonly source: string;
  readonly tokens: readonly SyqlToken[];
  readonly imports: readonly SyqlImportDeclaration[];
  readonly declarations: readonly SyqlDeclaration[];
  readonly predicates: readonly SyqlPredicateDeclaration[];
  readonly queries: readonly SyqlQueryDeclaration[];
  readonly span: SyqlSourceSpan;
}

export type SyqlParseErrorCode =
  | 'SYQL2001_EXPECTED_TOKEN'
  | 'SYQL2002_INVALID_NAME'
  | 'SYQL2003_RESERVED_NAME'
  | 'SYQL2004_DUPLICATE_NAME'
  | 'SYQL2005_INVALID_IMPORT'
  | 'SYQL2006_EMPTY_TEMPLATE'
  | 'SYQL2007_FORBIDDEN_SEMICOLON'
  | 'SYQL2008_INVALID_MEMBER'
  | 'SYQL2009_INVALID_INTEGER'
  | 'SYQL2010_INVALID_PAGE_RANGE'
  | 'SYQL2011_INVALID_PARAMETER';

const CAMEL_IDENT_RE = /^[a-z][A-Za-z0-9]*$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTEGER_LITERAL_RE = /^(?:0|[1-9][0-9]*)$/;
const BASE_TYPES = new Set<SyqlBaseType>([
  'string',
  'integer',
  'float',
  'boolean',
  'json',
  'bytes',
  'blob_ref',
  'crdt',
]);
const RESERVED_NAMES = new Set([
  'as',
  'blob_ref',
  'boolean',
  'by',
  'bytes',
  'cover',
  'crdt',
  'default',
  'float',
  'from',
  'identity',
  'import',
  'in',
  'integer',
  'json',
  'max',
  'null',
  'page',
  'predicate',
  'query',
  'scope',
  'sort',
  'sql',
  'string',
  'switch',
  'when',
]);

interface ParsedBlock {
  readonly template: SyqlTemplate;
  readonly open: SyqlToken;
  readonly close: SyqlToken;
}

interface ParsedQueryParameters {
  readonly parameters: readonly SyqlQueryParameter[];
  readonly publicNames: Set<string>;
  readonly bindNames: Set<string>;
}

function spanBetween(start: SyqlToken, end: SyqlToken): SyqlSourceSpan {
  return {
    file: start.span.file,
    start: start.span.start,
    end: end.span.end,
  };
}

function spanFromPositions(
  file: string,
  start: SyqlSourceSpan['start'],
  end: SyqlSourceSpan['end'],
): SyqlSourceSpan {
  return { file, start, end };
}

class Parser {
  readonly #file: string;
  readonly #source: string;
  readonly #tokens: readonly SyqlToken[];
  #index = 0;

  constructor(file: string, source: string) {
    this.#file = file;
    this.#source = source;
    this.#tokens = lexSyqlSource(file, source);
  }

  parse(): SyqlSyntaxFile {
    const imports: SyqlImportDeclaration[] = [];
    const declarations: SyqlDeclaration[] = [];
    const predicates: SyqlPredicateDeclaration[] = [];
    const queries: SyqlQueryDeclaration[] = [];
    const fileNames = new Map<string, SyqlSourceSpan>();
    let sawDeclaration = false;

    while (this.#peek().kind !== 'eof') {
      const keyword = this.#peek();
      if (keyword.text === 'import') {
        if (sawDeclaration) {
          this.#fail(
            'SYQL2008_INVALID_MEMBER',
            keyword,
            'imports must precede all predicate and query declarations',
          );
        }
        const declaration = this.#parseImport();
        for (const item of declaration.items) {
          this.#claimName(fileNames, item.local, item.span, 'imported name');
        }
        imports.push(declaration);
        continue;
      }

      sawDeclaration = true;
      if (keyword.text === 'predicate') {
        const declaration = this.#parsePredicate();
        this.#claimName(
          fileNames,
          declaration.name,
          declaration.nameSpan,
          'declaration',
        );
        declarations.push(declaration);
        predicates.push(declaration);
      } else if (keyword.text === 'query') {
        const declaration = this.#parseQuery();
        this.#claimName(
          fileNames,
          declaration.name,
          declaration.nameSpan,
          'declaration',
        );
        declarations.push(declaration);
        queries.push(declaration);
      } else {
        this.#fail(
          'SYQL2008_INVALID_MEMBER',
          keyword,
          `expected import, predicate, or query; found ${JSON.stringify(keyword.text)}`,
        );
      }
    }

    const first = this.#tokens[0] as SyqlToken;
    const eof = this.#tokens[this.#tokens.length - 1] as SyqlToken;
    return {
      kind: 'file',
      file: this.#file,
      source: this.#source,
      tokens: this.#tokens,
      imports,
      declarations,
      predicates,
      queries,
      span: spanFromPositions(this.#file, first.span.start, eof.span.end),
    };
  }

  #parseImport(): SyqlImportDeclaration {
    const start = this.#expectText('import');
    this.#expectText('{');
    const items: SyqlImportItem[] = [];
    const localNames = new Map<string, SyqlSourceSpan>();
    const importedNames = new Map<string, SyqlSourceSpan>();

    if (this.#peek().text === '}') {
      this.#fail(
        'SYQL2005_INVALID_IMPORT',
        this.#peek(),
        'an import list must contain at least one predicate name',
      );
    }

    for (;;) {
      const importedToken = this.#parseCamelName('imported predicate name');
      this.#claimName(
        importedNames,
        importedToken.text,
        importedToken.span,
        'imported predicate',
      );
      let localToken = importedToken;
      if (this.#peek().text === 'as') {
        this.#take();
        localToken = this.#parseCamelName('import alias');
      }
      this.#claimName(
        localNames,
        localToken.text,
        localToken.span,
        'import alias',
      );
      items.push({
        imported: importedToken.text,
        local: localToken.text,
        span: spanBetween(importedToken, localToken),
      });

      if (this.#peek().text !== ',') break;
      this.#take();
      if (this.#peek().text === '}') break;
    }

    this.#expectText('}');
    this.#expectText('from');
    const pathToken = this.#take();
    if (pathToken.kind !== 'import-path') {
      this.#fail(
        'SYQL2005_INVALID_IMPORT',
        pathToken,
        'expected a JSON double-quoted relative .syql import path',
      );
    }
    let path: unknown;
    try {
      path = JSON.parse(pathToken.text);
    } catch {
      this.#fail(
        'SYQL2005_INVALID_IMPORT',
        pathToken,
        'invalid JSON import path',
      );
    }
    if (
      typeof path !== 'string' ||
      (!path.startsWith('./') && !path.startsWith('../')) ||
      !path.endsWith('.syql') ||
      path.includes('\0') ||
      path.includes('\\')
    ) {
      this.#fail(
        'SYQL2005_INVALID_IMPORT',
        pathToken,
        'import path must be a slash-separated relative path ending in .syql',
      );
    }
    const end = this.#expectText(';');
    return { kind: 'import', items, path, span: spanBetween(start, end) };
  }

  #parsePredicate(): SyqlPredicateDeclaration {
    const start = this.#expectText('predicate');
    const name = this.#parseCamelName('predicate name');
    this.#expectText('(');
    const parameters: SyqlPredicateParameter[] = [];
    const names = new Map<string, SyqlSourceSpan>();
    if (this.#peek().text !== ')') {
      for (;;) {
        const paramStart = this.#parseCamelName('predicate parameter');
        const type =
          this.#peek().text === ':' ? this.#parseTypeAnnotation() : undefined;
        const span = spanFromPositions(
          this.#file,
          paramStart.span.start,
          (type?.span ?? paramStart.span).end,
        );
        this.#claimName(
          names,
          paramStart.text,
          paramStart.span,
          'predicate parameter',
        );
        parameters.push({
          name: paramStart.text,
          ...(type === undefined ? {} : { type }),
          span,
          nameSpan: paramStart.span,
        });
        if (this.#peek().text !== ',') break;
        this.#take();
        if (this.#peek().text === ')') break;
      }
    }
    this.#expectText(')');
    const body = this.#parseTemplateBlock('predicate body', 'predicate');
    return {
      kind: 'predicate',
      name: name.text,
      parameters,
      body: body.template,
      span: spanBetween(start, body.close),
      nameSpan: name.span,
    };
  }

  #parseQuery(): SyqlQueryDeclaration {
    const start = this.#expectText('query');
    const name = this.#parseCamelName('query name');
    const parsedParameters = this.#parseQueryParameters();
    const publicNames = parsedParameters.publicNames;
    this.#expectText('{');

    if (this.#peek().text !== 'sql') {
      this.#fail(
        'SYQL2008_INVALID_MEMBER',
        this.#peek(),
        'a query body must begin with exactly one sql { ... } section',
      );
    }
    const sql = this.#parseSqlSection();

    let sort: SyqlSortSection | undefined;
    let page: SyqlPageDeclaration | undefined;
    let identity: SyqlIdentityDeclaration | undefined;

    if (this.#peek().text === 'sort') {
      sort = this.#parseSortSection(publicNames);
    }
    if (this.#peek().text === 'page') {
      page = this.#parsePageDeclaration(publicNames);
    }
    if (this.#peek().text === 'identity') {
      identity = this.#parseIdentityDeclaration();
    }

    if (this.#peek().text !== '}') {
      this.#fail(
        'SYQL2008_INVALID_MEMBER',
        this.#peek(),
        `unexpected or out-of-order query member ${JSON.stringify(this.#peek().text)}`,
      );
    }
    const close = this.#expectText('}');

    return {
      kind: 'query',
      name: name.text,
      parameters: parsedParameters.parameters,
      sql,
      ...(sort === undefined ? {} : { sort }),
      ...(page === undefined ? {} : { page }),
      ...(identity === undefined ? {} : { identity }),
      span: spanBetween(start, close),
      nameSpan: name.span,
    };
  }

  #parseQueryParameters(): ParsedQueryParameters {
    this.#expectText('(');
    const parameters: SyqlQueryParameter[] = [];
    const publicNames = new Set<string>();
    const bindNames = new Set<string>();

    if (this.#peek().text !== ')') {
      for (;;) {
        const name = this.#parseCamelName('query parameter');
        const optional = this.#peek().text === '?';
        if (optional) this.#take();

        if (optional && this.#peek().text === '(') {
          if (publicNames.has(name.text)) {
            this.#duplicate(name, 'public query input');
          }
          publicNames.add(name.text);
          this.#take();
          const members: SyqlGroupMember[] = [];
          for (;;) {
            const memberName = this.#parseCamelName('group member');
            if (memberName.text === name.text) {
              this.#fail(
                'SYQL2011_INVALID_PARAMETER',
                memberName,
                `group ${name.text} cannot contain a member with the same name`,
              );
            }
            if (bindNames.has(memberName.text)) {
              this.#duplicate(memberName, 'query bind');
            }
            bindNames.add(memberName.text);
            const type =
              this.#peek().text === ':'
                ? this.#parseTypeAnnotation()
                : undefined;
            members.push({
              name: memberName.text,
              ...(type === undefined ? {} : { type }),
              span: spanFromPositions(
                this.#file,
                memberName.span.start,
                (type?.span ?? memberName.span).end,
              ),
              nameSpan: memberName.span,
            });
            if (this.#peek().text !== ',') break;
            this.#take();
            if (this.#peek().text === ')') break;
          }
          const groupClose = this.#expectText(')');
          if (members.length < 2) {
            this.#fail(
              'SYQL2011_INVALID_PARAMETER',
              name,
              `group ${name.text} must contain at least two members`,
            );
          }
          parameters.push({
            kind: 'group',
            name: name.text,
            optional: true,
            members,
            span: spanFromPositions(
              this.#file,
              name.span.start,
              groupClose.span.end,
            ),
            nameSpan: name.span,
          });
        } else {
          if (publicNames.has(name.text)) {
            this.#duplicate(name, 'public query input');
          }
          publicNames.add(name.text);

          if (this.#peek().text === ':') {
            const colon = this.#take();
            const typeName = this.#expectKind('identifier', 'parameter type');
            if (typeName.text === 'switch') {
              if (!optional) {
                this.#fail(
                  'SYQL2011_INVALID_PARAMETER',
                  typeName,
                  `switch ${name.text} must use the exact optional form ${name.text}?: switch`,
                );
              }
              parameters.push({
                kind: 'switch',
                name: name.text,
                optional: true,
                span: spanBetween(name, typeName),
                nameSpan: name.span,
              });
            } else {
              const type = this.#parseValueTypeAfterName(colon, typeName);
              if (bindNames.has(name.text)) {
                this.#duplicate(name, 'query bind');
              }
              bindNames.add(name.text);
              parameters.push({
                kind: 'value',
                name: name.text,
                optional,
                type,
                span: spanFromPositions(
                  this.#file,
                  name.span.start,
                  type.span.end,
                ),
                nameSpan: name.span,
              });
            }
          } else {
            if (bindNames.has(name.text)) {
              this.#duplicate(name, 'query bind');
            }
            bindNames.add(name.text);
            parameters.push({
              kind: 'value',
              name: name.text,
              optional,
              span: spanFromPositions(
                this.#file,
                name.span.start,
                optional
                  ? (this.#previousSignificant() as SyqlToken).span.end
                  : name.span.end,
              ),
              nameSpan: name.span,
            });
          }
        }

        if (this.#peek().text !== ',') break;
        this.#take();
        if (this.#peek().text === ')') break;
      }
    }
    this.#expectText(')');
    return { parameters, publicNames, bindNames };
  }

  #parseSqlSection(): SyqlSqlSection {
    const start = this.#expectText('sql');
    const block = this.#parseTemplateBlock('sql section', 'statement');
    return {
      kind: 'sql',
      body: block.template,
      span: spanBetween(start, block.close),
    };
  }

  #parseSortSection(publicNames: Set<string>): SyqlSortSection {
    const start = this.#expectText('sort');
    const control = this.#parseCamelName('sort control');
    if (publicNames.has(control.text)) {
      this.#duplicate(control, 'public query input');
    }
    publicNames.add(control.text);
    this.#expectText('default');
    const defaultProfile = this.#parseCamelName('default sort profile');
    this.#expectText('{');

    const profiles: SyqlSortProfile[] = [];
    const profileNames = new Set<string>();
    while (this.#peek().text !== '}') {
      if (this.#peek().kind === 'eof') {
        this.#fail(
          'SYQL2001_EXPECTED_TOKEN',
          this.#peek(),
          'expected } to close sort section',
        );
      }
      const profileName = this.#parseCamelName('sort profile');
      if (profileNames.has(profileName.text)) {
        this.#duplicate(profileName, 'sort profile');
      }
      profileNames.add(profileName.text);
      const order = this.#parseTemplateBlock('sort profile', 'order');
      profiles.push({
        name: profileName.text,
        order: order.template,
        span: spanBetween(profileName, order.close),
        nameSpan: profileName.span,
      });
    }
    const close = this.#expectText('}');
    if (profiles.length === 0) {
      this.#fail(
        'SYQL2008_INVALID_MEMBER',
        close,
        'a sort section must contain at least one profile',
      );
    }
    if (!profileNames.has(defaultProfile.text)) {
      this.#fail(
        'SYQL2008_INVALID_MEMBER',
        defaultProfile,
        `default sort profile ${JSON.stringify(defaultProfile.text)} is not declared`,
      );
    }
    return {
      kind: 'sort',
      control: control.text,
      defaultProfile: defaultProfile.text,
      profiles,
      span: spanBetween(start, close),
      controlSpan: control.span,
    };
  }

  #parsePageDeclaration(publicNames: Set<string>): SyqlPageDeclaration {
    const start = this.#expectText('page');
    const control = this.#parseCamelName('page control');
    if (publicNames.has(control.text)) {
      this.#duplicate(control, 'public query input');
    }
    publicNames.add(control.text);
    this.#expectText('default');
    const defaultToken = this.#parseInteger('page default');
    this.#expectText('max');
    const maxToken = this.#parseInteger('page maximum');
    const end = this.#expectText(';');
    const defaultSize = Number(defaultToken.text);
    const maxSize = Number(maxToken.text);
    if (defaultSize < 1 || defaultSize > maxSize || maxSize > 2_147_483_647) {
      this.#fail(
        'SYQL2010_INVALID_PAGE_RANGE',
        defaultToken,
        `page bounds must satisfy 1 <= default <= max <= 2147483647; found default ${defaultSize}, max ${maxSize}`,
      );
    }
    return {
      kind: 'page',
      control: control.text,
      defaultSize,
      maxSize,
      span: spanBetween(start, end),
      controlSpan: control.span,
    };
  }

  #parseIdentityDeclaration(): SyqlIdentityDeclaration {
    const start = this.#expectText('identity');
    this.#expectText('by');
    const fields: string[] = [];
    const names = new Set<string>();
    for (;;) {
      const field = this.#expectKind('identifier', 'identity result name');
      if (!IDENT_RE.test(field.text)) {
        this.#fail(
          'SYQL2002_INVALID_NAME',
          field,
          `invalid identity result name ${JSON.stringify(field.text)}`,
        );
      }
      if (names.has(field.text)) this.#duplicate(field, 'identity field');
      names.add(field.text);
      fields.push(field.text);
      if (this.#peek().text !== ',') break;
      this.#take();
    }
    const end = this.#expectText(';');
    return { kind: 'identity', fields, span: spanBetween(start, end) };
  }

  #parseTypeAnnotation(): SyqlValueType {
    const colon = this.#expectText(':');
    const name = this.#expectKind('identifier', 'value type');
    return this.#parseValueTypeAfterName(colon, name);
  }

  #parseValueTypeAfterName(colon: SyqlToken, name: SyqlToken): SyqlValueType {
    if (!BASE_TYPES.has(name.text as SyqlBaseType)) {
      this.#fail(
        'SYQL2011_INVALID_PARAMETER',
        name,
        `unknown value type ${JSON.stringify(name.text)}`,
      );
    }
    let end = name;
    let nullable = false;
    if (this.#peek().text === '|') {
      this.#take();
      end = this.#expectText('null');
      nullable = true;
    }
    return {
      base: name.text as SyqlBaseType,
      nullable,
      span: spanBetween(colon, end),
    };
  }

  #parseInteger(label: string): SyqlToken {
    const token = this.#take();
    if (token.kind !== 'number' || !INTEGER_LITERAL_RE.test(token.text)) {
      this.#fail(
        'SYQL2009_INVALID_INTEGER',
        token,
        `${label} must be a decimal integer literal without sign or separators`,
      );
    }
    return token;
  }

  #parseTemplateBlock(label: string, mode: SyqlTemplateMode): ParsedBlock {
    const open = this.#expectText('{');
    const contentStart = this.#index;
    let depth = 1;
    let cursor = this.#index;
    while (cursor < this.#tokens.length) {
      const token = this.#tokens[cursor] as SyqlToken;
      if (token.kind === 'eof') {
        this.#fail(
          'SYQL2001_EXPECTED_TOKEN',
          token,
          `expected } to close ${label}`,
        );
      }
      if (token.kind === 'punctuation') {
        if (token.text === '{') depth += 1;
        else if (token.text === '}') {
          depth -= 1;
          if (depth === 0) {
            const bodyTokens = this.#tokens.slice(contentStart, cursor);
            const semanticTokens = bodyTokens.filter(
              (candidate) => !isSyqlTrivia(candidate),
            );
            if (semanticTokens.length === 0) {
              this.#fail(
                'SYQL2006_EMPTY_TEMPLATE',
                token,
                `${label} must not be empty`,
              );
            }
            if (
              semanticTokens.some(
                (candidate) =>
                  candidate.kind === 'punctuation' && candidate.text === ';',
              )
            ) {
              const semicolon = semanticTokens.find(
                (candidate) =>
                  candidate.kind === 'punctuation' && candidate.text === ';',
              ) as SyqlToken;
              this.#fail(
                'SYQL2007_FORBIDDEN_SEMICOLON',
                semicolon,
                `${label} must not contain a semicolon token`,
              );
            }
            const templateSpan = spanFromPositions(
              this.#file,
              open.span.end,
              token.span.start,
            );
            const tree = parseSyqlEmbeddedTemplate(
              this.#file,
              bodyTokens,
              templateSpan,
              mode,
            );
            this.#index = cursor + 1;
            return {
              template: {
                text: this.#source.slice(
                  open.span.end.offset,
                  token.span.start.offset,
                ),
                tokens: bodyTokens,
                tree,
                span: templateSpan,
              },
              open,
              close: token,
            };
          }
        }
      }
      cursor += 1;
    }
    throw new Error('unreachable: token stream always ends in EOF');
  }

  #parseCamelName(label: string): SyqlToken {
    const token = this.#expectKind('identifier', label);
    if (!CAMEL_IDENT_RE.test(token.text)) {
      this.#fail(
        'SYQL2002_INVALID_NAME',
        token,
        `${label} must match [a-z][A-Za-z0-9]*; found ${JSON.stringify(token.text)}`,
      );
    }
    if (token.text.toLowerCase().startsWith('__syql')) {
      this.#fail(
        'SYQL2003_RESERVED_NAME',
        token,
        `${JSON.stringify(token.text)} uses the reserved __syql prefix`,
      );
    }
    if (RESERVED_NAMES.has(token.text)) {
      this.#fail(
        'SYQL2003_RESERVED_NAME',
        token,
        `${JSON.stringify(token.text)} is a reserved SYQL name`,
      );
    }
    return token;
  }

  #claimName(
    names: Map<string, SyqlSourceSpan>,
    name: string,
    span: SyqlSourceSpan,
    label: string,
  ): void {
    if (names.has(name)) {
      throw new SyqlFrontendError(
        'SYQL2004_DUPLICATE_NAME',
        span,
        `duplicate ${label} ${JSON.stringify(name)}`,
      );
    }
    names.set(name, span);
  }

  #duplicate(token: SyqlToken, label: string): never {
    this.#fail(
      'SYQL2004_DUPLICATE_NAME',
      token,
      `duplicate ${label} ${JSON.stringify(token.text)}`,
    );
  }

  #peek(): SyqlToken {
    let index = this.#index;
    while (
      index < this.#tokens.length &&
      isSyqlTrivia(this.#tokens[index] as SyqlToken)
    ) {
      index += 1;
    }
    return this.#tokens[index] as SyqlToken;
  }

  #take(): SyqlToken {
    while (
      this.#index < this.#tokens.length &&
      isSyqlTrivia(this.#tokens[this.#index] as SyqlToken)
    ) {
      this.#index += 1;
    }
    const token = this.#tokens[this.#index] as SyqlToken;
    this.#index += 1;
    return token;
  }

  #previousSignificant(): SyqlToken | undefined {
    let index = this.#index - 1;
    while (index >= 0) {
      const token = this.#tokens[index] as SyqlToken;
      if (!isSyqlTrivia(token)) return token;
      index -= 1;
    }
    return undefined;
  }

  #expectText(text: string): SyqlToken {
    const token = this.#take();
    if (token.text !== text) {
      this.#fail(
        'SYQL2001_EXPECTED_TOKEN',
        token,
        `expected ${JSON.stringify(text)}, found ${JSON.stringify(token.text || 'end of file')}`,
      );
    }
    return token;
  }

  #expectKind(kind: SyqlToken['kind'], label: string): SyqlToken {
    const token = this.#take();
    if (token.kind !== kind) {
      this.#fail(
        'SYQL2001_EXPECTED_TOKEN',
        token,
        `expected ${label}, found ${JSON.stringify(token.text || 'end of file')}`,
      );
    }
    return token;
  }

  #fail(code: SyqlParseErrorCode, token: SyqlToken, message: string): never {
    throw new SyqlFrontendError(code, token.span, message);
  }
}

/** Parse one `.syql` file using the destructive revision-1 grammar. */
export function parseSyqlSyntaxFile(
  file: string,
  source: string,
): SyqlSyntaxFile {
  return new Parser(file, source).parse();
}

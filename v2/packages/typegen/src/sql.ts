/**
 * SQL migration subset parser (REVISE B5).
 *
 * Parses exactly the subset v1-style migrations need:
 *
 * - `CREATE TABLE [IF NOT EXISTS] name (columns…, [PRIMARY KEY (col)])
 *   [WITHOUT ROWID]`
 * - `ALTER TABLE name ADD [COLUMN] coldef`
 * - column defs: `name TYPE [PRIMARY KEY] [NOT NULL] [NULL]
 *   [DEFAULT literal]`
 * - `--` and C-style comments
 *
 * Anything else — other statements, table constraints, parameterized or
 * unknown types, DEFAULT expressions, quoted identifiers, composite
 * primary keys — is a hard error naming the unsupported construct.
 */
import { TypegenError } from './errors';
import type { IrColumn, IrColumnType } from './ir';

/** SQL type keyword → the §2.4 column types. Case-insensitive. */
const TYPE_MAP: Readonly<Record<string, IrColumnType>> = {
  TEXT: 'string',
  INTEGER: 'integer',
  INT: 'integer',
  BIGINT: 'integer',
  SMALLINT: 'integer',
  REAL: 'float',
  FLOAT: 'float',
  DOUBLE: 'float',
  BOOLEAN: 'boolean',
  BOOL: 'boolean',
  JSON: 'json',
  JSONB: 'json',
  BLOB: 'bytes',
  BYTEA: 'bytes',
  // §5.9 tag 7: a stored-as-TEXT column carrying a canonical BlobRef
  // document. The synthetic keyword designates the semantic type; the local
  // column is TEXT-shaped like `json`.
  BLOB_REF: 'blob_ref',
  BLOBREF: 'blob_ref',
};

export interface ParsedTable {
  readonly name: string;
  primaryKey: string;
  readonly columns: IrColumn[];
}

interface Token {
  readonly kind: 'word' | 'string' | 'number' | 'punct';
  readonly text: string;
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function tokenizeStatements(sql: string, source: string): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new TypegenError(source, 'unterminated comment');
      i = end + 2;
    } else if (ch === ';') {
      if (current.length > 0) statements.push(current);
      current = [];
      i += 1;
    } else if (ch === "'") {
      let text = '';
      i += 1;
      for (;;) {
        if (i >= sql.length) {
          throw new TypegenError(source, 'unterminated string literal');
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            text += "'";
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          text += sql[i];
          i += 1;
        }
      }
      current.push({ kind: 'string', text });
    } else if (ch === '"' || ch === '`' || ch === '[') {
      throw new TypegenError(
        source,
        `quoted identifiers are unsupported (found ${JSON.stringify(ch)})`,
      );
    } else if (WORD_START.test(ch)) {
      let end = i + 1;
      while (end < sql.length && WORD_PART.test(sql[end] as string)) end += 1;
      current.push({ kind: 'word', text: sql.slice(i, end) });
      i = end;
    } else if (DIGIT.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[0-9.]/.test(sql[end] as string)) end += 1;
      current.push({ kind: 'number', text: sql.slice(i, end) });
      i = end;
    } else if (ch === '(' || ch === ')' || ch === ',') {
      current.push({ kind: 'punct', text: ch });
      i += 1;
    } else {
      throw new TypegenError(
        source,
        `unsupported SQL syntax: unexpected character ${JSON.stringify(ch)}`,
      );
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

class Cursor {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  peek(): Token | undefined {
    return this.tokens[this.index];
  }

  next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) {
      throw new TypegenError(this.source, 'unexpected end of SQL statement');
    }
    this.index += 1;
    return token;
  }

  /** Consume a word token if it matches (case-insensitive). */
  eatWord(word: string): boolean {
    const token = this.peek();
    if (token?.kind === 'word' && token.text.toUpperCase() === word) {
      this.index += 1;
      return true;
    }
    return false;
  }

  expectWord(word: string, context: string): void {
    const token = this.next();
    if (token.kind !== 'word' || token.text.toUpperCase() !== word) {
      throw new TypegenError(
        this.source,
        `expected ${word} ${context}, found ${JSON.stringify(token.text)}`,
      );
    }
  }

  expectPunct(punct: string, context: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.text !== punct) {
      throw new TypegenError(
        this.source,
        `expected ${JSON.stringify(punct)} ${context}, found ${JSON.stringify(token.text)}`,
      );
    }
  }

  identifier(context: string): string {
    const token = this.next();
    if (token.kind !== 'word') {
      throw new TypegenError(
        this.source,
        `expected ${context}, found ${JSON.stringify(token.text)}`,
      );
    }
    return token.text;
  }

  expectEnd(): void {
    const token = this.peek();
    if (token !== undefined) {
      throw new TypegenError(
        this.source,
        `unsupported trailing SQL ${JSON.stringify(token.text)}`,
      );
    }
  }

  fail(message: string): never {
    throw new TypegenError(this.source, message);
  }
}

interface ColumnDef {
  readonly column: IrColumn;
  readonly primaryKey: boolean;
}

function parseColumnType(cursor: Cursor, columnName: string): IrColumnType {
  const typeWord = cursor.identifier(`a column type for ${columnName}`);
  if (cursor.peek()?.text === '(') {
    cursor.fail(
      `column ${columnName}: parameterized column types are unsupported (${typeWord}(…))`,
    );
  }
  const mapped = TYPE_MAP[typeWord.toUpperCase()];
  if (mapped === undefined) {
    cursor.fail(
      `column ${columnName}: unsupported column type ${JSON.stringify(typeWord)}`,
    );
  }
  return mapped;
}

function parseColumnDef(cursor: Cursor, allowPrimaryKey: boolean): ColumnDef {
  const name = cursor.identifier('a column name');
  const type = parseColumnType(cursor, name);
  let nullable = true;
  let primaryKey = false;
  for (;;) {
    const token = cursor.peek();
    if (token === undefined || token.kind === 'punct') break;
    const word = token.text.toUpperCase();
    if (word === 'PRIMARY') {
      cursor.next();
      cursor.expectWord('KEY', 'after PRIMARY');
      if (!allowPrimaryKey) {
        cursor.fail(
          `column ${name}: PRIMARY KEY is not supported on ADD COLUMN`,
        );
      }
      primaryKey = true;
      nullable = false;
    } else if (word === 'NOT') {
      cursor.next();
      cursor.expectWord('NULL', 'after NOT');
      nullable = false;
    } else if (word === 'NULL') {
      cursor.next();
    } else if (word === 'DEFAULT') {
      cursor.next();
      const value = cursor.next();
      if (value.kind === 'punct') {
        cursor.fail(
          `column ${name}: DEFAULT expressions are unsupported (only literals)`,
        );
      }
      // Literal defaults are accepted and ignored: typegen extracts the
      // schema shape; running migrations is the host's job.
    } else {
      cursor.fail(
        `column ${name}: unsupported column constraint ${JSON.stringify(token.text)}`,
      );
    }
  }
  if (primaryKey) nullable = false;
  return { column: { name, type, nullable }, primaryKey };
}

function parseCreateTable(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
  source: string,
): void {
  cursor.expectWord('TABLE', 'after CREATE');
  if (cursor.eatWord('IF')) {
    cursor.expectWord('NOT', 'after IF');
    cursor.expectWord('EXISTS', 'after IF NOT');
  }
  const name = cursor.identifier('a table name');
  if (tables.has(name)) {
    cursor.fail(`table ${name} is created twice`);
  }
  cursor.expectPunct('(', `after CREATE TABLE ${name}`);
  const columns: IrColumn[] = [];
  const primaryKeys: string[] = [];
  for (;;) {
    const head = cursor.peek();
    if (head?.kind === 'word') {
      const word = head.text.toUpperCase();
      if (word === 'PRIMARY') {
        cursor.next();
        cursor.expectWord('KEY', 'after PRIMARY');
        cursor.expectPunct('(', 'after PRIMARY KEY');
        primaryKeys.push(cursor.identifier('a primary-key column name'));
        if (cursor.peek()?.text === ',') {
          cursor.fail(`table ${name}: composite primary keys are unsupported`);
        }
        cursor.expectPunct(')', 'after the PRIMARY KEY column');
      } else if (
        word === 'FOREIGN' ||
        word === 'UNIQUE' ||
        word === 'CHECK' ||
        word === 'CONSTRAINT'
      ) {
        cursor.fail(
          `table ${name}: unsupported table constraint ${JSON.stringify(head.text)}`,
        );
      } else {
        const def = parseColumnDef(cursor, true);
        if (columns.some((c) => c.name === def.column.name)) {
          cursor.fail(
            `table ${name}: duplicate column ${JSON.stringify(def.column.name)}`,
          );
        }
        columns.push(def.column);
        if (def.primaryKey) primaryKeys.push(def.column.name);
      }
    } else {
      cursor.fail(`table ${name}: expected a column definition`);
    }
    const sep = cursor.next();
    if (sep.kind === 'punct' && sep.text === ',') continue;
    if (sep.kind === 'punct' && sep.text === ')') break;
    cursor.fail(
      `table ${name}: expected "," or ")", found ${JSON.stringify(sep.text)}`,
    );
  }
  if (cursor.eatWord('WITHOUT')) {
    cursor.expectWord('ROWID', 'after WITHOUT');
  }
  cursor.expectEnd();
  if (primaryKeys.length === 0) {
    throw new TypegenError(source, `table ${name} declares no primary key`);
  }
  if (primaryKeys.length > 1) {
    throw new TypegenError(
      source,
      `table ${name}: composite primary keys are unsupported (${primaryKeys.join(', ')})`,
    );
  }
  const primaryKey = primaryKeys[0] as string;
  const pkColumn = columns.find((c) => c.name === primaryKey);
  if (pkColumn === undefined) {
    throw new TypegenError(
      source,
      `table ${name}: primary key ${JSON.stringify(primaryKey)} is not a column`,
    );
  }
  const finalColumns = columns.map((c) =>
    c.name === primaryKey ? { ...c, nullable: false } : c,
  );
  tables.set(name, { name, primaryKey, columns: finalColumns });
}

function parseAlterTable(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
): void {
  cursor.expectWord('TABLE', 'after ALTER');
  const name = cursor.identifier('a table name');
  const table = tables.get(name);
  if (table === undefined) {
    cursor.fail(`ALTER TABLE ${name}: table does not exist at this point`);
  }
  const action = cursor.identifier('an ALTER TABLE action');
  if (action.toUpperCase() !== 'ADD') {
    cursor.fail(
      `ALTER TABLE ${name}: unsupported action ${JSON.stringify(action)} (only ADD COLUMN)`,
    );
  }
  cursor.eatWord('COLUMN');
  const def = parseColumnDef(cursor, false);
  cursor.expectEnd();
  if (table.columns.some((c) => c.name === def.column.name)) {
    cursor.fail(
      `ALTER TABLE ${name}: duplicate column ${JSON.stringify(def.column.name)}`,
    );
  }
  table.columns.push(def.column);
}

/**
 * Apply one migration file's SQL to the accumulated table map. Columns
 * accumulate in declaration order — the §2.4 row-codec positional order.
 */
export function applyMigrationSql(
  tables: Map<string, ParsedTable>,
  sql: string,
  source: string,
): void {
  for (const tokens of tokenizeStatements(sql, source)) {
    const cursor = new Cursor(tokens, source);
    const head = cursor.next();
    const word = head.kind === 'word' ? head.text.toUpperCase() : '';
    if (word === 'CREATE') {
      parseCreateTable(cursor, tables, source);
    } else if (word === 'ALTER') {
      parseAlterTable(cursor, tables);
    } else {
      throw new TypegenError(
        source,
        `unsupported SQL statement starting with ${JSON.stringify(head.text)} (only CREATE TABLE and ALTER TABLE … ADD COLUMN)`,
      );
    }
  }
}

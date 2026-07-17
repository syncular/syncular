/**
 * SQL migration subset parser (REVISE B5).
 *
 * Parses exactly the subset v1-style migrations need:
 *
 * - `CREATE TABLE [IF NOT EXISTS] name (columns…, [PRIMARY KEY (col)])
 *   [WITHOUT ROWID]`
 * - `ALTER TABLE name ADD [COLUMN] coldef`
 * - `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table (col [, col…])`
 * - `DROP INDEX [IF EXISTS] name`
 * - `DROP TABLE [IF EXISTS] name`
 * - `CREATE VIRTUAL TABLE name USING fts5(cols…, content=table,
 *   [tokenize='allowlisted tokenizer'])` (RFC 0005 local projection)
 * - column defs: `name TYPE [PRIMARY KEY] [NOT NULL] [NULL]
 *   [DEFAULT literal]`
 * - `--` and C-style comments
 *
 * Anything else — other statements, table constraints, parameterized or
 * unknown types, DEFAULT expressions, quoted identifiers, composite
 * primary keys, ASC/DESC or expression index columns, partial (`WHERE`)
 * indexes — is a hard error naming the unsupported construct.
 */
import { TypegenError } from './errors';
import type { IrColumn, IrColumnType, IrFtsIndex, IrIndex } from './ir';

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
  // §5.10 tag 8: a stored-as-BLOB column carrying opaque server-merged CRDT
  // bytes. The synthetic keyword designates the semantic type; crdtType
  // defaults to the one built-in merger (`yjs-doc`, §5.10.1).
  CRDT: 'crdt',
};

/** Default `crdtType` for a bare `CRDT` keyword (§5.10.1). */
const DEFAULT_CRDT_TYPE = 'yjs-doc';

export interface ParsedTable {
  readonly name: string;
  primaryKey: string;
  readonly columns: IrColumn[];
  /** Local secondary indexes, in declaration order (CREATE INDEX subset). */
  readonly indexes: IrIndex[];
  /** Client-local contentful FTS5 projections. */
  readonly ftsIndexes: IrFtsIndex[];
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
    } else if (ch === '(' || ch === ')' || ch === ',' || ch === '=') {
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
  // §5.10.1: a crdt column carries a crdtType (default `yjs-doc`).
  const column: IrColumn =
    type === 'crdt'
      ? { name, type, nullable, crdtType: DEFAULT_CRDT_TYPE }
      : { name, type, nullable };
  return { column, primaryKey };
}

/**
 * Dispatch a `CREATE …` statement: `CREATE TABLE`, `CREATE INDEX`, or
 * `CREATE UNIQUE INDEX`. Anything else is a hard error naming the construct.
 */
function parseCreate(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
  droppedTables: ReadonlySet<string>,
  source: string,
): void {
  if (cursor.eatWord('VIRTUAL')) {
    parseCreateVirtualTable(cursor, tables);
    return;
  }
  if (cursor.eatWord('TABLE')) {
    parseCreateTable(cursor, tables, droppedTables, source);
    return;
  }
  if (cursor.eatWord('UNIQUE')) {
    cursor.expectWord('INDEX', 'after CREATE UNIQUE');
    parseCreateIndex(cursor, tables, true);
    return;
  }
  if (cursor.eatWord('INDEX')) {
    parseCreateIndex(cursor, tables, false);
    return;
  }
  const token = cursor.peek();
  cursor.fail(
    `unsupported CREATE statement (only CREATE TABLE, CREATE [UNIQUE] INDEX, and CREATE VIRTUAL TABLE … USING fts5), found ${JSON.stringify(token?.text ?? '')}`,
  );
}

const ALLOWED_FTS_TOKENIZERS = new Set([
  'unicode61',
  'unicode61 remove_diacritics 0',
  'unicode61 remove_diacritics 1',
  'unicode61 remove_diacritics 2',
  'porter unicode61',
  'trigram',
]);

/** Parse the deliberately narrow migration-subset v2 FTS5 form documented in
 * RFC 0005. The virtual table is attached to its owning synced
 * table and is not itself a synced table. */
function parseCreateVirtualTable(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
): void {
  cursor.expectWord('TABLE', 'after CREATE VIRTUAL');
  if (cursor.eatWord('IF')) {
    cursor.expectWord('NOT', 'after IF');
    cursor.expectWord('EXISTS', 'after IF NOT');
  }
  const name = cursor.identifier('an FTS virtual-table name');
  if (tables.has(name)) {
    cursor.fail(`FTS virtual table ${name} conflicts with a synced table`);
  }
  for (const table of tables.values()) {
    if (
      table.indexes.some((index) => index.name === name) ||
      table.ftsIndexes.some((index) => index.name === name)
    ) {
      cursor.fail(
        `FTS virtual table ${name} is created twice or conflicts with an index`,
      );
    }
  }
  cursor.expectWord('USING', `after CREATE VIRTUAL TABLE ${name}`);
  cursor.expectWord('FTS5', `as the module for ${name}`);
  cursor.expectPunct('(', `after USING fts5 for ${name}`);
  const columns: string[] = [];
  let content: string | undefined;
  let tokenize = 'unicode61';
  let tokenizeDeclared = false;
  let sawOption = false;
  for (;;) {
    const field = cursor.identifier(`an FTS5 column or option for ${name}`);
    if (cursor.peek()?.text === '=') {
      sawOption = true;
      cursor.next();
      const value = cursor.next();
      if (value.kind !== 'word' && value.kind !== 'string') {
        cursor.fail(
          `FTS virtual table ${name}: ${field} needs a literal value`,
        );
      }
      if (field.toUpperCase() === 'CONTENT') {
        if (content !== undefined) {
          cursor.fail(`FTS virtual table ${name}: content is declared twice`);
        }
        content = value.text;
      } else if (field.toUpperCase() === 'TOKENIZE') {
        if (tokenizeDeclared) {
          cursor.fail(`FTS virtual table ${name}: tokenize is declared twice`);
        }
        if (!ALLOWED_FTS_TOKENIZERS.has(value.text)) {
          cursor.fail(
            `FTS virtual table ${name}: tokenizer ${JSON.stringify(value.text)} is not allowlisted`,
          );
        }
        tokenize = value.text;
        tokenizeDeclared = true;
      } else {
        cursor.fail(
          `FTS virtual table ${name}: unsupported FTS5 option ${JSON.stringify(field)}`,
        );
      }
    } else {
      if (sawOption) {
        cursor.fail(
          `FTS virtual table ${name}: indexed columns must precede FTS5 options`,
        );
      }
      if (columns.includes(field)) {
        cursor.fail(
          `FTS virtual table ${name}: column ${JSON.stringify(field)} appears twice`,
        );
      }
      columns.push(field);
    }
    const separator = cursor.next();
    if (separator.kind === 'punct' && separator.text === ',') continue;
    if (separator.kind === 'punct' && separator.text === ')') break;
    cursor.fail(
      `FTS virtual table ${name}: expected "," or ")", found ${JSON.stringify(separator.text)}`,
    );
  }
  cursor.expectEnd();
  if (content === undefined) {
    cursor.fail(
      `FTS virtual table ${name}: content = synced_table is required`,
    );
  }
  const table = tables.get(content);
  if (table === undefined) {
    cursor.fail(
      `FTS virtual table ${name}: content table ${JSON.stringify(content)} does not exist at this point`,
    );
  }
  if (columns.length === 0 || columns.length > 32) {
    cursor.fail(
      `FTS virtual table ${name}: between 1 and 32 columns are required`,
    );
  }
  for (const columnName of columns) {
    const column = table.columns.find(
      (candidate) => candidate.name === columnName,
    );
    if (column === undefined) {
      cursor.fail(
        `FTS virtual table ${name}: column ${JSON.stringify(columnName)} does not exist on table ${content}`,
      );
    }
    if (column.type !== 'string') {
      cursor.fail(
        `FTS virtual table ${name}: column ${JSON.stringify(columnName)} must have TEXT/string type`,
      );
    }
  }
  table.ftsIndexes.push({ name, columns, tokenize });
}

function parseCreateTable(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
  droppedTables: ReadonlySet<string>,
  source: string,
): void {
  if (cursor.eatWord('IF')) {
    cursor.expectWord('NOT', 'after IF');
    cursor.expectWord('EXISTS', 'after IF NOT');
  }
  const name = cursor.identifier('a table name');
  if (droppedTables.has(name)) {
    cursor.fail(
      `table ${name} cannot be re-created after DROP TABLE — table-name reuse is unsupported`,
    );
  }
  if (tables.has(name)) {
    cursor.fail(`table ${name} is created twice`);
  }
  for (const table of tables.values()) {
    if (
      table.indexes.some((index) => index.name === name) ||
      table.ftsIndexes.some((index) => index.name === name)
    ) {
      cursor.fail(`table ${name} conflicts with an index or FTS virtual table`);
    }
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
  tables.set(name, {
    name,
    primaryKey,
    columns: finalColumns,
    indexes: [],
    ftsIndexes: [],
  });
}

/**
 * `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table (col [, col…])`.
 * The `UNIQUE` keyword is already consumed by the dispatcher (it precedes
 * `INDEX`), so `unique` is passed in. The subset keeps the column list to
 * bare column names of the target table: ASC/DESC, expressions, and a `WHERE`
 * (partial index) clause are hard errors naming the construct. Index names
 * are unique per accumulated schema.
 */
function parseCreateIndex(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
  unique: boolean,
): void {
  // `INDEX` already matched by the dispatcher.
  if (cursor.eatWord('IF')) {
    cursor.expectWord('NOT', 'after IF');
    cursor.expectWord('EXISTS', 'after IF NOT');
  }
  const name = cursor.identifier('an index name');
  if (tables.has(name)) {
    cursor.fail(`index ${name} conflicts with a synced table`);
  }
  for (const table of tables.values()) {
    if (
      table.indexes.some((i) => i.name === name) ||
      table.ftsIndexes.some((i) => i.name === name)
    ) {
      cursor.fail(
        `index ${name} is created twice or conflicts with an FTS virtual table`,
      );
    }
  }
  cursor.expectWord('ON', `after CREATE INDEX ${name}`);
  const tableName = cursor.identifier('a table name');
  const table = tables.get(tableName);
  if (table === undefined) {
    cursor.fail(
      `CREATE INDEX ${name}: table ${tableName} does not exist at this point`,
    );
  }
  cursor.expectPunct('(', `after CREATE INDEX ${name} ON ${tableName}`);
  const columns: string[] = [];
  for (;;) {
    const col = cursor.identifier(`an index column for ${name}`);
    // Reject ASC/DESC and any expression tail: the IR stores bare column names
    // only, so accepting a direction would silently drop it. A following word
    // (not "," or ")") is such an unsupported construct.
    const after = cursor.peek();
    if (
      after !== undefined &&
      !(after.kind === 'punct' && (after.text === ',' || after.text === ')'))
    ) {
      const dir = after.text.toUpperCase();
      if (dir === 'ASC' || dir === 'DESC') {
        cursor.fail(
          `index ${name}: ASC/DESC index columns are unsupported (found ${JSON.stringify(after.text)} after ${JSON.stringify(col)})`,
        );
      }
      cursor.fail(
        `index ${name}: expression index columns are unsupported (found ${JSON.stringify(after.text)} after ${JSON.stringify(col)})`,
      );
    }
    if (table.columns.every((c) => c.name !== col)) {
      cursor.fail(
        `index ${name}: column ${JSON.stringify(col)} does not exist on table ${tableName}`,
      );
    }
    if (columns.includes(col)) {
      cursor.fail(`index ${name}: column ${JSON.stringify(col)} appears twice`);
    }
    columns.push(col);
    const sep = cursor.next();
    if (sep.kind === 'punct' && sep.text === ',') continue;
    if (sep.kind === 'punct' && sep.text === ')') break;
    cursor.fail(
      `index ${name}: expected "," or ")", found ${JSON.stringify(sep.text)}`,
    );
  }
  // A trailing token here is a partial-index `WHERE`, `COLLATE`, etc.
  const trailing = cursor.peek();
  if (trailing !== undefined) {
    if (trailing.kind === 'word' && trailing.text.toUpperCase() === 'WHERE') {
      cursor.fail(`index ${name}: partial indexes (WHERE …) are unsupported`);
    }
    cursor.fail(
      `index ${name}: unsupported trailing SQL ${JSON.stringify(trailing.text)}`,
    );
  }
  table.indexes.push({ name, columns, unique });
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

/** `DROP TABLE [IF EXISTS] name`; table-name reuse remains unsupported. */
function parseDropTable(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
  droppedTables: Set<string>,
): void {
  let ifExists = false;
  if (cursor.eatWord('IF')) {
    cursor.expectWord('EXISTS', 'after IF');
    ifExists = true;
  }
  const name = cursor.identifier('a table name');
  cursor.expectEnd();
  if (!tables.has(name)) {
    if (ifExists) return;
    cursor.fail(`DROP TABLE ${name}: table does not exist at this point`);
  }
  tables.delete(name);
  droppedTables.add(name);
}

/** Remove one declared secondary index from the accumulated head schema. */
function parseDropIndex(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
): void {
  let ifExists = false;
  if (cursor.eatWord('IF')) {
    cursor.expectWord('EXISTS', 'after IF');
    ifExists = true;
  }
  const name = cursor.identifier('an index name');
  cursor.expectEnd();
  for (const table of tables.values()) {
    const index = table.indexes.findIndex(
      (candidate) => candidate.name === name,
    );
    if (index < 0) continue;
    table.indexes.splice(index, 1);
    return;
  }
  if (!ifExists) {
    cursor.fail(`DROP INDEX ${name}: index does not exist at this point`);
  }
}

function parseDrop(
  cursor: Cursor,
  tables: Map<string, ParsedTable>,
  droppedTables: Set<string>,
): void {
  if (cursor.eatWord('TABLE')) {
    parseDropTable(cursor, tables, droppedTables);
    return;
  }
  if (cursor.eatWord('INDEX')) {
    parseDropIndex(cursor, tables);
    return;
  }
  const token = cursor.peek();
  cursor.fail(
    `unsupported DROP statement (only DROP TABLE and DROP INDEX), found ${JSON.stringify(token?.text ?? '')}`,
  );
}

/**
 * Apply one migration file's SQL to the accumulated table map. Columns
 * accumulate in declaration order — the §2.4 row-codec positional order.
 */
export function applyMigrationSql(
  tables: Map<string, ParsedTable>,
  sql: string,
  source: string,
  droppedTables: Set<string> = new Set<string>(),
): void {
  for (const tokens of tokenizeStatements(sql, source)) {
    const cursor = new Cursor(tokens, source);
    const head = cursor.next();
    const word = head.kind === 'word' ? head.text.toUpperCase() : '';
    if (word === 'CREATE') {
      parseCreate(cursor, tables, droppedTables, source);
    } else if (word === 'ALTER') {
      parseAlterTable(cursor, tables);
    } else if (word === 'DROP') {
      parseDrop(cursor, tables, droppedTables);
    } else {
      throw new TypegenError(
        source,
        `unsupported SQL statement starting with ${JSON.stringify(head.text)} (only CREATE TABLE, CREATE [UNIQUE] INDEX, CREATE VIRTUAL TABLE … USING fts5, ALTER TABLE … ADD COLUMN, DROP INDEX, and DROP TABLE)`,
      );
    }
  }
}

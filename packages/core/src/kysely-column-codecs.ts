import {
  type AliasNode,
  type ColumnNode,
  type ColumnUpdateNode,
  type DeleteQueryNode,
  type IdentifierNode,
  type InsertQueryNode,
  type KyselyPlugin,
  type OperationNode,
  OperationNodeTransformer,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type PrimitiveValueListNode,
  type QueryResult,
  type ReferenceNode,
  type RootOperationNode,
  type SelectionNode,
  type SelectQueryNode,
  type TableNode,
  type UnknownRow,
  type UpdateQueryNode,
  type ValueNode,
  type ValuesNode,
} from 'kysely';
import {
  type AnyColumnCodec,
  applyCodecFromDbValue,
  applyCodecToDbValue,
  type ColumnCodecDialect,
  type ColumnCodecSource,
  type TableColumnCodecs,
  toTableColumnCodecs,
} from './column-codecs';

interface ColumnCodecPluginOptions {
  codecs: ColumnCodecSource;
  dialect?: ColumnCodecDialect;
}

interface ColumnReference {
  outputKey: string;
  table: string;
  column: string;
}

interface QueryResultPlan {
  explicit: ColumnReference[];
  selectAllTables: string[];
}

function isIdentifierNode(
  node: OperationNode | undefined
): node is IdentifierNode {
  return node?.kind === 'IdentifierNode';
}

function isTableNode(node: OperationNode | undefined): node is TableNode {
  return node?.kind === 'TableNode';
}

function isAliasNode(node: OperationNode | undefined): node is AliasNode {
  return node?.kind === 'AliasNode';
}

function isColumnNode(node: OperationNode | undefined): node is ColumnNode {
  return node?.kind === 'ColumnNode';
}

function isReferenceNode(
  node: OperationNode | undefined
): node is ReferenceNode {
  return node?.kind === 'ReferenceNode';
}

function isSelectionNode(
  node: OperationNode | undefined
): node is SelectionNode {
  return node?.kind === 'SelectionNode';
}

function isPrimitiveValueListNode(
  node: OperationNode | undefined
): node is PrimitiveValueListNode {
  return node?.kind === 'PrimitiveValueListNode';
}

function isValuesNode(node: OperationNode | undefined): node is ValuesNode {
  return node?.kind === 'ValuesNode';
}

function isValueNode(node: OperationNode | undefined): node is ValueNode {
  return node?.kind === 'ValueNode';
}

function getIdentifierName(node?: OperationNode): string | undefined {
  if (!isIdentifierNode(node)) return undefined;
  return node?.name;
}

function getTableName(node?: OperationNode): string | undefined {
  if (!isTableNode(node)) return undefined;
  return getIdentifierName(node.table.identifier);
}

function getColumnName(node?: OperationNode): string | undefined {
  if (!isColumnNode(node)) return undefined;
  return getIdentifierName(node.column);
}

function getBaseTableFromAlias(node: AliasNode): string | undefined {
  if (!isTableNode(node.node)) return undefined;
  return getTableName(node.node);
}

function getAliasName(node: AliasNode): string | undefined {
  return getIdentifierName(node.alias);
}

function tableAliasMapForSelect(node: SelectQueryNode): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const fromItem of node.from?.froms ?? []) {
    if (isTableNode(fromItem)) {
      const tableName = getTableName(fromItem);
      if (tableName) aliases.set(tableName, tableName);
      continue;
    }
    if (isAliasNode(fromItem)) {
      const tableName = getBaseTableFromAlias(fromItem);
      const aliasName = getAliasName(fromItem);
      if (tableName && aliasName) aliases.set(aliasName, tableName);
    }
  }

  for (const join of node.joins ?? []) {
    const joinItem = join.table;
    if (isTableNode(joinItem)) {
      const tableName = getTableName(joinItem);
      if (tableName) aliases.set(tableName, tableName);
      continue;
    }
    if (isAliasNode(joinItem)) {
      const tableName = getBaseTableFromAlias(joinItem);
      const aliasName = getAliasName(joinItem);
      if (tableName && aliasName) aliases.set(aliasName, tableName);
    }
  }

  return aliases;
}

function resolveTableName(args: {
  refTable?: string;
  aliases: Map<string, string>;
  fallbackTable?: string;
}): string | undefined {
  if (args.refTable) {
    return args.aliases.get(args.refTable) ?? args.refTable;
  }
  if (args.fallbackTable) return args.fallbackTable;
  if (args.aliases.size === 1) {
    return args.aliases.values().next().value;
  }
  return undefined;
}

function collectSelectionReferences(args: {
  selections: readonly OperationNode[];
  aliases: Map<string, string>;
  fallbackTable?: string;
}): { explicit: ColumnReference[]; selectAllTables: string[] } {
  const explicit: ColumnReference[] = [];
  const selectAllTables: string[] = [];

  for (const selectionCandidate of args.selections) {
    if (!isSelectionNode(selectionCandidate)) continue;
    const selectionNode = selectionCandidate;
    const selection = selectionNode.selection;

    if (selection.kind === 'SelectAllNode') {
      const tableName = resolveTableName({
        aliases: args.aliases,
        fallbackTable: args.fallbackTable,
      });
      if (tableName) selectAllTables.push(tableName);
      continue;
    }

    if (selection.kind === 'ReferenceNode') {
      if (selection.column.kind === 'SelectAllNode') {
        const tableRef = getTableName(selection.table);
        const tableName = resolveTableName({
          refTable: tableRef,
          aliases: args.aliases,
          fallbackTable: args.fallbackTable,
        });
        if (tableName) selectAllTables.push(tableName);
        continue;
      }

      const columnName = getColumnName(selection.column);
      const tableRef = getTableName(selection.table);
      const tableName = resolveTableName({
        refTable: tableRef,
        aliases: args.aliases,
        fallbackTable: args.fallbackTable,
      });
      if (!columnName || !tableName) continue;

      explicit.push({
        outputKey: columnName,
        table: tableName,
        column: columnName,
      });
      continue;
    }

    if (selection.kind === 'AliasNode' && isReferenceNode(selection.node)) {
      const outputKey = getIdentifierName(selection.alias);
      if (!outputKey) continue;

      const reference = selection.node;
      if (reference.column.kind === 'SelectAllNode') {
        const tableRef = getTableName(reference.table);
        const tableName = resolveTableName({
          refTable: tableRef,
          aliases: args.aliases,
          fallbackTable: args.fallbackTable,
        });
        if (tableName) selectAllTables.push(tableName);
        continue;
      }

      const columnName = getColumnName(reference.column);
      const tableRef = getTableName(reference.table);
      const tableName = resolveTableName({
        refTable: tableRef,
        aliases: args.aliases,
        fallbackTable: args.fallbackTable,
      });
      if (!columnName || !tableName) continue;

      explicit.push({
        outputKey,
        table: tableName,
        column: columnName,
      });
    }
  }

  return { explicit, selectAllTables };
}

function planForSelect(node: SelectQueryNode): QueryResultPlan | null {
  if (!node.selections || node.selections.length === 0) return null;
  const aliases = tableAliasMapForSelect(node);
  const collected = collectSelectionReferences({
    selections: node.selections,
    aliases,
  });
  if (
    collected.explicit.length === 0 &&
    collected.selectAllTables.length === 0
  ) {
    return null;
  }
  return collected;
}

function planForInsert(node: InsertQueryNode): QueryResultPlan | null {
  if (!node.returning || node.returning.selections.length === 0) return null;
  const tableName = getTableName(node.into);
  if (!tableName) return null;
  const aliases = new Map<string, string>([[tableName, tableName]]);
  const collected = collectSelectionReferences({
    selections: node.returning.selections,
    aliases,
    fallbackTable: tableName,
  });
  if (
    collected.explicit.length === 0 &&
    collected.selectAllTables.length === 0
  ) {
    return null;
  }
  return collected;
}

function planForUpdate(node: UpdateQueryNode): QueryResultPlan | null {
  if (!node.returning || node.returning.selections.length === 0) return null;
  const tableName = getTableName(node.table);
  if (!tableName) return null;
  const aliases = new Map<string, string>([[tableName, tableName]]);
  const collected = collectSelectionReferences({
    selections: node.returning.selections,
    aliases,
    fallbackTable: tableName,
  });
  if (
    collected.explicit.length === 0 &&
    collected.selectAllTables.length === 0
  ) {
    return null;
  }
  return collected;
}

function planForDelete(node: DeleteQueryNode): QueryResultPlan | null {
  if (!node.returning || node.returning.selections.length === 0) return null;
  const fromTables = node.from?.froms ?? [];
  if (fromTables.length !== 1) return null;
  const fromItem = fromTables[0];
  if (!fromItem) return null;

  let tableName: string | undefined;
  if (isTableNode(fromItem)) {
    tableName = getTableName(fromItem);
  } else if (isAliasNode(fromItem)) {
    tableName = getBaseTableFromAlias(fromItem);
  }
  if (!tableName) return null;

  const aliases = new Map<string, string>([[tableName, tableName]]);
  const collected = collectSelectionReferences({
    selections: node.returning.selections,
    aliases,
    fallbackTable: tableName,
  });
  if (
    collected.explicit.length === 0 &&
    collected.selectAllTables.length === 0
  ) {
    return null;
  }
  return collected;
}

function buildResultPlan(node: RootOperationNode): QueryResultPlan | null {
  if (node.kind === 'SelectQueryNode') return planForSelect(node);
  if (node.kind === 'InsertQueryNode') return planForInsert(node);
  if (node.kind === 'UpdateQueryNode') return planForUpdate(node);
  if (node.kind === 'DeleteQueryNode') return planForDelete(node);
  return null;
}

function cacheKey(table: string, columns: readonly string[]): string {
  const sorted = [...columns].sort().join('\u0000');
  return `${table}\u0001${sorted}`;
}

class ColumnCodecsTransformer extends OperationNodeTransformer {
  readonly #codecs: ColumnCodecSource;
  readonly #dialect: ColumnCodecDialect;
  readonly #tableCodecsCache = new Map<string, TableColumnCodecs>();
  #currentUpdateTable: string | null = null;

  constructor(options: ColumnCodecPluginOptions) {
    super();
    this.#codecs = options.codecs;
    this.#dialect = options.dialect ?? 'sqlite';
  }

  resolveTableCodecs(
    table: string,
    columns: readonly string[]
  ): TableColumnCodecs {
    const key = cacheKey(table, columns);
    const cached = this.#tableCodecsCache.get(key);
    if (cached) return cached;
    const resolved = toTableColumnCodecs(table, this.#codecs, columns, {
      dialect: this.#dialect,
    });
    this.#tableCodecsCache.set(key, resolved);
    return resolved;
  }

  protected override transformInsertQuery(
    node: InsertQueryNode
  ): InsertQueryNode {
    const transformed = super.transformInsertQuery(node);
    if (!transformed.columns || transformed.columns.length === 0) {
      return transformed;
    }
    if (!isValuesNode(transformed.values)) {
      return transformed;
    }

    const tableName = getTableName(transformed.into);
    if (!tableName) return transformed;

    const columns = transformed.columns
      .map((columnNode) => getColumnName(columnNode))
      .filter((columnName): columnName is string => Boolean(columnName));
    if (columns.length === 0) return transformed;

    const tableCodecs = this.resolveTableCodecs(tableName, columns);

    let didChange = false;
    const nextValueRows = transformed.values.values.map((valueNode) => {
      if (!isPrimitiveValueListNode(valueNode)) return valueNode;

      const nextValues = valueNode.values.map(
        (value: unknown, index: number) => {
          const columnName = columns[index];
          if (!columnName) return value;
          const codec = tableCodecs[columnName];
          if (!codec) return value;
          const converted = applyCodecToDbValue(codec, value, this.#dialect);
          if (converted !== value) {
            didChange = true;
          }
          return converted;
        }
      );

      if (!didChange) return valueNode;
      return {
        ...valueNode,
        values: nextValues,
      };
    });

    if (!didChange) return transformed;

    const nextValuesNode: ValuesNode = {
      ...transformed.values,
      values: nextValueRows,
    };

    return {
      ...transformed,
      values: nextValuesNode,
    };
  }

  protected override transformUpdateQuery(
    node: UpdateQueryNode
  ): UpdateQueryNode {
    const previousTable = this.#currentUpdateTable;
    this.#currentUpdateTable = getTableName(node.table) ?? null;
    try {
      return super.transformUpdateQuery(node);
    } finally {
      this.#currentUpdateTable = previousTable;
    }
  }

  protected override transformColumnUpdate(
    node: ColumnUpdateNode,
    queryId?: { readonly queryId: string }
  ): ColumnUpdateNode {
    const transformed = super.transformColumnUpdate(node, queryId);
    if (!this.#currentUpdateTable) return transformed;
    if (!isValueNode(transformed.value)) return transformed;

    const columnName = getColumnName(transformed.column);
    if (!columnName) return transformed;

    const tableCodecs = this.resolveTableCodecs(this.#currentUpdateTable, [
      columnName,
    ]);
    const codec = tableCodecs[columnName];
    if (!codec) return transformed;

    const valueNode = transformed.value;
    const converted = applyCodecToDbValue(
      codec,
      valueNode.value,
      this.#dialect
    );
    if (converted === valueNode.value) return transformed;

    const nextValueNode: ValueNode = {
      ...valueNode,
      value: converted,
    };
    return {
      ...transformed,
      value: nextValueNode,
    };
  }
}

export class ColumnCodecsPlugin implements KyselyPlugin {
  readonly #dialect: ColumnCodecDialect;
  readonly #transformer: ColumnCodecsTransformer;
  readonly #resultPlans = new WeakMap<object, QueryResultPlan>();
  readonly #codecs: ColumnCodecSource;
  readonly #resultCodecCache = new Map<string, TableColumnCodecs>();

  constructor(options: ColumnCodecPluginOptions) {
    this.#dialect = options.dialect ?? 'sqlite';
    this.#codecs = options.codecs;
    this.#transformer = new ColumnCodecsTransformer(options);
  }

  transformQuery({
    node,
    queryId,
  }: PluginTransformQueryArgs): RootOperationNode {
    const transformed = this.#transformer.transformNode(node);
    const plan = buildResultPlan(transformed);
    if (plan) {
      this.#resultPlans.set(queryId, plan);
    }
    return transformed;
  }

  async transformResult({
    result,
    queryId,
  }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const plan = this.#resultPlans.get(queryId);
    if (!plan) return result;
    if (!result.rows || result.rows.length === 0) return result;

    const rows = result.rows.map((row) => this.#transformRow(row, plan));
    return {
      ...result,
      rows,
    };
  }

  #resolveTableCodecs(
    table: string,
    columns: readonly string[]
  ): TableColumnCodecs {
    const key = cacheKey(table, columns);
    const cached = this.#resultCodecCache.get(key);
    if (cached) return cached;
    const resolved = toTableColumnCodecs(table, this.#codecs, columns, {
      dialect: this.#dialect,
    });
    this.#resultCodecCache.set(key, resolved);
    return resolved;
  }

  #transformRow(row: UnknownRow, plan: QueryResultPlan): UnknownRow {
    const source = row as Record<string, unknown>;
    const target: Record<string, unknown> = { ...source };
    const rowColumns = Object.keys(source);

    if (plan.selectAllTables.length > 0) {
      const codecCandidates = new Map<string, AnyColumnCodec>();
      const ambiguousColumns = new Set<string>();

      for (const table of plan.selectAllTables) {
        const tableCodecs = this.#resolveTableCodecs(table, rowColumns);
        for (const [column, codec] of Object.entries(tableCodecs)) {
          if (!(column in source)) continue;
          const existing = codecCandidates.get(column);
          if (existing && existing !== codec) {
            ambiguousColumns.add(column);
            continue;
          }
          codecCandidates.set(column, codec);
        }
      }

      for (const [column, codec] of codecCandidates.entries()) {
        if (ambiguousColumns.has(column)) continue;
        target[column] = applyCodecFromDbValue(
          codec,
          target[column],
          this.#dialect
        );
      }
    }

    for (const ref of plan.explicit) {
      if (!(ref.outputKey in source)) continue;
      const tableCodecs = this.#resolveTableCodecs(ref.table, [ref.column]);
      const codec = tableCodecs[ref.column];
      if (!codec) continue;
      target[ref.outputKey] = applyCodecFromDbValue(
        codec,
        target[ref.outputKey],
        this.#dialect
      );
    }

    return target;
  }
}

export function createColumnCodecsPlugin(
  options: ColumnCodecPluginOptions
): ColumnCodecsPlugin {
  return new ColumnCodecsPlugin(options);
}

import {
  type ColumnUpdateNode,
  type KyselyPlugin,
  OperationNodeTransformer,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type PrimitiveValueListNode,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
  type ValueNode,
} from 'kysely';

type Serializer = (parameter: unknown) => unknown;
type Deserializer = (parameter: unknown) => unknown;

const dateRegex = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;

function isBufferLike(value: object): value is { buffer: unknown } {
  return 'buffer' in value;
}

function skipTransform(parameter: unknown): boolean {
  if (
    parameter === undefined ||
    parameter === null ||
    typeof parameter === 'bigint' ||
    typeof parameter === 'number'
  ) {
    return true;
  }

  if (typeof parameter === 'object') {
    return isBufferLike(parameter);
  }

  return false;
}

function maybeJson(parameter: string): boolean {
  return (
    (parameter.startsWith('{') && parameter.endsWith('}')) ||
    (parameter.startsWith('[') && parameter.endsWith(']'))
  );
}

const defaultSerializer: Serializer = (parameter) => {
  if (skipTransform(parameter) || typeof parameter === 'string') {
    return parameter;
  }

  if (typeof parameter === 'boolean') {
    return String(parameter);
  }

  if (parameter instanceof Date) {
    return parameter.toISOString();
  }

  try {
    return JSON.stringify(parameter);
  } catch {
    return parameter;
  }
};

const defaultDeserializer: Deserializer = (parameter) => {
  if (skipTransform(parameter)) {
    return parameter;
  }

  if (typeof parameter !== 'string') {
    return parameter;
  }

  if (parameter === 'true') return true;
  if (parameter === 'false') return false;
  if (dateRegex.test(parameter)) return new Date(parameter);

  if (maybeJson(parameter)) {
    try {
      return JSON.parse(parameter);
    } catch {
      return parameter;
    }
  }

  return parameter;
};

class SerializeParametersTransformer extends OperationNodeTransformer {
  readonly #serializer: Serializer;

  constructor(serializer: Serializer) {
    super();
    this.#serializer = serializer;
  }

  protected override transformPrimitiveValueList(
    node: PrimitiveValueListNode
  ): PrimitiveValueListNode {
    return {
      ...node,
      values: node.values.map((v) => this.#serializer(v)),
    };
  }

  protected override transformColumnUpdate(
    node: ColumnUpdateNode,
    queryId?: { readonly queryId: string }
  ): ColumnUpdateNode {
    const valueNode = node.value;
    if (valueNode.kind !== 'ValueNode') {
      return super.transformColumnUpdate(node, queryId);
    }

    const currentValue = (valueNode as ValueNode).value;
    const serializedValue = this.#serializer(currentValue);
    if (currentValue === serializedValue) {
      return super.transformColumnUpdate(node, queryId);
    }

    const updatedValue: ValueNode = {
      ...(valueNode as ValueNode),
      value: serializedValue,
    };

    return super.transformColumnUpdate(
      { ...node, value: updatedValue },
      queryId
    );
  }

  protected override transformValue(node: ValueNode): ValueNode {
    return { ...node, value: this.#serializer(node.value) };
  }
}

class BaseSerializePlugin implements KyselyPlugin {
  readonly #transformer: SerializeParametersTransformer;
  readonly #deserializer: Deserializer;
  readonly #skipNodeSet: Set<RootOperationNode['kind']> | null;
  readonly #ctx: WeakSet<object> | null;

  /**
   * Base class for {@link SerializePlugin}, without default options.
   */
  constructor(
    serializer: Serializer,
    deserializer: Deserializer,
    skipNodeKind: Array<RootOperationNode['kind']>
  ) {
    this.#transformer = new SerializeParametersTransformer(serializer);
    this.#deserializer = deserializer;
    if (skipNodeKind.length > 0) {
      this.#skipNodeSet = new Set(skipNodeKind);
      this.#ctx = new WeakSet<object>();
    } else {
      this.#skipNodeSet = null;
      this.#ctx = null;
    }
  }

  transformQuery({
    node,
    queryId,
  }: PluginTransformQueryArgs): RootOperationNode {
    if (this.#skipNodeSet?.has(node.kind)) {
      this.#ctx?.add(queryId);
      return node;
    }
    return this.#transformer.transformNode(node);
  }

  async transformResult({
    result,
    queryId,
  }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    if (this.#ctx?.has(queryId)) {
      return result;
    }
    return { ...result, rows: this.#parseRows(result.rows) };
  }

  #parseRows(rows: UnknownRow[]): UnknownRow[] {
    const out: UnknownRow[] = [];
    for (const row of rows) {
      if (!row) continue;
      const parsed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        parsed[key] = this.#deserializer(value);
      }
      out.push(parsed);
    }
    return out;
  }
}

export interface SerializePluginOptions {
  serializer?: Serializer;
  deserializer?: Deserializer;
  skipNodeKind?: Array<RootOperationNode['kind']>;
}

export class SerializePlugin extends BaseSerializePlugin {
  constructor(options: SerializePluginOptions = {}) {
    const {
      serializer = defaultSerializer,
      deserializer = defaultDeserializer,
      skipNodeKind = [],
    } = options;
    super(serializer, deserializer, skipNodeKind);
  }
}

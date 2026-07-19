import type { IrDocument } from '../../../../packages/typegen/src/ir';

export interface PlaygroundExample {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly source: string;
  readonly schemaId: keyof typeof PLAYGROUND_SCHEMAS;
}

const TODOS_SCHEMA = {
  irVersion: 1,
  schemaVersion: 1,
  schemaVersions: [{ version: 1, migrations: ['0001_todos'] }],
  tables: [
    {
      name: 'todos',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'status', type: 'string', nullable: true },
        { name: 'created_at', type: 'integer', nullable: false },
        { name: 'assignee_id', type: 'string', nullable: true },
        { name: 'done', type: 'boolean', nullable: false },
      ],
      scopes: [
        { pattern: 'list:{list_id}', variable: 'list_id', column: 'list_id' },
      ],
      indexes: [
        {
          name: 'todos_list_created',
          columns: ['list_id', 'created_at'],
          unique: false,
        },
      ],
      ftsIndexes: [],
      extensions: {},
    },
  ],
  subscriptions: [],
  extensions: {},
} as const satisfies IrDocument;

export const PLAYGROUND_SCHEMAS = {
  todos: TODOS_SCHEMA,
} as const satisfies Readonly<Record<string, IrDocument>>;

export const PLAYGROUND_EXAMPLES = [
  {
    id: 'basic',
    label: 'Basic',
    description: 'Required input, typed projection, and inferred row identity.',
    schemaId: 'todos',
    source: `query listTodos(listId) {
  select id, title, status, done, created_at
  from todos
  where todos.list_id = :listId
  order by created_at desc, id desc;
}`,
  },
  {
    id: 'optional',
    label: 'Optional filters',
    description:
      'Nullable presence, an inclusive range, and a default-false flag.',
    schemaId: 'todos',
    source: `query findTodos(
  listId,
  status?: string | null,
  range?,
  unassigned: bool = false,
) {
  select id, title, status, created_at
  from todos
  where todos.list_id = :listId
    and when(status) status is :status
    and when(range) created_at between :range
    and when(unassigned) assignee_id is null
  order by created_at desc, id desc;
}`,
  },
  {
    id: 'sort-limit',
    label: 'Sort + limit',
    description: 'Closed sort profiles and a runtime-validated bounded limit.',
    schemaId: 'todos',
    source: `query sortedTodos(listId) {
  select id, title, status, created_at
  from todos
  where todos.list_id = :listId
  order by sortBy default newest {
    newest: created_at desc, id desc;
    oldest: created_at asc, id asc;
    title: title collate nocase asc, id asc;
  }
  limit pageSize default 50 max 200;
}`,
  },
  {
    id: 'sync-coverage',
    label: 'Sync coverage',
    description:
      'A scoped sync query whose required predicate proves download coverage.',
    schemaId: 'todos',
    source: `sync query syncTodos(listId) {
  select id, list_id, title, status, created_at
  from todos
  where todos.list_id = :listId
  order by created_at desc, id desc;
}`,
  },
  {
    id: 'predicate',
    label: 'Predicate',
    description: 'A reusable local predicate expanded hygienically into SQL.',
    schemaId: 'todos',
    source: `predicate matchesTitle(value: string) {
  title like '%' || :value || '%'
}

query searchTodos(listId, q: string) {
  select id, title, status, created_at
  from todos
  where todos.list_id = :listId
    and matchesTitle(:q)
  order by created_at desc, id desc;
}`,
  },
] as const satisfies readonly PlaygroundExample[];

export function playgroundExample(id: string | null): PlaygroundExample {
  return (
    PLAYGROUND_EXAMPLES.find((example) => example.id === id) ??
    PLAYGROUND_EXAMPLES[0]
  );
}

export function schemaSummary(
  schemaId: keyof typeof PLAYGROUND_SCHEMAS,
): string {
  const schema = PLAYGROUND_SCHEMAS[schemaId];
  return schema.tables
    .map((table) => {
      const scopes = table.scopes.map((scope) => scope.column).join(', ');
      return `${table.name} · ${table.columns.length} columns${scopes.length === 0 ? '' : ` · scope ${scopes}`}`;
    })
    .join(' / ');
}

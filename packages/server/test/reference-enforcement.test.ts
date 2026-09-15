/**
 * Declared-reference enforcement (SPEC.md §6.11): the check runs once per
 * commit after every client operation is staged and before whole-commit
 * validation, reads candidate state, and appends cascade operations to the
 * same commit. Driven through bytes like the rest of the push suite.
 */
import { describe, expect, test } from 'bun:test';
import { encodeRow, type PushOperation, type RowColumn } from '@syncular/core';
import type { ResponseMessage } from '@syncular/core';
import { compileSchema, type ServerSchema } from '@syncular/server';
import {
  del,
  makeContext,
  pushCommit,
  pushResults,
  sync,
  upsert,
} from './helpers';

const PARENT_COLUMNS: readonly RowColumn[] = [
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];

const CHILD_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'label', type: 'string', nullable: false },
  { name: 'restrict_parent', type: 'string', nullable: true },
  { name: 'cascade_parent', type: 'string', nullable: true },
  { name: 'nullify_parent', type: 'string', nullable: true },
];

const REFERENCE_SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'projects',
      columns: PARENT_COLUMNS,
      primaryKey: 'project_id',
      scopes: ['project:{project_id}'],
    },
    {
      name: 'items',
      columns: CHILD_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      references: [
        {
          column: 'restrict_parent',
          parentTable: 'projects',
          onDelete: 'RESTRICT',
        },
        {
          column: 'cascade_parent',
          parentTable: 'projects',
          onDelete: 'CASCADE',
        },
        {
          column: 'nullify_parent',
          parentTable: 'projects',
          onDelete: 'SET NULL',
        },
      ],
      indexes: [
        { name: 'idx_items_restrict_parent_ref', columns: ['restrict_parent'] },
        { name: 'idx_items_cascade_parent_ref', columns: ['cascade_parent'] },
        { name: 'idx_items_nullify_parent_ref', columns: ['nullify_parent'] },
      ],
    },
  ],
};

function projectRow(projectId: string, title = 'project'): Uint8Array {
  return encodeRow(PARENT_COLUMNS, [projectId, title]);
}

function itemRow(
  id: string,
  projectId: string,
  parents: {
    readonly restrict?: string | null;
    readonly cascade?: string | null;
    readonly nullify?: string | null;
  } = {},
): Uint8Array {
  return encodeRow(CHILD_COLUMNS, [
    id,
    projectId,
    'item',
    parents.restrict ?? null,
    parents.cascade ?? null,
    parents.nullify ?? null,
  ]);
}

/** The §6.3.1 companion frame carries the structured details; the legacy
 * record deliberately does not. */
function rejectionDetails(
  message: ResponseMessage,
): readonly { readonly opIndex: number; readonly details: unknown }[] {
  const frame = message.frames.find(
    (candidate) => candidate.type === 'PUSH_RESULT_DETAILS',
  );
  return frame?.type === 'PUSH_RESULT_DETAILS' ? frame.entries : [];
}

function referenceContext(
  overrides?: Parameters<typeof makeContext>[0],
): ReturnType<typeof makeContext> {
  return makeContext({
    schema: REFERENCE_SCHEMA,
    resolveScopes: () => ({ project_id: ['p1'] }),
    ...overrides,
  });
}

async function seed(
  t: ReturnType<typeof makeContext>,
  commitId: string,
  table: string,
  rowId: string,
  payload: Uint8Array,
): Promise<void> {
  const message = await sync(t, [
    pushCommit(commitId, [upsert(table, rowId, payload)]),
  ]);
  const result = pushResults(message)[0];
  expect(result?.status).toBe('applied');
}

describe('declared references (§6.11)', () => {
  test('an upsert naming an absent parent rejects with missing_parent details', async () => {
    const t = referenceContext();
    await seed(t, 'c1', 'projects', 'p1', projectRow('p1'));
    const message = await sync(t, [
      pushCommit('c2', [
        upsert('items', 'i1', itemRow('i1', 'p1', { restrict: 'ghost' })),
      ]),
    ]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('rejected');
    const record = result?.results[0];
    if (record?.status !== 'error') throw new Error('expected an error record');
    expect(record.code).toBe('sync.reference_violation');
    expect(record.retryable).toBe(false);
    expect(rejectionDetails(message)).toEqual([
      {
        opIndex: 0,
        details: {
          reason: 'missing_parent',
          fieldPaths: ['restrict_parent'],
          references: { parent: 'projects', row: 'ghost' },
        },
      },
    ]);
    // The whole commit rolls back.
    expect(await t.storage.getRow('part-1', 'items', 'i1')).toBeUndefined();
  });

  test('RESTRICT blocks a parent delete while a child remains', async () => {
    const t = referenceContext();
    await seed(t, 'c1', 'projects', 'p1', projectRow('p1'));
    await seed(t, 'c2', 'items', 'i1', itemRow('i1', 'p1', { restrict: 'p1' }));
    const message = await sync(t, [pushCommit('c3', [del('projects', 'p1')])]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('rejected');
    const record = result?.results[0];
    if (record?.status !== 'error') throw new Error('expected an error record');
    expect(record.code).toBe('sync.reference_violation');
    expect(rejectionDetails(message)).toEqual([
      {
        opIndex: 0,
        details: {
          reason: 'restricted_delete',
          references: { child: 'items' },
        },
      },
    ]);
    expect(await t.storage.getRow('part-1', 'projects', 'p1')).toBeDefined();
  });

  test('CASCADE appends the child delete inside the same commit', async () => {
    const t = referenceContext();
    await seed(t, 'c1', 'projects', 'p1', projectRow('p1'));
    await seed(t, 'c2', 'items', 'i1', itemRow('i1', 'p1', { cascade: 'p1' }));
    const message = await sync(t, [pushCommit('c3', [del('projects', 'p1')])]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('applied');
    expect(await t.storage.getRow('part-1', 'projects', 'p1')).toBeUndefined();
    expect(await t.storage.getRow('part-1', 'items', 'i1')).toBeUndefined();
    const seq = result?.commitSeq;
    if (seq === undefined) throw new Error('expected a commitSeq');
    const window = await t.storage.readCommitWindow('part-1', {
      table: 'items',
      scopeFilter: { project_id: ['p1'] },
      afterSeq: seq - 1,
      throughSeq: seq,
      limitChanges: 10,
    });
    expect(window.flatMap((commit) => commit.changes)).toEqual([
      expect.objectContaining({ table: 'items', rowId: 'i1', op: 'delete' }),
    ]);
  });

  test('SET NULL clears the reference column in the same commit', async () => {
    const t = referenceContext();
    await seed(t, 'c1', 'projects', 'p1', projectRow('p1'));
    await seed(t, 'c2', 'items', 'i1', itemRow('i1', 'p1', { nullify: 'p1' }));
    await sync(t, [pushCommit('c3', [del('projects', 'p1')])]);
    const child = await t.storage.getRow('part-1', 'items', 'i1');
    expect(child?.serverVersion).toBe(2);
    expect(child).toBeDefined();
  });

  test('a commit deleting parent and children together passes RESTRICT', async () => {
    const t = referenceContext();
    await seed(t, 'c1', 'projects', 'p1', projectRow('p1'));
    await seed(t, 'c2', 'items', 'i1', itemRow('i1', 'p1', { restrict: 'p1' }));
    const operations: PushOperation[] = [
      del('items', 'i1'),
      del('projects', 'p1'),
    ];
    const message = await sync(t, [pushCommit('c3', operations)]);
    expect(pushResults(message)[0]?.status).toBe('applied');
  });

  test('a cascade past the cap rejects with cascade_limit', async () => {
    const t = referenceContext({
      limits: { maxCascadeOperationsPerCommit: 3 },
    });
    await seed(t, 'c1', 'projects', 'p1', projectRow('p1'));
    for (const id of ['i1', 'i2', 'i3', 'i4']) {
      await seed(
        t,
        `c-${id}`,
        'items',
        id,
        itemRow(id, 'p1', { cascade: 'p1' }),
      );
    }
    const message = await sync(t, [pushCommit('c5', [del('projects', 'p1')])]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('rejected');
    const record = result?.results[0];
    if (record?.status !== 'error') throw new Error('expected an error record');
    expect(record.code).toBe('sync.reference_violation');
    expect(rejectionDetails(message)).toEqual([
      { opIndex: 0, details: { reason: 'cascade_limit' } },
    ]);
    expect(await t.storage.getRow('part-1', 'projects', 'p1')).toBeDefined();
  });
});

describe('reference schema compilation (§6.11)', () => {
  function withChildren(
    references: NonNullable<ServerSchema['tables'][number]['references']>,
    indexes: NonNullable<ServerSchema['tables'][number]['indexes']>,
  ): ServerSchema {
    return {
      version: 1,
      tables: [
        REFERENCE_SCHEMA.tables[0] as ServerSchema['tables'][number],
        {
          ...(REFERENCE_SCHEMA.tables[1] as ServerSchema['tables'][number]),
          references,
          indexes,
        },
      ],
    };
  }

  test('unknown parent, missing index, and scope mismatch fail loud', () => {
    expect(() =>
      compileSchema(
        withChildren(
          [{ column: 'restrict_parent', parentTable: 'ghosts' }],
          [
            {
              name: 'idx_items_restrict_parent_ref',
              columns: ['restrict_parent'],
            },
          ],
        ),
      ),
    ).toThrow(/names unknown table "ghosts"/);
    expect(() =>
      compileSchema(
        withChildren(
          [{ column: 'restrict_parent', parentTable: 'projects' }],
          [],
        ),
      ),
    ).toThrow(/needs a declared single-column index/);
    expect(() =>
      compileSchema({
        version: 1,
        tables: [
          REFERENCE_SCHEMA.tables[0] as ServerSchema['tables'][number],
          {
            ...(REFERENCE_SCHEMA.tables[1] as ServerSchema['tables'][number]),
            scopes: ['org:{project_id}'],
            references: [
              { column: 'restrict_parent', parentTable: 'projects' },
            ],
            indexes: [
              {
                name: 'idx_items_restrict_parent_ref',
                columns: ['restrict_parent'],
              },
            ],
          },
        ],
      }),
    ).toThrow(/MUST NOT cross an authorization boundary/);
  });
});

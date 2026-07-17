/**
 * Manifest validation and IR construction fail loud: unknown keys,
 * migration/table mismatches, bad scope patterns, bad subscription
 * templates, and gappy schema-version history are all hard errors.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildIr,
  type Manifest,
  type MigrationInput,
  parseManifest,
  TypegenError,
} from '../src';

const BASE_RAW = {
  manifestVersion: 1,
  schemaVersions: [{ version: 1, through: '0001_initial' }],
  tables: [{ name: 'tasks', scopes: ['project:{project_id}'] }],
};

const MIGRATIONS: MigrationInput[] = [
  {
    name: '0001_initial',
    sql: 'CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)',
  },
];

function manifest(overrides: Record<string, unknown> = {}): Manifest {
  return parseManifest({ ...BASE_RAW, ...overrides });
}

function expectFail(fn: () => unknown, pattern: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TypegenError);
  expect((error as TypegenError).message).toMatch(pattern);
}

describe('parseManifest', () => {
  test('defaults are applied', () => {
    const m = manifest();
    expect(m.migrations).toBe('./migrations');
    expect(m.output).toEqual({
      ir: './syncular.ir.json',
      module: './syncular.generated.ts',
    });
    expect(m.subscriptions).toEqual([]);
    expect(m.extensions).toEqual({});
  });

  test('unknown keys are rejected at every level', () => {
    expectFail(
      () => parseManifest({ ...BASE_RAW, extra: true }),
      /unknown key "extra"/,
    );
    expectFail(
      () =>
        manifest({
          tables: [{ name: 't', scopes: ['a:{b}'], typo: 1 }],
        }),
      /unknown key "typo"/,
    );
    // `output.swift`/`kotlin`/`dart`/`rust` are recognized emitter keys;
    // an unrelated typo in `output` is still rejected.
    expectFail(
      () => manifest({ output: { typo: './x' } }),
      /unknown key "typo"/,
    );
    // Native-emitter option objects still reject their own unknown keys.
    expectFail(
      () => manifest({ output: { kotlin: { path: './x', bogus: 1 } } }),
      /output\.kotlin has unknown key "bogus"/,
    );
  });

  test('Rust output is object-only with a required path and validated crate alias', () => {
    const parsed = manifest({
      output: { rust: { queriesPath: './src/syncular_queries.rs' } },
    });
    expect(parsed.output.rust).toEqual({
      queriesPath: './src/syncular_queries.rs',
      clientCrate: 'syncular_client',
    });
    expectFail(
      () => manifest({ output: { rust: './queries.rs' } }),
      /output\.rust must be an object/,
    );
    expectFail(
      () => manifest({ output: { rust: {} } }),
      /output\.rust\.queriesPath must be a non-empty string/,
    );
    expectFail(
      () =>
        manifest({
          output: {
            rust: { queriesPath: './queries.rs', clientCrate: 'crate::client' },
          },
        }),
      /must be one Rust identifier/,
    );
    expectFail(
      () =>
        manifest({
          output: {
            rust: { queriesPath: './queries.rs', clientCrate: 'type' },
          },
        }),
      /must be one Rust identifier/,
    );
  });

  test('manifestVersion must be 1', () => {
    expectFail(
      () => parseManifest({ ...BASE_RAW, manifestVersion: 2 }),
      /manifestVersion must be 1/,
    );
  });

  test('tables need at least one scope pattern', () => {
    expectFail(
      () => manifest({ tables: [{ name: 'tasks', scopes: [] }] }),
      /scopes must be a non-empty array/,
    );
  });

  test('schemaVersions must be strictly increasing', () => {
    expectFail(
      () =>
        manifest({
          schemaVersions: [
            { version: 2, through: 'a' },
            { version: 2, through: 'b' },
          ],
        }),
      /strictly increasing/,
    );
  });

  test('subscription names must be identifiers', () => {
    expectFail(
      () =>
        manifest({
          subscriptions: [
            { name: 'my-tasks', table: 'tasks', scopes: { a: ['b'] } },
          ],
        }),
      /must be a valid identifier/,
    );
  });
});

describe('buildIr cross-checks', () => {
  test('manifest table missing from migrations', () => {
    expectFail(
      () =>
        buildIr(
          manifest({
            tables: [
              { name: 'tasks', scopes: ['project:{project_id}'] },
              { name: 'ghosts', scopes: ['g:{id}'] },
            ],
          }),
          MIGRATIONS,
        ),
      /table "ghosts" is not created by any migration/,
    );
  });

  test('migrated table missing from the manifest', () => {
    expectFail(
      () =>
        buildIr(manifest(), [
          {
            name: '0001_initial',
            sql: `${MIGRATIONS[0]?.sql}; CREATE TABLE hidden (id TEXT PRIMARY KEY)`,
          },
        ]),
      /migrated table "hidden" is missing from the manifest/,
    );
  });

  test('a table retired by the head migration is omitted from the manifest and IR', () => {
    const ir = buildIr(
      manifest({
        schemaVersions: [
          { version: 1, through: '0001_initial' },
          { version: 2, through: '0002_retire_hidden' },
        ],
      }),
      [
        {
          name: '0001_initial',
          sql: `${MIGRATIONS[0]?.sql}; CREATE TABLE hidden (id TEXT PRIMARY KEY)`,
        },
        { name: '0002_retire_hidden', sql: 'DROP TABLE hidden' },
      ],
    );
    expect(ir.schemaVersion).toBe(2);
    expect(ir.tables.map((table) => table.name)).toEqual(['tasks']);
  });

  test('a dropped table name cannot be reused by a later migration', () => {
    expectFail(
      () =>
        buildIr(
          manifest({
            schemaVersions: [
              { version: 1, through: '0001_initial' },
              { version: 2, through: '0002_recreate' },
            ],
          }),
          [
            MIGRATIONS[0]!,
            {
              name: '0002_recreate',
              sql: 'DROP TABLE tasks; CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)',
            },
          ],
        ),
      /cannot be re-created after DROP TABLE/,
    );
  });

  test('scope pattern must reference an existing column', () => {
    expectFail(
      () =>
        buildIr(
          manifest({ tables: [{ name: 'tasks', scopes: ['team:{team_id}'] }] }),
          MIGRATIONS,
        ),
      /names unknown column "team_id"/,
    );
  });

  test('malformed scope pattern', () => {
    expectFail(
      () =>
        buildIr(
          manifest({ tables: [{ name: 'tasks', scopes: ['no-variable'] }] }),
          MIGRATIONS,
        ),
      /must be 'prefix:\{variable\}'/,
    );
  });

  test('variable mapping to two different columns', () => {
    expectFail(
      () =>
        buildIr(
          manifest({
            tables: [
              {
                name: 'tasks',
                scopes: [
                  'p:{project_id}',
                  { pattern: 'q:{project_id}', column: 'id' },
                ],
              },
            ],
          }),
          MIGRATIONS,
        ),
      /maps to two different columns/,
    );
  });

  test('subscription referencing an unknown table', () => {
    expectFail(
      () =>
        buildIr(
          manifest({
            subscriptions: [{ name: 'x', table: 'nope', scopes: { a: ['b'] } }],
          }),
          MIGRATIONS,
        ),
      /subscription x: unknown table "nope"/,
    );
  });

  test('subscription referencing an undeclared scope variable', () => {
    expectFail(
      () =>
        buildIr(
          manifest({
            subscriptions: [
              { name: 'x', table: 'tasks', scopes: { org_id: ['o1'] } },
            ],
          }),
          MIGRATIONS,
        ),
      /"org_id" is not a scope variable of table tasks/,
    );
  });

  test('partial placeholder templates are rejected', () => {
    expectFail(
      () =>
        buildIr(
          manifest({
            subscriptions: [
              {
                name: 'x',
                table: 'tasks',
                scopes: { project_id: ['p-{projectId}'] },
              },
            ],
          }),
          MIGRATIONS,
        ),
      /mixes literals and placeholders/,
    );
  });

  test("requested '*' is rejected (§3.2)", () => {
    expectFail(
      () =>
        buildIr(
          manifest({
            subscriptions: [
              { name: 'x', table: 'tasks', scopes: { project_id: ['*'] } },
            ],
          }),
          MIGRATIONS,
        ),
      /'\*' is rejected in requested scopes/,
    );
  });

  test('schema versions must cover every migration', () => {
    expectFail(
      () =>
        buildIr(manifest(), [
          ...MIGRATIONS,
          { name: '0002_more', sql: 'ALTER TABLE tasks ADD note TEXT' },
        ]),
      /migrations 0002_more are not covered/,
    );
    expectFail(
      () =>
        buildIr(
          manifest({ schemaVersions: [{ version: 1, through: 'nope' }] }),
          MIGRATIONS,
        ),
      /names migration "nope", which does not exist/,
    );
  });

  test('extensions pass through with sorted keys', () => {
    const ir = buildIr(
      manifest({ extensions: { zeta: 1, alpha: { b: 2, a: 1 } } }),
      MIGRATIONS,
    );
    expect(Object.keys(ir.extensions)).toEqual(['alpha', 'zeta']);
  });
});

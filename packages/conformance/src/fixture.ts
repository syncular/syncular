/**
 * The shared scenario fixture: a two-table schema exercising single- and
 * multi-variable scope declarations (§3.1) and every non-bytes column
 * type (§2.4; bytes columns are pinned by the golden vectors).
 */
import type { DriverRow, DriverSchema, DriverTable } from './driver';

export const PARTITION = 'part-1';

export const FIXTURE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'done', type: 'boolean', nullable: false },
        { name: 'priority', type: 'integer', nullable: true },
        { name: 'meta', type: 'json', nullable: true },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
    {
      name: 'docs',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'org_id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [
        { pattern: 'org:{org_id}' },
        { pattern: 'project:{projectId}', column: 'project_id' },
      ],
    },
  ],
};

/** A schema-version bump of the fixture (same tables, version 2). */
export const FIXTURE_SCHEMA_V2: DriverSchema = {
  ...FIXTURE_SCHEMA,
  version: 2,
};

/**
 * A version-2 bump that DROPS the `tasks.meta` column (§7.4.4): a pending
 * outbox commit that set `meta` cannot re-encode under this schema and
 * surfaces as `sync.outbox_incompatible`. The server side is created with
 * this same schema so the surviving commits still converge.
 */
export const FIXTURE_SCHEMA_V2_DROP_META: DriverSchema = {
  version: 2,
  tables: [
    {
      name: 'tasks',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'done', type: 'boolean', nullable: false },
        { name: 'priority', type: 'integer', nullable: true },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
    FIXTURE_SCHEMA.tables[1] as DriverTable,
  ],
};

export function task(
  id: string,
  projectId: string,
  title = 'task',
  done = false,
  priority: number | null = null,
  meta: string | null = null,
): DriverRow {
  return { id, project_id: projectId, title, done, priority, meta };
}

export function doc(
  id: string,
  orgId: string,
  projectId: string,
  body = 'body',
): DriverRow {
  return { id, org_id: orgId, project_id: projectId, body };
}

/** Wildcard grant for every fixture scope variable (§3.2 step 3). */
export const ALL_SCOPES: Readonly<Record<string, readonly string[]>> = {
  project_id: ['*'],
  projectId: ['*'],
  org_id: ['*'],
};

/**
 * §6.11 reference fixture: `projects` is the parent, `items` the child, with
 * one reference column per `ON DELETE` behavior. Parent and child declare the
 * same scope pattern, so every cascade stays inside one authorization
 * boundary.
 */
export const REFERENCE_FIXTURE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'projects',
      columns: [
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      primaryKey: 'project_id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
    {
      name: 'items',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'label', type: 'string', nullable: false },
        { name: 'restrict_parent', type: 'string', nullable: true },
        { name: 'cascade_parent', type: 'string', nullable: true },
        { name: 'nullify_parent', type: 'string', nullable: true },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
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
    },
  ],
};

export function project(projectId: string, title = 'project'): DriverRow {
  return { project_id: projectId, title };
}

export function item(
  id: string,
  projectId: string,
  label = 'item',
  parents: {
    readonly restrict?: string | null;
    readonly cascade?: string | null;
    readonly nullify?: string | null;
  } = {},
): DriverRow {
  return {
    id,
    project_id: projectId,
    label,
    restrict_parent: parents.restrict ?? null,
    cascade_parent: parents.cascade ?? null,
    nullify_parent: parents.nullify ?? null,
  };
}

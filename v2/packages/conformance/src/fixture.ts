/**
 * The shared scenario fixture: a two-table schema exercising single- and
 * multi-variable scope declarations (§3.1) and every non-bytes column
 * type (§2.4; bytes columns are pinned by the golden vectors).
 */
import type { DriverRow, DriverSchema } from './driver';

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

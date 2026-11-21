/**
 * The shared scenario fixture: a two-table schema exercising single- and
 * multi-variable scope declarations (§3.1) and every non-bytes column
 * type (§2.4; bytes columns are pinned by the golden vectors).
 */
import type {
  DriverAuthorityQuery,
  DriverRow,
  DriverSchema,
  DriverTable,
} from './driver';

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

/**
 * A version-2 bump that ADDS a non-nullable `tasks.owner` column (§7.1,
 * §7.4.6): a pending insert-intent commit written under v1 lacks it and cannot
 * encode, which the pre-reset audit reports as `missing-required-column`.
 */
export const FIXTURE_SCHEMA_V2_ADD_REQUIRED: DriverSchema = {
  version: 2,
  tables: [
    {
      ...(FIXTURE_SCHEMA.tables[0] as DriverTable),
      columns: [
        ...(FIXTURE_SCHEMA.tables[0] as DriverTable).columns,
        { name: 'owner', type: 'string', nullable: false },
      ],
    },
    FIXTURE_SCHEMA.tables[1] as DriverTable,
  ],
};

/**
 * A version-2 bump that DROPS the `docs` table (§7.4.4): a pending outbox
 * commit for `docs` has no local mirror to replay into and cannot re-encode,
 * so it surfaces as `sync.outbox_incompatible` instead of failing the boot
 * reset with `sync.unknown_table`.
 */
export const FIXTURE_SCHEMA_V2_DROP_DOCS: DriverSchema = {
  version: 2,
  tables: [FIXTURE_SCHEMA.tables[0] as DriverTable],
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

/**
 * SPEC §5.11 authority fixture: an OP pointer (`surgeries`), its seal
 * (`surgery_sealed_identities`), the record-key wrap (`record_key_wraps`,
 * scoped by recipient and sealer) and the workspace participant table.
 */
export const AUTHORITY_FIXTURE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'surgeries',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'workspace_id', type: 'string', nullable: false },
        { name: 'practice_facility_id', type: 'string', nullable: false },
        { name: 'sealed_identity_id', type: 'string', nullable: true },
      ],
      primaryKey: 'id',
      scopes: [
        { pattern: 'opread:{op_read_workspace_id}', column: 'workspace_id' },
      ],
    },
    {
      name: 'surgery_sealed_identities',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'workspace_id', type: 'string', nullable: false },
        { name: 'record_key_id', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [
        { pattern: 'opread:{op_read_workspace_id}', column: 'workspace_id' },
      ],
    },
    {
      name: 'record_key_wraps',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'record_key_id', type: 'string', nullable: false },
        { name: 'recipient_facility_id', type: 'string', nullable: false },
        { name: 'sealer_facility_id', type: 'string', nullable: false },
        { name: 'epoch_id', type: 'string', nullable: false },
        { name: 'expires_at_ms', type: 'integer', nullable: true },
        { name: 'revoked_at_ms', type: 'integer', nullable: true },
        { name: 'wrapped_key', type: 'bytes', nullable: true },
      ],
      primaryKey: 'id',
      scopes: [
        { pattern: 'key-wraps:{recipient_facility_id}' },
        { pattern: 'sealer:{sealer_facility_id}' },
      ],
    },
    {
      name: 'workspace_participants',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'workspace_id', type: 'string', nullable: false },
        { name: 'facility_id', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [
        { pattern: 'access:{workspace_access_id}', column: 'workspace_id' },
      ],
    },
  ],
};

const WRAP_COVER_SQL =
  'select count(w.id) > 0 as qualifying, max(w.expires_at_ms) as latest_expires_at_ms, ' +
  'coalesce(max(w.expires_at_ms is null), 0) as unbounded_expiry ' +
  'from surgeries as s ' +
  'join surgery_sealed_identities as i on i.id = s.sealed_identity_id and i.workspace_id = s.workspace_id ' +
  'join record_key_wraps as w on w.record_key_id = i.record_key_id ' +
  'join workspace_participants as p on p.workspace_id = s.workspace_id ' +
  'where s.workspace_id = ? and w.recipient_facility_id = ? and p.facility_id = ? ' +
  'and w.epoch_id = ? and w.revoked_at_ms is null ' +
  'and (w.expires_at_ms is null or w.expires_at_ms > ?)';

const WRAP_COVER_PARAMS: DriverAuthorityQuery['params'] = [
  { name: 'centreFacilityId', type: 'string', nullable: false },
  { name: 'workspaceId', type: 'string', nullable: false },
  { name: 'epochId', type: 'string', nullable: false },
  { name: 'trustedNowMs', type: 'integer', nullable: false },
];

const WRAP_COVER_READS: DriverAuthorityQuery['reads'] = {
  record_key_wraps: [
    'epoch_id',
    'expires_at_ms',
    'id',
    'recipient_facility_id',
    'record_key_id',
    'revoked_at_ms',
  ],
  surgeries: ['sealed_identity_id', 'workspace_id'],
  surgery_sealed_identities: ['id', 'record_key_id', 'workspace_id'],
  workspace_participants: ['facility_id', 'workspace_id'],
};

const WRAP_COVER_RESULT: DriverAuthorityQuery['resultColumns'] = [
  { name: 'qualifying', type: 'boolean', nullable: false },
  { name: 'latest_expires_at_ms', type: 'integer', nullable: true },
  { name: 'unbounded_expiry', type: 'boolean', nullable: false },
];

/** Diego's centre query as typegen emits it (SYQL.md §13.3). */
export const CENTRE_WRAP_COVER: DriverAuthorityQuery = {
  name: 'centreRecordWrapCover',
  sql: WRAP_COVER_SQL,
  bind: [
    'workspaceId',
    'centreFacilityId',
    'centreFacilityId',
    'epochId',
    'trustedNowMs',
  ],
  params: WRAP_COVER_PARAMS,
  coverage: [
    {
      table: 'record_key_wraps',
      variable: 'recipient_facility_id',
      units: ['centreFacilityId'],
    },
    {
      table: 'surgeries',
      variable: 'op_read_workspace_id',
      units: ['workspaceId'],
    },
    {
      table: 'surgery_sealed_identities',
      variable: 'op_read_workspace_id',
      units: ['workspaceId'],
    },
    {
      table: 'workspace_participants',
      variable: 'workspace_access_id',
      units: ['workspaceId'],
    },
  ],
  reads: WRAP_COVER_READS,
  resultColumns: WRAP_COVER_RESULT,
};

/**
 * The centre query with the sealer integrity chain: the wrap's sealer is
 * the OP's practice. The chain proves `sealer_facility_id`, a fixed scope of
 * the wrap entry, so a recipient-only unit proves it by the subset rule.
 */
export const CENTRE_WRAP_COVER_SEALED: DriverAuthorityQuery = {
  ...CENTRE_WRAP_COVER,
  name: 'centreRecordWrapCoverSealed',
  sql: `${WRAP_COVER_SQL} and w.sealer_facility_id = ? and s.practice_facility_id = ?`,
  bind: [...CENTRE_WRAP_COVER.bind, 'sealerFacilityId', 'sealerFacilityId'],
  params: [
    ...WRAP_COVER_PARAMS,
    { name: 'sealerFacilityId', type: 'string', nullable: false },
  ],
  coverage: CENTRE_WRAP_COVER.coverage.map((entry) =>
    entry.table === 'record_key_wraps'
      ? { ...entry, fixedScopes: { sealer_facility_id: 'sealerFacilityId' } }
      : entry,
  ),
  reads: {
    ...WRAP_COVER_READS,
    record_key_wraps: [
      ...(WRAP_COVER_READS['record_key_wraps'] ?? []),
      'sealer_facility_id',
    ].sort(),
    surgeries: ['practice_facility_id', 'sealed_identity_id', 'workspace_id'],
  },
};

/** A per-project lookup of accepted task originals (SPEC §5.11). */
export const TASK_ORIGINALS: DriverAuthorityQuery = {
  name: 'taskOriginals',
  sql: 'select t.id, t.project_id, t.title, t._sync_version as server_version from tasks as t where t.project_id = ? order by t.id',
  bind: ['projectId'],
  params: [{ name: 'projectId', type: 'string', nullable: false }],
  coverage: [{ table: 'tasks', variable: 'project_id', units: ['projectId'] }],
  reads: { tasks: ['_sync_version', 'id', 'project_id', 'title'] },
  resultColumns: [
    { name: 'id', type: 'string', nullable: false },
    { name: 'project_id', type: 'string', nullable: false },
    { name: 'title', type: 'string', nullable: false },
    { name: 'server_version', type: 'integer', nullable: false },
  ],
};

export function surgery(
  id: string,
  workspaceId: string,
  sealedIdentityId: string | null,
  practiceFacilityId = 'p1',
): DriverRow {
  return {
    id,
    workspace_id: workspaceId,
    practice_facility_id: practiceFacilityId,
    sealed_identity_id: sealedIdentityId,
  };
}

export function sealedIdentity(
  id: string,
  workspaceId: string,
  recordKeyId: string,
): DriverRow {
  return { id, workspace_id: workspaceId, record_key_id: recordKeyId };
}

export function wrap(
  id: string,
  recordKeyId: string,
  expiresAtMs: number | null,
  options: {
    readonly recipient?: string;
    readonly sealer?: string;
    readonly epoch?: string;
    readonly revokedAtMs?: number | null;
  } = {},
): DriverRow {
  return {
    id,
    record_key_id: recordKeyId,
    recipient_facility_id: options.recipient ?? 'c1',
    sealer_facility_id: options.sealer ?? 'p1',
    epoch_id: options.epoch ?? 'e1',
    expires_at_ms: expiresAtMs,
    revoked_at_ms: options.revokedAtMs ?? null,
    wrapped_key: null,
  };
}

export function participant(
  id: string,
  workspaceId: string,
  facilityId: string,
): DriverRow {
  return { id, workspace_id: workspaceId, facility_id: facilityId };
}

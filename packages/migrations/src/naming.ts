/**
 * @syncular/migrations - Migration tracking table naming helpers
 */

export type MigrationTrackingTableNamePart =
  | string
  | number
  | null
  | undefined
  | false;

export interface CreateMigrationTrackingTableNameOptions {
  /**
   * Optional namespace prefix placed before the scope segments.
   * Defaults to `sync`.
   */
  namespace?:
    | MigrationTrackingTableNamePart
    | readonly MigrationTrackingTableNamePart[];
  /**
   * Optional suffix segments appended after `migration_state`.
   */
  suffix?:
    | MigrationTrackingTableNamePart
    | readonly MigrationTrackingTableNamePart[];
}

export const DEFAULT_MIGRATION_TRACKING_TABLE = 'sync_migration_state';

function normalizeTrackingTableNamePart(
  part: MigrationTrackingTableNamePart
): string | null {
  if (part === null || part === undefined || part === false) {
    return null;
  }

  const normalized = String(part)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  return normalized.length > 0 ? normalized : null;
}

function normalizeTrackingTableNameParts(
  input:
    | MigrationTrackingTableNamePart
    | readonly MigrationTrackingTableNamePart[]
    | undefined
): string[] {
  if (Array.isArray(input)) {
    return input
      .map((part) => normalizeTrackingTableNamePart(part))
      .filter((part): part is string => part !== null);
  }

  const normalized = normalizeTrackingTableNamePart(
    input as MigrationTrackingTableNamePart
  );
  return normalized ? [normalized] : [];
}

/**
 * Create a stable migration tracking table name.
 *
 * The generated name always includes the `migration_state` suffix and
 * normalizes segments to lowercase snake_case.
 *
 * @example
 * createMigrationTrackingTableName()
 * // => 'sync_migration_state'
 *
 * @example
 * createMigrationTrackingTableName('server')
 * // => 'sync_server_migration_state'
 *
 * @example
 * createMigrationTrackingTableName(['spaces', 'billing'], {
 *   suffix: ['prod', 'v2'],
 * })
 * // => 'sync_spaces_billing_migration_state_prod_v2'
 */
export function createMigrationTrackingTableName(
  scope?:
    | MigrationTrackingTableNamePart
    | readonly MigrationTrackingTableNamePart[],
  options: CreateMigrationTrackingTableNameOptions = {}
): string {
  const namespace =
    options.namespace === undefined ? ['sync'] : options.namespace;
  const segments = [
    ...normalizeTrackingTableNameParts(namespace),
    ...normalizeTrackingTableNameParts(scope),
    'migration',
    'state',
    ...normalizeTrackingTableNameParts(options.suffix),
  ];

  if (segments.length === 0) {
    return DEFAULT_MIGRATION_TRACKING_TABLE;
  }

  return segments.join('_');
}

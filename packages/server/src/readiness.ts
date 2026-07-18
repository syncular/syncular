/**
 * Explicit server startup readiness.
 *
 * Protocol handlers ensure storage lazily for embeddability, but a production
 * host must prove schema compatibility before it binds an HTTP/WebSocket port.
 * This helper accepts the generated ServerSchema, compiles it once, and exposes
 * a structured failure that cannot be confused with request authentication.
 */
import type { SyncServerConfig } from './context';
import { type CompiledSchema, compileSchema } from './schema';

export const SYNC_SERVER_READINESS_ERROR_CODE =
  'sync.schema_not_ready' as const;

export type SyncServerReadinessPhase = 'schema_compile' | 'storage_migration';

export class SyncServerReadinessError extends Error {
  override readonly name = 'SyncServerReadinessError';
  readonly code = SYNC_SERVER_READINESS_ERROR_CODE;
  readonly phase: SyncServerReadinessPhase;
  readonly schemaVersion: number;

  constructor(options: {
    readonly phase: SyncServerReadinessPhase;
    readonly schemaVersion: number;
    readonly cause: unknown;
  }) {
    super(
      `Syncular server schema ${options.schemaVersion} is not ready (${options.phase})`,
      { cause: options.cause },
    );
    this.phase = options.phase;
    this.schemaVersion = options.schemaVersion;
  }
}

/**
 * Compile and migrate the configured server storage before listening.
 *
 * Pass the same canonical config used by HTTP and realtime. The thrown error
 * exposes only a stable code, phase, and schema version; operators can inspect
 * `cause` locally for the table/column or storage diagnostic.
 */
export async function ensureSyncServerReady(
  config: Pick<SyncServerConfig, 'schema' | 'storage'>,
): Promise<void> {
  let compiled: CompiledSchema;
  try {
    compiled = compileSchema(config.schema);
  } catch (cause) {
    throw new SyncServerReadinessError({
      phase: 'schema_compile',
      schemaVersion: config.schema.version,
      cause,
    });
  }
  try {
    await config.storage.ensureSchema(compiled);
  } catch (cause) {
    throw new SyncServerReadinessError({
      phase: 'storage_migration',
      schemaVersion: config.schema.version,
      cause,
    });
  }
}

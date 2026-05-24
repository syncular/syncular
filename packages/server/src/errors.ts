export class SyncClientSchemaUnsupportedError extends Error {
  readonly code = 'sync.client_schema_unsupported' as const;
  readonly schemaVersion: number | null;
  readonly supportedSchemaVersions: readonly number[];

  constructor(options: {
    schemaVersion: number | null | undefined;
    supportedSchemaVersions: readonly number[];
  }) {
    const schemaVersion = options.schemaVersion ?? null;
    super(
      `Client schema version ${
        schemaVersion ?? 'unknown'
      } is not supported. Supported client schema versions: ${options.supportedSchemaVersions.join(
        ', '
      )}.`
    );
    this.name = 'SyncClientSchemaUnsupportedError';
    this.schemaVersion = schemaVersion;
    this.supportedSchemaVersions = options.supportedSchemaVersions;
  }
}

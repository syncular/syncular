/**
 * `syncular-v2 init` — drop a starter `syncular.json` + `migrations/0001_initial`
 * into an existing project (the "add syncular to my app" path). Writes nothing
 * that would clobber an existing manifest or migration; fails loud instead.
 *
 * The starter mirrors the `create-app` minimal template's schema shape so the
 * two on-ramps agree. Kept dependency-free and pure of process concerns.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MANIFEST_FILENAME } from './manifest';

const STARTER_MANIFEST = `{
  "manifestVersion": 1,
  "migrations": "./migrations",
  "output": {
    "ir": "./syncular.ir.json",
    "module": "./src/syncular.generated.ts"
  },
  "schemaVersions": [{ "version": 1, "through": "0001_initial" }],
  "tables": [{ "name": "notes", "scopes": ["list:{list_id}"] }],
  "subscriptions": [
    {
      "name": "notesInList",
      "table": "notes",
      "scopes": { "list_id": ["{listId}"] }
    }
  ]
}
`;

const STARTER_MIGRATION = `-- Your first table. typegen reads this for the schema SHAPE (column types,
-- primary key); the server manages its own sync_* tables and never runs it.
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`;

export interface InitResult {
  readonly written: readonly string[];
}

/** Errors that carry a friendly, actionable message for the CLI. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitError';
  }
}

/**
 * Create the starter files under `dir`. Refuses to overwrite an existing
 * manifest or `migrations/0001_initial/up.sql`.
 */
export function initProject(dir: string): InitResult {
  const root = resolve(dir);
  const manifestPath = join(root, MANIFEST_FILENAME);
  const migrationDir = join(root, 'migrations', '0001_initial');
  const migrationPath = join(migrationDir, 'up.sql');

  if (existsSync(manifestPath)) {
    throw new InitError(
      `${manifestPath} already exists — refusing to overwrite. ` +
        'Edit it directly, or run `syncular-v2 generate`.',
    );
  }
  if (existsSync(migrationPath)) {
    throw new InitError(
      `${migrationPath} already exists — refusing to overwrite.`,
    );
  }

  mkdirSync(migrationDir, { recursive: true });
  writeFileSync(manifestPath, STARTER_MANIFEST, 'utf8');
  writeFileSync(migrationPath, STARTER_MIGRATION, 'utf8');
  return { written: [manifestPath, migrationPath] };
}

/**
 * Generate OpenAPI spec from Hono routes
 *
 * Usage: bun scripts/generate-openapi.ts
 */

import type { BlobStorageAdapter } from '@syncular/core';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import type {
  ServerSyncDialect,
  ServerTableHandler,
  SyncBlobUploadsDb,
  SyncCoreDb,
} from '@syncular/server';
import { createBlobManager, ensureSyncSchema } from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { Hono } from 'hono';
import { generateSpecs } from 'hono-openapi';
import { createBlobRoutes } from '../src/blobs';
import { type ConsoleAuthResult, createConsoleRoutes } from '../src/console';
import { createSyncRoutes, type SyncAuthResult } from '../src/routes';

// Create a minimal app with routes for spec generation
const app = new Hono();

const db = createDatabase<SyncCoreDb>({
  dialect: createPgliteDialect(),
  family: 'postgres',
});
const dialect: ServerSyncDialect = createPostgresServerDialect();
await ensureSyncSchema(db, dialect);
const handlers: ServerTableHandler<SyncCoreDb>[] = [];

// Create sync routes with minimal config (handlers will throw, but that's fine for spec generation)
const syncRoutes = createSyncRoutes({
  db,
  dialect,
  handlers,
  authenticate: async (): Promise<SyncAuthResult | null> => ({
    actorId: 'spec-gen',
  }),
});

// Create console routes with minimal config
const consoleRoutes = createConsoleRoutes({
  db,
  dialect,
  handlers,
  authenticate: async (): Promise<ConsoleAuthResult | null> => ({
    consoleUserId: 'spec-gen',
  }),
});

// Create blob routes with minimal config
const blobAdapter: BlobStorageAdapter = {
  name: 'spec-gen',
  async signUpload() {
    return { url: 'https://example.invalid/upload', method: 'PUT' };
  },
  async signDownload() {
    return 'https://example.invalid/download';
  },
  async exists() {
    return false;
  },
  async delete() {},
};

const blobDb = createDatabase<SyncBlobUploadsDb>({
  dialect: createPgliteDialect(),
  family: 'postgres',
});
const blobManager = createBlobManager({ db: blobDb, adapter: blobAdapter });

const blobRoutes = createBlobRoutes({
  blobManager,
  authenticate: async () => ({ actorId: 'spec-gen' }),
});

// Mount routes
app.route('/sync', syncRoutes);
app.route('/console', consoleRoutes);
app.route('/sync', blobRoutes);

// Generate OpenAPI spec
const document = await generateSpecs(app, {
  documentation: {
    info: {
      title: 'Syncular API',
      version: '1.0.0',
      description: 'Sync infrastructure API for real-time data synchronization',
    },
  },
});

// Write to file using Node.js fs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputPath = join(__dirname, '..', 'openapi.json');

Bun.write(outputPath, JSON.stringify(document, null, 2));

console.log(`OpenAPI spec written to ${outputPath}`);

process.exit(0);

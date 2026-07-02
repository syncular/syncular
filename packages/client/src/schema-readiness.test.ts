import { describe, expect, it } from 'bun:test';
import {
  getSyncularSchemaReadiness,
  type SyncularSchemaReadinessClient,
} from './schema-readiness';
import type { SyncularRuntimeInfo, SyncularSchemaState } from './types';

describe('getSyncularSchemaReadiness', () => {
  it('reports a ready generated/runtime/local schema match', async () => {
    const client = fakeSchemaClient();

    await expect(
      getSyncularSchemaReadiness(client, {
        generatedSchemaVersion: 8,
        expectedRuntime: {
          packageName: '@syncular/client',
          packageVersion: '0.1.3',
          workerProtocolVersion: 2,
          requiredRustFeatures: ['web-owned-sqlite-core'],
          wasmGlueUrl: 'http://localhost/wasm/syncular.js',
          wasmUrl: 'http://localhost/wasm/syncular_bg.wasm',
        },
        now: () => 1,
      })
    ).resolves.toMatchObject({
      generatedAt: 1,
      status: 'ready',
      ready: true,
      requiresAction: false,
      generatedSchemaVersion: 8,
      localSchema: {
        schemaId: 'syncular-app',
        schemaVersion: 8,
        currentSchemaVersion: 8,
      },
      issues: [],
    });
  });

  it('reports mixed runtime package, protocol, and asset deploys as typed blockers', async () => {
    const client = fakeSchemaClient({
      runtime: {
        packageVersion: '0.1.2',
        workerProtocolVersion: 1,
        wasmGlueUrl: 'https://cdn.example/old/syncular.js?token=secret',
        wasmUrl: 'https://cdn.example/old/syncular_bg.wasm#cache',
      },
    });

    const result = await getSyncularSchemaReadiness(client, {
      generatedSchemaVersion: 8,
      expectedRuntime: {
        packageName: '@syncular/client',
        packageVersion: '0.1.3',
        workerProtocolVersion: 2,
        wasmGlueUrl: 'https://cdn.example/new/syncular.js?token=expected',
        wasmUrl: 'https://cdn.example/new/syncular_bg.wasm#expected',
      },
    });

    expect(result.status).toBe('not-ready');
    expect(result.ready).toBe(false);
    expect(result.requiresAction).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'runtime.package_version_mismatch',
      'runtime.worker_protocol_mismatch',
      'runtime.wasm_glue_asset_mismatch',
      'runtime.wasm_asset_mismatch',
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        recommendedAction: 'redeployClient',
        details: {
          expectedPackageVersion: '0.1.3',
          actualPackageVersion: '0.1.2',
        },
      }),
      expect.objectContaining({
        recommendedAction: 'redeployClient',
        details: {
          expectedWorkerProtocolVersion: 2,
          actualWorkerProtocolVersion: 1,
        },
      }),
      expect.objectContaining({
        recommendedAction: 'refreshRuntimeAssets',
        details: {
          expectedWasmGlueUrl: 'https://cdn.example/new/syncular.js',
          actualWasmGlueUrl: 'https://cdn.example/old/syncular.js',
        },
      }),
      expect.objectContaining({
        recommendedAction: 'refreshRuntimeAssets',
        details: {
          expectedWasmUrl: 'https://cdn.example/new/syncular_bg.wasm',
          actualWasmUrl: 'https://cdn.example/old/syncular_bg.wasm',
        },
      }),
    ]);
  });

  it('reports missing Rust runtime features without throwing', async () => {
    const client = fakeSchemaClient({
      runtime: {
        rust: {
          crateName: 'syncular-runtime',
          crateVersion: '0.1.3',
          schemaVersion: 8,
          features: ['web-owned-sqlite-core'],
        },
      },
    });

    const result = await getSyncularSchemaReadiness(client, {
      generatedSchemaVersion: 8,
      expectedRuntime: {
        rust: {
          crateName: 'syncular-runtime',
          crateVersion: '0.1.3',
          schemaVersion: 8,
        },
        requiredRustFeatures: ['web-owned-sqlite-core', 'blobs', 'crdt-yjs'],
      },
    });

    expect(result).toMatchObject({
      status: 'not-ready',
      ready: false,
      requiresAction: true,
      issues: [
        {
          code: 'runtime.rust_feature_missing',
          severity: 'error',
          recommendedAction: 'redeployClient',
          details: {
            missingRustFeatures: ['blobs', 'crdt-yjs'],
            actualRustFeatures: ['web-owned-sqlite-core'],
          },
        },
      ],
    });
  });

  it('reports missing Rust runtime information when the generated app requires it', async () => {
    const client = fakeSchemaClient({ runtime: { rust: undefined } });

    const result = await getSyncularSchemaReadiness(client, {
      generatedSchemaVersion: 8,
      expectedRuntime: {
        requiredRustFeatures: ['web-owned-sqlite-core'],
      },
    });

    expect(result).toMatchObject({
      status: 'not-ready',
      issues: [
        {
          code: 'runtime.rust_info_missing',
          recommendedAction: 'redeployClient',
          details: {
            expectedRustFeatures: ['web-owned-sqlite-core'],
          },
        },
      ],
    });
  });

  it('distinguishes a missing local schema from generated drift', async () => {
    const client = fakeSchemaClient({
      schema: { schemaVersion: null, currentSchemaVersion: 8 },
    });

    await expect(
      getSyncularSchemaReadiness(client, { generatedSchemaVersion: 8 })
    ).resolves.toMatchObject({
      status: 'not-ready',
      ready: false,
      requiresAction: true,
      issues: [
        {
          code: 'schema.missing_local_schema',
          severity: 'error',
          recommendedAction: 'openDatabase',
          details: {
            schemaId: 'syncular-app',
            expectedSchemaVersion: 8,
          },
        },
      ],
    });
  });

  it('reports a stale generated client when the runtime app schema is newer', async () => {
    const client = fakeSchemaClient({
      schema: { schemaVersion: 9, currentSchemaVersion: 9 },
    });

    const result = await getSyncularSchemaReadiness(client, {
      generatedSchemaVersion: 8,
    });

    expect(result.status).toBe('not-ready');
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'schema.generated_client_stale',
      'schema.local_schema_newer_than_generated',
    ]);
    expect(result.issues[0]).toMatchObject({
      recommendedAction: 'runSyncularGenerate',
      details: {
        generatedSchemaVersion: 8,
        runtimeCurrentSchemaVersion: 9,
      },
    });
  });

  it('reports stale local schema separately from generated output compatibility', async () => {
    const client = fakeSchemaClient({
      schema: { schemaVersion: 7, currentSchemaVersion: 8 },
    });

    await expect(
      getSyncularSchemaReadiness(client, { generatedSchemaVersion: 8 })
    ).resolves.toMatchObject({
      status: 'not-ready',
      issues: [
        {
          code: 'schema.local_schema_stale',
          recommendedAction: 'runSchemaMigrations',
          details: {
            localSchemaVersion: 7,
            generatedSchemaVersion: 8,
          },
        },
      ],
    });
  });

  it('reports stale server schema and newer server requirements as different issues', async () => {
    const staleServer = await getSyncularSchemaReadiness(fakeSchemaClient(), {
      generatedSchemaVersion: 8,
      server: { latestSchemaVersion: 7, source: 'deploy-check' },
    });
    expect(staleServer.status).toBe('not-ready');
    expect(staleServer.issues).toEqual([
      expect.objectContaining({
        code: 'schema.server_schema_stale',
        recommendedAction: 'redeployServer',
        details: expect.objectContaining({
          generatedSchemaVersion: 8,
          latestSchemaVersion: 7,
          source: 'deploy-check',
        }),
      }),
    ]);

    const newerRequired = await getSyncularSchemaReadiness(fakeSchemaClient(), {
      generatedSchemaVersion: 8,
      server: { requiredSchemaVersion: 9, latestSchemaVersion: 9 },
    });
    expect(newerRequired.status).toBe('not-ready');
    expect(newerRequired.issues.map((issue) => issue.code)).toEqual([
      'schema.server_requires_newer_client',
      'schema.server_newer_available',
    ]);
  });

  it('keeps advisory newer-server information as a warning', async () => {
    const result = await getSyncularSchemaReadiness(fakeSchemaClient(), {
      generatedSchemaVersion: 8,
      server: { latestSchemaVersion: 9 },
    });

    expect(result).toMatchObject({
      status: 'warning',
      ready: true,
      requiresAction: false,
      issues: [
        {
          code: 'schema.server_newer_available',
          severity: 'warning',
          recommendedAction: 'runSyncularGenerate',
        },
      ],
    });
  });

  it('reports runtime and schema-state open failures without throwing', async () => {
    const result = await getSyncularSchemaReadiness({
      async runtimeInfo() {
        throw new Error('worker failed to open');
      },
      async generatedSchemaState() {
        throw new Error('database locked');
      },
    });

    expect(result).toMatchObject({
      status: 'unknown',
      ready: false,
      requiresAction: true,
      runtime: null,
      localSchema: null,
      generatedSchemaVersion: null,
      issues: [
        {
          code: 'runtime.info_unavailable',
          recommendedAction: 'inspectRuntime',
          details: { name: 'Error', message: 'worker failed to open' },
        },
        {
          code: 'runtime.schema_state_unavailable',
          recommendedAction: 'inspectRuntime',
          details: { name: 'Error', message: 'database locked' },
        },
      ],
    });
  });
});

function fakeSchemaClient(
  options: {
    runtime?: Partial<SyncularRuntimeInfo>;
    schema?: Partial<SyncularSchemaState>;
  } = {}
): SyncularSchemaReadinessClient {
  return {
    async runtimeInfo() {
      return {
        packageName: '@syncular/client',
        packageVersion: '0.1.3',
        workerProtocolVersion: 2,
        storage: 'opfsSahPool',
        workerUrl: 'http://localhost/syncular-worker.js',
        wasmGlueUrl: 'http://localhost/wasm/syncular.js',
        wasmUrl: 'http://localhost/wasm/syncular_bg.wasm',
        rust: {
          crateName: 'syncular-runtime',
          crateVersion: '0.1.3',
          schemaVersion: 8,
          features: ['web-owned-sqlite-core'],
        },
        ...options.runtime,
      };
    },
    async generatedSchemaState() {
      return {
        schemaId: 'syncular-app',
        schemaVersion: 8,
        currentSchemaVersion: 8,
        updatedAt: 1,
        ...options.schema,
      };
    },
  };
}

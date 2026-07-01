import { describe, expect, it } from 'bun:test';
import {
  getSyncularBrowserDeploymentPreflight,
  type SyncularBrowserDeploymentPreflightFetch,
  type SyncularBrowserDeploymentPreflightGlobal,
  type SyncularBrowserDeploymentPreflightNavigator,
} from './browser-deployment-preflight';

describe('Syncular browser deployment preflight', () => {
  it('reports ready when browser capabilities, durable storage, and runtime assets are available', async () => {
    const fetch = fakeFetch({
      'https://cdn.example/syncular.js': response(
        200,
        'application/javascript'
      ),
      'https://cdn.example/syncular_bg.wasm': response(200, 'application/wasm'),
    });

    await expect(
      getSyncularBrowserDeploymentPreflight({
        runtime: {
          wasmGlueUrl: 'https://cdn.example/syncular.js',
          wasmUrl: 'https://cdn.example/syncular_bg.wasm',
        },
        fetch,
        global: browserGlobal(),
        navigator: browserNavigator({
          opfs: true,
          persisted: true,
          quotaBytes: 250 * 1024 * 1024,
        }),
        minimumQuotaBytes: 50 * 1024 * 1024,
        generatedAt: 42,
      })
    ).resolves.toMatchObject({
      generatedAt: 42,
      status: 'ready',
      ready: true,
      requiresAction: false,
      support: {
        tier: 'persistent-offline',
        persistence: 'persistent',
        persistentOffline: true,
        productionReady: true,
        issueCodes: [],
        recommendedActions: [],
      },
      browser: {
        worker: true,
        webAssembly: true,
        secureContext: true,
        indexedDB: true,
      },
      lifecycle: {
        broadcastChannel: true,
        webLocks: true,
        pageVisibility: true,
        pageHideEvent: true,
        beforeUnloadEvent: true,
        resumeSignalAvailable: true,
        shutdownSignalAvailable: true,
        multiTabMode: 'coordinated',
      },
      storage: {
        requested: 'opfsSahPool',
        fallbackAllowed: true,
        durableRequired: true,
        opfsAvailable: true,
        persistenceSupported: true,
        persisted: true,
        quotaBytes: 250 * 1024 * 1024,
      },
      runtimeAssets: {
        checked: true,
        assets: [
          {
            kind: 'wasm-glue',
            checked: true,
            status: 'ready',
            contentType: 'application/javascript',
          },
          {
            kind: 'wasm-binary',
            checked: true,
            status: 'ready',
            contentType: 'application/wasm',
          },
        ],
      },
      issues: [],
    });
  });

  it('treats explicit OPFS storage as not-ready when OPFS is unavailable', async () => {
    await expect(
      getSyncularBrowserDeploymentPreflight({
        runtime: {
          wasmGlueUrl: 'https://cdn.example/syncular.js',
          wasmUrl: 'https://cdn.example/syncular_bg.wasm',
        },
        checkRuntimeAssets: false,
        storage: 'opfsSahPool',
        global: browserGlobal(),
        navigator: browserNavigator({ opfs: false, persisted: true }),
      })
    ).resolves.toMatchObject({
      status: 'not-ready',
      ready: false,
      requiresAction: true,
      support: {
        tier: 'unsupported',
        persistence: 'unsupported',
        persistentOffline: false,
        productionReady: false,
        issueCodes: ['browser.opfs_unavailable'],
        recommendedActions: ['selectSupportedStorage'],
      },
      storage: {
        requested: 'opfsSahPool',
        fallbackAllowed: false,
        opfsAvailable: false,
      },
      issues: [
        expect.objectContaining({
          code: 'browser.opfs_unavailable',
          severity: 'error',
          recommendedAction: 'selectSupportedStorage',
        }),
      ],
    });
  });

  it('warns when the default OPFS request can fall back to IndexedDB', async () => {
    const fetch = fakeFetch({
      'https://cdn.example/syncular.js': response(
        200,
        'application/javascript'
      ),
      'https://cdn.example/syncular_bg.wasm': response(200, 'application/wasm'),
    });

    await expect(
      getSyncularBrowserDeploymentPreflight({
        runtime: {
          wasmGlueUrl: 'https://cdn.example/syncular.js',
          wasmUrl: 'https://cdn.example/syncular_bg.wasm',
        },
        fetch,
        global: browserGlobal(),
        navigator: browserNavigator({ opfs: false, persisted: false }),
      })
    ).resolves.toMatchObject({
      status: 'warning',
      ready: false,
      requiresAction: false,
      support: {
        tier: 'persistent-offline',
        persistence: 'evictable',
        persistentOffline: true,
        productionReady: false,
        recommendedActions: [
          'selectSupportedStorage',
          'requestPersistentStorage',
        ],
      },
      storage: {
        requested: 'opfsSahPool',
        fallbackAllowed: true,
        opfsAvailable: false,
      },
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'browser.opfs_unavailable',
          severity: 'warning',
        }),
        expect.objectContaining({
          code: 'browser.storage_persistence_not_granted',
          severity: 'warning',
        }),
      ]),
    });
  });

  it('labels intentional memory storage as development-only ephemeral support', async () => {
    await expect(
      getSyncularBrowserDeploymentPreflight({
        runtime: {
          wasmGlueUrl: 'https://cdn.example/syncular.js',
          wasmUrl: 'https://cdn.example/syncular_bg.wasm',
        },
        checkRuntimeAssets: false,
        storage: 'memory',
        global: browserGlobal(),
        navigator: browserNavigator({ opfs: false }),
      })
    ).resolves.toMatchObject({
      status: 'ready',
      ready: true,
      requiresAction: false,
      support: {
        tier: 'ephemeral-development',
        persistence: 'ephemeral',
        persistentOffline: false,
        productionReady: false,
        issueCodes: [],
        recommendedActions: [],
      },
      storage: {
        requested: 'memory',
        durableRequired: false,
      },
    });
  });

  it('keeps durable support unknown when runtime assets were not checked', async () => {
    await expect(
      getSyncularBrowserDeploymentPreflight({
        runtime: {
          wasmGlueUrl: 'https://cdn.example/syncular.js',
          wasmUrl: 'https://cdn.example/syncular_bg.wasm',
        },
        checkRuntimeAssets: false,
        storage: 'indexedDb',
        global: browserGlobal(),
        navigator: browserNavigator({
          opfs: false,
          persisted: true,
          quotaBytes: 250 * 1024 * 1024,
        }),
      })
    ).resolves.toMatchObject({
      status: 'ready',
      ready: true,
      requiresAction: false,
      support: {
        tier: 'unknown',
        persistence: 'persistent',
        persistentOffline: false,
        productionReady: false,
        issueCodes: [],
        recommendedActions: [],
      },
      runtimeAssets: {
        checked: false,
      },
      storage: {
        requested: 'indexedDb',
        durableRequired: true,
      },
    });
  });

  it('flags runtime assets served as HTML or missing from deployment', async () => {
    const fetch = fakeFetch({
      'https://app.example/assets/syncular.js': response(200, 'text/html'),
      'https://app.example/assets/syncular_bg.wasm': response(404, 'text/html'),
    });

    await expect(
      getSyncularBrowserDeploymentPreflight({
        runtime: {
          wasmGlueUrl: 'https://app.example/assets/syncular.js',
          wasmUrl: 'https://app.example/assets/syncular_bg.wasm',
        },
        fetch,
        global: browserGlobal(),
        navigator: browserNavigator({ opfs: true, persisted: true }),
      })
    ).resolves.toMatchObject({
      status: 'not-ready',
      requiresAction: true,
      runtimeAssets: {
        checked: true,
        assets: [
          expect.objectContaining({
            kind: 'wasm-glue',
            status: 'not-ready',
            issueCodes: ['browser.runtime_asset_bad_content_type'],
          }),
          expect.objectContaining({
            kind: 'wasm-binary',
            status: 'not-ready',
            issueCodes: [
              'browser.runtime_asset_bad_status',
              'browser.runtime_asset_bad_content_type',
            ],
          }),
        ],
      },
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'browser.runtime_asset_bad_content_type',
          severity: 'error',
          recommendedAction: 'configureStaticAssetServing',
        }),
        expect.objectContaining({
          code: 'browser.runtime_asset_bad_status',
          severity: 'error',
          recommendedAction: 'serveRuntimeAssets',
        }),
      ]),
    });
  });

  it('reports browser capability blockers before opening a database', async () => {
    await expect(
      getSyncularBrowserDeploymentPreflight({
        runtime: {
          wasmGlueUrl: 'https://cdn.example/syncular.js',
          wasmUrl: 'https://cdn.example/syncular_bg.wasm',
        },
        checkRuntimeAssets: false,
        requireCrossOriginIsolation: true,
        global: browserGlobal({
          worker: false,
          webAssembly: false,
          indexedDB: false,
          secureContext: false,
          crossOriginIsolated: false,
        }),
        navigator: browserNavigator({ opfs: false }),
      })
    ).resolves.toMatchObject({
      status: 'not-ready',
      requiresAction: true,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'browser.worker_unavailable' }),
        expect.objectContaining({ code: 'browser.webassembly_unavailable' }),
        expect.objectContaining({ code: 'browser.indexeddb_unavailable' }),
        expect.objectContaining({ code: 'browser.insecure_context' }),
        expect.objectContaining({
          code: 'browser.cross_origin_isolation_missing',
        }),
      ]),
    });
  });

  it('fails explicit multi-tab and resume requirements when lifecycle primitives are missing', async () => {
    await expect(
      getSyncularBrowserDeploymentPreflight({
        runtime: {
          wasmGlueUrl: 'https://cdn.example/syncular.js',
          wasmUrl: 'https://cdn.example/syncular_bg.wasm',
        },
        checkRuntimeAssets: false,
        requireMultiTabCoordination: true,
        requirePageLifecycleResume: true,
        global: browserGlobal({
          broadcastChannel: false,
          pageLifecycle: false,
        }),
        navigator: browserNavigator({
          locks: false,
          opfs: true,
          persisted: true,
        }),
      })
    ).resolves.toMatchObject({
      status: 'not-ready',
      requiresAction: true,
      lifecycle: {
        broadcastChannel: false,
        webLocks: false,
        pageVisibility: false,
        pageHideEvent: false,
        beforeUnloadEvent: false,
        resumeSignalAvailable: false,
        shutdownSignalAvailable: false,
        multiTabMode: 'single-open-database-tab',
      },
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'browser.broadcast_channel_unavailable',
          target: 'lifecycle',
          recommendedAction: 'coordinateBrowserTabs',
        }),
        expect.objectContaining({
          code: 'browser.web_locks_unavailable',
          target: 'lifecycle',
          recommendedAction: 'coordinateBrowserTabs',
        }),
        expect.objectContaining({
          code: 'browser.page_lifecycle_unavailable',
          target: 'lifecycle',
          recommendedAction: 'wirePageLifecycleResume',
        }),
      ]),
    });
  });
});

function browserGlobal(
  options: {
    broadcastChannel?: boolean;
    pageLifecycle?: boolean;
    worker?: boolean;
    webAssembly?: boolean;
    indexedDB?: boolean;
    secureContext?: boolean;
    crossOriginIsolated?: boolean;
  } = {}
): SyncularBrowserDeploymentPreflightGlobal {
  return {
    BroadcastChannel:
      options.broadcastChannel === false
        ? undefined
        : class BroadcastChannel {},
    Worker: options.worker === false ? undefined : class Worker {},
    WebAssembly: options.webAssembly === false ? undefined : {},
    indexedDB: options.indexedDB === false ? undefined : {},
    document:
      options.pageLifecycle === false
        ? undefined
        : {
            visibilityState: 'visible',
            addEventListener() {},
          },
    ...(options.pageLifecycle === false
      ? {}
      : {
          addEventListener() {},
          onbeforeunload: null,
          onpagehide: null,
        }),
    isSecureContext: options.secureContext ?? true,
    crossOriginIsolated: options.crossOriginIsolated ?? false,
  };
}

function browserNavigator(options: {
  locks?: boolean;
  opfs: boolean;
  persisted?: boolean;
  quotaBytes?: number;
}): SyncularBrowserDeploymentPreflightNavigator {
  return {
    ...(options.locks === false
      ? {}
      : {
          locks: {
            request() {},
          },
        }),
    storage: {
      ...(options.opfs
        ? {
            getDirectory() {
              return {};
            },
          }
        : {}),
      ...(options.persisted == null
        ? {}
        : {
            async persisted() {
              return options.persisted ?? false;
            },
          }),
      ...(options.quotaBytes == null
        ? {}
        : {
            async estimate() {
              return { quota: options.quotaBytes, usage: 1024 };
            },
          }),
    },
  };
}

function fakeFetch(
  responses: Record<
    string,
    Pick<Response, 'headers' | 'ok' | 'status' | 'statusText'>
  >
): SyncularBrowserDeploymentPreflightFetch {
  return async (input) => {
    const url = input instanceof URL ? input.href : String(input);
    const resolved = responses[url];
    if (!resolved) throw new Error(`missing fake response for ${url}`);
    return resolved;
  };
}

function response(
  status: number,
  contentType: string
): Pick<Response, 'headers' | 'ok' | 'status' | 'statusText'> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: new Headers({ 'content-type': contentType }),
  };
}

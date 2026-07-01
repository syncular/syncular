import {
  resolveSyncularClientConfig,
  SYNCULAR_DEFAULT_STORAGE,
} from './client-config';
import type {
  SyncularRuntimeArtifact,
  SyncularRuntimeArtifactCandidate,
  SyncularStorage,
} from './types';
import {
  getSyncularRuntimeArtifact,
  type SyncularWasmArtifactVariant,
  selectSyncularRuntimeArtifact,
} from './wasm-runtime';

export type SyncularBrowserDeploymentPreflightStatus =
  | 'ready'
  | 'warning'
  | 'not-ready'
  | 'unknown';

export type SyncularBrowserDeploymentPreflightIssueSeverity =
  | 'error'
  | 'warning'
  | 'info';

export type SyncularBrowserDeploymentPreflightIssueCode =
  | 'browser.broadcast_channel_unavailable'
  | 'browser.cross_origin_isolation_missing'
  | 'browser.indexeddb_unavailable'
  | 'browser.insecure_context'
  | 'browser.opfs_unavailable'
  | 'browser.page_lifecycle_unavailable'
  | 'browser.runtime_asset_bad_content_type'
  | 'browser.runtime_asset_bad_status'
  | 'browser.runtime_asset_file_url_unchecked'
  | 'browser.runtime_asset_unreachable'
  | 'browser.storage_persistence_not_granted'
  | 'browser.storage_persistence_unavailable'
  | 'browser.storage_pressure_high'
  | 'browser.storage_quota_low'
  | 'browser.webassembly_unavailable'
  | 'browser.web_locks_unavailable'
  | 'browser.worker_unavailable';

export type SyncularBrowserDeploymentPreflightRecommendedAction =
  | 'coordinateBrowserTabs'
  | 'configureCrossOriginIsolation'
  | 'configureHttpsOrLocalhost'
  | 'configureStaticAssetServing'
  | 'freeStorageQuota'
  | 'requestPersistentStorage'
  | 'selectSupportedStorage'
  | 'serveRuntimeAssets'
  | 'wirePageLifecycleResume';

export type SyncularBrowserDeploymentPreflightSupportTier =
  | 'persistent-offline'
  | 'ephemeral-development'
  | 'unsupported'
  | 'unknown';

export type SyncularBrowserDeploymentPreflightPersistenceMode =
  | 'persistent'
  | 'evictable'
  | 'ephemeral'
  | 'unsupported'
  | 'unknown';

export type SyncularBrowserDeploymentPreflightQuotaPressure =
  | 'unknown'
  | 'normal'
  | 'elevated'
  | 'high';

export interface SyncularBrowserDeploymentPreflightIssue {
  code: SyncularBrowserDeploymentPreflightIssueCode;
  severity: SyncularBrowserDeploymentPreflightIssueSeverity;
  message: string;
  target: 'browser' | 'lifecycle' | 'storage' | 'runtime-assets';
  recommendedAction?: SyncularBrowserDeploymentPreflightRecommendedAction;
  details?: Record<string, unknown>;
}

export interface SyncularBrowserDeploymentPreflightRuntimeAsset {
  kind: 'wasm-glue' | 'wasm-binary';
  url: string;
  checked: boolean;
  status: SyncularBrowserDeploymentPreflightStatus;
  httpStatus?: number;
  contentType?: string | null;
  issueCodes: SyncularBrowserDeploymentPreflightIssueCode[];
}

export interface SyncularBrowserDeploymentPreflightRuntimeAssets {
  checked: boolean;
  artifactName?: string;
  requiredFeatures: string[];
  assets: SyncularBrowserDeploymentPreflightRuntimeAsset[];
}

export interface SyncularBrowserDeploymentPreflightBrowser {
  worker: boolean | null;
  webAssembly: boolean | null;
  secureContext: boolean | null;
  crossOriginIsolated: boolean | null;
  indexedDB: boolean | null;
  serviceWorker: boolean | null;
  serviceWorkerControlled: boolean | null;
  serviceWorkerControllerState: string | null;
  serviceWorkerControllerScriptPath: string | null;
}

export type SyncularBrowserDeploymentPreflightMultiTabMode =
  | 'coordinated'
  | 'best-effort'
  | 'single-open-database-tab';

export interface SyncularBrowserDeploymentPreflightLifecycle {
  broadcastChannel: boolean | null;
  webLocks: boolean | null;
  pageVisibility: boolean | null;
  pageHideEvent: boolean | null;
  beforeUnloadEvent: boolean | null;
  resumeSignalAvailable: boolean;
  shutdownSignalAvailable: boolean;
  multiTabMode: SyncularBrowserDeploymentPreflightMultiTabMode;
}

export interface SyncularBrowserDeploymentPreflightStorage {
  requested: SyncularStorage;
  fallbackAllowed: boolean;
  durableRequired: boolean;
  opfsAvailable: boolean | null;
  persistenceSupported: boolean | null;
  persistRequestSupported: boolean | null;
  persisted: boolean | null;
  quotaPressure: SyncularBrowserDeploymentPreflightQuotaPressure;
  availableBytes?: number;
  quotaBytes?: number;
  usageRatio?: number;
  usageBytes?: number;
  minimumAvailableBytes?: number;
  minimumQuotaBytes?: number;
}

export interface SyncularBrowserDeploymentPreflightSupport {
  tier: SyncularBrowserDeploymentPreflightSupportTier;
  persistence: SyncularBrowserDeploymentPreflightPersistenceMode;
  persistentOffline: boolean;
  productionReady: boolean;
  summary: string;
  issueCodes: SyncularBrowserDeploymentPreflightIssueCode[];
  recommendedActions: SyncularBrowserDeploymentPreflightRecommendedAction[];
}

export interface SyncularBrowserDeploymentPreflight {
  generatedAt: number;
  status: SyncularBrowserDeploymentPreflightStatus;
  ready: boolean;
  requiresAction: boolean;
  support: SyncularBrowserDeploymentPreflightSupport;
  browser: SyncularBrowserDeploymentPreflightBrowser;
  lifecycle: SyncularBrowserDeploymentPreflightLifecycle;
  storage: SyncularBrowserDeploymentPreflightStorage;
  runtimeAssets: SyncularBrowserDeploymentPreflightRuntimeAssets;
  issues: SyncularBrowserDeploymentPreflightIssue[];
}

export interface SyncularBrowserDeploymentPreflightOptions {
  runtime?: SyncularRuntimeArtifact | SyncularWasmArtifactVariant;
  runtimeArtifacts?: readonly SyncularRuntimeArtifactCandidate[];
  requiredRuntimeFeatures?: readonly string[];
  /**
   * Expected storage. Omit this to model Syncular's default OPFS request with
   * IndexedDB fallback. Passing `storage: 'opfsSahPool'` models an explicit
   * OPFS requirement and reports missing OPFS as not-ready.
   */
  storage?: SyncularStorage;
  requireCrossOriginIsolation?: boolean;
  requireMultiTabCoordination?: boolean;
  requirePageLifecycleResume?: boolean;
  checkRuntimeAssets?: boolean;
  minimumAvailableBytes?: number;
  minimumQuotaBytes?: number;
  fetch?: SyncularBrowserDeploymentPreflightFetch;
  global?: SyncularBrowserDeploymentPreflightGlobal;
  navigator?: SyncularBrowserDeploymentPreflightNavigator;
  generatedAt?: number;
}

export type SyncularBrowserDeploymentPreflightFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Pick<Response, 'headers' | 'ok' | 'status' | 'statusText'>>;

export interface SyncularBrowserDeploymentPreflightGlobal {
  Worker?: unknown;
  WebAssembly?: unknown;
  BroadcastChannel?: unknown;
  indexedDB?: unknown;
  document?: {
    visibilityState?: unknown;
    addEventListener?: unknown;
  };
  addEventListener?: unknown;
  onbeforeunload?: unknown;
  onpagehide?: unknown;
  isSecureContext?: boolean;
  crossOriginIsolated?: boolean;
}

export interface SyncularBrowserDeploymentPreflightNavigator {
  locks?: {
    request?: unknown;
  };
  serviceWorker?: {
    controller?: unknown;
  };
  storage?: {
    getDirectory?: unknown;
    persist?: () => Promise<boolean>;
    persisted?: () => Promise<boolean>;
    estimate?: () => Promise<{ quota?: number; usage?: number }>;
  };
}

export async function getSyncularBrowserDeploymentPreflight(
  options: SyncularBrowserDeploymentPreflightOptions = {}
): Promise<SyncularBrowserDeploymentPreflight> {
  const runtimeArtifact = resolveRuntimeArtifact(options);
  const issues: SyncularBrowserDeploymentPreflightIssue[] = [];
  const globalRef = resolveGlobal(options.global);
  const navigatorRef = resolveNavigator(options.navigator);
  const browser = summarizeBrowser(globalRef, navigatorRef);
  const lifecycle = summarizeLifecycle(globalRef, navigatorRef);
  const storage = await summarizeStorage({
    expectedStorage: resolveExpectedStorage(options.storage),
    storageWasExplicit: options.storage != null,
    globalRef,
    navigatorRef,
    minimumAvailableBytes: options.minimumAvailableBytes,
    minimumQuotaBytes: options.minimumQuotaBytes,
    issues,
  });
  const runtimeAssets = await summarizeRuntimeAssets({
    runtimeArtifact,
    requiredFeatures: options.requiredRuntimeFeatures,
    runtimeArtifacts: options.runtimeArtifacts,
    checkRuntimeAssets: options.checkRuntimeAssets !== false,
    fetchRef: options.fetch ?? resolveFetch(),
    issues,
  });

  addBrowserIssues({
    browser,
    storage,
    requireCrossOriginIsolation: options.requireCrossOriginIsolation === true,
    issues,
  });
  addLifecycleIssues({
    lifecycle,
    requireMultiTabCoordination: options.requireMultiTabCoordination === true,
    requirePageLifecycleResume: options.requirePageLifecycleResume === true,
    issues,
  });

  const status = summarizeStatus(issues);
  const support = summarizeSupport({
    issues,
    runtimeAssets,
    status,
    storage,
  });

  return {
    generatedAt: options.generatedAt ?? Date.now(),
    status,
    ready: status === 'ready',
    requiresAction: issues.some((issue) => issue.severity === 'error'),
    support,
    browser,
    lifecycle,
    storage,
    runtimeAssets,
    issues,
  };
}

function resolveRuntimeArtifact(
  options: Pick<
    SyncularBrowserDeploymentPreflightOptions,
    'requiredRuntimeFeatures' | 'runtime' | 'runtimeArtifacts'
  >
): SyncularRuntimeArtifact {
  if (typeof options.runtime === 'string') {
    return getSyncularRuntimeArtifact(options.runtime);
  }
  return (
    options.runtime ??
    selectSyncularRuntimeArtifact(
      options.requiredRuntimeFeatures,
      options.runtimeArtifacts
    )
  );
}

function resolveExpectedStorage(storage: SyncularStorage | undefined) {
  if (storage) return storage;
  return (
    resolveSyncularClientConfig({
      actorId: 'syncular-preflight',
      clientId: 'syncular-preflight',
      mode: 'local-sync-compatible',
    }).storage ?? SYNCULAR_DEFAULT_STORAGE
  );
}

function resolveGlobal(
  provided?: SyncularBrowserDeploymentPreflightGlobal
): SyncularBrowserDeploymentPreflightGlobal {
  return provided ?? (globalThis as SyncularBrowserDeploymentPreflightGlobal);
}

function resolveNavigator(
  provided?: SyncularBrowserDeploymentPreflightNavigator
): SyncularBrowserDeploymentPreflightNavigator | undefined {
  return (
    provided ??
    (typeof navigator === 'undefined'
      ? undefined
      : (navigator as SyncularBrowserDeploymentPreflightNavigator))
  );
}

function resolveFetch(): SyncularBrowserDeploymentPreflightFetch | undefined {
  if (typeof fetch === 'undefined') return undefined;
  return fetch as SyncularBrowserDeploymentPreflightFetch;
}

function summarizeBrowser(
  globalRef: SyncularBrowserDeploymentPreflightGlobal,
  navigatorRef?: SyncularBrowserDeploymentPreflightNavigator
): SyncularBrowserDeploymentPreflightBrowser {
  const serviceWorkerAvailable =
    navigatorRef == null ? null : navigatorRef.serviceWorker != null;
  const serviceWorkerController = navigatorRef?.serviceWorker?.controller;
  const serviceWorkerControlled =
    serviceWorkerAvailable == null
      ? null
      : serviceWorkerAvailable && serviceWorkerController != null;
  const serviceWorkerControllerRecord = isRecord(serviceWorkerController)
    ? serviceWorkerController
    : null;
  return {
    worker: typeof globalRef.Worker === 'function',
    webAssembly: globalRef.WebAssembly != null,
    secureContext:
      typeof globalRef.isSecureContext === 'boolean'
        ? globalRef.isSecureContext
        : null,
    crossOriginIsolated:
      typeof globalRef.crossOriginIsolated === 'boolean'
        ? globalRef.crossOriginIsolated
        : null,
    indexedDB: globalRef.indexedDB != null,
    serviceWorker: serviceWorkerAvailable,
    serviceWorkerControlled,
    serviceWorkerControllerState:
      typeof serviceWorkerControllerRecord?.state === 'string'
        ? serviceWorkerControllerRecord.state
        : null,
    serviceWorkerControllerScriptPath: summarizeServiceWorkerScriptPath(
      serviceWorkerControllerRecord?.scriptURL
    ),
  };
}

function summarizeServiceWorkerScriptPath(scriptUrl: unknown): string | null {
  if (typeof scriptUrl !== 'string' || scriptUrl.length === 0) return null;
  try {
    return truncateBrowserDiagnosticText(new URL(scriptUrl).pathname);
  } catch {
    const path = scriptUrl.split(/[?#]/, 1)[0];
    if (!path?.startsWith('/')) return null;
    return truncateBrowserDiagnosticText(path);
  }
}

function truncateBrowserDiagnosticText(value: string): string {
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function summarizeLifecycle(
  globalRef: SyncularBrowserDeploymentPreflightGlobal,
  navigatorRef?: SyncularBrowserDeploymentPreflightNavigator
): SyncularBrowserDeploymentPreflightLifecycle {
  const broadcastChannel = typeof globalRef.BroadcastChannel === 'function';
  const webLocks = typeof navigatorRef?.locks?.request === 'function';
  const pageVisibility =
    typeof globalRef.document?.visibilityState === 'string' &&
    typeof globalRef.document?.addEventListener === 'function';
  const pageHideEvent =
    typeof globalRef.addEventListener === 'function' &&
    'onpagehide' in globalRef;
  const beforeUnloadEvent =
    typeof globalRef.addEventListener === 'function' &&
    'onbeforeunload' in globalRef;
  return {
    broadcastChannel,
    webLocks,
    pageVisibility,
    pageHideEvent,
    beforeUnloadEvent,
    resumeSignalAvailable: pageVisibility || pageHideEvent,
    shutdownSignalAvailable: pageHideEvent || beforeUnloadEvent,
    multiTabMode:
      broadcastChannel && webLocks
        ? 'coordinated'
        : broadcastChannel || webLocks
          ? 'best-effort'
          : 'single-open-database-tab',
  };
}

async function summarizeStorage(args: {
  expectedStorage: SyncularStorage;
  storageWasExplicit: boolean;
  globalRef: SyncularBrowserDeploymentPreflightGlobal;
  navigatorRef?: SyncularBrowserDeploymentPreflightNavigator;
  minimumAvailableBytes?: number;
  minimumQuotaBytes?: number;
  issues: SyncularBrowserDeploymentPreflightIssue[];
}): Promise<SyncularBrowserDeploymentPreflightStorage> {
  const fallbackAllowed =
    !args.storageWasExplicit &&
    args.expectedStorage === SYNCULAR_DEFAULT_STORAGE;
  const durableRequired = args.expectedStorage !== 'memory';
  const opfsAvailable =
    args.expectedStorage === 'opfsSahPool'
      ? typeof args.navigatorRef?.storage?.getDirectory === 'function'
      : null;
  const persistenceSupported = durableRequired
    ? typeof args.navigatorRef?.storage?.persisted === 'function'
    : null;
  const persistRequestSupported = durableRequired
    ? typeof args.navigatorRef?.storage?.persist === 'function'
    : null;
  const persisted =
    persistenceSupported === true
      ? await safeBooleanCall(args.navigatorRef?.storage?.persisted)
      : null;
  const estimate =
    durableRequired &&
    typeof args.navigatorRef?.storage?.estimate === 'function'
      ? await safeEstimate(args.navigatorRef.storage.estimate)
      : undefined;
  const availableBytes = summarizeAvailableBytes(estimate);
  const usageRatio = summarizeStorageUsageRatio(estimate);
  const quotaPressure = summarizeQuotaPressure(usageRatio);

  const storage: SyncularBrowserDeploymentPreflightStorage = {
    requested: args.expectedStorage,
    fallbackAllowed,
    durableRequired,
    opfsAvailable,
    persistenceSupported,
    persistRequestSupported,
    persisted,
    quotaPressure,
    ...(availableBytes != null ? { availableBytes } : {}),
    ...(estimate?.quota != null ? { quotaBytes: estimate.quota } : {}),
    ...(usageRatio != null ? { usageRatio } : {}),
    ...(estimate?.usage != null ? { usageBytes: estimate.usage } : {}),
    ...(args.minimumAvailableBytes != null
      ? { minimumAvailableBytes: args.minimumAvailableBytes }
      : {}),
    ...(args.minimumQuotaBytes != null
      ? { minimumQuotaBytes: args.minimumQuotaBytes }
      : {}),
  };

  if (durableRequired && args.globalRef.indexedDB == null) {
    args.issues.push({
      code: 'browser.indexeddb_unavailable',
      severity: 'error',
      target: 'storage',
      recommendedAction: 'selectSupportedStorage',
      message:
        'IndexedDB is unavailable, so Syncular cannot use durable browser storage or OPFS fallback.',
    });
  }

  if (args.expectedStorage === 'opfsSahPool' && opfsAvailable === false) {
    args.issues.push({
      code: 'browser.opfs_unavailable',
      severity: fallbackAllowed ? 'warning' : 'error',
      target: 'storage',
      recommendedAction: 'selectSupportedStorage',
      message: fallbackAllowed
        ? 'OPFS is unavailable; default Syncular storage can fall back to IndexedDB, but OPFS performance will not be used.'
        : 'OPFS is unavailable and the requested Syncular storage requires it.',
    });
  }

  if (durableRequired && persistenceSupported === false) {
    args.issues.push({
      code: 'browser.storage_persistence_unavailable',
      severity: 'warning',
      target: 'storage',
      recommendedAction: 'requestPersistentStorage',
      message:
        'The browser does not expose persistent-storage status; installed offline data may still be evicted under storage pressure.',
      details: { persistRequestSupported },
    });
  } else if (durableRequired && persisted === false) {
    args.issues.push({
      code: 'browser.storage_persistence_not_granted',
      severity: 'warning',
      target: 'storage',
      recommendedAction: 'requestPersistentStorage',
      message:
        'Persistent browser storage is not currently granted; offline data may be evicted under storage pressure.',
      details: { persistRequestSupported },
    });
  }

  if (
    durableRequired &&
    args.minimumQuotaBytes != null &&
    estimate?.quota != null &&
    estimate.quota < args.minimumQuotaBytes
  ) {
    args.issues.push({
      code: 'browser.storage_quota_low',
      severity: 'warning',
      target: 'storage',
      recommendedAction: 'freeStorageQuota',
      message:
        'The available browser storage quota is below the configured Syncular preflight budget.',
      details: {
        quotaBytes: estimate.quota,
        minimumQuotaBytes: args.minimumQuotaBytes,
      },
    });
  }

  if (
    durableRequired &&
    args.minimumAvailableBytes != null &&
    availableBytes != null &&
    availableBytes < args.minimumAvailableBytes
  ) {
    args.issues.push({
      code: 'browser.storage_quota_low',
      severity: 'warning',
      target: 'storage',
      recommendedAction: 'freeStorageQuota',
      message:
        'The available browser storage budget is below the configured Syncular preflight budget.',
      details: {
        availableBytes,
        minimumAvailableBytes: args.minimumAvailableBytes,
        quotaBytes: estimate?.quota,
        usageBytes: estimate?.usage,
      },
    });
  }

  if (durableRequired && quotaPressure === 'high') {
    args.issues.push({
      code: 'browser.storage_pressure_high',
      severity: 'warning',
      target: 'storage',
      recommendedAction: 'freeStorageQuota',
      message:
        'Browser storage usage is close to the reported quota; offline data may be at higher risk of eviction or write failures.',
      details: {
        availableBytes,
        quotaBytes: estimate?.quota,
        usageBytes: estimate?.usage,
        usageRatio,
      },
    });
  }

  return storage;
}

async function summarizeRuntimeAssets(args: {
  runtimeArtifact: SyncularRuntimeArtifact;
  requiredFeatures?: readonly string[];
  runtimeArtifacts?: readonly SyncularRuntimeArtifactCandidate[];
  checkRuntimeAssets: boolean;
  fetchRef?: SyncularBrowserDeploymentPreflightFetch;
  issues: SyncularBrowserDeploymentPreflightIssue[];
}): Promise<SyncularBrowserDeploymentPreflightRuntimeAssets> {
  const assets = [
    {
      kind: 'wasm-glue' as const,
      input: args.runtimeArtifact.wasmGlueUrl,
      fallback: getSyncularRuntimeArtifact().wasmGlueUrl,
    },
    {
      kind: 'wasm-binary' as const,
      input: args.runtimeArtifact.wasmUrl,
      fallback: getSyncularRuntimeArtifact().wasmUrl,
    },
  ];
  const resolvedAssets = await Promise.all(
    assets.map((asset) =>
      inspectRuntimeAsset({
        kind: asset.kind,
        input: resolveRuntimeAssetInput(asset.input, asset.fallback),
        checkRuntimeAssets: args.checkRuntimeAssets,
        fetchRef: args.fetchRef,
        issues: args.issues,
      })
    )
  );
  const artifactName = findRuntimeArtifactName(
    args.runtimeArtifact,
    args.runtimeArtifacts
  );

  return {
    checked: resolvedAssets.every((asset) => asset.checked),
    ...(artifactName ? { artifactName } : {}),
    requiredFeatures: [...(args.requiredFeatures ?? [])],
    assets: resolvedAssets,
  };
}

function resolveRuntimeAssetInput(
  input: string | URL | Request | undefined,
  fallback: string | URL | Request | undefined
): string | URL | Request {
  const resolved = input ?? fallback;
  if (resolved == null) {
    throw new Error('Syncular runtime artifact is missing an asset URL.');
  }
  return resolved;
}

async function inspectRuntimeAsset(args: {
  kind: SyncularBrowserDeploymentPreflightRuntimeAsset['kind'];
  input: string | URL | Request;
  checkRuntimeAssets: boolean;
  fetchRef?: SyncularBrowserDeploymentPreflightFetch;
  issues: SyncularBrowserDeploymentPreflightIssue[];
}): Promise<SyncularBrowserDeploymentPreflightRuntimeAsset> {
  const url = describeRuntimeAssetUrl(args.input);
  if (!args.checkRuntimeAssets || args.fetchRef == null) {
    return {
      kind: args.kind,
      url,
      checked: false,
      status: 'unknown',
      issueCodes: [],
    };
  }
  if (isFileRuntimeAsset(args.input)) {
    const issue = {
      code: 'browser.runtime_asset_file_url_unchecked' as const,
      severity: 'info' as const,
      target: 'runtime-assets' as const,
      recommendedAction: 'configureStaticAssetServing' as const,
      message:
        'The Syncular runtime asset resolved to a file URL; browser deployment preflight can only verify served HTTP(S) assets.',
      details: { url, assetKind: args.kind },
    };
    args.issues.push(issue);
    return {
      kind: args.kind,
      url,
      checked: false,
      status: 'unknown',
      issueCodes: [issue.code],
    };
  }

  try {
    const response = await fetchRuntimeAsset(args.fetchRef, args.input);
    const contentType = response.headers.get('content-type');
    const issueCodes: SyncularBrowserDeploymentPreflightIssueCode[] = [];
    let status: SyncularBrowserDeploymentPreflightStatus = 'ready';

    if (!response.ok) {
      const issue = {
        code: 'browser.runtime_asset_bad_status' as const,
        severity: 'error' as const,
        target: 'runtime-assets' as const,
        recommendedAction: 'serveRuntimeAssets' as const,
        message: `The Syncular ${args.kind} asset responded with HTTP ${response.status}.`,
        details: {
          url,
          assetKind: args.kind,
          httpStatus: response.status,
          statusText: response.statusText,
        },
      };
      args.issues.push(issue);
      issueCodes.push(issue.code);
      status = 'not-ready';
    }

    const contentTypeIssue = validateRuntimeAssetContentType({
      kind: args.kind,
      contentType,
      url,
    });
    if (contentTypeIssue) {
      args.issues.push(contentTypeIssue);
      issueCodes.push(contentTypeIssue.code);
      if (status !== 'not-ready') {
        status =
          contentTypeIssue.severity === 'error' ? 'not-ready' : 'warning';
      }
    }

    return {
      kind: args.kind,
      url,
      checked: true,
      status,
      httpStatus: response.status,
      contentType,
      issueCodes,
    };
  } catch (error) {
    const issue = {
      code: 'browser.runtime_asset_unreachable' as const,
      severity: 'error' as const,
      target: 'runtime-assets' as const,
      recommendedAction: 'serveRuntimeAssets' as const,
      message: `The Syncular ${args.kind} asset could not be fetched.`,
      details: {
        url,
        assetKind: args.kind,
        error: error instanceof Error ? error.message : String(error),
      },
    };
    args.issues.push(issue);
    return {
      kind: args.kind,
      url,
      checked: true,
      status: 'not-ready',
      issueCodes: [issue.code],
    };
  }
}

async function fetchRuntimeAsset(
  fetchRef: SyncularBrowserDeploymentPreflightFetch,
  input: string | URL | Request
) {
  const head = await fetchRef(input, { method: 'HEAD' });
  if (head.status !== 405) return head;
  return fetchRef(input, { method: 'GET' });
}

function validateRuntimeAssetContentType(args: {
  kind: SyncularBrowserDeploymentPreflightRuntimeAsset['kind'];
  contentType: string | null;
  url: string;
}): SyncularBrowserDeploymentPreflightIssue | null {
  const normalized = args.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (args.kind === 'wasm-binary') {
    if (normalized === 'application/wasm') return null;
    return {
      code: 'browser.runtime_asset_bad_content_type',
      severity: normalized === 'text/html' ? 'error' : 'warning',
      target: 'runtime-assets',
      recommendedAction: 'configureStaticAssetServing',
      message: normalized
        ? `The Syncular WASM asset is served as ${normalized}; application/wasm is expected.`
        : 'The Syncular WASM asset did not include a content-type header; application/wasm is expected.',
      details: {
        url: args.url,
        assetKind: args.kind,
        contentType: args.contentType,
        expectedContentType: 'application/wasm',
      },
    };
  }

  if (
    normalized == null ||
    [
      'application/ecmascript',
      'application/javascript',
      'application/x-javascript',
      'text/ecmascript',
      'text/javascript',
    ].includes(normalized)
  ) {
    return null;
  }
  return {
    code: 'browser.runtime_asset_bad_content_type',
    severity: normalized === 'text/html' ? 'error' : 'warning',
    target: 'runtime-assets',
    recommendedAction: 'configureStaticAssetServing',
    message: `The Syncular WASM glue asset is served as ${normalized}; JavaScript content type is expected.`,
    details: {
      url: args.url,
      assetKind: args.kind,
      contentType: args.contentType,
      expectedContentType: 'application/javascript',
    },
  };
}

function addBrowserIssues(args: {
  browser: SyncularBrowserDeploymentPreflightBrowser;
  storage: SyncularBrowserDeploymentPreflightStorage;
  requireCrossOriginIsolation: boolean;
  issues: SyncularBrowserDeploymentPreflightIssue[];
}) {
  if (args.browser.worker === false) {
    args.issues.push({
      code: 'browser.worker_unavailable',
      severity: 'error',
      target: 'browser',
      recommendedAction: 'configureStaticAssetServing',
      message:
        'Web Workers are unavailable; Syncular browser databases run the Rust runtime in a Worker.',
    });
  }
  if (args.browser.webAssembly === false) {
    args.issues.push({
      code: 'browser.webassembly_unavailable',
      severity: 'error',
      target: 'browser',
      recommendedAction: 'serveRuntimeAssets',
      message:
        'WebAssembly is unavailable; Syncular cannot run the Rust SQLite runtime in this browser.',
    });
  }
  if (args.storage.durableRequired && args.browser.secureContext === false) {
    args.issues.push({
      code: 'browser.insecure_context',
      severity: 'error',
      target: 'browser',
      recommendedAction: 'configureHttpsOrLocalhost',
      message:
        'The page is not a secure context; use HTTPS or localhost before relying on durable browser storage.',
    });
  }
  if (
    args.requireCrossOriginIsolation &&
    args.browser.crossOriginIsolated === false
  ) {
    args.issues.push({
      code: 'browser.cross_origin_isolation_missing',
      severity: 'error',
      target: 'browser',
      recommendedAction: 'configureCrossOriginIsolation',
      message:
        'Cross-origin isolation is required by this Syncular deployment check but is not active.',
    });
  }
}

function addLifecycleIssues(args: {
  lifecycle: SyncularBrowserDeploymentPreflightLifecycle;
  requireMultiTabCoordination: boolean;
  requirePageLifecycleResume: boolean;
  issues: SyncularBrowserDeploymentPreflightIssue[];
}) {
  if (args.requireMultiTabCoordination && !args.lifecycle.broadcastChannel) {
    args.issues.push({
      code: 'browser.broadcast_channel_unavailable',
      severity: 'error',
      target: 'lifecycle',
      recommendedAction: 'coordinateBrowserTabs',
      message:
        'BroadcastChannel is unavailable; this deployment requires browser-tab coordination before opening persistent Syncular databases in multiple tabs.',
    });
  }
  if (args.requireMultiTabCoordination && !args.lifecycle.webLocks) {
    args.issues.push({
      code: 'browser.web_locks_unavailable',
      severity: 'error',
      target: 'lifecycle',
      recommendedAction: 'coordinateBrowserTabs',
      message:
        'The Web Locks API is unavailable; this deployment requires a browser lock before running multi-tab local recovery or single-writer database work.',
    });
  }
  if (
    args.requirePageLifecycleResume &&
    !args.lifecycle.resumeSignalAvailable
  ) {
    args.issues.push({
      code: 'browser.page_lifecycle_unavailable',
      severity: 'error',
      target: 'lifecycle',
      recommendedAction: 'wirePageLifecycleResume',
      message:
        'Page lifecycle visibility/pagehide signals are unavailable; this deployment requires a host signal that calls resumeFromBackground() after tab or app suspension.',
    });
  }
}

function summarizeStatus(
  issues: readonly SyncularBrowserDeploymentPreflightIssue[]
): SyncularBrowserDeploymentPreflightStatus {
  if (issues.some((issue) => issue.severity === 'error')) return 'not-ready';
  if (issues.some((issue) => issue.severity === 'warning')) return 'warning';
  if (issues.some((issue) => issue.severity === 'info')) return 'unknown';
  return 'ready';
}

function summarizeSupport(args: {
  status: SyncularBrowserDeploymentPreflightStatus;
  storage: SyncularBrowserDeploymentPreflightStorage;
  runtimeAssets: SyncularBrowserDeploymentPreflightRuntimeAssets;
  issues: readonly SyncularBrowserDeploymentPreflightIssue[];
}): SyncularBrowserDeploymentPreflightSupport {
  const persistence = summarizePersistence(args.storage, args.issues);
  const hasError = args.issues.some((issue) => issue.severity === 'error');
  const tier = summarizeSupportTier({
    hasError,
    runtimeAssetsChecked: args.runtimeAssets.checked,
    status: args.status,
    storage: args.storage,
  });
  return {
    tier,
    persistence,
    persistentOffline: tier === 'persistent-offline',
    productionReady:
      tier === 'persistent-offline' &&
      persistence === 'persistent' &&
      args.status === 'ready',
    summary: summarizeSupportMessage(tier, persistence),
    issueCodes: args.issues.map((issue) => issue.code),
    recommendedActions: uniqueRecommendedActions(args.issues),
  };
}

function summarizePersistence(
  storage: SyncularBrowserDeploymentPreflightStorage,
  issues: readonly SyncularBrowserDeploymentPreflightIssue[]
): SyncularBrowserDeploymentPreflightPersistenceMode {
  if (!storage.durableRequired) return 'ephemeral';
  if (
    issues.some(
      (issue) => issue.target === 'storage' && issue.severity === 'error'
    )
  ) {
    return 'unsupported';
  }
  if (storage.persisted === true) return 'persistent';
  if (
    storage.persistenceSupported === false ||
    storage.persisted === false ||
    storage.quotaBytes === 0
  ) {
    return 'evictable';
  }
  return 'unknown';
}

function summarizeSupportTier(args: {
  hasError: boolean;
  runtimeAssetsChecked: boolean;
  status: SyncularBrowserDeploymentPreflightStatus;
  storage: SyncularBrowserDeploymentPreflightStorage;
}): SyncularBrowserDeploymentPreflightSupportTier {
  if (args.hasError) return 'unsupported';
  if (!args.storage.durableRequired) return 'ephemeral-development';
  if (!args.runtimeAssetsChecked || args.status === 'unknown') return 'unknown';
  return 'persistent-offline';
}

function summarizeSupportMessage(
  tier: SyncularBrowserDeploymentPreflightSupportTier,
  persistence: SyncularBrowserDeploymentPreflightPersistenceMode
): string {
  if (tier === 'persistent-offline' && persistence === 'persistent') {
    return 'Persistent offline browser storage is supported and persistent storage is currently granted.';
  }
  if (tier === 'persistent-offline') {
    return 'Persistent offline browser storage is supported, but storage may be evicted or persistence could not be fully proven.';
  }
  if (tier === 'ephemeral-development') {
    return 'Syncular is configured for memory storage; this is suitable for development or tests, not production offline persistence.';
  }
  if (tier === 'unsupported') {
    return 'This browser or deployment is missing a required Syncular capability.';
  }
  return 'Syncular browser support could not be fully proven by this preflight.';
}

function uniqueRecommendedActions(
  issues: readonly SyncularBrowserDeploymentPreflightIssue[]
): SyncularBrowserDeploymentPreflightRecommendedAction[] {
  return [
    ...new Set(
      issues
        .map((issue) => issue.recommendedAction)
        .filter(
          (
            action
          ): action is SyncularBrowserDeploymentPreflightRecommendedAction =>
            action != null
        )
    ),
  ];
}

function findRuntimeArtifactName(
  artifact: SyncularRuntimeArtifact,
  artifacts?: readonly SyncularRuntimeArtifactCandidate[]
): string | undefined {
  const candidates = artifacts ?? [
    getSyncularRuntimeArtifact('core'),
    getSyncularRuntimeArtifact('full'),
    getSyncularRuntimeArtifact('full-perf'),
  ];
  return candidates.find(
    (candidate) =>
      sameRuntimeAsset(candidate.wasmGlueUrl, artifact.wasmGlueUrl) &&
      sameRuntimeAsset(candidate.wasmUrl, artifact.wasmUrl)
  )?.name;
}

function sameRuntimeAsset(
  left: string | URL | Request | undefined,
  right: string | URL | Request | undefined
): boolean {
  if (left == null || right == null) return false;
  return describeRuntimeAssetUrl(left) === describeRuntimeAssetUrl(right);
}

function describeRuntimeAssetUrl(input: string | URL | Request): string {
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function summarizeAvailableBytes(
  estimate: { quota?: number; usage?: number } | undefined
): number | undefined {
  if (estimate?.quota == null || estimate.usage == null) return undefined;
  return Math.max(0, estimate.quota - estimate.usage);
}

function summarizeStorageUsageRatio(
  estimate: { quota?: number; usage?: number } | undefined
): number | undefined {
  if (
    estimate?.quota == null ||
    estimate.usage == null ||
    estimate.quota <= 0
  ) {
    return undefined;
  }
  return Math.min(1, Math.max(0, estimate.usage / estimate.quota));
}

function summarizeQuotaPressure(
  usageRatio: number | undefined
): SyncularBrowserDeploymentPreflightQuotaPressure {
  if (usageRatio == null) return 'unknown';
  if (usageRatio >= 0.9) return 'high';
  if (usageRatio >= 0.75) return 'elevated';
  return 'normal';
}

function isFileRuntimeAsset(input: string | URL | Request): boolean {
  try {
    const value =
      typeof Request !== 'undefined' && input instanceof Request
        ? input.url
        : input;
    const url = value instanceof URL ? value : new URL(String(value));
    return url.protocol === 'file:';
  } catch {
    return false;
  }
}

async function safeBooleanCall(
  callback: (() => Promise<boolean>) | undefined
): Promise<boolean | null> {
  if (!callback) return null;
  try {
    return await callback();
  } catch {
    return null;
  }
}

async function safeEstimate(
  callback: () => Promise<{ quota?: number; usage?: number }>
): Promise<{ quota?: number; usage?: number } | undefined> {
  try {
    return await callback();
  } catch {
    return undefined;
  }
}

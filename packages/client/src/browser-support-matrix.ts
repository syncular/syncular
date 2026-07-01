import type {
  SyncularBrowserDeploymentPreflight,
  SyncularBrowserDeploymentPreflightIssueCode,
  SyncularBrowserDeploymentPreflightPersistenceMode,
  SyncularBrowserDeploymentPreflightRecommendedAction,
  SyncularBrowserDeploymentPreflightSupportTier,
} from './browser-deployment-preflight';

export type SyncularBrowserSupportContext =
  | 'chromium-secure-page'
  | 'firefox-secure-page'
  | 'safari-secure-page'
  | 'private-browsing'
  | 'webview'
  | 'pwa'
  | 'ssr-build';

export type SyncularBrowserSupportPolicy =
  | 'supported-after-preflight'
  | 'preflight-required'
  | 'development-only'
  | 'unsupported';

export interface SyncularBrowserSupportMatrixEntry {
  context: SyncularBrowserSupportContext;
  label: string;
  policy: SyncularBrowserSupportPolicy;
  expectedSupportTier: SyncularBrowserDeploymentPreflightSupportTier;
  expectedPersistence: SyncularBrowserDeploymentPreflightPersistenceMode;
  preflightRequired: boolean;
  requiredEvidence: readonly string[];
  knownRisks: readonly string[];
  capabilityIssueCodes: readonly SyncularBrowserDeploymentPreflightIssueCode[];
  recommendedActions: readonly SyncularBrowserDeploymentPreflightRecommendedAction[];
  nextSteps: readonly string[];
}

export type SyncularBrowserSupportPolicyEvaluationStatus =
  | 'met'
  | 'warning'
  | 'not-met'
  | 'not-applicable';

export interface SyncularBrowserSupportPolicyEvaluation {
  context: SyncularBrowserSupportContext;
  label: string;
  policy: SyncularBrowserSupportPolicy;
  status: SyncularBrowserSupportPolicyEvaluationStatus;
  preflightRequired: boolean;
  expectedSupportTier: SyncularBrowserDeploymentPreflightSupportTier;
  observedSupportTier: SyncularBrowserDeploymentPreflightSupportTier | null;
  expectedPersistence: SyncularBrowserDeploymentPreflightPersistenceMode;
  observedPersistence: SyncularBrowserDeploymentPreflightPersistenceMode | null;
  preflightStatus: SyncularBrowserDeploymentPreflight['status'] | null;
  productionReady: boolean | null;
  issueCodes: readonly SyncularBrowserDeploymentPreflightIssueCode[];
  recommendedActions: readonly SyncularBrowserDeploymentPreflightRecommendedAction[];
  summary: string;
}

const SYNCULAR_BROWSER_SUPPORT_MATRIX: readonly SyncularBrowserSupportMatrixEntry[] =
  [
    {
      context: 'chromium-secure-page',
      label: 'Chrome/Chromium secure browser page',
      policy: 'supported-after-preflight',
      expectedSupportTier: 'persistent-offline',
      expectedPersistence: 'persistent',
      preflightRequired: true,
      requiredEvidence: [
        '`getSyncularBrowserDeploymentPreflight(...)` reports `persistent-offline`',
        'Worker, WebAssembly, IndexedDB, and OPFS/SAH or selected durable storage are available',
        'WASM glue and binary assets are served with ready status and expected content types',
        'Persistent storage is granted or quota/eviction risk is accepted by product policy',
        'Multi-tab and lifecycle requirements match the app policy',
      ],
      knownRisks: [
        'Storage can still be evicted when persistence is not granted',
        'Service-worker, CDN, or cache skew can serve stale JS/WASM assets',
        'Durable multi-tab use depends on BroadcastChannel/Web Locks or an explicit single-open-tab policy',
      ],
      capabilityIssueCodes: [
        'browser.worker_unavailable',
        'browser.webassembly_unavailable',
        'browser.indexeddb_unavailable',
        'browser.opfs_unavailable',
        'browser.runtime_asset_bad_status',
        'browser.runtime_asset_bad_content_type',
        'browser.storage_persistence_not_granted',
        'browser.storage_quota_low',
        'browser.broadcast_channel_unavailable',
        'browser.web_locks_unavailable',
        'browser.page_lifecycle_unavailable',
      ],
      recommendedActions: [
        'serveRuntimeAssets',
        'configureStaticAssetServing',
        'selectSupportedStorage',
        'requestPersistentStorage',
        'freeStorageQuota',
        'coordinateBrowserTabs',
        'wirePageLifecycleResume',
      ],
      nextSteps: [
        'Run the deployment preflight in the deployed page before opening the database',
        'Keep a reopen/restart browser smoke for production persistence confidence',
      ],
    },
    {
      context: 'firefox-secure-page',
      label: 'Firefox secure browser page',
      policy: 'preflight-required',
      expectedSupportTier: 'unknown',
      expectedPersistence: 'unknown',
      preflightRequired: true,
      requiredEvidence: [
        'Deployment preflight proves Worker, WebAssembly, IndexedDB, runtime assets, quota, and lifecycle support in the exact Firefox version',
        'Storage fallback behavior is visible and acceptable for the app',
        'A browser reopen smoke proves local rows survive the lifecycle boundary the app cares about',
      ],
      knownRisks: [
        'OPFS/SAH, Web Locks, and persistence-grant behavior are browser-version dependent',
        'IndexedDB-backed durable mode may be evictable without an explicit persistence grant',
        'Lifecycle resume and multi-tab coordination need real browser evidence',
      ],
      capabilityIssueCodes: [
        'browser.worker_unavailable',
        'browser.webassembly_unavailable',
        'browser.indexeddb_unavailable',
        'browser.opfs_unavailable',
        'browser.storage_persistence_not_granted',
        'browser.web_locks_unavailable',
        'browser.page_lifecycle_unavailable',
      ],
      recommendedActions: [
        'selectSupportedStorage',
        'requestPersistentStorage',
        'coordinateBrowserTabs',
        'wirePageLifecycleResume',
      ],
      nextSteps: [
        'Treat Firefox as preflight-gated until the project has a maintained Firefox runtime smoke',
      ],
    },
    {
      context: 'safari-secure-page',
      label: 'Safari secure browser page',
      policy: 'preflight-required',
      expectedSupportTier: 'unknown',
      expectedPersistence: 'unknown',
      preflightRequired: true,
      requiredEvidence: [
        'Deployment preflight proves Worker, WebAssembly, IndexedDB, OPFS/fallback storage, runtime assets, and quota in the exact Safari version',
        'Page restore, backgrounding, and storage persistence are tested on the target desktop or iOS host',
        'The app has an explicit policy for evictable storage and single-open-tab behavior',
      ],
      knownRisks: [
        'Storage persistence, OPFS/SAH, and Web Locks differ across Safari versions and host modes',
        'Backgrounding and page restoration can interrupt realtime and local visibility timing',
        'Private browsing behavior can look similar to normal Safari until persistence is tested',
      ],
      capabilityIssueCodes: [
        'browser.worker_unavailable',
        'browser.webassembly_unavailable',
        'browser.indexeddb_unavailable',
        'browser.opfs_unavailable',
        'browser.storage_persistence_not_granted',
        'browser.web_locks_unavailable',
        'browser.page_lifecycle_unavailable',
      ],
      recommendedActions: [
        'selectSupportedStorage',
        'requestPersistentStorage',
        'coordinateBrowserTabs',
        'wirePageLifecycleResume',
      ],
      nextSteps: [
        'Treat Safari support as target-host evidence until a maintained Safari matrix smoke exists',
      ],
    },
    {
      context: 'private-browsing',
      label: 'Private/incognito browsing mode',
      policy: 'development-only',
      expectedSupportTier: 'ephemeral-development',
      expectedPersistence: 'ephemeral',
      preflightRequired: true,
      requiredEvidence: [
        'The app explicitly opts into memory or test-only fallback behavior',
        'Deployment preflight shows that durable storage is unavailable, evictable, or intentionally not required',
        'User-facing copy does not promise offline persistence in this mode',
      ],
      knownRisks: [
        'Storage can be blocked, quota-limited, or deleted when the private session ends',
        'Persistent storage grants are generally unavailable or not durable enough for production offline promises',
        'A same-page smoke can pass while reopen/restart persistence fails',
      ],
      capabilityIssueCodes: [
        'browser.storage_persistence_not_granted',
        'browser.storage_persistence_unavailable',
        'browser.storage_quota_low',
        'browser.indexeddb_unavailable',
        'browser.opfs_unavailable',
      ],
      recommendedActions: [
        'selectSupportedStorage',
        'requestPersistentStorage',
        'freeStorageQuota',
      ],
      nextSteps: [
        'Fail loudly for production durable mode or show a clear dev/test-only storage state',
      ],
    },
    {
      context: 'webview',
      label: 'Native WebView host',
      policy: 'preflight-required',
      expectedSupportTier: 'unknown',
      expectedPersistence: 'unknown',
      preflightRequired: true,
      requiredEvidence: [
        'The target WebView proves Worker, WebAssembly, IndexedDB/OPFS or selected durable storage, and asset loading through deployment preflight',
        'The native host wires foreground/background/resume signals into Syncular lifecycle recovery',
        'The app has a storage and asset-serving policy for packaged or custom-scheme URLs',
      ],
      knownRisks: [
        'Host WebViews vary by OS version, embedding flags, custom URL scheme, and process lifetime',
        'Lifecycle and network events may belong to the native shell rather than the page',
        'Packaged assets can have missing or wrong content types unless the host serves JS/WASM deliberately',
      ],
      capabilityIssueCodes: [
        'browser.worker_unavailable',
        'browser.webassembly_unavailable',
        'browser.indexeddb_unavailable',
        'browser.opfs_unavailable',
        'browser.runtime_asset_bad_status',
        'browser.runtime_asset_bad_content_type',
        'browser.runtime_asset_file_url_unchecked',
        'browser.page_lifecycle_unavailable',
      ],
      recommendedActions: [
        'serveRuntimeAssets',
        'configureStaticAssetServing',
        'selectSupportedStorage',
        'wirePageLifecycleResume',
      ],
      nextSteps: [
        'Keep WebView support host-specific until the project owns Tauri/React Native WebView runtime smokes',
      ],
    },
    {
      context: 'pwa',
      label: 'Installed PWA or service-worker controlled page',
      policy: 'preflight-required',
      expectedSupportTier: 'unknown',
      expectedPersistence: 'unknown',
      preflightRequired: true,
      requiredEvidence: [
        'Deployment preflight runs through the service-worker controlled page and verifies current JS/WASM assets',
        'The app proves reopen or restart persistence after installation',
        'Cache/version skew policy is tested for generated client, JS glue, WASM binary, and server schema versions',
      ],
      knownRisks: [
        'Service workers can keep stale runtime assets alive after a deploy',
        'Storage eviction and quota pressure are more visible once the app is installed and used offline',
        'Background/resume semantics differ from an ordinary foreground browser tab',
      ],
      capabilityIssueCodes: [
        'browser.runtime_asset_bad_status',
        'browser.runtime_asset_bad_content_type',
        'browser.storage_persistence_not_granted',
        'browser.storage_quota_low',
        'browser.page_lifecycle_unavailable',
      ],
      recommendedActions: [
        'serveRuntimeAssets',
        'configureStaticAssetServing',
        'requestPersistentStorage',
        'freeStorageQuota',
        'wirePageLifecycleResume',
        'coordinateBrowserTabs',
      ],
      nextSteps: [
        'Treat PWA support as preflight-gated until install, cache-update, and reopen smokes are maintained',
      ],
    },
    {
      context: 'ssr-build',
      label: 'SSR, static build, or server render context',
      policy: 'unsupported',
      expectedSupportTier: 'unsupported',
      expectedPersistence: 'unsupported',
      preflightRequired: false,
      requiredEvidence: [
        'Root imports are safe during SSR/build, but opening a Syncular browser database is gated to browser code',
        'The browser page, not the SSR process, runs deployment preflight before database open',
        'Framework smokes prove the client root import does not start Worker/WASM side effects during build',
      ],
      knownRisks: [
        'Server render contexts do not provide browser Worker, WebAssembly, IndexedDB, OPFS, or page lifecycle globals',
        'Accidental database open during SSR can look like a generic bootstrap or runtime failure',
      ],
      capabilityIssueCodes: [
        'browser.worker_unavailable',
        'browser.webassembly_unavailable',
        'browser.indexeddb_unavailable',
        'browser.opfs_unavailable',
        'browser.page_lifecycle_unavailable',
      ],
      recommendedActions: [],
      nextSteps: [
        'Keep database open and preflight calls inside client-only framework boundaries',
      ],
    },
  ];

export function getSyncularBrowserSupportMatrix(): SyncularBrowserSupportMatrixEntry[] {
  return SYNCULAR_BROWSER_SUPPORT_MATRIX.map(cloneBrowserSupportMatrixEntry);
}

export function getSyncularBrowserSupportPolicy(
  context: SyncularBrowserSupportContext
): SyncularBrowserSupportMatrixEntry {
  const entry = SYNCULAR_BROWSER_SUPPORT_MATRIX.find(
    (candidate) => candidate.context === context
  );
  if (!entry) {
    throw new Error(`Unknown Syncular browser support context: ${context}`);
  }
  return cloneBrowserSupportMatrixEntry(entry);
}

export function evaluateSyncularBrowserSupportPolicy(
  context: SyncularBrowserSupportContext,
  preflight?: SyncularBrowserDeploymentPreflight | null
): SyncularBrowserSupportPolicyEvaluation {
  const policy = getSyncularBrowserSupportPolicy(context);
  const observedSupportTier = preflight?.support.tier ?? null;
  const observedPersistence = preflight?.support.persistence ?? null;
  const preflightStatus = preflight?.status ?? null;
  const productionReady = preflight?.support.productionReady ?? null;
  const issueCodes = preflight?.support.issueCodes ?? [];
  const recommendedActions = uniqueBrowserSupportRecommendedActions([
    ...(preflight?.support.recommendedActions ?? []),
    ...policy.recommendedActions,
  ]);
  const status = evaluateBrowserSupportPolicyStatus(policy, preflight);
  return {
    context: policy.context,
    label: policy.label,
    policy: policy.policy,
    status,
    preflightRequired: policy.preflightRequired,
    expectedSupportTier: policy.expectedSupportTier,
    observedSupportTier,
    expectedPersistence: policy.expectedPersistence,
    observedPersistence,
    preflightStatus,
    productionReady,
    issueCodes,
    recommendedActions,
    summary: summarizeBrowserSupportPolicyEvaluation({
      policy,
      preflight,
      status,
    }),
  };
}

function cloneBrowserSupportMatrixEntry(
  entry: SyncularBrowserSupportMatrixEntry
): SyncularBrowserSupportMatrixEntry {
  return {
    ...entry,
    requiredEvidence: [...entry.requiredEvidence],
    knownRisks: [...entry.knownRisks],
    capabilityIssueCodes: [...entry.capabilityIssueCodes],
    recommendedActions: [...entry.recommendedActions],
    nextSteps: [...entry.nextSteps],
  };
}

function evaluateBrowserSupportPolicyStatus(
  policy: SyncularBrowserSupportMatrixEntry,
  preflight?: SyncularBrowserDeploymentPreflight | null
): SyncularBrowserSupportPolicyEvaluationStatus {
  if (policy.policy === 'unsupported') return 'not-applicable';
  if (!preflight) return 'not-met';
  if (
    preflight.status === 'not-ready' ||
    preflight.support.tier === 'unsupported'
  ) {
    return 'not-met';
  }
  if (policy.policy === 'development-only') {
    if (
      preflight.support.tier === 'ephemeral-development' ||
      preflight.support.persistence === 'ephemeral'
    ) {
      return 'met';
    }
    return 'warning';
  }
  if (policy.expectedSupportTier === 'unknown') {
    return 'warning';
  }
  if (preflight.support.tier !== policy.expectedSupportTier) {
    return 'warning';
  }
  if (
    policy.expectedPersistence === 'persistent' &&
    preflight.support.persistence !== 'persistent'
  ) {
    return 'warning';
  }
  return preflight.support.productionReady ? 'met' : 'warning';
}

function summarizeBrowserSupportPolicyEvaluation(args: {
  policy: SyncularBrowserSupportMatrixEntry;
  preflight?: SyncularBrowserDeploymentPreflight | null;
  status: SyncularBrowserSupportPolicyEvaluationStatus;
}): string {
  if (args.status === 'not-applicable') {
    return `${args.policy.label} is not a supported context for opening a Syncular browser database.`;
  }
  if (!args.preflight) {
    return `${args.policy.label} requires deployment preflight evidence before Syncular can classify browser support.`;
  }
  if (args.status === 'not-met') {
    return `${args.policy.label} does not meet Syncular browser support policy: ${args.preflight.support.tier}.`;
  }
  if (args.status === 'met') {
    return `${args.policy.label} meets Syncular browser support policy: ${args.preflight.support.tier}.`;
  }
  return `${args.policy.label} still needs retained target evidence: observed ${args.preflight.support.tier}.`;
}

function uniqueBrowserSupportRecommendedActions(
  actions: readonly SyncularBrowserDeploymentPreflightRecommendedAction[]
): SyncularBrowserDeploymentPreflightRecommendedAction[] {
  return [...new Set(actions)];
}

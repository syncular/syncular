import { describe, expect, it } from 'bun:test';
import type {
  SyncularBrowserDeploymentPreflight,
  SyncularBrowserDeploymentPreflightPersistenceMode,
  SyncularBrowserDeploymentPreflightStatus,
  SyncularBrowserDeploymentPreflightSupportTier,
} from './browser-deployment-preflight';
import {
  evaluateSyncularBrowserSupportPolicy,
  getSyncularBrowserSupportMatrix,
  getSyncularBrowserSupportPolicy,
  type SyncularBrowserSupportContext,
} from './browser-support-matrix';

describe('Syncular browser support matrix', () => {
  it('names every browser and host context with evidence and actions', () => {
    const matrix = getSyncularBrowserSupportMatrix();
    const contexts = matrix.map((entry) => entry.context);

    expect(contexts).toEqual([
      'chromium-secure-page',
      'firefox-secure-page',
      'safari-secure-page',
      'private-browsing',
      'webview',
      'pwa',
      'ssr-build',
    ]);
    expect(new Set(contexts).size).toBe(matrix.length);

    for (const entry of matrix) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.requiredEvidence.length).toBeGreaterThan(0);
      expect(entry.knownRisks.length).toBeGreaterThan(0);
      expect(entry.capabilityIssueCodes.length).toBeGreaterThan(0);
      expect(entry.nextSteps.length).toBeGreaterThan(0);
      expect(new Set(entry.capabilityIssueCodes).size).toBe(
        entry.capabilityIssueCodes.length
      );
      expect(new Set(entry.recommendedActions).size).toBe(
        entry.recommendedActions.length
      );
    }
  });

  it('marks Chromium secure pages as supported only after runtime preflight evidence', () => {
    expect(
      getSyncularBrowserSupportPolicy('chromium-secure-page')
    ).toMatchObject({
      policy: 'supported-after-preflight',
      expectedSupportTier: 'persistent-offline',
      expectedPersistence: 'persistent',
      preflightRequired: true,
      capabilityIssueCodes: expect.arrayContaining([
        'browser.runtime_asset_bad_content_type',
        'browser.storage_persistence_not_granted',
        'browser.web_locks_unavailable',
      ]),
      recommendedActions: expect.arrayContaining([
        'serveRuntimeAssets',
        'coordinateBrowserTabs',
      ]),
    });
  });

  it('keeps Firefox, Safari, WebView, and PWA contexts preflight-gated', () => {
    const contexts: SyncularBrowserSupportContext[] = [
      'firefox-secure-page',
      'safari-secure-page',
      'webview',
      'pwa',
    ];

    for (const context of contexts) {
      expect(getSyncularBrowserSupportPolicy(context)).toMatchObject({
        policy: 'preflight-required',
        expectedSupportTier: 'unknown',
        expectedPersistence: 'unknown',
        preflightRequired: true,
      });
    }
  });

  it('does not classify private browsing or SSR as production durable browser support', () => {
    expect(getSyncularBrowserSupportPolicy('private-browsing')).toMatchObject({
      policy: 'development-only',
      expectedSupportTier: 'ephemeral-development',
      expectedPersistence: 'ephemeral',
      capabilityIssueCodes: expect.arrayContaining([
        'browser.storage_persistence_unavailable',
      ]),
    });

    expect(getSyncularBrowserSupportPolicy('ssr-build')).toMatchObject({
      policy: 'unsupported',
      expectedSupportTier: 'unsupported',
      expectedPersistence: 'unsupported',
      preflightRequired: false,
      capabilityIssueCodes: expect.arrayContaining([
        'browser.worker_unavailable',
        'browser.indexeddb_unavailable',
      ]),
    });
  });

  it('returns defensive copies so callers cannot mutate the public matrix', () => {
    const matrix = getSyncularBrowserSupportMatrix();
    (matrix[0]?.requiredEvidence as string[] | undefined)?.push('mutated');

    expect(
      getSyncularBrowserSupportPolicy('chromium-secure-page').requiredEvidence
    ).not.toContain('mutated');
  });

  it('evaluates a ready Chromium preflight as support-policy evidence', () => {
    expect(
      evaluateSyncularBrowserSupportPolicy(
        'chromium-secure-page',
        preflight({
          productionReady: true,
          supportTier: 'persistent-offline',
          persistence: 'persistent',
        })
      )
    ).toMatchObject({
      context: 'chromium-secure-page',
      policy: 'supported-after-preflight',
      status: 'met',
      reasonCodes: ['browser_support.policy_met'],
      expectedSupportTier: 'persistent-offline',
      observedSupportTier: 'persistent-offline',
      expectedPersistence: 'persistent',
      observedPersistence: 'persistent',
      preflightStatus: 'ready',
      productionReady: true,
    });
  });

  it('keeps incomplete Chromium evidence as a warning instead of pretending support is proven', () => {
    expect(
      evaluateSyncularBrowserSupportPolicy(
        'chromium-secure-page',
        preflight({
          supportTier: 'unknown',
          persistence: 'persistent',
          productionReady: false,
        })
      )
    ).toMatchObject({
      status: 'warning',
      reasonCodes: ['browser_support.support_tier_mismatch'],
      observedSupportTier: 'unknown',
      observedPersistence: 'persistent',
      preflightStatus: 'ready',
      productionReady: false,
    });
  });

  it('evaluates capability blockers as not meeting support policy', () => {
    expect(
      evaluateSyncularBrowserSupportPolicy(
        'chromium-secure-page',
        preflight({
          issueCodes: ['browser.worker_unavailable'],
          persistence: 'unsupported',
          status: 'not-ready',
          supportTier: 'unsupported',
        })
      )
    ).toMatchObject({
      status: 'not-met',
      reasonCodes: [
        'browser_support.preflight_not_ready',
        'browser_support.unsupported_tier',
        'browser_support.support_tier_mismatch',
        'browser_support.persistence_mismatch',
      ],
      observedSupportTier: 'unsupported',
      observedPersistence: 'unsupported',
      issueCodes: ['browser.worker_unavailable'],
      recommendedActions: expect.arrayContaining(['serveRuntimeAssets']),
    });
  });

  it('evaluates development-only and unsupported contexts explicitly', () => {
    expect(
      evaluateSyncularBrowserSupportPolicy(
        'private-browsing',
        preflight({
          persistence: 'ephemeral',
          productionReady: false,
          supportTier: 'ephemeral-development',
        })
      )
    ).toMatchObject({
      policy: 'development-only',
      status: 'met',
      reasonCodes: ['browser_support.development_only_context'],
      observedSupportTier: 'ephemeral-development',
      observedPersistence: 'ephemeral',
    });

    expect(
      evaluateSyncularBrowserSupportPolicy('ssr-build', null)
    ).toMatchObject({
      policy: 'unsupported',
      status: 'not-applicable',
      reasonCodes: ['browser_support.unsupported_context'],
      observedSupportTier: null,
      observedPersistence: null,
      preflightRequired: false,
    });
  });

  it('returns reason codes for missing evidence and production-readiness gaps', () => {
    expect(
      evaluateSyncularBrowserSupportPolicy('chromium-secure-page', null)
    ).toMatchObject({
      status: 'not-met',
      reasonCodes: ['browser_support.preflight_missing'],
    });

    expect(
      evaluateSyncularBrowserSupportPolicy(
        'chromium-secure-page',
        preflight({
          persistence: 'persistent',
          productionReady: false,
          supportTier: 'persistent-offline',
        })
      )
    ).toMatchObject({
      status: 'warning',
      reasonCodes: ['browser_support.production_ready_missing'],
    });

    expect(
      evaluateSyncularBrowserSupportPolicy(
        'firefox-secure-page',
        preflight({
          persistence: 'persistent',
          productionReady: true,
          supportTier: 'persistent-offline',
        })
      )
    ).toMatchObject({
      status: 'warning',
      reasonCodes: ['browser_support.target_evidence_required'],
    });
  });
});

function preflight(options: {
  issueCodes?: SyncularBrowserDeploymentPreflight['support']['issueCodes'];
  persistence: SyncularBrowserDeploymentPreflightPersistenceMode;
  productionReady?: boolean;
  status?: SyncularBrowserDeploymentPreflightStatus;
  supportTier: SyncularBrowserDeploymentPreflightSupportTier;
}): SyncularBrowserDeploymentPreflight {
  const status = options.status ?? 'ready';
  const issueCodes = options.issueCodes ?? [];
  const supportTier = options.supportTier;
  const productionReady = options.productionReady ?? false;
  return {
    generatedAt: 42,
    status,
    ready: status === 'ready',
    requiresAction: status === 'not-ready',
    browser: {
      worker: true,
      webAssembly: true,
      secureContext: true,
      crossOriginIsolated: false,
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
      requested: 'indexedDb',
      fallbackAllowed: false,
      durableRequired: options.persistence !== 'ephemeral',
      opfsAvailable: true,
      persistenceSupported: true,
      persisted: options.persistence === 'persistent',
    },
    runtimeAssets: {
      checked: true,
      requiredFeatures: [],
      assets: [],
    },
    support: {
      tier: supportTier,
      persistence: options.persistence,
      persistentOffline: supportTier === 'persistent-offline',
      productionReady,
      summary: 'test preflight',
      issueCodes,
      recommendedActions: status === 'not-ready' ? ['serveRuntimeAssets'] : [],
    },
    issues: issueCodes.map((code) => ({
      code,
      severity: 'error',
      message: code,
      target: 'browser',
    })),
  };
}

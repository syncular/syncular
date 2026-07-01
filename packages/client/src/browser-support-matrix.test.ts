import { describe, expect, it } from 'bun:test';
import {
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
});

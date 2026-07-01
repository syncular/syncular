import { describe, expect, it } from 'bun:test';
import {
  assertFailureArtifactRedacted,
  findFailureArtifactSensitiveField,
  requireBrowserPreviewFailureArtifact,
  requireCloudflareRuntimeFailureArtifact,
} from './failure-artifacts';

describe('failure artifact assertions', () => {
  it('accepts canonical browser preview failure artifacts', () => {
    const artifact = browserPreviewFailureArtifact();

    expect(requireBrowserPreviewFailureArtifact(artifact)).toBe(artifact);
  });

  it('rejects browser preview artifacts with unsafe or inconsistent evidence', () => {
    const withSecret = browserPreviewFailureArtifact({
      probe: {
        ...browserPreviewFailureArtifact().probe,
        authorization: 'Bearer secret',
      },
    });

    expect(() => requireBrowserPreviewFailureArtifact(withSecret)).toThrow(
      'sensitive field $.probe.authorization'
    );

    const withStaleSupportCounts = browserPreviewFailureArtifact({
      probe: {
        ...browserPreviewFailureArtifact().probe,
        browserSupportPolicy: {
          ...browserPreviewFailureArtifact().probe.browserSupportPolicy,
          reasonCount: 7,
        },
      },
    });

    expect(() =>
      requireBrowserPreviewFailureArtifact(withStaleSupportCounts)
    ).toThrow('$.probe.browserSupportPolicy.reasonCount did not match');

    const withUnboundedText = browserPreviewFailureArtifact({
      probe: {
        ...browserPreviewFailureArtifact().probe,
        textExcerpt: 'x'.repeat(4001),
      },
    });

    expect(() =>
      requireBrowserPreviewFailureArtifact(withUnboundedText)
    ).toThrow('$.probe.textExcerpt was not a bounded string');
  });

  it('accepts canonical Cloudflare runtime failure artifacts', () => {
    const artifact = cloudflareRuntimeFailureArtifact();

    expect(requireCloudflareRuntimeFailureArtifact(artifact)).toBe(artifact);
  });

  it('rejects Cloudflare artifacts with unsafe or malformed metrics', () => {
    const withSecret = cloudflareRuntimeFailureArtifact({
      probe: {
        ...cloudflareRuntimeFailureArtifact().probe,
        secret: 'raw-token',
      },
    });

    expect(() => requireCloudflareRuntimeFailureArtifact(withSecret)).toThrow(
      'sensitive field $.probe.secret'
    );

    const withNegativeMetric = cloudflareRuntimeFailureArtifact({
      probe: {
        ...cloudflareRuntimeFailureArtifact().probe,
        blobMetrics: {
          ...cloudflareRuntimeFailureArtifact().probe.blobMetrics,
          downloadBytes: -1,
        },
      },
    });

    expect(() =>
      requireCloudflareRuntimeFailureArtifact(withNegativeMetric)
    ).toThrow('$.probe.blobMetrics.downloadBytes');

    const withLongOutput = cloudflareRuntimeFailureArtifact({
      probe: {
        ...cloudflareRuntimeFailureArtifact().probe,
        outputExcerpt: 'x'.repeat(12_004),
      },
    });

    expect(() =>
      requireCloudflareRuntimeFailureArtifact(withLongOutput)
    ).toThrow('$.probe.outputExcerpt was not a bounded string');
  });

  it('supports generic redaction scans for known secret values', () => {
    expect(
      findFailureArtifactSensitiveField({
        nested: [{ refreshToken: 'raw-token' }],
      })
    ).toBe('$.nested[0].refreshToken');

    expect(() =>
      assertFailureArtifactRedacted(
        { outputExcerpt: 'safe prefix raw-secret safe suffix' },
        { forbiddenSubstrings: ['raw-secret'] }
      )
    ).toThrow('forbidden substring "raw-secret"');
  });
});

function browserPreviewFailureArtifact(
  overrides: Record<string, unknown> = {}
) {
  return {
    generatedAt: '2026-07-01T12:00:00.000Z',
    reason: 'artifact-self-check',
    metrics: {
      artifactCreatedAfterMs: 18,
      assetCheckMs: 7,
      assetCount: 4,
      browserHealthMarkerInAssets: true,
      browserSupportPolicyMarkerInAssets: true,
      commandTimelineMarkerInAssets: true,
      cssAssetBytes: 2048,
      cssAssetCount: 1,
      deploymentPreflightMarkerInAssets: true,
      jsAssetBytes: 12_000,
      jsAssetCount: 2,
      lifecycleResumeMarkerInAssets: true,
      otherAssetBytes: 128,
      otherAssetCount: 1,
      previewReadyMs: 42,
      starterTimelineMarkerInAssets: true,
      storageRecoveryMarkerInAssets: true,
      supportBundleMarkerInAssets: true,
      totalAssetBytes: 14_176,
    },
    probe: {
      ready: false,
      errors: ['support bundle export failed'],
      markers: {
        durableHealthLine: true,
        schemaLine: true,
        preflightFailure: false,
        databaseOpening: false,
      },
      browserHealth: {
        blockedOperationCount: 0,
        generatedMutation: 'available',
        lifecycleStage: 'realtime-live',
        localVisibility: 'available',
        recoveryOwner: 'runtime',
        status: 'healthy',
        syncNow: 'available',
      },
      deploymentPreflight: {
        actionCount: 0,
        issueCount: 0,
        minimumQuotaBytes: 52_428_800,
        persistence: 'persistent',
        persisted: 'true',
        preflightMs: 2,
        quotaBytes: 107_374_182_400,
        status: 'ready',
        supportTier: 'persistent-offline',
        usageBytes: 4096,
      },
      browserSupportPolicy: {
        actionCount: 0,
        context: 'chromium-secure-page',
        expectedPersistence: 'persistent',
        expectedSupportTier: 'persistent-offline',
        issueCount: 0,
        knownRisks: ['storage can be evicted'],
        knownRiskCount: 1,
        nextSteps: ['run reopen smoke'],
        nextStepCount: 1,
        observedPersistence: 'persistent',
        observedSupportTier: 'persistent-offline',
        policy: 'supported-after-preflight',
        preflightRequired: 'true',
        reasonCodes: ['browser_support.policy_met'],
        reasonCount: 1,
        requiredEvidence: ['deployment preflight passed'],
        requiredEvidenceCount: 1,
        status: 'met',
      },
      supportBundle: {
        status: 'failed',
        redacted: 'true',
        sectionCount: 4,
        issueCount: 1,
        blobEventCount: 0,
        cursorCount: 1,
        latestBlobCode: null,
        latestLocalApplyCode: 'local.visibility.visible',
        latestRealtimeCode: 'realtime.sync_wakeup',
        latestSyncCode: 'sync.pull.complete',
        localApplyEventCount: 1,
        realtimeEventCount: 2,
        requestIdCount: 0,
        sectionErrorCount: 1,
        syncAttemptIdCount: 1,
        syncEventCount: 3,
        timelineEventCount: 12,
      },
      lifecycleResume: {
        status: 'complete',
        count: 2,
        reason: 'online',
        error: null,
        lockName: 'syncular:create-syncular-app:lifecycle-resume',
        lockRequired: 'false',
        lockState: 'acquired',
      },
      lifecyclePause: {
        count: 2,
        reason: 'beforeunload',
        pagehidePersisted: 'true',
        shutdownSignalCount: 1,
        visibilityState: 'visible',
      },
      starterTimeline: {
        bootstrapReadyMs: 10,
        bootstrapStatus: 'ready',
        databaseOpenMs: 12,
        healthRefreshMs: 3,
        localVisibilityErrorCode: null,
        localVisibilityMs: 5,
        localVisibilityStatus: 'visible',
        marker: true,
        realtimeConnectedMs: 14,
        realtimeStatus: 'connected',
        schemaReadinessMs: 2,
        supportBundleExportMs: 4,
      },
      textExcerpt:
        'Syncular support bundle failed after redacted export check.',
    },
    ...overrides,
  };
}

function cloudflareRuntimeFailureArtifact(
  overrides: Record<string, unknown> = {}
) {
  return {
    generatedAt: '2026-07-01T12:00:00.000Z',
    reason: 'cloudflare-runtime-artifact-self-check',
    probe: {
      blobMetrics: {
        attempted: true,
        completeUploadMs: 3,
        contentBytes: 128,
        downloadBytes: 128,
        downloadBytesMs: 2,
        downloadUrlMs: 3,
        partitionedDownloadBytes: 128,
        partitionedDownloadBytesMs: 2,
        partitionedDownloadUrlMs: 4,
        referencePushMs: 5,
        totalMs: 19,
        uploadBytesMs: 2,
        uploadInitMs: 1,
      },
      blobRouteBase: 'http://127.0.0.1:8787/sync/blobs',
      expectedText: 'Syncular Cloudflare smoke',
      exited: { code: null, signal: null },
      outputExcerpt: 'wrangler dev output excerpt',
      port: 8787,
      route: '/sync',
      syncRouteBase: 'http://127.0.0.1:8787/sync',
      webSocketRoute: '/sync/realtime',
    },
    ...overrides,
  };
}

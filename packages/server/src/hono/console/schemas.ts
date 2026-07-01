/**
 * @syncular/server/hono - Console API Zod schemas
 */

import { z } from 'zod';

// ============================================================================
// Stats Schema
// ============================================================================

export const SyncStatsSchema = z.object({
  commitCount: z.number().int(),
  changeCount: z.number().int(),
  minCommitSeq: z.number().int(),
  maxCommitSeq: z.number().int(),
  clientCount: z.number().int(),
  activeClientCount: z.number().int(),
  minActiveClientCursor: z.number().int().nullable(),
  maxActiveClientCursor: z.number().int().nullable(),
  snapshotChunkCount: z.number().int().nonnegative(),
  snapshotChunkBytes: z.number().int().nonnegative(),
  expiredSnapshotChunkCount: z.number().int().nonnegative(),
  expiredSnapshotChunkBytes: z.number().int().nonnegative(),
  snapshotArtifactCount: z.number().int().nonnegative(),
  snapshotArtifactBytes: z.number().int().nonnegative(),
  expiredSnapshotArtifactCount: z.number().int().nonnegative(),
  expiredSnapshotArtifactBytes: z.number().int().nonnegative(),
});

export type SyncStats = z.infer<typeof SyncStatsSchema>;

// ============================================================================
// Commit Schemas
// ============================================================================

export const ConsoleCommitListItemSchema = z.object({
  commitSeq: z.number().int(),
  actorId: z.string(),
  clientId: z.string(),
  clientCommitId: z.string(),
  createdAt: z.string(),
  changeCount: z.number().int(),
  affectedTables: z.array(z.string()),
});

export type ConsoleCommitListItem = z.infer<typeof ConsoleCommitListItemSchema>;

export const ConsoleAuditChangeKindSchema = z.enum([
  'app_row',
  'delete',
  'blob_reference',
  'encrypted_field_envelope',
  'encrypted_crdt_update',
  'encrypted_crdt_checkpoint',
]);

export const ConsoleAuditChangeRedactionSchema = z.object({
  payload: z.literal('omitted'),
  reason: z.literal('audit_redacted_by_default'),
});

export const ConsoleChangeSchema = z.object({
  changeId: z.number().int(),
  table: z.string(),
  rowId: z.string(),
  op: z.enum(['upsert', 'delete']),
  rowVersion: z.number().int().nullable(),
  fields: z.array(z.string()),
  scopeFields: z.array(z.string()),
  changeKind: ConsoleAuditChangeKindSchema,
  sensitiveFields: z.array(z.string()),
  redaction: ConsoleAuditChangeRedactionSchema,
});

export type ConsoleChange = z.infer<typeof ConsoleChangeSchema>;

export const ConsoleCommitDetailSchema = ConsoleCommitListItemSchema.extend({
  changes: z.array(ConsoleChangeSchema),
});

export type ConsoleCommitDetail = z.infer<typeof ConsoleCommitDetailSchema>;

export const ConsoleRowHistoryEntrySchema = z.object({
  commitSeq: z.number().int(),
  actorId: z.string(),
  clientId: z.string(),
  clientCommitId: z.string(),
  createdAt: z.string(),
  changeId: z.number().int(),
  table: z.string(),
  rowId: z.string(),
  op: z.enum(['upsert', 'delete']),
  rowVersion: z.number().int().nullable(),
  fields: z.array(z.string()),
  scopeFields: z.array(z.string()),
  changeKind: ConsoleAuditChangeKindSchema,
  sensitiveFields: z.array(z.string()),
  redaction: ConsoleAuditChangeRedactionSchema,
  requestEventIds: z.array(z.number().int()),
  requestIds: z.array(z.string()),
  traceIds: z.array(z.string()),
});

export type ConsoleRowHistoryEntry = z.infer<
  typeof ConsoleRowHistoryEntrySchema
>;

export const ConsoleRowHistoryResponseSchema = z.object({
  table: z.string(),
  rowId: z.string(),
  partitionId: z.string(),
  history: z.array(ConsoleRowHistoryEntrySchema),
  nextCursor: z.number().int().nullable(),
});

export type ConsoleRowHistoryResponse = z.infer<
  typeof ConsoleRowHistoryResponseSchema
>;

export const ConsoleRowInvestigationClientSchema = z.object({
  clientId: z.string(),
  actorId: z.string(),
  cursor: z.number().int(),
  effectiveScopeKeys: z.array(z.string()),
  updatedAt: z.string(),
  lastRequestAt: z.string().nullable(),
  lastRequestType: z.enum(['sync', 'push', 'pull']).nullable(),
  lastRequestOutcome: z.string().nullable(),
});

export type ConsoleRowInvestigationClient = z.infer<
  typeof ConsoleRowInvestigationClientSchema
>;

export const ConsoleRowInvestigationScopeEligibilitySchema = z.object({
  status: z.enum(['eligible', 'not_eligible', 'unknown', 'no_client']),
  requiredScopeKeys: z.array(z.string()),
  matchedScopeKeys: z.array(z.string()),
  missingScopeKeys: z.array(z.string()),
});

export type ConsoleRowInvestigationScopeEligibility = z.infer<
  typeof ConsoleRowInvestigationScopeEligibilitySchema
>;

export const ConsoleRowInvestigationFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  message: z.string(),
});

export type ConsoleRowInvestigationFinding = z.infer<
  typeof ConsoleRowInvestigationFindingSchema
>;

export const ConsoleRowInvestigationSubscriptionEvidenceSchema = z.object({
  status: z.enum(['observed', 'revoked', 'not_observed', 'unknown']),
  matchingEventCount: z.number().int().nonnegative(),
  latestEventId: z.number().int().nullable(),
  latestRequestId: z.string().nullable(),
  latestEventOutcome: z.string().nullable(),
  latestSubscriptionCount: z.number().int().nullable(),
  requestedTableObserved: z.boolean(),
  observedScopeKeys: z.array(z.string()),
});

export type ConsoleRowInvestigationSubscriptionEvidence = z.infer<
  typeof ConsoleRowInvestigationSubscriptionEvidenceSchema
>;

export const ConsoleRowInvestigationRequestEvidenceSchema = z.object({
  matchingEventCount: z.number().int().nonnegative(),
  successEventCount: z.number().int().nonnegative(),
  nonSuccessEventCount: z.number().int().nonnegative(),
  latestEventId: z.number().int().nullable(),
  latestRequestId: z.string().nullable(),
  latestOutcome: z.string().nullable(),
  latestResponseStatus: z.string().nullable(),
  latestErrorCode: z.string().nullable(),
  latestErrorMessage: z.string().nullable(),
  latestSuccessRequestId: z.string().nullable(),
  latestNonSuccessRequestId: z.string().nullable(),
  latestNonSuccessResponseStatus: z.string().nullable(),
  latestNonSuccessErrorCode: z.string().nullable(),
});

export type ConsoleRowInvestigationRequestEvidence = z.infer<
  typeof ConsoleRowInvestigationRequestEvidenceSchema
>;

export const ConsoleRowInvestigationSnapshotEvidenceSchema = z.object({
  pageCount: z.number().int().nonnegative(),
  inlineRowCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  chunkBytes: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  artifactBytes: z.number().int().nonnegative(),
});

export type ConsoleRowInvestigationSnapshotEvidence = z.infer<
  typeof ConsoleRowInvestigationSnapshotEvidenceSchema
>;

export const ConsoleRowInvestigationRealtimeEvidenceSchema = z.object({
  matchingEventCount: z.number().int().nonnegative(),
  connectedEventCount: z.number().int().nonnegative(),
  pullRequiredEventCount: z.number().int().nonnegative(),
  ackEventCount: z.number().int().nonnegative(),
  rejectedEventCount: z.number().int().nonnegative(),
  errorEventCount: z.number().int().nonnegative(),
  latestEventId: z.number().int().nullable(),
  latestEventType: z.string().nullable(),
  latestReason: z.string().nullable(),
  latestCursor: z.number().int().nullable(),
  latestServerCursor: z.number().int().nullable(),
  latestPullRequiredReason: z.string().nullable(),
});

export type ConsoleRowInvestigationRealtimeEvidence = z.infer<
  typeof ConsoleRowInvestigationRealtimeEvidenceSchema
>;

export const ConsoleRequestEventResponseSummarySchema = z
  .object({
    subscriptionCount: z.number().int().nonnegative().optional(),
    activeSubscriptionCount: z.number().int().nonnegative().optional(),
    revokedSubscriptionCount: z.number().int().nonnegative().optional(),
    bootstrapSubscriptionCount: z.number().int().nonnegative().optional(),
    commitCount: z.number().int().nonnegative().optional(),
    changeCount: z.number().int().nonnegative().optional(),
    snapshotPageCount: z.number().int().nonnegative().optional(),
    snapshotInlineRowCount: z.number().int().nonnegative().optional(),
    snapshotChunkCount: z.number().int().nonnegative().optional(),
    snapshotChunkBytes: z.number().int().nonnegative().optional(),
    snapshotArtifactCount: z.number().int().nonnegative().optional(),
    snapshotArtifactBytes: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type ConsoleRequestEventResponseSummary = z.infer<
  typeof ConsoleRequestEventResponseSummarySchema
>;

export const ConsoleDebugExportCommitSchema =
  ConsoleCommitListItemSchema.extend({
    changes: z.array(ConsoleChangeSchema),
  });

export type ConsoleDebugExportCommit = z.infer<
  typeof ConsoleDebugExportCommitSchema
>;

export const ConsoleDebugExportEventSchema = z.object({
  eventId: z.number().int(),
  partitionId: z.string(),
  requestId: z.string(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  eventType: z.enum(['sync', 'push', 'pull']),
  syncPath: z.enum(['http-combined', 'ws-push']),
  transportPath: z.enum(['direct', 'relay']),
  actorId: z.string(),
  clientId: z.string(),
  statusCode: z.number().int(),
  outcome: z.string(),
  responseStatus: z.string(),
  errorCode: z.string().nullable(),
  durationMs: z.number().int(),
  commitSeq: z.number().int().nullable(),
  operationCount: z.number().int().nullable(),
  rowCount: z.number().int().nullable(),
  subscriptionCount: z.number().int().nullable(),
  scopesSummary: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .nullable(),
  responseSummary: ConsoleRequestEventResponseSummarySchema.nullable(),
  tables: z.array(z.string()),
  createdAt: z.string(),
});

export type ConsoleDebugExportEvent = z.infer<
  typeof ConsoleDebugExportEventSchema
>;

export const ConsoleDebugExportResponseSchema = z.object({
  generatedAt: z.string(),
  partitionId: z.string(),
  limits: z.object({
    commits: z.number().int(),
    requestEvents: z.number().int(),
  }),
  truncated: z.object({
    commits: z.boolean(),
    requestEvents: z.boolean(),
  }),
  commits: z.array(ConsoleDebugExportCommitSchema),
  requestEvents: z.array(ConsoleDebugExportEventSchema),
});

export type ConsoleDebugExportResponse = z.infer<
  typeof ConsoleDebugExportResponseSchema
>;

// ============================================================================
// Client Schemas
// ============================================================================

export const ConsoleClientDiagnosticHealthSeveritySchema = z.enum([
  'debug',
  'info',
  'warn',
  'error',
]);

export type ConsoleClientDiagnosticHealthSeverity = z.infer<
  typeof ConsoleClientDiagnosticHealthSeveritySchema
>;

export const ConsoleClientDiagnosticFreshnessStateSchema = z.enum([
  'active',
  'idle',
  'stale',
]);

export type ConsoleClientDiagnosticFreshnessState = z.infer<
  typeof ConsoleClientDiagnosticFreshnessStateSchema
>;

export const ConsoleClientSchema = z.object({
  clientId: z.string(),
  actorId: z.string(),
  cursor: z.number().int(),
  lagCommitCount: z.number().int().nonnegative(),
  connectionPath: z.enum(['direct', 'relay']),
  connectionMode: z.enum(['polling', 'realtime']),
  realtimeConnectionCount: z.number().int().nonnegative(),
  isRealtimeConnected: z.boolean(),
  activityState: z.enum(['active', 'idle', 'stale']),
  diagnosticFreshnessState:
    ConsoleClientDiagnosticFreshnessStateSchema.nullable(),
  diagnosticHealthMaxSeverity:
    ConsoleClientDiagnosticHealthSeveritySchema.nullable(),
  diagnosticReceivedAt: z.string().nullable(),
  lastRequestAt: z.string().nullable(),
  lastRequestType: z.enum(['sync', 'push', 'pull']).nullable(),
  lastRequestOutcome: z.string().nullable(),
  effectiveScopes: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});

export type ConsoleClient = z.infer<typeof ConsoleClientSchema>;

export const ConsoleClientDiagnosticRuntimeSchema = z
  .object({
    packageName: z.string().optional(),
    packageVersion: z.string().optional(),
    workerProtocolVersion: z.number().int().optional(),
    storage: z.string().optional(),
    storageFallback: z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        reason: z.string().optional(),
      })
      .passthrough()
      .optional(),
    workerUrl: z.string().optional(),
    wasmGlueUrl: z.string().optional(),
    wasmUrl: z.string().optional(),
    rust: z
      .object({
        crateName: z.string().optional(),
        crateVersion: z.string().optional(),
        schemaVersion: z.number().int().optional(),
        features: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ConsoleClientDiagnosticRuntime = z.infer<
  typeof ConsoleClientDiagnosticRuntimeSchema
>;

export const ConsoleClientDiagnosticConnectionSchema = z
  .object({
    closed: z.boolean().optional(),
    pendingRequests: z.number().int().nonnegative().optional(),
    realtime: z.string().optional(),
    storageFallback: z.unknown().optional(),
    lastDiagnostic: z.unknown().optional(),
    lastError: z.unknown().optional(),
  })
  .passthrough();

export const ConsoleClientDiagnosticLifecycleSchema = z
  .object({
    phase: z.string().optional(),
    realtime: z.string().optional(),
    online: z.boolean().optional(),
    requiresAction: z.boolean().optional(),
    pendingRequests: z.number().int().nonnegative().optional(),
    bootstrap: z.unknown().optional(),
    outbox: z.unknown().optional(),
    conflicts: z.unknown().optional(),
    blobUploads: z.unknown().optional(),
    lastDiagnostic: z.unknown().optional(),
    lastError: z.unknown().optional(),
  })
  .passthrough();

export const ConsoleClientDiagnosticSubscriptionSchema = z
  .object({
    id: z.string(),
    table: z.string(),
    scopeKeys: z.array(z.string()).default([]),
    scopeValueCount: z.number().int().nonnegative().default(0),
    paramsKeys: z.array(z.string()).default([]),
    paramsValueCount: z.number().int().nonnegative().default(0),
    status: z.string().nullable().default(null),
    ready: z.boolean().default(false),
    phase: z.string().optional(),
    progressPercent: z.number().default(0),
    cursor: z.union([z.number().int(), z.string()]).nullable().default(null),
    bootstrapPhase: z.number().int().default(0),
    bootstrapState: z.unknown().nullable().default(null),
  })
  .passthrough();

export type ConsoleClientDiagnosticSubscription = z.infer<
  typeof ConsoleClientDiagnosticSubscriptionSchema
>;

export const ConsoleClientDiagnosticEventSchema = z
  .object({
    at: z.number(),
    level: z.enum(['debug', 'info', 'warn', 'error']).catch('info'),
    source: z.string(),
    code: z.string(),
    message: z.string(),
    syncAttemptId: z.string().optional(),
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    clientId: z.string().optional(),
    subscriptionId: z.string().optional(),
    table: z.string().optional(),
    rowId: z.string().optional(),
    cursor: z.union([z.number(), z.string()]).nullable().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type ConsoleClientDiagnosticEvent = z.infer<
  typeof ConsoleClientDiagnosticEventSchema
>;

export const ConsoleClientDiagnosticCodeSummarySchema = z.object({
  code: z.string(),
  count: z.number().int().nonnegative(),
  maxLevel: ConsoleClientDiagnosticHealthSeveritySchema,
});

export type ConsoleClientDiagnosticCodeSummary = z.infer<
  typeof ConsoleClientDiagnosticCodeSummarySchema
>;

export const ConsoleClientDiagnosticSnapshotSchema = z
  .object({
    generatedAt: z.number().optional(),
    runtime: ConsoleClientDiagnosticRuntimeSchema.optional(),
    connection: ConsoleClientDiagnosticConnectionSchema.optional(),
    subscriptions: z
      .array(ConsoleClientDiagnosticSubscriptionSchema)
      .default([]),
    recentDiagnostics: z.array(ConsoleClientDiagnosticEventSchema).default([]),
    recentSyncTimings: z.array(z.record(z.string(), z.unknown())).default([]),
    bootstrap: z.record(z.string(), z.unknown()).optional(),
    transportStats: z.record(z.string(), z.unknown()).optional(),
    outboxStats: z.record(z.string(), z.unknown()).optional(),
    conflictStats: z.record(z.string(), z.unknown()).optional(),
    blobUploadStats: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type ConsoleClientDiagnosticSnapshot = z.infer<
  typeof ConsoleClientDiagnosticSnapshotSchema
>;

export const ConsoleClientDiagnosticIngestSchema = z.object({
  clientId: z.string().min(1),
  actorId: z.string().min(1).optional(),
  partitionId: z.string().min(1).default('default'),
  lifecycle: ConsoleClientDiagnosticLifecycleSchema.optional(),
  snapshot: ConsoleClientDiagnosticSnapshotSchema,
});

export type ConsoleClientDiagnosticIngest = z.infer<
  typeof ConsoleClientDiagnosticIngestSchema
>;

const ConsoleBrowserPreviewFailureMetricsSchema = z
  .object({
    artifactCreatedAfterMs: z.number().nonnegative(),
    assetCheckMs: z.number().nonnegative(),
    assetCount: z.number().int().nonnegative(),
    browserHealthMarkerInAssets: z.boolean().optional(),
    browserSupportPolicyMarkerInAssets: z.boolean().optional(),
    commandTimelineMarkerInAssets: z.boolean().optional(),
    cssAssetBytes: z.number().int().nonnegative(),
    cssAssetCount: z.number().int().nonnegative(),
    deploymentPreflightMarkerInAssets: z.boolean(),
    jsAssetBytes: z.number().int().nonnegative(),
    jsAssetCount: z.number().int().nonnegative(),
    lifecycleResumeMarkerInAssets: z.boolean(),
    otherAssetBytes: z.number().int().nonnegative(),
    otherAssetCount: z.number().int().nonnegative(),
    previewReadyMs: z.number().nonnegative(),
    starterTimelineMarkerInAssets: z.boolean(),
    storageRecoveryMarkerInAssets: z.boolean().optional(),
    supportBundleMarkerInAssets: z.boolean(),
    totalAssetBytes: z.number().int().nonnegative(),
  })
  .passthrough();

const ConsoleBrowserPreviewFailureNullableNumberSchema = z
  .number()
  .nonnegative()
  .nullable();
const ConsoleBrowserPreviewFailureNullableStringSchema = z.string().nullable();

const ConsoleBrowserPreviewFailureProbeSchema = z
  .object({
    ready: z.boolean(),
    errors: z.array(z.string()).default([]),
    markers: z
      .object({
        durableHealthLine: z.boolean(),
        schemaLine: z.boolean(),
        preflightFailure: z.boolean(),
        databaseOpening: z.boolean(),
      })
      .passthrough(),
    browserHealth: z
      .object({
        blockedOperationCount: z.number().int().nonnegative(),
        generatedMutation: ConsoleBrowserPreviewFailureNullableStringSchema,
        lifecycleStage: ConsoleBrowserPreviewFailureNullableStringSchema,
        localVisibility: ConsoleBrowserPreviewFailureNullableStringSchema,
        recoveryOwner: ConsoleBrowserPreviewFailureNullableStringSchema,
        status: ConsoleBrowserPreviewFailureNullableStringSchema,
        syncNow: ConsoleBrowserPreviewFailureNullableStringSchema,
      })
      .passthrough()
      .optional(),
    deploymentPreflight: z
      .object({
        actionCount: z.number().int().nonnegative(),
        availableBytes: ConsoleBrowserPreviewFailureNullableNumberSchema,
        issueCount: z.number().int().nonnegative(),
        minimumAvailableBytes: ConsoleBrowserPreviewFailureNullableNumberSchema,
        minimumQuotaBytes: ConsoleBrowserPreviewFailureNullableNumberSchema,
        persistence: ConsoleBrowserPreviewFailureNullableStringSchema,
        persisted: ConsoleBrowserPreviewFailureNullableStringSchema,
        preflightMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
        quotaPressure: ConsoleBrowserPreviewFailureNullableStringSchema,
        quotaBytes: ConsoleBrowserPreviewFailureNullableNumberSchema,
        serviceWorker: ConsoleBrowserPreviewFailureNullableStringSchema,
        serviceWorkerControlled:
          ConsoleBrowserPreviewFailureNullableStringSchema,
        serviceWorkerControllerScriptPath:
          ConsoleBrowserPreviewFailureNullableStringSchema,
        serviceWorkerControllerState:
          ConsoleBrowserPreviewFailureNullableStringSchema,
        status: ConsoleBrowserPreviewFailureNullableStringSchema,
        supportTier: ConsoleBrowserPreviewFailureNullableStringSchema,
        usageRatio: ConsoleBrowserPreviewFailureNullableNumberSchema,
        usageBytes: ConsoleBrowserPreviewFailureNullableNumberSchema,
      })
      .passthrough(),
    browserSupportPolicy: z
      .object({
        actionCount: z.number().int().nonnegative(),
        context: ConsoleBrowserPreviewFailureNullableStringSchema,
        expectedPersistence: ConsoleBrowserPreviewFailureNullableStringSchema,
        expectedSupportTier: ConsoleBrowserPreviewFailureNullableStringSchema,
        issueCount: z.number().int().nonnegative(),
        knownRisks: z.array(z.string()).default([]),
        knownRiskCount: z.number().int().nonnegative().optional(),
        nextSteps: z.array(z.string()).default([]),
        nextStepCount: z.number().int().nonnegative().optional(),
        observedPersistence: ConsoleBrowserPreviewFailureNullableStringSchema,
        observedSupportTier: ConsoleBrowserPreviewFailureNullableStringSchema,
        policy: ConsoleBrowserPreviewFailureNullableStringSchema,
        preflightRequired: ConsoleBrowserPreviewFailureNullableStringSchema,
        reasonCodes: z.array(z.string()).default([]),
        reasonCount: z.number().int().nonnegative().optional(),
        requiredEvidence: z.array(z.string()).default([]),
        requiredEvidenceCount: z.number().int().nonnegative().optional(),
        status: ConsoleBrowserPreviewFailureNullableStringSchema,
      })
      .passthrough()
      .optional(),
    supportBundle: z
      .object({
        status: ConsoleBrowserPreviewFailureNullableStringSchema,
        redacted: ConsoleBrowserPreviewFailureNullableStringSchema,
        sectionCount: z.number().int().nonnegative(),
        issueCount: z.number().int().nonnegative(),
        blobEventCount: z.number().int().nonnegative(),
        cursorCount: z.number().int().nonnegative(),
        latestBlobCode: ConsoleBrowserPreviewFailureNullableStringSchema,
        latestLocalApplyCode: ConsoleBrowserPreviewFailureNullableStringSchema,
        latestRealtimeCode: ConsoleBrowserPreviewFailureNullableStringSchema,
        latestSyncCode: ConsoleBrowserPreviewFailureNullableStringSchema,
        localApplyEventCount: z.number().int().nonnegative(),
        realtimeEventCount: z.number().int().nonnegative(),
        requestIdCount: z.number().int().nonnegative(),
        sectionErrorCount: z.number().int().nonnegative(),
        syncAttemptIdCount: z.number().int().nonnegative(),
        syncEventCount: z.number().int().nonnegative(),
        timelineEventCount: z.number().int().nonnegative(),
      })
      .passthrough(),
    lifecycleResume: z
      .object({
        status: ConsoleBrowserPreviewFailureNullableStringSchema,
        count: z.number().int().nonnegative(),
        reason: ConsoleBrowserPreviewFailureNullableStringSchema,
        error: ConsoleBrowserPreviewFailureNullableStringSchema,
        lockName: ConsoleBrowserPreviewFailureNullableStringSchema,
        lockRequired: ConsoleBrowserPreviewFailureNullableStringSchema,
        lockState: ConsoleBrowserPreviewFailureNullableStringSchema,
        lockTimeoutMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
      })
      .passthrough(),
    lifecyclePause: z
      .object({
        count: z.number().int().nonnegative(),
        reason: ConsoleBrowserPreviewFailureNullableStringSchema,
        pagehidePersisted: ConsoleBrowserPreviewFailureNullableStringSchema,
        shutdownSignalCount: z.number().int().nonnegative(),
        visibilityState: ConsoleBrowserPreviewFailureNullableStringSchema,
      })
      .passthrough(),
    starterTimeline: z
      .object({
        bootstrapReadyMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
        bootstrapStatus: ConsoleBrowserPreviewFailureNullableStringSchema,
        databaseOpenMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
        healthRefreshMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
        localVisibilityErrorCode:
          ConsoleBrowserPreviewFailureNullableStringSchema,
        localVisibilityMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
        localVisibilityStatus: ConsoleBrowserPreviewFailureNullableStringSchema,
        marker: z.boolean(),
        realtimeConnectedMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
        realtimeStatus: ConsoleBrowserPreviewFailureNullableStringSchema,
        schemaReadinessMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
        supportBundleExportMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
      })
      .passthrough(),
    textExcerpt: z.string().max(4000).default(''),
  })
  .passthrough();

export const ConsoleBrowserPreviewFailureArtifactSchema = z
  .object({
    generatedAt: z
      .string()
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        'generatedAt must be a parseable date'
      ),
    metrics: ConsoleBrowserPreviewFailureMetricsSchema,
    reason: z.string().min(1),
    probe: ConsoleBrowserPreviewFailureProbeSchema.nullable(),
  })
  .passthrough();

export type ConsoleBrowserPreviewFailureArtifact = z.infer<
  typeof ConsoleBrowserPreviewFailureArtifactSchema
>;

export const ConsoleBrowserPreviewFailureIngestSchema = z
  .object({
    clientId: z.string().min(1).default('browser-preview'),
    actorId: z.string().min(1).optional(),
    partitionId: z.string().min(1).default('default'),
    artifact: ConsoleBrowserPreviewFailureArtifactSchema.optional(),
    generatedAt: z
      .string()
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        'generatedAt must be a parseable date'
      )
      .optional(),
    metrics: ConsoleBrowserPreviewFailureMetricsSchema.optional(),
    reason: z.string().min(1).optional(),
    probe: ConsoleBrowserPreviewFailureProbeSchema.nullable().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.artifact) {
      return;
    }
    const rawArtifact =
      ConsoleBrowserPreviewFailureArtifactSchema.safeParse(value);
    if (!rawArtifact.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Expected artifact or raw create-syncular-app browser preview failure artifact',
      });
    }
  });

export type ConsoleBrowserPreviewFailureIngest = z.infer<
  typeof ConsoleBrowserPreviewFailureIngestSchema
>;

const ConsoleCloudflareBlobRouteMetricsSchema = z
  .object({
    attempted: z.boolean(),
    completeUploadMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
    contentBytes: ConsoleBrowserPreviewFailureNullableNumberSchema,
    downloadBytes: ConsoleBrowserPreviewFailureNullableNumberSchema,
    downloadBytesMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
    downloadUrlMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
    partitionedDownloadBytes: ConsoleBrowserPreviewFailureNullableNumberSchema,
    partitionedDownloadBytesMs:
      ConsoleBrowserPreviewFailureNullableNumberSchema,
    partitionedDownloadUrlMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
    referencePushMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
    totalMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
    uploadBytesMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
    uploadInitMs: ConsoleBrowserPreviewFailureNullableNumberSchema,
  })
  .passthrough();

const ConsoleCloudflareRuntimeFailureProbeSchema = z
  .object({
    blobMetrics: ConsoleCloudflareBlobRouteMetricsSchema.nullable(),
    blobRouteBase: ConsoleBrowserPreviewFailureNullableStringSchema,
    expectedText: z.string().max(1000),
    exited: z
      .object({
        code: z.number().nullable(),
        signal: ConsoleBrowserPreviewFailureNullableStringSchema,
      })
      .passthrough()
      .nullable(),
    outputExcerpt: z.string().max(13_000),
    port: z.number().int().positive(),
    route: z.string().min(1).max(500),
    syncRouteBase: ConsoleBrowserPreviewFailureNullableStringSchema,
    webSocketRoute: ConsoleBrowserPreviewFailureNullableStringSchema,
  })
  .passthrough();

export const ConsoleCloudflareRuntimeFailureArtifactSchema = z
  .object({
    generatedAt: z
      .string()
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        'generatedAt must be a parseable date'
      ),
    reason: z.string().min(1),
    probe: ConsoleCloudflareRuntimeFailureProbeSchema,
  })
  .passthrough();

export type ConsoleCloudflareRuntimeFailureArtifact = z.infer<
  typeof ConsoleCloudflareRuntimeFailureArtifactSchema
>;

export const ConsoleCloudflareRuntimeFailureIngestSchema = z
  .object({
    clientId: z.string().min(1).default('cloudflare-runtime'),
    actorId: z.string().min(1).optional(),
    partitionId: z.string().min(1).default('default'),
    artifact: ConsoleCloudflareRuntimeFailureArtifactSchema.optional(),
    generatedAt: z
      .string()
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        'generatedAt must be a parseable date'
      )
      .optional(),
    reason: z.string().min(1).optional(),
    probe: ConsoleCloudflareRuntimeFailureProbeSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.artifact) {
      return;
    }
    const rawArtifact =
      ConsoleCloudflareRuntimeFailureArtifactSchema.safeParse(value);
    if (!rawArtifact.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Expected artifact or raw framework-import-smokes Cloudflare runtime failure artifact',
      });
    }
  });

export type ConsoleCloudflareRuntimeFailureIngest = z.infer<
  typeof ConsoleCloudflareRuntimeFailureIngestSchema
>;

export const ConsoleClientDiagnosticRecordSchema = z.object({
  clientId: z.string(),
  actorId: z.string().nullable(),
  partitionId: z.string(),
  reportedAt: z.string(),
  receivedAt: z.string(),
  freshnessState: ConsoleClientDiagnosticFreshnessStateSchema,
  healthMaxSeverity: ConsoleClientDiagnosticHealthSeveritySchema.nullable(),
  diagnosticCodesSummary: z.array(ConsoleClientDiagnosticCodeSummarySchema),
  queueSummary: z.record(z.string(), z.unknown()).nullable(),
  timingSummary: z.record(z.string(), z.unknown()).nullable(),
  redactionSummary: z.record(z.string(), z.unknown()),
  runtime: ConsoleClientDiagnosticRuntimeSchema.nullable(),
  connection: ConsoleClientDiagnosticConnectionSchema.nullable(),
  lifecycle: ConsoleClientDiagnosticLifecycleSchema.nullable(),
  bootstrap: z.record(z.string(), z.unknown()).nullable(),
  transportStats: z.record(z.string(), z.unknown()).nullable(),
  outboxStats: z.record(z.string(), z.unknown()).nullable(),
  conflictStats: z.record(z.string(), z.unknown()).nullable(),
  blobUploadStats: z.record(z.string(), z.unknown()).nullable(),
  subscriptions: z.array(ConsoleClientDiagnosticSubscriptionSchema),
  recentDiagnostics: z.array(ConsoleClientDiagnosticEventSchema),
  recentSyncTimings: z.array(z.record(z.string(), z.unknown())),
});

export type ConsoleClientDiagnosticRecord = z.infer<
  typeof ConsoleClientDiagnosticRecordSchema
>;

// ============================================================================
// Handler Schemas
// ============================================================================

export const ConsoleHandlerSchema = z.object({
  table: z.string(),
  dependsOn: z.array(z.string()).optional(),
  snapshotChunkTtlMs: z.number().int().optional(),
});

export type ConsoleHandler = z.infer<typeof ConsoleHandlerSchema>;

// ============================================================================
// Prune & Compact Schemas
// ============================================================================

export const ConsolePrunePreviewSchema = z.object({
  watermarkCommitSeq: z.number().int(),
  commitsToDelete: z.number().int(),
});

export type ConsolePrunePreview = z.infer<typeof ConsolePrunePreviewSchema>;

export const ConsolePruneResultSchema = z.object({
  deletedCommits: z.number().int(),
});

export type ConsolePruneResult = z.infer<typeof ConsolePruneResultSchema>;

export const ConsoleCompactResultSchema = z.object({
  deletedChanges: z.number().int(),
});

export type ConsoleCompactResult = z.infer<typeof ConsoleCompactResultSchema>;

// ============================================================================
// Evict Schema
// ============================================================================

export const ConsoleEvictResultSchema = z.object({
  evicted: z.boolean(),
});

export type ConsoleEvictResult = z.infer<typeof ConsoleEvictResultSchema>;

// ============================================================================
// Request Event Schemas
// ============================================================================

export const ConsoleRequestEventSchema = z.object({
  eventId: z.number().int(),
  partitionId: z.string(),
  requestId: z.string(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  eventType: z.enum(['sync', 'push', 'pull']),
  syncPath: z.enum(['http-combined', 'ws-push']),
  transportPath: z.enum(['direct', 'relay']),
  actorId: z.string(),
  clientId: z.string(),
  statusCode: z.number().int(),
  outcome: z.string(),
  responseStatus: z.string(),
  errorCode: z.string().nullable(),
  durationMs: z.number().int(),
  commitSeq: z.number().int().nullable(),
  operationCount: z.number().int().nullable(),
  rowCount: z.number().int().nullable(),
  subscriptionCount: z.number().int().nullable(),
  scopesSummary: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .nullable(),
  responseSummary: ConsoleRequestEventResponseSummarySchema.nullable(),
  tables: z.array(z.string()),
  errorMessage: z.string().nullable(),
  payloadRef: z.string().nullable(),
  createdAt: z.string(),
});

export type ConsoleRequestEvent = z.infer<typeof ConsoleRequestEventSchema>;

export const ConsoleRowInvestigationResponseSchema = z.object({
  table: z.string(),
  rowId: z.string(),
  partitionId: z.string(),
  clientId: z.string().nullable(),
  rowKnown: z.boolean(),
  latestCommitSeq: z.number().int().nullable(),
  latestOp: z.enum(['upsert', 'delete']).nullable(),
  client: ConsoleRowInvestigationClientSchema.nullable(),
  scopeEligibility: ConsoleRowInvestigationScopeEligibilitySchema,
  subscriptionEvidence: ConsoleRowInvestigationSubscriptionEvidenceSchema,
  requestEvidence: ConsoleRowInvestigationRequestEvidenceSchema,
  snapshotEvidence: ConsoleRowInvestigationSnapshotEvidenceSchema,
  realtimeEvidence: ConsoleRowInvestigationRealtimeEvidenceSchema,
  history: z.array(ConsoleRowHistoryEntrySchema),
  relevantEvents: z.array(ConsoleRequestEventSchema),
  findings: z.array(ConsoleRowInvestigationFindingSchema),
  nextCursor: z.number().int().nullable(),
});

export type ConsoleRowInvestigationResponse = z.infer<
  typeof ConsoleRowInvestigationResponseSchema
>;

export const ConsoleRequestPayloadSchema = z.object({
  payloadRef: z.string(),
  partitionId: z.string(),
  requestPayload: z.unknown(),
  responsePayload: z.unknown().nullable(),
  createdAt: z.string(),
});

export type ConsoleRequestPayload = z.infer<typeof ConsoleRequestPayloadSchema>;

export const ConsoleTimelineItemSchema = z.object({
  type: z.enum(['commit', 'event']),
  timestamp: z.string(),
  commit: ConsoleCommitListItemSchema.nullable(),
  event: ConsoleRequestEventSchema.nullable(),
});

export type ConsoleTimelineItem = z.infer<typeof ConsoleTimelineItemSchema>;

export const ConsoleClearEventsResultSchema = z.object({
  deletedCount: z.number().int(),
});

export type ConsoleClearEventsResult = z.infer<
  typeof ConsoleClearEventsResultSchema
>;

export const ConsolePruneEventsResultSchema = z.object({
  deletedCount: z.number().int(),
  requestEventsDeleted: z.number().int().nonnegative(),
  operationEventsDeleted: z.number().int().nonnegative(),
  realtimeEventsDeleted: z.number().int().nonnegative(),
  payloadDeletedCount: z.number().int().nonnegative(),
});

export type ConsolePruneEventsResult = z.infer<
  typeof ConsolePruneEventsResultSchema
>;

// ============================================================================
// Operation Audit Schemas
// ============================================================================

export const ConsoleOperationTypeSchema = z.enum([
  'prune',
  'compact',
  'notify_data_change',
  'evict_client',
  'ops_readiness',
]);

export type ConsoleOperationType = z.infer<typeof ConsoleOperationTypeSchema>;

export const ConsoleOperationEventSchema = z.object({
  operationId: z.number().int(),
  operationType: ConsoleOperationTypeSchema,
  consoleUserId: z.string().nullable(),
  partitionId: z.string().nullable(),
  targetClientId: z.string().nullable(),
  requestPayload: z.unknown().nullable(),
  resultPayload: z.unknown().nullable(),
  createdAt: z.string(),
});

export type ConsoleOperationEvent = z.infer<typeof ConsoleOperationEventSchema>;

const ConsoleOpsReadinessStatusSchema = z.enum(['ready', 'not-ready']);

const ConsoleOpsReadinessCheckStatusSchema = z.enum([
  'ready',
  'not-ready',
  'not-applicable',
  'missing',
]);

const ConsoleOpsReadinessChecksSchema = z.object({
  schemaReadiness: ConsoleOpsReadinessCheckStatusSchema,
  restoreDrill: ConsoleOpsReadinessCheckStatusSchema,
  blobConsistency: ConsoleOpsReadinessCheckStatusSchema,
  credentialRotation: ConsoleOpsReadinessCheckStatusSchema,
  rateLimits: ConsoleOpsReadinessCheckStatusSchema,
  logRetention: ConsoleOpsReadinessCheckStatusSchema,
  supportWindow: ConsoleOpsReadinessCheckStatusSchema,
});

export const ConsoleOpsReadinessIssueSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['warning', 'error']),
  message: z.string().min(1),
  recommendedAction: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ConsoleOpsReadinessInputSchema = z.object({
  generatedAt: z.string().datetime(),
  status: ConsoleOpsReadinessStatusSchema,
  ready: z.boolean(),
  manifestDir: z.string().optional(),
  configPath: z.string().optional(),
  environment: z.string().nullable(),
  checks: ConsoleOpsReadinessChecksSchema,
  issues: z.array(ConsoleOpsReadinessIssueSchema),
});

export type ConsoleOpsReadinessInput = z.infer<
  typeof ConsoleOpsReadinessInputSchema
>;

export const ConsoleOpsReadinessReportSchema = z.object({
  artifactSchema: z.literal('syncular.ops-readiness.v1'),
  generatedAt: z.string().datetime(),
  environment: z.string().nullable(),
  status: ConsoleOpsReadinessStatusSchema,
  ready: z.boolean(),
  checks: ConsoleOpsReadinessChecksSchema,
  issueCount: z.number().int().nonnegative(),
  issues: z.array(ConsoleOpsReadinessIssueSchema),
  redaction: z.object({
    localPaths: z.literal('omitted'),
    sensitiveKeys: z.literal('rejected'),
  }),
});

export type ConsoleOpsReadinessReport = z.infer<
  typeof ConsoleOpsReadinessReportSchema
>;

export const ConsoleOpsReadinessInstanceReportSchema = z.object({
  instanceId: z.string(),
  label: z.string().optional(),
  available: z.boolean(),
  operationId: z.number().int().nullable(),
  recordedAt: z.string().nullable(),
  report: ConsoleOpsReadinessReportSchema.nullable(),
});

export const ConsoleOpsReadinessGatewayFailureSchema = z.object({
  instanceId: z.string(),
  reason: z.string(),
  status: z.number().int().optional(),
});

export const ConsoleOpsReadinessResponseSchema = z.object({
  available: z.boolean(),
  operationId: z.number().int().nullable(),
  recordedAt: z.string().nullable(),
  report: ConsoleOpsReadinessReportSchema.nullable(),
  instanceReports: z.array(ConsoleOpsReadinessInstanceReportSchema).optional(),
  readyInstanceCount: z.number().int().nonnegative().optional(),
  notReadyInstanceCount: z.number().int().nonnegative().optional(),
  missingInstanceCount: z.number().int().nonnegative().optional(),
  partial: z.boolean().optional(),
  failedInstances: z.array(ConsoleOpsReadinessGatewayFailureSchema).optional(),
});

export type ConsoleOpsReadinessResponse = z.infer<
  typeof ConsoleOpsReadinessResponseSchema
>;

const ConsoleOpsReadinessTrendRangeSchema = z.enum(['24h', '7d', '30d', '90d']);

export const ConsoleOpsReadinessTrendsQuerySchema = z.object({
  range: ConsoleOpsReadinessTrendRangeSchema.default('30d'),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type ConsoleOpsReadinessTrendsQuery = z.infer<
  typeof ConsoleOpsReadinessTrendsQuerySchema
>;

export const ConsoleOpsReadinessIssueTrendSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['warning', 'error']),
  count: z.number().int().nonnegative(),
  affectedTargets: z.array(z.string()),
  latestSeenAt: z.string(),
  latestAction: z.string(),
});

export const ConsoleOpsReadinessTrendBucketSchema = z.object({
  bucketStart: z.string(),
  reportCount: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
  notReadyCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
});

export const ConsoleOpsReadinessTrendsResponseSchema = z.object({
  range: ConsoleOpsReadinessTrendRangeSchema,
  from: z.string().datetime(),
  to: z.string().datetime(),
  matchedCount: z.number().int().nonnegative(),
  scannedCount: z.number().int().nonnegative(),
  reportCount: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
  notReadyCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  issueTrends: z.array(ConsoleOpsReadinessIssueTrendSchema),
  buckets: z.array(ConsoleOpsReadinessTrendBucketSchema),
  partial: z.boolean().optional(),
  failedInstances: z.array(ConsoleOpsReadinessGatewayFailureSchema).optional(),
});

export type ConsoleOpsReadinessTrendsResponse = z.infer<
  typeof ConsoleOpsReadinessTrendsResponseSchema
>;

// ============================================================================
// API Key Schemas
// ============================================================================

export const ApiKeyTypeSchema = z.enum(['relay', 'proxy', 'admin']);
export type ApiKeyType = z.infer<typeof ApiKeyTypeSchema>;

export const ConsoleApiKeySchema = z.object({
  keyId: z.string(),
  keyPrefix: z.string(),
  name: z.string(),
  keyType: ApiKeyTypeSchema,
  scopeKeys: z.array(z.string()),
  actorId: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export type ConsoleApiKey = z.infer<typeof ConsoleApiKeySchema>;

export const ConsoleApiKeyCreateRequestSchema = z.object({
  name: z.string().min(1),
  keyType: ApiKeyTypeSchema,
  scopeKeys: z.array(z.string()).optional(),
  actorId: z.string().optional(),
  expiresInDays: z.number().int().positive().optional(),
});

export const ConsoleApiKeyCreateResponseSchema = z.object({
  key: ConsoleApiKeySchema,
  secretKey: z.string(),
});

export type ConsoleApiKeyCreateResponse = z.infer<
  typeof ConsoleApiKeyCreateResponseSchema
>;

export const ConsoleApiKeyRevokeResponseSchema = z.object({
  revoked: z.boolean(),
});

export const ConsoleApiKeyBulkRevokeRequestSchema = z.object({
  keyIds: z.array(z.string().min(1)).min(1).max(200),
});

export const ConsoleApiKeyBulkRevokeResponseSchema = z.object({
  requestedCount: z.number().int().nonnegative(),
  revokedCount: z.number().int().nonnegative(),
  alreadyRevokedCount: z.number().int().nonnegative(),
  notFoundCount: z.number().int().nonnegative(),
  revokedKeyIds: z.array(z.string()),
  alreadyRevokedKeyIds: z.array(z.string()),
  notFoundKeyIds: z.array(z.string()),
});

export type ConsoleApiKeyBulkRevokeResponse = z.infer<
  typeof ConsoleApiKeyBulkRevokeResponseSchema
>;

// ============================================================================
// Pagination Schemas (Console-specific)
// ============================================================================

export const ConsolePaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const ConsolePartitionQuerySchema = z.object({
  partitionId: z.string().min(1).optional(),
});

export const ConsolePartitionedPaginationQuerySchema =
  ConsolePaginationQuerySchema.extend({
    partitionId: z.string().min(1).optional(),
  });

export const ConsolePaginatedResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T
) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
  });

export type ConsolePaginatedResponse<T> = {
  items: T[];
  total: number;
  offset: number;
  limit: number;
};

export const ConsoleTimelineQuerySchema =
  ConsolePartitionedPaginationQuerySchema.extend({
    view: z.enum(['all', 'commits', 'events']).default('all'),
    eventType: z.enum(['sync', 'push', 'pull']).optional(),
    actorId: z.string().optional(),
    clientId: z.string().optional(),
    requestId: z.string().optional(),
    traceId: z.string().optional(),
    syncAttemptId: z.string().optional(),
    table: z.string().optional(),
    outcome: z.string().optional(),
    search: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  });

export const ConsoleOperationsQuerySchema =
  ConsolePartitionedPaginationQuerySchema.extend({
    operationType: ConsoleOperationTypeSchema.optional(),
  });

// ============================================================================
// Time-Series Stats Schemas
// ============================================================================

const TimeseriesIntervalSchema = z.enum(['minute', 'hour', 'day']);
const TimeseriesRangeSchema = z.enum(['1h', '6h', '24h', '7d', '30d']);
export const TimeseriesQuerySchema = z.object({
  interval: TimeseriesIntervalSchema.default('hour'),
  range: TimeseriesRangeSchema.default('24h'),
  partitionId: z.string().min(1).optional(),
});

export const TimeseriesBucketSchema = z.object({
  timestamp: z.string(),
  pushCount: z.number().int(),
  pullCount: z.number().int(),
  errorCount: z.number().int(),
  avgLatencyMs: z.number(),
});

export type TimeseriesBucket = z.infer<typeof TimeseriesBucketSchema>;

export const TimeseriesStatsResponseSchema = z.object({
  buckets: z.array(TimeseriesBucketSchema),
  interval: TimeseriesIntervalSchema,
  range: TimeseriesRangeSchema,
});

export type TimeseriesStatsResponse = z.infer<
  typeof TimeseriesStatsResponseSchema
>;

// ============================================================================
// Latency Percentiles Schemas
// ============================================================================

export const LatencyPercentilesSchema = z.object({
  p50: z.number(),
  p90: z.number(),
  p99: z.number(),
});

export type LatencyPercentiles = z.infer<typeof LatencyPercentilesSchema>;

export const LatencyStatsResponseSchema = z.object({
  push: LatencyPercentilesSchema,
  pull: LatencyPercentilesSchema,
  range: TimeseriesRangeSchema,
});

export type LatencyStatsResponse = z.infer<typeof LatencyStatsResponseSchema>;

export const LatencyQuerySchema = z.object({
  range: TimeseriesRangeSchema.default('24h'),
  partitionId: z.string().min(1).optional(),
});

// ============================================================================
// Live Events Schemas (for WebSocket)
// ============================================================================

export const LiveEventSchema = z.object({
  type: z.enum(['sync', 'push', 'pull', 'commit', 'client_update']),
  timestamp: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type LiveEvent = z.infer<typeof LiveEventSchema>;

// ---------------------------------------------------------------------------
// Blob storage
// ---------------------------------------------------------------------------

export const ConsoleBlobSchema = z.object({
  key: z.string(),
  size: z.number().int(),
  uploaded: z.string(),
  httpMetadata: z.object({ contentType: z.string().optional() }).optional(),
});

export type ConsoleBlob = z.infer<typeof ConsoleBlobSchema>;

export const ConsoleBlobListQuerySchema = z.object({
  prefix: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const ConsoleBlobListResponseSchema = z.object({
  items: z.array(ConsoleBlobSchema),
  truncated: z.boolean(),
  cursor: z.string().nullable(),
});

export const ConsoleBlobDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});

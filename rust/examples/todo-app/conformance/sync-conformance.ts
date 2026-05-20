import { readFileSync } from "node:fs";

export const syncConformance = JSON.parse(
  readFileSync(new URL("./sync-scenarios.json", import.meta.url), "utf8"),
) as SyncScenarioFixture;

export interface SyncScenarioFixture {
  actors: {
    ownerA: SyncScenarioActor;
    ownerB: SyncScenarioActor;
    rust: SyncScenarioActor & { projectId: string };
  };
  subscription: {
    id: string;
    table: string;
  };
  ownerConflict: {
    clientId: string;
    firstFileName: string;
    secondFileName: string;
    expectedErrorPattern: string;
    expectedRefreshCount: number;
  };
  revokedSubscription: {
    clientId: string;
    revokedActorId: string;
    seedTask: {
      id: string;
      title: string;
      serverVersion: number;
    };
    expectedStatus: string;
    expectedScopes: Record<string, never>;
    expectedCursorSequence: number[];
  };
  retryBackoff: {
    clientId: string;
    localRow: Omit<SyncScenarioTaskRow, "user_id">;
    expectedSyncPostCounts: number[];
    expectedPendingPushes: number;
  };
  snapshotChunk: {
    clientId: string;
    failureClientId: string;
    chunkId: string;
    byteLength: number;
    sha256: string;
    encoding: string;
    compression: string;
    expectedErrorPattern: string;
    serverTask: {
      id: string;
      title: string;
      serverVersion: number;
    };
    browserServerTask: {
      id: string;
      title: string;
    };
    localRow: Omit<SyncScenarioTaskRow, "user_id">;
  };
  repeatedPull: {
    clientId: string;
    task: {
      id: string;
      title: string;
      serverVersion: number;
    };
    expectedCursor: number;
    expectedBrowserCursor: number;
    expectedRowCount: number;
    expectedPullCount: number;
  };
  duplicatePush: {
    clientId: string;
    task: Omit<SyncScenarioTaskRow, "user_id">;
    expectedFirstPushCommits: number;
    expectedSecondPushCommits: number;
    expectedServerRowCount: number;
    expectedOutboxStatus: string;
    expectedConflictCount: number;
  };
  conflictKeepLocal: {
    clientId: string;
    keepServerClientId: string;
    dismissClientId: string;
    rowId: string;
    localTitle: string;
    serverTitle: string;
    staleBaseVersion: number;
    serverVersion: number;
    conflictCode: string;
    conflictMessage: string;
    browserConflictMessage: string;
    keepServerResolution: string;
    dismissResolution: string;
    expectedInitialConflictCount: number;
    expectedAfterResolveConflictCount: number;
    expectedAfterRetryConflictCount: number;
    expectedRetryPushCommits: number;
    retryBaseVersion: number;
  };
  realtime: {
    clientAId: string;
    clientBId: string;
    authRefreshClientId: string;
    websocketToken: string;
    refreshedWebsocketToken: string;
    expectedAuthTokens: string[];
    expectedConnectionCount: number;
    presenceEvent: string;
    expectedEventDebug: string[];
    task: {
      id: string;
      title: string;
      serverVersion: number;
    };
  };
  liveQuery: {
    clientAId: string;
    clientBId: string;
    querySql: string;
    tables: string[];
    expectedInitialRows: number;
    expectedEventsBeforeUnsubscribe: number;
    expectedEventsAfterUnsubscribe: number;
    firstTask: SyncScenarioTaskInput;
    secondTask: SyncScenarioTaskInput;
    thirdTask: SyncScenarioTaskInput;
  };
  workerAuth: {
    clientId: string;
    authorization: string;
  };
  authRefresh: {
    clientId: string;
    initialAuthorization: string;
    refreshedAuthorization: string;
    expectedRefreshCount: number;
    expectedAuthHeaders: string[];
  };
  revokedSession: {
    clientId: string;
    authorization: string;
    expectedStatus: 401 | 403;
    expectedRefreshCount: number;
    expectedRetryCount: number;
    expectedErrorPattern: string;
  };
  schemaVersion: {
    requiredFutureClientId: string;
    latestFutureClientId: string;
    invalidOutboxClientId: string;
    futureVersionOffset: number;
    expectedRequiredErrorPattern: string;
    expectedInvalidOutboxErrorPattern: string;
  };
  e2ee: {
    clientId: string;
    pullClientId: string;
    keyBase64: string;
    envelopePrefix: string;
    rule: {
      scope: string;
      table: string;
      fields: string[];
    };
    task: {
      id: string;
      title: string;
    };
    conflict: {
      seedClientId: string;
      clientId: string;
      rowId: string;
      serverTitle: string;
      localTitle: string;
      staleBaseVersion: number;
      expectedConflictCount: number;
    };
    chunk: {
      seedClientId: string;
      clientId: string;
    };
    serverVersion: number;
    expectedDecryptedRowCount: number;
  };
  blob: {
    clientId: string;
    browserClientId: string;
    streamingClientId: string;
    dedupeClientId: string;
    authFailureClientId: string;
    interruptedUploadClientId: string;
    missingClientId: string;
    cachePruneClientId: string;
    actorId: string;
    browserActorId: string;
    authorization: string;
    staleAuthorization: string;
    mimeType: string;
    textMimeType: string;
    bytes: number[];
    browserText: string;
    referenceSync: {
      sourceClientId: string;
      readerClientId: string;
      task: SyncScenarioTaskInput;
      image: SyncScenarioBlobRef;
    };
    dedupeText: string;
    authFailureText: string;
    interruptedUploadText: string;
    cachePruneOldText: string;
    cachePruneNewText: string;
    streamingByteCount: number;
    uploadToken: string;
    uploadPath: string;
    downloadPath: string;
    expectedUploadQueueBefore: BlobQueueStats;
    expectedUploadQueueAfter: BlobQueueStats;
    expectedFailedQueue: BlobQueueStats;
    cachePruneMaxBytes: number;
    expectedCacheBeforePrune: BlobCacheStats;
    expectedCachePrunedBytes: number;
    expectedCacheAfterPrune: BlobCacheStats;
    expectedProcessUploaded: BlobProcessResult;
    expectedProcessRetryableFailure: BlobProcessResult;
    expectedProcessPermanentFailure: BlobProcessResult;
    expectedAuthHeaderCount: number;
  };
}

export interface SyncScenarioActor {
  actorId: string;
  token: string;
}

export interface SyncScenarioTaskInput {
  id: string;
  title: string;
}

export interface SyncScenarioBlobRef {
  hash: string;
  size: number;
  mimeType: string;
  encrypted?: boolean;
  keyId?: string;
}

export interface SyncScenarioTaskRow {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string | null;
  server_version: number;
  image: string | null;
  title_yjs_state: string | null;
}

export type HonoTaskRow = SyncScenarioTaskRow;

export interface BlobQueueStats {
  pending: number;
  uploading: number;
  failed: number;
}

export interface BlobCacheStats {
  count: number;
  totalBytes: number;
}

export interface BlobProcessResult {
  uploaded: number;
  failed: number;
}

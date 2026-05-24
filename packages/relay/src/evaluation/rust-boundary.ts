import { readFileSync } from 'node:fs';
import {
  BlobRefSchema,
  BlobUploadCompleteResponseSchema,
  BlobUploadInitRequestSchema,
  BlobUploadInitResponseSchema,
  decodeBinarySyncPack,
  SyncAuthLeaseIssueRequestSchema,
  SyncAuthLeaseIssueResponseSchema,
  SyncAuthLeaseProvenanceSchema,
  type SyncCombinedRequest,
  SyncCombinedRequestSchema,
  type SyncCombinedResponse,
  SyncCombinedResponseSchema,
  SyncSnapshotArtifactRefSchema,
  SyncSnapshotChunkRefSchema,
} from '@syncular/core';

const DEFAULT_ITERATIONS = 2_000;
const DEFAULT_WARMUP_ITERATIONS = 100;

export interface RelayRustBoundaryEvaluationOptions {
  iterations?: number;
  warmupIterations?: number;
}

export interface RelayProtocolBoundaryFixture {
  name: string;
  generatedBy: string;
  combined: {
    request: SyncCombinedRequest;
    response: SyncCombinedResponse;
  };
  snapshotChunk: {
    ref: unknown;
    encodedHex: string;
  };
  scopedSnapshotArtifact: {
    ref: unknown;
    encodedHex: string;
  };
  blob: {
    ref: unknown;
    bytesHex: string;
    uploadInitRequest: unknown;
    uploadInitResponse: unknown;
    uploadCompleteResponse: unknown;
  };
  authLease: {
    provenance: unknown;
    issueRequest: unknown;
    issueResponse: unknown;
  };
  binarySyncPack: {
    contentType: string;
    wireVersion: number;
    encodedHex: string;
    decodedResponse: SyncCombinedResponse;
  };
  realtime: {
    pushRequest: unknown;
    presenceRequest: unknown;
    serverSyncMessage: unknown;
    serverPresenceMessage: unknown;
    serverPushResponseMessage: unknown;
    binarySyncPackHex: string;
  };
}

export interface RelayRustBoundaryMetric {
  name: string;
  iterations: number;
  totalUs: number;
  minUs: number;
  avgUs: number;
  p50Us: number;
  p95Us: number;
  maxUs: number;
}

export interface RelayRustBoundaryDiagnostic {
  case: string;
  rejected: boolean;
  issues: RelayRustBoundaryDiagnosticIssue[];
}

export interface RelayRustBoundaryDiagnosticIssue {
  path: string;
  code: string;
  message: string;
}

export interface RelayRustBoundaryEvaluationResult {
  fixture: {
    name: string;
    generatedBy: string;
    binarySyncPackWireVersion: number;
  };
  payloads: {
    combinedRequestJsonBytes: number;
    combinedResponseJsonBytes: number;
    binarySyncPackBytes: number;
    snapshotChunkBytes: number;
    scopedSnapshotArtifactBytes: number;
    blobBytes: number;
    realtimeServerSyncMessageJsonBytes: number;
  };
  metrics: RelayRustBoundaryMetric[];
  malformedDiagnostics: RelayRustBoundaryDiagnostic[];
  notes: string[];
}

let evaluationSink: unknown;

export function readRelayProtocolBoundaryFixture(): RelayProtocolBoundaryFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../../rust/crates/runtime/tests/fixtures/relay-protocol-boundary-v1.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as RelayProtocolBoundaryFixture;
}

export function evaluateRelayRustBoundary(
  options: RelayRustBoundaryEvaluationOptions = {}
): RelayRustBoundaryEvaluationResult {
  const iterations = positiveIntegerOrDefault(
    options.iterations,
    DEFAULT_ITERATIONS
  );
  const warmupIterations = positiveIntegerOrDefault(
    options.warmupIterations,
    DEFAULT_WARMUP_ITERATIONS
  );
  const fixture = readRelayProtocolBoundaryFixture();
  const combinedRequestJson = JSON.stringify(fixture.combined.request);
  const combinedResponseJson = JSON.stringify(fixture.combined.response);
  const realtimeServerSyncMessageJson = JSON.stringify(
    fixture.realtime.serverSyncMessage
  );
  const binarySyncPackBytes = bytesFromHex(fixture.binarySyncPack.encodedHex);

  const metrics: RelayRustBoundaryMetric[] = [
    measureOperation(
      'json.parse.combined_request',
      iterations,
      warmupIterations,
      () => JSON.parse(combinedRequestJson) as unknown
    ),
    measureOperation(
      'json.parse.combined_response',
      iterations,
      warmupIterations,
      () => JSON.parse(combinedResponseJson) as unknown
    ),
    measureOperation(
      'schema.combined_request',
      iterations,
      warmupIterations,
      () => SyncCombinedRequestSchema.parse(fixture.combined.request)
    ),
    measureOperation(
      'schema.combined_response',
      iterations,
      warmupIterations,
      () => SyncCombinedResponseSchema.parse(fixture.combined.response)
    ),
    measureOperation(
      'http_style_parse_and_schema.combined_request',
      iterations,
      warmupIterations,
      () => SyncCombinedRequestSchema.parse(JSON.parse(combinedRequestJson))
    ),
    measureOperation(
      'http_style_parse_and_schema.combined_response',
      iterations,
      warmupIterations,
      () => SyncCombinedResponseSchema.parse(JSON.parse(combinedResponseJson))
    ),
    measureOperation(
      'binary_sync_pack.decode',
      iterations,
      warmupIterations,
      () => decodeBinarySyncPack(binarySyncPackBytes)
    ),
    measureOperation(
      'binary_sync_pack.decode_plus_schema',
      iterations,
      warmupIterations,
      () =>
        SyncCombinedResponseSchema.parse(
          decodeBinarySyncPack(binarySyncPackBytes)
        )
    ),
    measureOperation(
      'relay_protocol_boundary.validate_schema_backed_fixture_objects',
      iterations,
      warmupIterations,
      () => validateRelayProtocolBoundaryFixture(fixture)
    ),
  ];

  return {
    fixture: {
      name: fixture.name,
      generatedBy: fixture.generatedBy,
      binarySyncPackWireVersion: fixture.binarySyncPack.wireVersion,
    },
    payloads: {
      combinedRequestJsonBytes: byteLength(combinedRequestJson),
      combinedResponseJsonBytes: byteLength(combinedResponseJson),
      binarySyncPackBytes: binarySyncPackBytes.byteLength,
      snapshotChunkBytes: bytesFromHex(fixture.snapshotChunk.encodedHex)
        .byteLength,
      scopedSnapshotArtifactBytes: bytesFromHex(
        fixture.scopedSnapshotArtifact.encodedHex
      ).byteLength,
      blobBytes: bytesFromHex(fixture.blob.bytesHex).byteLength,
      realtimeServerSyncMessageJsonBytes: byteLength(
        realtimeServerSyncMessageJson
      ),
    },
    metrics,
    malformedDiagnostics: collectMalformedDiagnostics(
      fixture,
      binarySyncPackBytes
    ),
    notes: [
      'This is a current TypeScript relay/protocol baseline, not a Rust production integration.',
      'Metrics are candidate/control inputs for deciding whether a Rust validation boundary is worth a later prototype.',
      'Malformed diagnostics intentionally report schema paths and codes without row payloads or secret material.',
    ],
  };
}

export function assertRelayRustBoundaryEvaluation(
  result: RelayRustBoundaryEvaluationResult
): void {
  if (result.metrics.length === 0) {
    throw new Error('Relay Rust boundary evaluation produced no metrics');
  }
  const emptyMetric = result.metrics.find(
    (metric) => metric.iterations <= 0 || metric.totalUs <= 0
  );
  if (emptyMetric) {
    throw new Error(
      `Relay Rust boundary metric ${emptyMetric.name} did not record timing`
    );
  }
  const acceptedMalformedCase = result.malformedDiagnostics.find(
    (diagnostic) => !diagnostic.rejected
  );
  if (acceptedMalformedCase) {
    throw new Error(
      `Malformed protocol case ${acceptedMalformedCase.case} was accepted`
    );
  }
}

function validateRelayProtocolBoundaryFixture(
  fixture: RelayProtocolBoundaryFixture
): true {
  SyncCombinedRequestSchema.parse(fixture.combined.request);
  SyncCombinedResponseSchema.parse(fixture.combined.response);
  SyncSnapshotChunkRefSchema.parse(fixture.snapshotChunk.ref);
  SyncSnapshotArtifactRefSchema.parse(fixture.scopedSnapshotArtifact.ref);
  BlobRefSchema.parse(fixture.blob.ref);
  BlobUploadInitRequestSchema.parse(fixture.blob.uploadInitRequest);
  BlobUploadInitResponseSchema.parse(fixture.blob.uploadInitResponse);
  BlobUploadCompleteResponseSchema.parse(fixture.blob.uploadCompleteResponse);
  SyncAuthLeaseProvenanceSchema.parse(fixture.authLease.provenance);
  SyncAuthLeaseIssueRequestSchema.parse(fixture.authLease.issueRequest);
  SyncAuthLeaseIssueResponseSchema.parse(fixture.authLease.issueResponse);
  decodeBinarySyncPack(bytesFromHex(fixture.binarySyncPack.encodedHex));
  return true;
}

function collectMalformedDiagnostics(
  fixture: RelayProtocolBoundaryFixture,
  binarySyncPackBytes: Uint8Array
): RelayRustBoundaryDiagnostic[] {
  return [
    collectDiagnostic('combined_request.empty_client_id', () => {
      SyncCombinedRequestSchema.parse({
        ...fixture.combined.request,
        clientId: '',
      });
    }),
    collectDiagnostic('combined_response.non_true_ok', () => {
      SyncCombinedResponseSchema.parse({
        ...fixture.combined.response,
        ok: false,
      });
    }),
    collectDiagnostic('blob_ref.invalid_hash', () => {
      BlobRefSchema.parse({
        ...recordFrom(fixture.blob.ref),
        hash: 'sha256:bad',
      });
    }),
    collectDiagnostic('binary_sync_pack.unsupported_wire_version', () => {
      const stale = new Uint8Array(binarySyncPackBytes);
      stale[4] = 0;
      stale[5] = 0;
      decodeBinarySyncPack(stale);
    }),
  ];
}

function collectDiagnostic(
  name: string,
  action: () => void
): RelayRustBoundaryDiagnostic {
  try {
    action();
    return {
      case: name,
      rejected: false,
      issues: [],
    };
  } catch (error) {
    return {
      case: name,
      rejected: true,
      issues: sanitizedIssues(error),
    };
  }
}

function sanitizedIssues(error: unknown): RelayRustBoundaryDiagnosticIssue[] {
  const issues = issueArray(error);
  if (issues) {
    return issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    }));
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  return [
    {
      path: '',
      code: 'error',
      message,
    },
  ];
}

function issueArray(error: unknown):
  | Array<{
      path: Array<string | number>;
      code: string;
      message: string;
    }>
  | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('issues' in error) ||
    !Array.isArray(error.issues)
  ) {
    return undefined;
  }
  const issues = error.issues as unknown[];
  return issues
    .filter(
      (
        issue
      ): issue is {
        path: Array<string | number>;
        code: string;
        message: string;
      } =>
        typeof issue === 'object' &&
        issue !== null &&
        'path' in issue &&
        Array.isArray(issue.path) &&
        'code' in issue &&
        typeof issue.code === 'string' &&
        'message' in issue &&
        typeof issue.message === 'string'
    )
    .map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    }));
}

function measureOperation(
  name: string,
  iterations: number,
  warmupIterations: number,
  operation: () => unknown
): RelayRustBoundaryMetric {
  for (let index = 0; index < warmupIterations; index += 1) {
    evaluationSink = operation();
  }

  const samples = new Array<number>(iterations);
  const totalStart = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint();
    evaluationSink = operation();
    samples[index] = Number(process.hrtime.bigint() - start) / 1_000;
  }
  const totalUs = Number(process.hrtime.bigint() - totalStart) / 1_000;
  samples.sort((left, right) => left - right);

  return {
    name,
    iterations,
    totalUs: roundUs(totalUs),
    minUs: roundUs(samples[0] ?? 0),
    avgUs: roundUs(totalUs / iterations),
    p50Us: roundUs(percentile(samples, 0.5)),
    p95Us: roundUs(percentile(samples, 0.95)),
    maxUs: roundUs(samples[samples.length - 1] ?? 0),
  };
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedSamples.length - 1,
    Math.floor((sortedSamples.length - 1) * percentileValue)
  );
  return sortedSamples[index] ?? 0;
}

function positiveIntegerOrDefault(
  value: number | undefined,
  defaultValue: number
): number {
  if (Number.isInteger(value) && value !== undefined && value > 0) {
    return value;
  }
  return defaultValue;
}

function bytesFromHex(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function roundUs(value: number): number {
  return Math.round(value * 100) / 100;
}

function recordFrom(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Expected record value in relay protocol fixture');
}

export function relayRustBoundaryEvaluationSink(): unknown {
  return evaluationSink;
}

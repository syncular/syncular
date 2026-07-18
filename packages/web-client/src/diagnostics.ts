/**
 * Privacy-safe client diagnostics shared by direct, Worker, Tauri, React
 * Native, and normalized React hosts. The snapshot deliberately excludes
 * requested/effective scope values, row/cardinality data, SQL, database paths,
 * auth material, lease ids, encryption keys, mutation bodies, and arbitrary
 * diagnostic prose.
 */
import type { SecurityLifecycle } from './client';

export const CLIENT_DIAGNOSTICS_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS = 256;
export const MAX_DIAGNOSTIC_DOMAINS = 256;

export type ClientDiagnosticsHostKind =
  | 'direct'
  | 'worker'
  | 'tauri'
  | 'react-native';
export type ClientDiagnosticsHostRole =
  | 'single'
  | 'leader'
  | 'follower'
  | 'unknown';
export type ClientDiagnosticsConnectivity = 'online' | 'offline' | 'unknown';
export type ClientDiagnosticsRealtime =
  | 'connected'
  | 'disconnected'
  | 'unsupported'
  | 'unknown';

export interface ClientDiagnosticsHost {
  readonly kind: ClientDiagnosticsHostKind;
  readonly role: ClientDiagnosticsHostRole;
  readonly connectivity: ClientDiagnosticsConnectivity;
  readonly realtime: ClientDiagnosticsRealtime;
}

export interface ExpectedDiagnosticSubscription {
  /** Application-owned stable identifier. It must never contain PHI. */
  readonly id: string;
  /** Generated schema table name. */
  readonly table: string;
}

export interface ClientDiagnosticsRequest {
  /**
   * Optional bounded intent list. Missing registrations are returned as
   * `unregistered`, allowing a zero-row security scope to fail closed without
   * reading private Syncular tables. Values/scopes are intentionally absent.
   */
  readonly expectedSubscriptions?: readonly ExpectedDiagnosticSubscription[];
}

export type DiagnosticSubscriptionState =
  | 'unregistered'
  | 'bootstrapping'
  | 'complete'
  | 'reset'
  | 'revoked'
  | 'failed';

export interface DiagnosticSubscription {
  readonly id: string;
  readonly table: string;
  readonly state: DiagnosticSubscriptionState;
  readonly complete: boolean;
  /** Last fully applied local commit sequence; absent when unregistered. */
  readonly cursor?: number;
  readonly reasonCode?: string;
}

export interface DiagnosticRoundCounters {
  readonly pushed: number;
  readonly applied: number;
  readonly rejected: number;
  readonly retryable: number;
  readonly conflicts: number;
  readonly commitsApplied: number;
  readonly segmentRowsApplied: number;
  readonly bootstrapping: number;
  readonly resets: number;
  readonly revoked: number;
  readonly failed: number;
  readonly deferredCommits: number;
}

export type DiagnosticLastRound =
  | {
      readonly status: 'succeeded';
      readonly startedAtMs: number;
      readonly completedAtMs: number;
      readonly durationMs: number;
      readonly counters: DiagnosticRoundCounters;
    }
  | {
      readonly status: 'failed';
      readonly startedAtMs: number;
      readonly completedAtMs: number;
      readonly durationMs: number;
      /** Stable code only; never arbitrary transport/server prose. */
      readonly errorCode: string;
    };

export interface DiagnosticLastChange {
  /** Decimal u64 for JSON/IPC parity. */
  readonly revision: string;
  readonly recordedAtMs: number;
  /** Generated table names only; no scope keys or row ids. */
  readonly tables: readonly string[];
  /** Generated table names for changed window registrations/completeness. */
  readonly windows: readonly string[];
  readonly domainsTruncated: boolean;
  readonly statusChanged: boolean;
  readonly conflictsChanged: boolean;
  readonly rejectionsChanged: boolean;
  readonly outcomesChanged: boolean;
}

export interface ClientDiagnosticsStorage {
  readonly status: 'healthy' | 'pressure' | 'unreadable';
  /** SQLite page estimate. No path, filename, or per-domain row counts. */
  readonly databaseBytesApprox?: number;
  readonly pendingOutboxBytesApprox?: number;
  readonly retainedOutcomeBytesApprox?: number;
  readonly retainedOutcomeEntries?: number;
  readonly blobCacheBytesApprox?: number;
  readonly pressureReasonCode?: 'client.blob_cache_over_limit';
}

export interface ClientDiagnosticsSnapshot {
  readonly version: typeof CLIENT_DIAGNOSTICS_VERSION;
  readonly capturedAtMs: number;
  readonly host: ClientDiagnosticsHost;
  readonly securityLifecycle: SecurityLifecycle;
  readonly schema: {
    readonly currentVersion: number;
    readonly upgrading: boolean;
    readonly requiredVersion?: number;
    readonly latestVersion?: number;
  };
  readonly replica: {
    /** Decimal u64 for JSON/IPC parity. */
    readonly localRevision: string;
    readonly syncNeeded: boolean;
    readonly pendingOutbox: number;
  };
  readonly lease: {
    readonly state: 'none' | 'active' | 'expired' | 'stopped';
    readonly expiresAtMs?: number;
    readonly errorCode?: string;
  };
  readonly subscriptions: readonly DiagnosticSubscription[];
  readonly subscriptionsTruncated: boolean;
  readonly lastRound?: DiagnosticLastRound;
  readonly lastChange?: DiagnosticLastChange;
  readonly storage: ClientDiagnosticsStorage;
}

export type ClientDiagnosticsListener = (
  snapshot: ClientDiagnosticsSnapshot,
) => void;

export class ClientDiagnosticsEmitter {
  readonly #listeners = new Set<ClientDiagnosticsListener>();

  on(listener: ClientDiagnosticsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(snapshot: ClientDiagnosticsSnapshot): void {
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // Diagnostics observers cannot alter sync correctness.
      }
    }
  }
}

/** Host wrappers replace topology facts without changing core evidence. */
export function withClientDiagnosticsHost(
  snapshot: ClientDiagnosticsSnapshot,
  host: ClientDiagnosticsHost,
): ClientDiagnosticsSnapshot {
  return { ...snapshot, host };
}

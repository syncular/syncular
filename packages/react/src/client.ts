/**
 * The ONE client interface the React bindings target. Both the direct
 * `SyncClient` (constructed on the current thread) and the worker-mode
 * `SyncClientHandle` (a promise proxy over the OPFS worker) satisfy it —
 * their public surfaces diverge (getters vs methods, sync vs promise), so
 * this module normalizes both into a single async-friendly facade the hooks
 * consume. That is the "one interface across direct and worker-handle modes"
 * the invalidation seam (TODO 3.1) was standardized to enable.
 *
 * The normalizer resolves each accessor at call time (function → call it,
 * value → read it) and wraps every result in `Promise.resolve`, so a hook
 * never has to care which core it holds.
 */
import type {
  ClientChangeListener,
  ClientDiagnosticsListener,
  ClientDiagnosticsRequest,
  ClientDiagnosticsSnapshot,
  CommitOutcome,
  CommitOutcomeQuery,
  ConflictRecord,
  InvalidationListener,
  LeadershipState,
  LeaseState,
  LocalDataPurgeInput,
  LocalDataPurgeResult,
  MutationInput,
  PresencePeer,
  QueryReadSpec,
  QuerySnapshot,
  RejectionRecord,
  ResolveCommitOutcomeInput,
  SchemaFloor,
  SecurityLifecycle,
  SqlRow,
  SqlValue,
  SyncStatusSnapshot,
  WindowBase,
  WindowState,
} from '@syncular/client';

/**
 * The structural union of `SyncClient` and `SyncClientHandle`. Members that
 * diverge are typed as "value or method, sync or promise"; {@link normalizeClient}
 * collapses the divergence. Only what the hooks use is listed — the bindings
 * never reach past this surface.
 */
export interface SyncClientLike {
  readonly currentSchemaVersion?: number;
  onChange(listener: ClientChangeListener): () => void;
  onDiagnostics(listener: ClientDiagnosticsListener): () => void;
  onInvalidate(listener: InvalidationListener): () => void;
  onPresence(listener: (scopeKey: string) => void): () => void;
  onLeadershipChange?(listener: (state: LeadershipState) => void): () => void;
  leadershipSnapshot?(): LeadershipState | undefined;
  securityLifecycle:
    | SecurityLifecycle
    | (() => SecurityLifecycle | Promise<SecurityLifecycle>);
  beginSecurityPreflight(): void | Promise<void>;
  /** Key-bearing activation remains available on each concrete host type. */
  activateSecurity(): void | Promise<void>;
  query(
    sql: string,
    params?: readonly SqlValue[],
  ): SqlRow[] | Promise<SqlRow[]>;
  mutate(mutations: readonly MutationInput[]): string | Promise<string>;
  patch(
    table: string,
    rowId: string,
    partial: Readonly<Record<string, unknown>>,
    options?: { readonly baseVersion?: number },
  ): string | Promise<string>;
  purgeLocalData(
    input: LocalDataPurgeInput,
  ): LocalDataPurgeResult | Promise<LocalDataPurgeResult>;
  querySnapshot<Row = SqlRow>(
    spec: QueryReadSpec,
  ): QuerySnapshot<Row> | Promise<QuerySnapshot<Row>>;
  statusSnapshot(): SyncStatusSnapshot | Promise<SyncStatusSnapshot>;
  diagnosticsSnapshot(
    request?: ClientDiagnosticsRequest,
  ): ClientDiagnosticsSnapshot | Promise<ClientDiagnosticsSnapshot>;
  conflicts:
    | readonly ConflictRecord[]
    | (() => readonly ConflictRecord[] | Promise<readonly ConflictRecord[]>);
  rejections:
    | readonly RejectionRecord[]
    | (() => readonly RejectionRecord[] | Promise<readonly RejectionRecord[]>);
  commitOutcome(
    clientCommitId: string,
  ): CommitOutcome | undefined | Promise<CommitOutcome | undefined>;
  commitOutcomes(
    query?: CommitOutcomeQuery,
  ): readonly CommitOutcome[] | Promise<readonly CommitOutcome[]>;
  resolveCommitOutcome(
    input: ResolveCommitOutcomeInput,
  ): CommitOutcome | Promise<CommitOutcome>;
  schemaFloor:
    | SchemaFloor
    | undefined
    | (() => SchemaFloor | undefined | Promise<SchemaFloor | undefined>);
  leaseState:
    | LeaseState
    | undefined
    | (() => LeaseState | undefined | Promise<LeaseState | undefined>);
  upgrading: boolean | (() => boolean | Promise<boolean>);
  syncNeeded: boolean | (() => boolean | Promise<boolean>);
  pendingCommits: () => unknown[] | Promise<unknown[]>;
  presence(
    scopeKey: string,
  ): readonly PresencePeer[] | Promise<readonly PresencePeer[]>;
  setPresence(
    scopeKey: string,
    doc: Record<string, unknown> | null,
  ): void | Promise<void>;
  /** §4.8 windowed subscriptions: set the live units for a window base. */
  setWindow(base: WindowBase, units: readonly string[]): void | Promise<void>;
  /** §4.8 completeness oracle (I3): the windowed-in units for a base. */
  windowState(base: WindowBase): WindowState | Promise<WindowState>;
}

/**
 * Read a member by key that is EITHER a value getter (SyncClient) or a
 * method returning a value/promise (SyncClientHandle). Read from the client
 * so a method keeps its `this` binding; if the read is a function, call it.
 */
function resolveMember<T>(
  client: SyncClientLike,
  key: keyof SyncClientLike,
): Promise<T> {
  const member = client[key] as unknown;
  const value =
    typeof member === 'function'
      ? (member as (this: SyncClientLike) => T | Promise<T>).call(client)
      : (member as T);
  return Promise.resolve(value as T);
}

/** The uniform async facade the hooks actually call. */
export interface NormalizedClient {
  readonly currentSchemaVersion?: number;
  onChange(listener: ClientChangeListener): () => void;
  onDiagnostics(listener: ClientDiagnosticsListener): () => void;
  onInvalidate(listener: InvalidationListener): () => void;
  onPresence(listener: (scopeKey: string) => void): () => void;
  onLeadershipChange(listener: (state: LeadershipState) => void): () => void;
  leadershipSnapshot(): LeadershipState | undefined;
  securityLifecycle(): Promise<SecurityLifecycle>;
  beginSecurityPreflight(): Promise<void>;
  /** Key-bearing activation remains available on each concrete host type. */
  activateSecurity(): Promise<void>;
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  mutate(mutations: readonly MutationInput[]): Promise<string>;
  patch(
    table: string,
    rowId: string,
    partial: Readonly<Record<string, unknown>>,
    options?: { readonly baseVersion?: number },
  ): Promise<string>;
  purgeLocalData(input: LocalDataPurgeInput): Promise<LocalDataPurgeResult>;
  querySnapshot<Row = SqlRow>(spec: QueryReadSpec): Promise<QuerySnapshot<Row>>;
  statusSnapshot(): Promise<SyncStatusSnapshot>;
  diagnosticsSnapshot(
    request?: ClientDiagnosticsRequest,
  ): Promise<ClientDiagnosticsSnapshot>;
  conflicts(): Promise<readonly ConflictRecord[]>;
  rejections(): Promise<readonly RejectionRecord[]>;
  commitOutcome(clientCommitId: string): Promise<CommitOutcome | undefined>;
  commitOutcomes(query?: CommitOutcomeQuery): Promise<readonly CommitOutcome[]>;
  resolveCommitOutcome(
    input: ResolveCommitOutcomeInput,
  ): Promise<CommitOutcome>;
  schemaFloor(): Promise<SchemaFloor | undefined>;
  leaseState(): Promise<LeaseState | undefined>;
  upgrading(): Promise<boolean>;
  syncNeeded(): Promise<boolean>;
  pendingCommits(): Promise<unknown[]>;
  presence(scopeKey: string): Promise<readonly PresencePeer[]>;
  setPresence(
    scopeKey: string,
    doc: Record<string, unknown> | null,
  ): Promise<void>;
  setWindow(base: WindowBase, units: readonly string[]): Promise<void>;
  windowState(base: WindowBase): Promise<WindowState>;
}

export function normalizeClient(client: SyncClientLike): NormalizedClient {
  return {
    ...(client.currentSchemaVersion !== undefined
      ? { currentSchemaVersion: client.currentSchemaVersion }
      : {}),
    onChange: (listener) => client.onChange(listener),
    onDiagnostics: (listener) => client.onDiagnostics(listener),
    onInvalidate: (listener) => client.onInvalidate(listener),
    onPresence: (listener) => client.onPresence(listener),
    onLeadershipChange: (listener) =>
      client.onLeadershipChange?.(listener) ?? (() => {}),
    leadershipSnapshot: () => client.leadershipSnapshot?.(),
    securityLifecycle: () => resolveMember(client, 'securityLifecycle'),
    beginSecurityPreflight: () =>
      Promise.resolve(client.beginSecurityPreflight()),
    activateSecurity: () => Promise.resolve(client.activateSecurity()),
    query: (sql, params) => Promise.resolve(client.query(sql, params)),
    mutate: (mutations) => Promise.resolve(client.mutate(mutations)),
    patch: (table, rowId, partial, options) =>
      Promise.resolve(client.patch(table, rowId, partial, options)),
    purgeLocalData: (input) => Promise.resolve(client.purgeLocalData(input)),
    querySnapshot: (spec) => Promise.resolve(client.querySnapshot(spec)),
    statusSnapshot: () => Promise.resolve(client.statusSnapshot()),
    diagnosticsSnapshot: (request) =>
      Promise.resolve(client.diagnosticsSnapshot(request)),
    conflicts: () => resolveMember(client, 'conflicts'),
    rejections: () => resolveMember(client, 'rejections'),
    commitOutcome: (clientCommitId) =>
      Promise.resolve(client.commitOutcome(clientCommitId)),
    commitOutcomes: (query) => Promise.resolve(client.commitOutcomes(query)),
    resolveCommitOutcome: (input) =>
      Promise.resolve(client.resolveCommitOutcome(input)),
    schemaFloor: () => resolveMember(client, 'schemaFloor'),
    leaseState: () => resolveMember(client, 'leaseState'),
    upgrading: () => resolveMember(client, 'upgrading'),
    syncNeeded: () => resolveMember(client, 'syncNeeded'),
    pendingCommits: () => resolveMember(client, 'pendingCommits'),
    presence: (scopeKey) => Promise.resolve(client.presence(scopeKey)),
    setPresence: (scopeKey, doc) =>
      Promise.resolve(client.setPresence(scopeKey, doc)),
    setWindow: (base, units) => Promise.resolve(client.setWindow(base, units)),
    windowState: (base) => Promise.resolve(client.windowState(base)),
  };
}

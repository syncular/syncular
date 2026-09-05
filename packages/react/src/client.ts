/** The provider uses the supplied client identity and canonical snapshot methods. */
import type {
  ClientSnapshotReader,
  ClientChangeListener,
  ClientDiagnosticsListener,
  InvalidationListener,
  LeadershipState,
  LocalDataPurgeInput,
  LocalDataPurgeResult,
  LocalDataRebootstrapInput,
  LocalDataRebootstrapResult,
  MutationInput,
  PresencePeer,
  QueryReadSpec,
  QuerySnapshot,
  SecurityLifecycle,
  SqlRow,
  SqlValue,
  WindowBase,
  WindowState,
} from '@syncular/client';

export interface SyncClientLike extends ClientSnapshotReader {
  readonly currentSchemaVersion?: number;
  onChange(listener: ClientChangeListener): () => void;
  onDiagnostics(listener: ClientDiagnosticsListener): () => void;
  onInvalidate(listener: InvalidationListener): () => void;
  onPresence(listener: (scopeKey: string) => void): () => void;
  onLeadershipChange?(listener: (state: LeadershipState) => void): () => void;
  leadershipSnapshot?(): LeadershipState | undefined;
  securityLifecycle(): SecurityLifecycle | Promise<SecurityLifecycle>;
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
  rebootstrapLocalData(
    input: LocalDataRebootstrapInput,
  ): LocalDataRebootstrapResult | Promise<LocalDataRebootstrapResult>;
  querySnapshot<Row = SqlRow>(
    spec: QueryReadSpec,
  ): QuerySnapshot<Row> | Promise<QuerySnapshot<Row>>;
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

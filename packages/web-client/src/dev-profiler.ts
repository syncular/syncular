/**
 * `@syncular/client/dev`: a development profiler. It wraps the database,
 * the sync transport, the realtime connector and the client (or a worker or
 * native handle) an app already constructs, and reports per live query, per
 * statement, per round, per unit and per write burst. It keeps SQL text in
 * memory, so `createSyncProfiler` refuses a build without a development or
 * test signal. No production entry imports this module.
 */
import type { MutationInput, QueryReadSpec, QuerySnapshot } from './client';
import type { ClientDatabase, SqlValue } from './database';
import { developmentBuild } from './devtools';
import type { ClientDiagnosticsListener } from './diagnostics';
import { ClientSyncError } from './errors';
import type { ClientChangeListener } from './invalidation';
import type { SyncProgressListener } from './progress';
import { canonicalValue } from './reactive-store';
import type { RealtimeConnector, SyncTransport } from './transport';

/** The surface `profiler.client()` wraps: a `SyncClient`, a worker handle or a native handle. */
export interface ProfiledClient {
  querySnapshot(spec: QueryReadSpec): QuerySnapshot | Promise<QuerySnapshot>;
  mutate(mutations: readonly MutationInput[]): unknown;
  onChange(listener: ClientChangeListener): () => void;
  onProgress(listener: SyncProgressListener): () => void;
  onDiagnostics(listener: ClientDiagnosticsListener): () => void;
}

export interface SyncProfilerOptions {
  /** Milliseconds clock; tests pass a virtual one. Default `performance.now`. */
  readonly now?: () => number;
  /** The server's `maxSubscriptionsPerRequest`. Default 500. */
  readonly unitLimit?: number;
  /**
   * Single-operation commits that start within this many milliseconds of the
   * previous one join its write burst. Default 16.
   */
  readonly burstWindowMs?: number;
  /**
   * Shared between a worker's profiler and the page's: the worker posts its
   * statements and rounds, the page merges them into its report. Pass
   * `new BroadcastChannel(name)` with the same name on both sides.
   */
  readonly channel?: Pick<BroadcastChannel, 'postMessage' | 'onmessage'>;
}

export interface QueryProfile {
  /** The owner id of a live query, or the SQL of an unowned read. */
  readonly id: string;
  readonly sql: string;
  readonly tables: readonly string[];
  readonly runs: number;
  /** Runs whose rows equal the previous run's rows. */
  readonly identicalRuns: number;
  readonly totalMs: number;
  readonly maxMs: number;
  /** Rows of the last run. */
  readonly rows: number;
  /** Runs per changed table, plus `mount` (first run) and `refresh` (no table changed). */
  readonly triggers: Readonly<Record<string, number>>;
}

export interface StatementProfile {
  readonly sql: string;
  readonly runs: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly rows: number;
}

export interface RoundProfile {
  readonly via: 'http' | 'socket';
  readonly requestBytes: number;
  readonly responseBytes: number;
  /** From sending the request to the last response byte. */
  readonly ms: number;
}

export interface UnitProfile {
  readonly unitId: string;
  readonly table: string | undefined;
  /** Segment bytes downloaded or received inline. */
  readonly bytes: number;
  readonly rows: number;
  /** From the unit's first progress event to its last. */
  readonly ms: number;
}

export interface ProfileReport {
  readonly queries: readonly QueryProfile[];
  readonly statements: readonly StatementProfile[];
  /** The last 256 rounds. */
  readonly rounds: readonly RoundProfile[];
  readonly deltas: { readonly count: number; readonly bytes: number };
  readonly units: {
    /** `activeUnits` of the last diagnostics snapshot: the units the next pull sends. */
    readonly active: number;
    readonly peak: number;
    readonly limit: number;
    readonly bootstraps: readonly UnitProfile[];
  };
  readonly writes: {
    readonly mutateCalls: number;
    readonly operations: number;
    /** Runs of more than one single-operation commit (`burstWindowMs`). */
    readonly bursts: readonly {
      readonly commits: number;
      readonly tables: readonly string[];
    }[];
  };
}

export interface SyncProfiler {
  database<D extends ClientDatabase>(database: D): D;
  transport(transport: SyncTransport): SyncTransport;
  realtime(connector: RealtimeConnector): RealtimeConnector;
  client<C extends ProfiledClient>(client: C): C;
  report(): ProfileReport;
  reset(): void;
}

export interface ProfileBudgets {
  readonly maxActiveUnits?: number;
  /** Request plus response bytes of one round. */
  readonly maxRoundBytes?: number;
  readonly maxRunsPerQuery?: number;
  /** Identical runs summed over all queries. */
  readonly maxIdenticalRuns?: number;
  /** Commits of the largest write burst. */
  readonly maxWriteBurst?: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type UnitState = Mutable<UnitProfile> & {
  startedAt: number;
  segment: string | undefined;
  segmentBytes: number;
  segmentRows: number;
};

/** A proxy that replaces `overrides` and binds every other method to `target`. */
function wrap<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(object, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key as keyof T];
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export function createSyncProfiler(
  options: SyncProfilerOptions = {},
): SyncProfiler {
  if (!developmentBuild())
    throw new ClientSyncError(
      'client.profiler_in_production',
      'createSyncProfiler requires a development or test build',
    );
  const now = options.now ?? (() => performance.now());
  const burstWindowMs = options.burstWindowMs ?? 16;
  const channel = options.channel;
  const source = Math.random().toString(36).slice(2);
  let queries = new Map<string, Mutable<QueryProfile>>();
  // Per query: the canonical rows of its last run and the change sequence it saw.
  let queryState = new Map<string, { rows: string; seq: number }>();
  let statements = new Map<string, Mutable<StatementProfile>>();
  let rounds: Mutable<RoundProfile>[] = [];
  let deltas = { count: 0, bytes: 0 };
  let units = { active: 0, peak: 0 };
  let bootstraps = new Map<string, UnitState>();
  let writes = {
    mutateCalls: 0,
    operations: 0,
    bursts: [] as { commits: number; tables: string[] }[],
  };
  let burst: { commits: number; tables: string[]; at: number } | undefined;
  let changeSeq = 0;
  const changedAt = new Map<string, number>();
  const remote = new Map<
    string,
    Pick<ProfileReport, 'statements' | 'rounds'>
  >();
  let posting = false;
  const clear = () => {
    queries = new Map();
    queryState = new Map();
    statements = new Map();
    rounds = [];
    deltas = { count: 0, bytes: 0 };
    units = { active: units.active, peak: units.active };
    bootstraps = new Map();
    writes = { mutateCalls: 0, operations: 0, bursts: [] };
    burst = undefined;
    remote.clear();
  };

  const post = () => {
    if (channel === undefined || posting) return;
    posting = true;
    queueMicrotask(() => {
      posting = false;
      channel.postMessage({
        syncularProfile: source,
        statements: [...statements.values()],
        rounds,
      });
    });
  };
  if (channel !== undefined)
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        syncularProfile?: unknown;
        syncularProfileReset?: unknown;
      } & Pick<ProfileReport, 'statements' | 'rounds'>;
      if (data?.syncularProfileReset === true) clear();
      else if (typeof data?.syncularProfile === 'string')
        remote.set(data.syncularProfile, {
          statements: data.statements,
          rounds: data.rounds,
        });
    };

  const round = (entry: Mutable<RoundProfile>) => {
    rounds.push(entry);
    if (rounds.length > 256) rounds.shift();
    post();
    return entry;
  };
  const statement =
    <R>(run: (sql: string, params?: readonly SqlValue[]) => R) =>
    (sql: string, params?: readonly SqlValue[]): R => {
      const startedAt = now();
      const result = run(sql, params);
      const ms = now() - startedAt;
      const entry =
        statements.get(sql) ??
        statements
          .set(sql, { sql, runs: 0, totalMs: 0, maxMs: 0, rows: 0 })
          .get(sql)!;
      entry.runs += 1;
      entry.totalMs += ms;
      entry.maxMs = Math.max(entry.maxMs, ms);
      if (Array.isArray(result)) entry.rows += result.length;
      post();
      return result;
    };

  return {
    database: (database) =>
      wrap(database, {
        exec: statement((sql, params) => database.exec(sql, params)),
        query: statement((sql, params) => database.query(sql, params)),
        queryReadOnly: statement((sql, params) =>
          database.queryReadOnly(sql, params),
        ),
      } as Partial<typeof database>),

    transport: (transport) => async (request, signal) => {
      const startedAt = now();
      const response = await transport(request, signal);
      round({
        via: 'http',
        requestBytes: request.length,
        responseBytes: response.length,
        ms: now() - startedAt,
      });
      return response;
    },

    realtime: (connector) => (handlers, clientId) => {
      let open: (Mutable<RoundProfile> & { startedAt: number }) | undefined;
      const socket = connector(
        {
          ...handlers,
          onBinary: (bytes) => {
            // §8.7: tag 0x00 is a delta, tag 0x01 a chunk of the open round.
            if (bytes[0] === 0) {
              deltas.count += 1;
              deltas.bytes += bytes.length - 1;
            } else if (open !== undefined) {
              open.responseBytes += bytes.length - 1;
              open.ms = now() - open.startedAt;
              post();
            }
            handlers.onBinary(bytes);
          },
        },
        clientId,
      );
      const profiled = (opened: Awaited<typeof socket>) =>
        wrap(opened, {
          sendBytes: (bytes: Uint8Array) => {
            if (bytes[0] === 1) {
              const startedAt = now();
              open = Object.assign(
                round({
                  via: 'socket',
                  requestBytes: bytes.length - 1,
                  responseBytes: 0,
                  ms: 0,
                }),
                { startedAt },
              );
            }
            opened.sendBytes(bytes);
          },
        });
      return socket instanceof Promise
        ? socket.then(profiled)
        : profiled(socket);
    },

    client: (client) => {
      client.onChange((batch) => {
        changeSeq += 1;
        for (const change of batch.tables)
          changedAt.set(change.table, changeSeq);
      });
      client.onDiagnostics((snapshot) => {
        units.active = snapshot.activeUnits;
        units.peak = Math.max(units.peak, snapshot.activeUnits);
      });
      client.onProgress((progress) => {
        if (progress.unitId === undefined || progress.phase === 'request')
          return;
        let unit = bootstraps.get(progress.unitId);
        if (unit === undefined) {
          unit = {
            unitId: progress.unitId,
            table: progress.table,
            bytes: 0,
            rows: 0,
            ms: 0,
            startedAt: now(),
            segment: undefined,
            segmentBytes: 0,
            segmentRows: 0,
          };
          bootstraps.set(progress.unitId, unit);
        }
        // A progress event repeats its segment's running totals; a new
        // segment, or totals that went down, starts the next one.
        if (
          progress.segmentId !== unit.segment ||
          progress.bytesReceived < unit.segmentBytes ||
          progress.rowsProcessed < unit.segmentRows
        ) {
          unit.bytes += unit.segmentBytes;
          unit.rows += unit.segmentRows;
        }
        unit.segment = progress.segmentId;
        unit.segmentBytes = progress.bytesReceived;
        unit.segmentRows = progress.rowsProcessed;
        unit.ms = now() - unit.startedAt;
      });
      const record = (
        spec: QueryReadSpec,
        startedAt: number,
        seq: number,
        snapshot: QuerySnapshot,
      ) => {
        const id = spec.owner?.id ?? spec.sql;
        const ms = now() - startedAt;
        const query =
          queries.get(id) ??
          queries
            .set(id, {
              id,
              sql: spec.sql,
              tables: spec.owner?.tables ?? [],
              runs: 0,
              identicalRuns: 0,
              totalMs: 0,
              maxMs: 0,
              rows: 0,
              triggers: {},
            })
            .get(id)!;
        const previous = queryState.get(id);
        const rows = canonicalValue(snapshot.rows);
        const changed = query.tables.filter(
          (table) => (changedAt.get(table) ?? 0) > (previous?.seq ?? 0),
        );
        const triggers = query.triggers as Record<string, number>;
        for (const trigger of previous === undefined
          ? ['mount']
          : changed.length > 0
            ? changed
            : ['refresh'])
          triggers[trigger] = (triggers[trigger] ?? 0) + 1;
        if (previous?.rows === rows) query.identicalRuns += 1;
        queryState.set(id, { rows, seq });
        query.runs += 1;
        query.totalMs += ms;
        query.maxMs = Math.max(query.maxMs, ms);
        query.rows = snapshot.rows.length;
        return snapshot;
      };
      return wrap(client, {
        querySnapshot: (spec: QueryReadSpec) => {
          const startedAt = now();
          const seq = changeSeq;
          const snapshot = client.querySnapshot(spec);
          return snapshot instanceof Promise
            ? snapshot.then((value) => record(spec, startedAt, seq, value))
            : record(spec, startedAt, seq, snapshot);
        },
        mutate: (mutations: readonly MutationInput[]) => {
          writes.mutateCalls += 1;
          writes.operations += mutations.length;
          const at = now();
          if (mutations.length !== 1) burst = undefined;
          else if (burst !== undefined && at - burst.at <= burstWindowMs) {
            burst.at = at;
            burst.commits += 1;
            if (!burst.tables.includes(mutations[0]!.table))
              burst.tables.push(mutations[0]!.table);
            if (burst.commits === 2) writes.bursts.push(burst);
          } else burst = { commits: 1, tables: [mutations[0]!.table], at };
          return client.mutate(mutations);
        },
      } as Partial<typeof client>);
    },

    report: () => {
      const merged = new Map<string, Mutable<StatementProfile>>();
      for (const list of [
        [...statements.values()],
        ...[...remote.values()].map((entry) => entry.statements),
      ])
        for (const entry of list) {
          const into = merged.get(entry.sql);
          if (into === undefined) merged.set(entry.sql, { ...entry });
          else {
            into.runs += entry.runs;
            into.totalMs += entry.totalMs;
            into.maxMs = Math.max(into.maxMs, entry.maxMs);
            into.rows += entry.rows;
          }
        }
      return {
        queries: [...queries.values()].map((query) => ({
          ...query,
          triggers: { ...query.triggers },
        })),
        statements: [...merged.values()],
        rounds: [
          ...[...remote.values()].flatMap((entry) => entry.rounds),
          ...rounds,
        ].map((entry) => ({
          via: entry.via,
          requestBytes: entry.requestBytes,
          responseBytes: entry.responseBytes,
          ms: entry.ms,
        })),
        deltas: { ...deltas },
        units: {
          ...units,
          limit: options.unitLimit ?? 500,
          bootstraps: [...bootstraps.values()].map((unit) => ({
            unitId: unit.unitId,
            table: unit.table,
            bytes: unit.bytes + unit.segmentBytes,
            rows: unit.rows + unit.segmentRows,
            ms: unit.ms,
          })),
        },
        writes: {
          ...writes,
          bursts: writes.bursts.map((entry) => ({
            commits: entry.commits,
            tables: [...entry.tables],
          })),
        },
      };
    },

    reset: () => {
      clear();
      channel?.postMessage({ syncularProfileReset: true });
    },
  };
}

/**
 * Throws `client.profile_budget_exceeded` listing every budget the report
 * exceeds, with `budget`, `limit` and `measured` per entry in `details.exceeded`.
 */
export function assertBudgets(
  report: ProfileReport,
  budgets: ProfileBudgets,
): void {
  const measured: Record<keyof ProfileBudgets, number> = {
    maxActiveUnits: report.units.peak,
    maxRoundBytes: Math.max(
      0,
      ...report.rounds.map((entry) => entry.requestBytes + entry.responseBytes),
    ),
    maxRunsPerQuery: Math.max(0, ...report.queries.map((query) => query.runs)),
    maxIdenticalRuns: report.queries.reduce(
      (sum, query) => sum + query.identicalRuns,
      0,
    ),
    maxWriteBurst: Math.max(
      0,
      ...report.writes.bursts.map((entry) => entry.commits),
    ),
  };
  const exceeded = Object.entries(budgets)
    .filter(
      ([budget, limit]) => measured[budget as keyof ProfileBudgets] > limit,
    )
    .map(([budget, limit]) => ({
      budget,
      limit,
      measured: measured[budget as keyof ProfileBudgets],
    }));
  if (exceeded.length > 0)
    throw new ClientSyncError(
      'client.profile_budget_exceeded',
      'the profile report exceeds its budgets',
      false,
      { exceeded },
    );
}

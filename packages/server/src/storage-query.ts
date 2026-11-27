import type { ScopeMap, UnitScopes } from '@syncular/core';
import type { CompiledTable, IndexSchema } from './schema';
import { matchesEffective } from './scopes';
import type {
  AuthoritativeQueryRequest,
  AuthoritativeQueryResult,
  IndexRowScanQuery,
  LiveWindow,
  LiveWindowQuery,
  RowScanQuery,
  StorageTransaction,
  StoredChange,
  StoredCommit,
} from './storage';
import { StorageQueryError } from './storage-errors';

/**
 * One variable of a scan filter whose index entries a probe counts; `i` is
 * the row's `sub` in the probe result (see `scanProbeSql`).
 */
export interface ScanProbe {
  readonly i: number;
  readonly tbl: string;
  readonly var: string;
  readonly vals: readonly string[];
}

/**
 * The scope variable a `scanRows` call seeks the row-scope index with: the
 * one whose values have the fewest index entries, ties broken alphabetically.
 * `undefined` means the intersection is empty: a variable without values or
 * without entries, so the scan returns no persisted row. An empty or omitted
 * filter fails loudly instead of making an unsupported unscoped scan look
 * empty.
 *
 * A single-variable filter needs no probe. Otherwise `count` counts each
 * variable's entries in one statement, up to `cap`. The cap starts at
 * max(1,024, limit) and grows fourfold while the fewest count is shared by
 * several variables at the cap. A round runs only while every tied variable
 * has at least `cap` entries, so the probe ends at the first cap above the
 * smallest count `n`: at most max(4n, 1,024) entries per variable in the last
 * round, and the pick is the variable with the fewest entries whatever the
 * starting cap.
 *
 * `chosen` memoizes the pick per (partition, table, filter), at most 1,024
 * entries, so the page loop of a bootstrap probes once, and a scan and an
 * extent count of one filter started together share one probe. An empty
 * intersection and a failed probe are not memoized. A stale pick only costs
 * index reads: every scan and count still verifies all variables against
 * the stored scopes, so the choice never changes a result.
 */
export async function chooseScanVariable(
  partition: string,
  query: Pick<RowScanQuery, 'table' | 'scopeFilter' | 'limit'>,
  chosen: Map<string, Promise<string | undefined>>,
  count: (
    probes: readonly ScanProbe[],
    cap: number,
  ) => Promise<readonly { readonly sub: unknown; readonly n: unknown }[]>,
): Promise<string | undefined> {
  const scopeFilter = (
    query as typeof query & { readonly scopeFilter?: ScopeMap | null }
  ).scopeFilter;
  const variables =
    scopeFilter === undefined || scopeFilter === null
      ? []
      : Object.keys(scopeFilter).sort();
  if (
    scopeFilter === undefined ||
    scopeFilter === null ||
    variables[0] === undefined
  ) {
    throw new StorageQueryError('sync.storage.scan_requires_scope');
  }
  if (variables.some((variable) => scopeFilter[variable]?.length === 0)) {
    return undefined;
  }
  if (variables.length === 1) return variables[0];
  const key = JSON.stringify([
    partition,
    query.table,
    variables.map((variable) => [variable, [...scopeFilter[variable]!].sort()]),
  ]);
  const cached = chosen.get(key);
  if (cached !== undefined) return cached;
  const pick = (async () => {
    let tied = variables;
    for (let cap = Math.max(1_024, query.limit); ; cap *= 4) {
      const counts = tied.map(() => 0);
      const probes = tied.map((variable, i) => ({
        i,
        tbl: query.table,
        var: variable,
        vals: scopeFilter[variable]!,
      }));
      for (const row of await count(probes, cap)) {
        counts[Number(row.sub)] = Number(row.n);
      }
      const fewest = Math.min(...counts);
      if (fewest === 0) return undefined;
      tied = tied.filter((_, i) => counts[i] === fewest);
      if (fewest < cap || tied.length === 1) return tied[0];
    }
  })();
  if (chosen.size >= 1_024) chosen.delete(chosen.keys().next().value!);
  chosen.set(key, pick);
  const forget = () => {
    if (chosen.get(key) === pick) chosen.delete(key);
  };
  pick.then((variable) => variable ?? forget(), forget);
  return pick;
}

/** Validate and resolve one exact trusted-host relational index lookup. */
export function resolveIndexRowScan(
  table: CompiledTable,
  query: IndexRowScanQuery,
): IndexSchema {
  if (
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 1_000
  ) {
    throw new StorageQueryError('sync.storage.invalid_limit');
  }
  if (!table.materialize) {
    throw new StorageQueryError('sync.storage.index_not_materialized');
  }
  const index = table.indexes.find(
    (candidate) => candidate.name === query.index,
  );
  if (index === undefined) {
    throw new StorageQueryError('sync.storage.index_not_found');
  }
  if (
    !Array.isArray(query.values) ||
    query.values.length !== index.columns.length
  ) {
    throw new StorageQueryError('sync.storage.index_value_count_mismatch');
  }
  return index;
}

/**
 * §6.7/§6.8 transaction-bound registered query for every host hook that runs
 * inside a push transaction. A storage transaction without the capability
 * fails; the call never falls back to `ServerStorage.queryAuthoritative`,
 * which reads outside the transaction.
 */
export async function transactionQuery(
  tx: StorageTransaction,
  query: AuthoritativeQueryRequest,
): Promise<AuthoritativeQueryResult> {
  if (tx.queryAuthoritative === undefined) {
    throw new StorageQueryError('sync.storage.transaction_query_unsupported');
  }
  return tx.queryAuthoritative(query);
}

/**
 * One index range of the live scan: a unit key, its exclusive lower bound,
 * and the tables its units cover. The range seeks `var` = `value`; a
 * change counts for the key when its stored scopes carry every entry of
 * `scopes`, the scope map of the key's units. `i` is the key's position
 * in the list.
 */
export interface LiveKey {
  readonly i: number;
  readonly var: string;
  readonly value: string;
  readonly scopes: UnitScopes;
  readonly after: number;
  readonly tables: readonly string[];
}

/**
 * One row of a live-window candidate page: a candidate commit joined to its
 * metadata (absent when the commit vanished) and, per key, the count and
 * stored bytes (payload, row id, scopes) of its changes that key reads: a
 * covered table and the key's scope map in the stored scopes. A commit with no
 * such change comes back once without `key`. Rows are in (commitSeq, key)
 * order.
 */
export interface LiveCandidateRow {
  readonly commitSeq: number;
  readonly meta?: { readonly actorId: string; readonly createdAtMs: number };
  readonly key?: number;
  readonly bytes?: number;
  readonly changes?: number;
}

/**
 * The §4.5 live scan over a backend's two reads. `readCandidates` takes up
 * to `limit` candidate commits above every key range's bound and sizes them
 * in commit order, without payload, until their change count reaches
 * `budget.changes` or their byte size passes `budget.bytes`. It returns the
 * sized candidates with their per-key sizes, the one that reached the budget
 * last, so a page sizes the commits it delivers and one more. `readChanges`
 * loads the changes the keys read in the given candidate commits, in
 * (commitSeq, change index) order; it never visits a commit outside that
 * list, so the cost of a page follows its candidates and not the length of
 * the change log below them. A unit's key is the variable of its scope map
 * that `chooseScanVariable` picks over the change log: `probe` counts the
 * change-scope index entries of each variable's value, so the key seeks the
 * shortest range. The empty table name memoizes those picks apart from the
 * row scans; a stale pick only costs index reads. A unit whose value of some
 * variable no change carries reads nothing and takes no key. Units share a
 * key only when their scope maps are equal, so a key's sizes count exactly
 * the changes its units' scope map reaches. Each key becomes one index range
 * starting at the lowest bound of the units that share it. A change is kept when a unit covers its table, the pair's
 * effective scopes match it, and its commit lies above that unit's own
 * bound. Every candidate advances the scan, so a page of non-matching
 * candidates never repeats.
 *
 * The counts bound the delivered changes from above, because every change
 * a unit keeps is one its key reads: the scan loads pending candidates once
 * their counts could reach the rest of `limitChanges`, so a page loads
 * about the changes it delivers and never a candidate past the cut.
 *
 * The sizes bound the loaded bytes by `limitBytes` before any payload is
 * read: the section stops before the commit that would pass it, and a
 * commit that passes it alone ends the read as `oversized`, naming the
 * units of the keys that read the most of it, largest first, until the rest
 * fits (§4.6).
 */
export async function readLiveWindowPages(
  partition: string,
  query: LiveWindowQuery,
  chosen: Map<string, Promise<string | undefined>>,
  probe: (
    probes: readonly ScanProbe[],
    cap: number,
  ) => Promise<readonly { readonly sub: unknown; readonly n: unknown }[]>,
  readCandidates: (
    keys: readonly LiveKey[],
    limit: number,
    budget: { readonly changes: number; readonly bytes: number },
  ) => Promise<readonly LiveCandidateRow[]>,
  readChanges: (
    keys: readonly LiveKey[],
    commitSeqs: readonly number[],
  ) => Promise<
    readonly { readonly commitSeq: number; readonly change: StoredChange }[]
  >,
): Promise<LiveWindow> {
  const bounds = new Map<string, { key: LiveKey; tables: Set<string> }>();
  const unitKeys: (number | undefined)[] = [];
  // The units count each round together: every probe queued in one
  // microtask turn leaves in one `probe` call per cap. All units start
  // their first round at once, and the units a round leaves tied queue
  // their next round while its answers resume them.
  type Counted = readonly { readonly sub: unknown; readonly n: unknown }[];
  let queued: {
    readonly probes: readonly ScanProbe[];
    readonly cap: number;
    readonly resolve: (rows: Counted) => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  const batched = (probes: readonly ScanProbe[], cap: number) =>
    new Promise<Counted>((resolve, reject) => {
      if (queued.length === 0) {
        queueMicrotask(() => {
          const batch = queued;
          queued = [];
          for (const round of new Set(batch.map((entry) => entry.cap))) {
            const entries = batch.filter((entry) => entry.cap === round);
            const offsets = entries.map((_, e) =>
              entries
                .slice(0, e)
                .reduce((sum, entry) => sum + entry.probes.length, 0),
            );
            probe(
              entries.flatMap((entry, e) =>
                entry.probes.map((p) => ({ ...p, i: offsets[e]! + p.i })),
              ),
              round,
            ).then(
              (rows) =>
                entries.forEach((entry, e) =>
                  entry.resolve(
                    rows.flatMap((row) => {
                      const sub = Number(row.sub) - offsets[e]!;
                      return sub >= 0 && sub < entry.probes.length
                        ? [{ sub, n: row.n }]
                        : [];
                    }),
                  ),
                ),
              (error: unknown) => {
                for (const entry of entries) entry.reject(error);
              },
            );
          }
        });
      }
      queued.push({ probes, cap, resolve, reject });
    });
  const variables = await Promise.all(
    query.units.map((unit) =>
      unit.tables.size === 0
        ? undefined
        : chooseScanVariable(
            partition,
            {
              table: '',
              scopeFilter: Object.fromEntries(
                Object.entries(unit.scopes).map(([name, value]) => [
                  name,
                  [value],
                ]),
              ),
              limit: 0,
            },
            chosen,
            batched,
          ),
    ),
  );
  for (const [index, unit] of query.units.entries()) {
    const variable = variables[index];
    if (variable === undefined) {
      unitKeys.push(undefined);
      continue;
    }
    const scopes = Object.fromEntries(
      Object.entries(unit.scopes).sort(([x], [y]) => (x < y ? -1 : 1)),
    );
    const id = JSON.stringify(scopes);
    const prior = bounds.get(id);
    const tables = new Set([...(prior?.tables ?? []), ...unit.tables.keys()]);
    const i = prior?.key.i ?? bounds.size;
    bounds.set(id, {
      key: {
        i,
        var: variable,
        value: scopes[variable]!,
        scopes,
        after: Math.min(prior?.key.after ?? unit.afterSeq, unit.afterSeq),
        tables: [...tables],
      },
      tables,
    });
    unitKeys.push(i);
  }
  const keys = [...bounds.values()].map(({ key }) => key);
  const commits: StoredCommit[] = [];
  const limit = Math.max(64, query.limitChanges);
  let delivered = 0;
  let loaded = 0;
  // Upper bound of the changes the pending candidates deliver.
  let bound = 0;
  let scanned = -1;
  // Candidates sized but not loaded yet: (scanned, pending.at(-1)].
  let pending: { commitSeq: number; meta?: LiveCandidateRow['meta'] }[] = [];
  const scanKeys = () =>
    keys.map((key) => ({ ...key, after: Math.max(key.after, scanned) }));
  // Loads the pending candidates; returns T when `limitChanges` cut there.
  const load = async (): Promise<number | undefined> => {
    const last = pending.at(-1);
    if (last === undefined) return undefined;
    const metas = new Map(pending.map((c) => [c.commitSeq, c.meta]));
    const rows = await readChanges(
      scanKeys(),
      pending.map((c) => c.commitSeq),
    );
    pending = [];
    bound = 0;
    scanned = last.commitSeq;
    for (let i = 0; i < rows.length;) {
      const seq = rows[i]!.commitSeq;
      const changes: StoredChange[] = [];
      for (; rows[i]?.commitSeq === seq; i++) {
        const change = rows[i]!.change;
        if (
          query.units.some((unit) => {
            const effective: ScopeMap | undefined = unit.tables.get(
              change.table,
            );
            return (
              seq > unit.afterSeq &&
              effective !== undefined &&
              matchesEffective(change.scopes, effective)
            );
          })
        ) {
          changes.push(change);
        }
      }
      const meta = metas.get(seq);
      if (meta === undefined || changes.length === 0) continue;
      commits.push({ commitSeq: seq, ...meta, changes });
      delivered += changes.length;
      if (delivered >= query.limitChanges) return seq;
    }
    return undefined;
  };
  while (keys.length > 0) {
    const rows = await readCandidates(scanKeys(), limit, {
      changes: query.limitChanges - delivered,
      bytes: query.limitBytes - loaded,
    });
    let candidates = 0;
    // The change budget ended the read, possibly before `limit` candidates.
    let reached = false;
    for (let i = 0; i < rows.length;) {
      const head = rows[i]!;
      candidates += 1;
      let bytes = 0;
      let changes = 0;
      const sizes: [key: number, bytes: number][] = [];
      for (; rows[i]?.commitSeq === head.commitSeq; i++) {
        const row = rows[i]!;
        if (row.key === undefined) continue;
        bytes += row.bytes ?? 0;
        changes += row.changes ?? 0;
        sizes.push([row.key, row.bytes ?? 0]);
      }
      if (bytes > query.limitBytes) {
        // The keys that read the most of it leave until the rest fits.
        const reached = new Set<number>();
        let rest = bytes;
        for (const [key, size] of sizes.sort((x, y) => y[1] - x[1])) {
          if (rest <= query.limitBytes) break;
          reached.add(key);
          rest -= size;
        }
        return {
          commits: [],
          throughSeq: query.throughSeq,
          oversized: {
            commitSeq: head.commitSeq,
            units: query.units.flatMap((unit, index) => {
              const key = unitKeys[index];
              return key !== undefined &&
                reached.has(key) &&
                head.commitSeq > unit.afterSeq
                ? [index]
                : [];
            }),
          },
        };
      }
      if (loaded + bytes > query.limitBytes) {
        const cut = await load();
        return { commits, throughSeq: cut ?? scanned };
      }
      loaded += bytes;
      bound += changes;
      pending.push({ commitSeq: head.commitSeq, meta: head.meta });
      if (delivered + bound >= query.limitChanges) {
        reached = true;
        const cut = await load();
        if (cut !== undefined) return { commits, throughSeq: cut };
      }
    }
    const cut = await load();
    if (cut !== undefined) return { commits, throughSeq: cut };
    if (candidates < limit && !reached) break;
  }
  return { commits, throughSeq: query.throughSeq };
}

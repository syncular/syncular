import type { ScopeMap } from '@syncular/core';
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
 * max(64, limit) and grows fourfold, to at most 65,536, while the fewest
 * count is shared by several variables at the cap.
 *
 * `chosen` memoizes the pick per (partition, table, filter), at most 1,024
 * entries, so the page loop of a bootstrap probes once. A stale pick only
 * costs index reads: every scan still verifies all variables against the
 * stored scopes, so the choice never changes a result.
 */
export async function chooseScanVariable(
  partition: string,
  query: RowScanQuery,
  chosen: Map<string, string>,
  count: (
    probes: readonly ScanProbe[],
    cap: number,
  ) => Promise<readonly { readonly sub: unknown; readonly n: unknown }[]>,
): Promise<string | undefined> {
  const scopeFilter = (
    query as RowScanQuery & { readonly scopeFilter?: ScopeMap | null }
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
  let tied = variables;
  for (let cap = Math.max(64, query.limit); ; cap = Math.min(cap * 4, 65_536)) {
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
    if (fewest < cap || tied.length === 1 || cap >= 65_536) break;
  }
  if (chosen.size >= 1_024) chosen.delete(chosen.keys().next().value!);
  chosen.set(key, tied[0]!);
  return tied[0];
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
 * and the tables its units cover. `i` is the key's position in the list.
 */
export interface LiveKey {
  readonly i: number;
  readonly var: string;
  readonly value: string;
  readonly after: number;
  readonly tables: readonly string[];
}

/**
 * One row of a live-window candidate page: a candidate commit joined to its
 * metadata (absent when the commit vanished) and, per key, the stored bytes
 * (payload, row id, scopes) of its changes that key reads: a covered table
 * and the key's value in the stored scopes. A commit with no such change
 * comes back once without `key`. Rows are in (commitSeq, key) order.
 */
export interface LiveCandidateRow {
  readonly commitSeq: number;
  readonly meta?: { readonly actorId: string; readonly createdAtMs: number };
  readonly key?: number;
  readonly bytes?: number;
}

/**
 * The §4.5 live scan over a backend's two reads. `readCandidates` returns
 * up to `limit` candidate commits above every key range's bound with their
 * per-key byte sizes, and no payload. `readChanges` loads the changes the
 * keys read in the given candidate commits, in (commitSeq, change index)
 * order; it never visits a commit outside that list, so the cost of a page
 * follows its candidates and not the length of the change log below them. Each distinct unit key (the first variable, keys sorted)
 * becomes one index range starting at the lowest bound of the units that
 * share it. A change is kept when a unit covers its table, the pair's
 * effective scopes match it, and its commit lies above that unit's own
 * bound. Every candidate advances the scan, so a page of non-matching
 * candidates never repeats.
 *
 * The sizes bound the loaded bytes by `limitBytes` before any payload is
 * read: the section stops before the commit that would pass it, and a
 * commit that passes it alone ends the read as `oversized`, naming the
 * units of the keys that read the most of it, largest first, until the rest
 * fits (§4.6).
 */
export async function readLiveWindowPages(
  query: LiveWindowQuery,
  readCandidates: (
    keys: readonly LiveKey[],
    limit: number,
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
  for (const unit of query.units) {
    if (unit.tables.size === 0) {
      unitKeys.push(undefined);
      continue;
    }
    const variable = Object.keys(unit.scopes).sort()[0];
    const value = variable === undefined ? undefined : unit.scopes[variable];
    if (variable === undefined || value === undefined) {
      throw new StorageQueryError('sync.storage.scan_requires_scope');
    }
    const id = JSON.stringify([variable, value]);
    const prior = bounds.get(id);
    const tables = new Set([...(prior?.tables ?? []), ...unit.tables.keys()]);
    const i = prior?.key.i ?? bounds.size;
    bounds.set(id, {
      key: {
        i,
        var: variable,
        value,
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
    const rows = await readCandidates(scanKeys(), limit);
    let candidates = 0;
    for (let i = 0; i < rows.length;) {
      const head = rows[i]!;
      candidates += 1;
      let bytes = 0;
      const sizes: [key: number, bytes: number][] = [];
      for (; rows[i]?.commitSeq === head.commitSeq; i++) {
        const row = rows[i]!;
        if (row.key === undefined) continue;
        bytes += row.bytes ?? 0;
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
      pending.push({ commitSeq: head.commitSeq, meta: head.meta });
    }
    const cut = await load();
    if (cut !== undefined) return { commits, throughSeq: cut };
    if (candidates < limit) break;
  }
  return { commits, throughSeq: query.throughSeq };
}

import type { SyncOperation } from '@syncular/core';
import type { Insertable, Updateable } from 'kysely';

type AnyDb = Record<string, Record<string, unknown>>;

type ReservedKeys = '$commit' | '$table';
type KnownKeys<T> = string extends keyof T ? never : keyof T & string;
type KnownTableKey<DB> = Exclude<KnownKeys<DB>, ReservedKeys>;

type InsertPayload<Row> =
  Insertable<Row> extends { id?: infer I }
    ? Omit<Insertable<Row>, 'id'> & { id?: I }
    : Insertable<Row>;

type UpdatePayload<Row> = Omit<Updateable<Row>, 'id'> & { id?: never };

type BaseVersionOptions = { baseVersion?: number | null };

export interface MutationReceipt {
  commitId: string;
  clientCommitId: string;
}

export interface SyncularCommitMeta {
  operations: SyncOperation[];
  localMutations: Array<{
    table: string;
    rowId: string;
    op: 'upsert' | 'delete';
  }>;
}

export type TableMutations<DB, T extends keyof DB & string> = {
  insert: (
    values: InsertPayload<DB[T]>
  ) => Promise<MutationReceipt & { id: string }>;
  insertMany: (
    rows: Array<InsertPayload<DB[T]>>
  ) => Promise<MutationReceipt & { ids: string[] }>;
  update: (
    id: string,
    patch: UpdatePayload<DB[T]>,
    options?: BaseVersionOptions
  ) => Promise<MutationReceipt>;
  delete: (
    id: string,
    options?: BaseVersionOptions
  ) => Promise<MutationReceipt>;
  upsert: (
    id: string,
    patch: UpdatePayload<DB[T]>,
    options?: BaseVersionOptions
  ) => Promise<MutationReceipt>;
};

export type TableMutationsTx<DB, T extends keyof DB & string> = {
  insert: (values: InsertPayload<DB[T]>) => Promise<string>;
  insertMany: (rows: Array<InsertPayload<DB[T]>>) => Promise<string[]>;
  update: (
    id: string,
    patch: UpdatePayload<DB[T]>,
    options?: BaseVersionOptions
  ) => Promise<void>;
  delete: (id: string, options?: BaseVersionOptions) => Promise<void>;
  upsert: (
    id: string,
    patch: UpdatePayload<DB[T]>,
    options?: BaseVersionOptions
  ) => Promise<void>;
};

export type MutationsTx<DB> = {
  [T in KnownTableKey<DB>]: TableMutationsTx<DB, T>;
} & {
  [table: string]: TableMutationsTx<AnyDb, string>;
};

export type MutationsCommitFn<DB, Meta = unknown, Options = unknown> = <R>(
  fn: (tx: MutationsTx<DB>) => Promise<R> | R,
  options?: Options
) => Promise<{ result: R; receipt: MutationReceipt; meta: Meta }>;

export type MutationsApi<DB, CommitOptions = unknown> = {
  $commit: <R>(
    fn: (tx: MutationsTx<DB>) => Promise<R> | R,
    options?: CommitOptions
  ) => Promise<{ result: R; commit: MutationReceipt }>;
  $table: {
    <T extends KnownTableKey<DB>>(table: T): TableMutations<DB, T>;
    (table: string): TableMutations<AnyDb, string>;
  };
} & {
  [T in KnownTableKey<DB>]: TableMutations<DB, T>;
};

export function createMutationsApi<DB, Meta = unknown, CommitOptions = unknown>(
  commit: MutationsCommitFn<DB, Meta, CommitOptions>
): MutationsApi<DB, CommitOptions> {
  const rootTableCache = new Map<string, TableMutations<AnyDb, string>>();

  const apiBase = {
    $commit: async <R>(
      fn: (tx: MutationsTx<DB>) => Promise<R> | R,
      options?: CommitOptions
    ) => {
      const { result, receipt } = await commit(fn, options);
      return { result, commit: receipt };
    },
    $table: (table: string) => {
      const cached = rootTableCache.get(table);
      if (cached) return cached;

      const tableApi: TableMutations<AnyDb, string> = {
        async insert(values) {
          const { result, receipt } = await commit(
            async (tx) => await tx[table]!.insert(values)
          );
          return { ...receipt, id: result };
        },
        async insertMany(rows) {
          const { result, receipt } = await commit(
            async (tx) => await tx[table]!.insertMany(rows)
          );
          return { ...receipt, ids: result };
        },
        async update(id, patch, opts) {
          const { receipt } = await commit(async (tx) => {
            await tx[table]!.update(id, patch, opts);
            return null;
          });
          return receipt;
        },
        async delete(id, opts) {
          const { receipt } = await commit(async (tx) => {
            await tx[table]!.delete(id, opts);
            return null;
          });
          return receipt;
        },
        async upsert(id, patch, opts) {
          const { receipt } = await commit(async (tx) => {
            await tx[table]!.upsert(id, patch, opts);
            return null;
          });
          return receipt;
        },
      };

      rootTableCache.set(table, tableApi);
      return tableApi;
    },
  };

  return new Proxy(apiBase, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop !== 'string') return undefined;
      if (hasOwn(target, prop)) {
        return (target as Record<string, unknown>)[prop];
      }
      return target.$table(prop);
    },
  }) as MutationsApi<DB, CommitOptions>;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.hasOwn(obj, key);
}

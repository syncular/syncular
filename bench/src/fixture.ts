/**
 * Bench fixture: one realistic ~6-column table and a deterministic row
 * generator (fixed seed — timings vary, data never does).
 */
import type { RowColumn, RowValue } from '@syncular/core';
import type { ServerSchema } from '@syncular/server';
import { createCipheriv, createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';

/** Generate reproducible, incompressible file input outside client timers. */
export async function writeBlobFixture(
  path: string,
  byteLength: number,
  seed = 0,
) {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > 500_000_000 ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffff_ffff
  )
    throw new Error(
      'Blob fixture requires 1..500000000 bytes and a uint32 seed',
    );
  const algorithm = 'aes-256-ctr-zero-v1';
  const key = createHash('sha256')
    .update(`syncular-blob-fixture-v1:${seed}`)
    .digest();
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16));
  const digest = createHash('sha256');
  const zeros = Buffer.alloc(Math.min(byteLength, 65_536));
  const file = await open(path, 'wx');
  let complete = false;
  try {
    for (let offset = 0; offset < byteLength; offset += zeros.length) {
      const bytes = cipher.update(
        zeros.subarray(0, Math.min(zeros.length, byteLength - offset)),
      );
      digest.update(bytes);
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await file.write(bytes.subarray(written));
        if (bytesWritten === 0)
          throw new Error('Blob fixture write made no progress');
        written += bytesWritten;
      }
    }
    if (cipher.final().length !== 0)
      throw new Error('Blob fixture cipher returned an unexpected tail');
    await file.close();
    complete = true;
    return { algorithm, seed, byteLength, sha256: digest.digest('hex') };
  } finally {
    if (!complete) {
      try {
        await file.close();
      } finally {
        await rm(path, { force: true });
      }
    }
  }
}

export const PARTITION = 'bench';
export const ACTOR_ID = 'bench-actor';
export const PROJECT_ID = 'p-1';
export const RETAINED_PROJECT_ID = 'p-retained';
export const TABLE = 'tasks';

export const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'priority', type: 'integer', nullable: false },
  { name: 'updated_at_ms', type: 'integer', nullable: false },
];

export const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: TABLE,
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

/** Blob lifecycle fixture; ordinary task workloads retain SCHEMA unchanged. */
export const BLOB_SCHEMA: ServerSchema = {
  ...SCHEMA,
  tables: [
    ...SCHEMA.tables,
    {
      name: 'attachments',
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'body', type: 'blob_ref', nullable: false },
      ],
    },
  ],
};

/** mulberry32 — the deterministic seed for row data. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'triage',
  'review',
  'deploy',
  'refactor',
  'document',
  'benchmark',
  'migrate',
  'polish',
  'inspect',
  'archive',
];

export function rowId(index: number): string {
  return `row-${String(index).padStart(7, '0')}`;
}

/** Shared replay edits for the TS core and native direct/command lanes. */
export function queuedValues(index: number, repeated: boolean) {
  return {
    id: rowId(repeated ? index % 32 : index),
    project_id: PROJECT_ID,
    title: `queued-${index}`,
    done: false,
    priority: index % 5,
    updated_at_ms: 1_750_000_000_000 + index,
  };
}

/** Normalize driver row ordering and boolean representation before comparison. */
export function canonicalTaskRows(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Expected task rows');
  return value
    .map((row: unknown) => {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('id' in row) ||
        typeof row.id !== 'string' ||
        !('project_id' in row) ||
        typeof row.project_id !== 'string' ||
        !('title' in row) ||
        typeof row.title !== 'string' ||
        !('done' in row) ||
        ![0, 1, false, true].includes(row.done as number | boolean) ||
        !('priority' in row) ||
        typeof row.priority !== 'number' ||
        !Number.isSafeInteger(row.priority) ||
        !('updated_at_ms' in row) ||
        typeof row.updated_at_ms !== 'number' ||
        !Number.isSafeInteger(row.updated_at_ms)
      ) {
        throw new Error('Invalid task row from benchmark client');
      }
      return {
        id: row.id,
        project_id: row.project_id,
        title: row.title,
        done: Number(row.done),
        priority: row.priority,
        updated_at_ms: row.updated_at_ms,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Deterministic row values in row-codec column order. */
export function rowValues(index: number, rand: () => number): RowValue[] {
  const w = (n: number) =>
    WORDS[Math.floor(rand() * WORDS.length * n) % WORDS.length];
  return [
    rowId(index),
    PROJECT_ID,
    `${w(1)} ${w(2)} #${index}`,
    rand() < 0.3,
    Math.floor(rand() * 5),
    1_750_000_000_000 + index,
  ];
}

/** Expected observation state comes from the seed and edits, independently of clients. */
export function observationFixture(rows: number, count: number) {
  const random = seededRandom(0xb6b6b6);
  const initial = canonicalTaskRows(
    Array.from({ length: rows }, (_, index) => {
      const values = rowValues(index, random);
      return Object.fromEntries(
        COLUMNS.map((column, offset) => [column.name, values[offset]]),
      );
    }),
  );
  const commits = Array.from({ length: count }, (_, index) => ({
    mutations: [
      {
        table: TABLE,
        op: 'upsert' as const,
        values: {
          ...queuedValues(index, false),
          title: `observation-${index}`,
        },
      },
    ],
  }));
  const expected = new Map(initial.map((row) => [row.id, row]));
  for (const commit of commits) {
    for (const mutation of commit.mutations)
      expected.set(mutation.values.id, { ...mutation.values, done: 0 });
  }
  return {
    initial,
    commits,
    expected: canonicalTaskRows([...expected.values()]),
  };
}

/** Shared oracle for both observation runners and malformed-result contracts. */
export function assertObservationRows(
  actual: unknown,
  expected: ReturnType<typeof canonicalTaskRows>,
): void {
  if (JSON.stringify(canonicalTaskRows(actual)) !== JSON.stringify(expected))
    throw new Error('Observation rows differ from the deterministic fixture');
}

/** The durable journal is newest-first; every fixture commit has one operation. */
export function assertObservationOutcomes(
  actual: unknown,
  ids: readonly string[],
): void {
  if (!Array.isArray(actual) || actual.length !== ids.length)
    throw new Error('Observation outcome count differs from fixture');
  for (let index = 0; index < actual.length; index++) {
    const outcome: unknown = actual[index];
    if (
      typeof outcome !== 'object' ||
      outcome === null ||
      !('clientCommitId' in outcome) ||
      outcome.clientCommitId !== ids[ids.length - index - 1] ||
      !('status' in outcome) ||
      outcome.status !== 'applied' ||
      !('results' in outcome) ||
      !Array.isArray(outcome.results) ||
      outcome.results.length !== 1 ||
      outcome.results[0]?.status !== 'applied' ||
      outcome.results[0]?.opIndex !== 0
    )
      throw new Error('Observation durable outcomes differ from fixture');
  }
}

export const SQLITE_CONFIGURATION_SQL =
  'SELECT sqlite_version() AS version, (SELECT journal_mode FROM pragma_journal_mode) AS journalMode, (SELECT synchronous FROM pragma_synchronous) AS synchronous';

export function sqliteConfiguration(value: unknown, persistent: boolean) {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('SQLite configuration missing');
  const row: unknown = value[0];
  if (
    typeof row !== 'object' ||
    row === null ||
    !('version' in row) ||
    typeof row.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(row.version) ||
    !('journalMode' in row) ||
    typeof row.journalMode !== 'string' ||
    row.journalMode !== (persistent ? 'wal' : 'memory') ||
    !('synchronous' in row) ||
    row.synchronous !== 2
  )
    throw new Error('SQLite configuration differs from workload');
  return {
    version: row.version,
    journalMode: row.journalMode,
    synchronous: row.synchronous,
  };
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

export function fmtMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

export function fmtKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

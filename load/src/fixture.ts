/**
 * Load fixture — the same realistic table shape and deterministic row
 * generator the micro-bench uses (mirrored, not imported: bench is a
 * sibling workspace member, and copying the ~6-column shape keeps the two
 * suites independent while sharing seeding semantics — "reuse/mirror bench
 * fixture shapes", per the load brief).
 *
 * Timings vary; data never does (fixed seed). The load table is
 * partitioned by `project_id` scope: each virtual client owns one project,
 * so N clients contend on distinct scope keys the way real tenants do,
 * while a shared "storm" project holds the big bootstrap dataset.
 */
import type { RowColumn, RowValue } from '@syncular/core';
import type { ServerSchema } from '@syncular/server';

export const PARTITION = 'load';
export const ACTOR_ID = 'load-actor';
export const TABLE = 'tasks';

/** The seeded project every bootstrap-storm client reads from. */
export const STORM_PROJECT = 'storm';

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

/** mulberry32 — the deterministic seed for row data (matches bench). */
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

/** Deterministic row values for the storm dataset, in column order. */
export function rowValues(
  index: number,
  projectId: string,
  rand: () => number,
): RowValue[] {
  const w = (n: number) =>
    WORDS[Math.floor(rand() * WORDS.length * n) % WORDS.length];
  return [
    rowId(index),
    projectId,
    `${w(1)} ${w(2)} #${index}`,
    rand() < 0.3,
    Math.floor(rand() * 5),
    1_750_000_000_000 + index,
  ];
}

/** A per-client project id — distinct scope key per virtual user. */
export function clientProject(vu: number): string {
  return `vu-${String(vu).padStart(5, '0')}`;
}

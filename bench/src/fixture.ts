/**
 * Bench fixture: one realistic ~6-column table and a deterministic row
 * generator (fixed seed — timings vary, data never does).
 */
import type { RowColumn, RowValue } from '@syncular/core';
import type { ServerSchema } from '@syncular/server';

export const PARTITION = 'bench';
export const ACTOR_ID = 'bench-actor';
export const PROJECT_ID = 'p-1';
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

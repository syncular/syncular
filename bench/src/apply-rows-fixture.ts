/**
 * Rows-segment apply lane shared by the Bun and browser halves: a fresh
 * bootstrap of `rows` rows into a 12-column table with two secondary indexes,
 * applied in 1,000-row blocks as the server chunks them, then the same rows
 * again one version higher (every row lands as an update). With `retained`,
 * the table holds ten failed commits' retained rows (§7.4) whose intents
 * collide on the unique index, so every block maintains retained bases and
 * unique conflicts.
 */
import type { RowsSegment, SegmentRow } from '@syncular/core';
import { applyRowsSegment } from '../../packages/web-client/src/apply';
import type { ClientDatabase } from '../../packages/web-client/src/database';
import {
  compileClientSchema,
  ensureLocalSchema,
} from '../../packages/web-client/src/schema';

const schema = compileClientSchema({
  version: 1,
  tables: [
    {
      name: 'items',
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'code', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: true },
        { name: 'kind', type: 'string', nullable: false },
        { name: 'rank', type: 'integer', nullable: false },
        { name: 'price', type: 'float', nullable: true },
        { name: 'active', type: 'boolean', nullable: false },
        { name: 'meta', type: 'json', nullable: true },
        { name: 'created_at', type: 'integer', nullable: false },
        { name: 'updated_at', type: 'integer', nullable: false },
      ],
      indexes: [
        { name: 'items_code', columns: ['project_id', 'code'], unique: true },
        { name: 'items_kind_rank', columns: ['kind', 'rank'], unique: false },
      ],
    },
  ],
});
const table = schema.tables.get('items')!;

function segment(rows: number, version: number): RowsSegment {
  const blocks: SegmentRow[][] = [];
  for (let start = 0; start < rows; start += 1000) {
    const block: SegmentRow[] = [];
    for (let i = start; i < Math.min(rows, start + 1000); i++)
      block.push({
        serverVersion: version,
        values: [
          `item-${String(i).padStart(6, '0')}`,
          'p1',
          `C${i}`,
          `Item ${i} title`,
          `Body text for item ${i}, version ${version}`,
          `kind-${i % 17}`,
          i % 997,
          i / 7,
          i % 2 === 0,
          JSON.stringify({ i, tags: ['a', 'b'] }),
          1_700_000_000_000 + i,
          1_700_000_000_000 + i + version,
        ],
      });
    blocks.push(block);
  }
  return { table: 'items', schemaVersion: 1, columns: table.columns, blocks };
}

export interface ApplyRowsResult {
  rows: number;
  bootstrapMs: number;
  bootstrapRowsPerSecond: number;
  updateMs: number;
  updateRowsPerSecond: number;
}

export async function runApplyRows(
  db: ClientDatabase,
  rows: number,
  retained: boolean,
): Promise<ApplyRowsResult> {
  ensureLocalSchema(db, schema);
  if (retained)
    for (let k = 0; k < 10; k++)
      db.exec(
        `INSERT INTO _syncular_failed_rows(commit_id,idx,tbl,id,at,op,intent,base,version)VALUES(?,0,'items',?,0,'{}',?,NULL,NULL)`,
        [
          `failed-${k}`,
          `local-${k}`,
          JSON.stringify({
            id: `local-${k}`,
            project_id: 'p1',
            code: `C${k * 1000 + 5}`,
          }),
        ],
      );
  const options = {
    effective: { project_id: ['p1'] },
    owners: () => [{ project_id: ['p1'] }],
  };
  const timed = async (version: number, clearFirst: boolean) => {
    const input = segment(rows, version);
    const started = performance.now();
    const applied = await applyRowsSegment(db, schema, table, input, {
      ...options,
      clearFirst,
    });
    const ms = performance.now() - started;
    if (applied !== rows) throw new Error(`applied ${applied} of ${rows}`);
    return ms;
  };
  const bootstrapMs = await timed(1, true);
  const updateMs = await timed(2, false);
  const count = Number(db.query('SELECT count(*) AS n FROM items')[0]!.n);
  if (count !== rows) throw new Error(`stored ${count} of ${rows}`);
  return {
    rows,
    bootstrapMs: Math.round(bootstrapMs),
    bootstrapRowsPerSecond: Math.round((rows / bootstrapMs) * 1000),
    updateMs: Math.round(updateMs),
    updateRowsPerSecond: Math.round((rows / updateMs) * 1000),
  };
}

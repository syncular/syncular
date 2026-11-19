/**
 * Rows-segment apply lane shared by the Bun and browser halves: a fresh
 * bootstrap of `rows` rows into a 12-column table with two secondary indexes,
 * applied in 1,000-row blocks as the server chunks them, then the same rows
 * again one version higher (every row lands as an update). With `retained`,
 * the table holds ten failed commits' retained rows (§7.4) whose intents
 * collide on the unique index, so every block maintains retained bases and
 * unique conflicts.
 */
import {
  echoDigest,
  encodeMessage,
  encodeRowsSegment,
  encryptValue,
  PROTOCOL_WIRE_VERSION,
  type RowsSegment,
  type RowValue,
  type SegmentRow,
} from '../../packages/core/src/index';
import { computeBlobId } from '../../packages/web-client/src/blob';
import { SyncClient } from '../../packages/web-client/src/client';
import { applyRowsSegment } from '../../packages/web-client/src/apply';
import type { ClientDatabase } from '../../packages/web-client/src/database';
import {
  type ClientSchema,
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

/** A table of `width` columns (string, integer, float, boolean, json in turn)
 * with `indexes` two-column secondary indexes, scoped by `project_id`. */
function wideSchema(
  width: number,
  indexes: number,
  encrypted: number,
): ClientSchema {
  const types = ['string', 'integer', 'float', 'boolean', 'json'] as const;
  const columns = [
    { name: 'id', type: 'string' as const, nullable: false },
    { name: 'project_id', type: 'string' as const, nullable: false },
    ...Array.from({ length: width - 2 }, (_, i) =>
      i < encrypted
        ? {
            name: `c${i}`,
            type: 'bytes' as const,
            declaredType: 'string' as const,
            encrypted: true,
            nullable: true,
          }
        : {
            name: `c${i}`,
            type: types[i % types.length]!,
            nullable: i % 3 === 0,
          },
    ),
  ];
  return {
    version: 1,
    tables: [
      {
        name: 'wide',
        primaryKey: 'id',
        scopes: ['project:{project_id}'],
        columns,
        indexes: Array.from({ length: indexes }, (_, i) => ({
          name: `wide_i${i}`,
          columns: ['project_id', `c${i + encrypted}`],
          unique: false,
        })),
      },
    ],
  };
}

function wideValue(type: string, i: number, column: number): RowValue {
  if (type === 'string') return `value ${i} of column ${column}`;
  if (type === 'integer') return i * 31 + column;
  if (type === 'float') return i / (column + 1);
  if (type === 'boolean') return (i + column) % 2 === 0;
  return JSON.stringify({ i, column });
}

export interface ClientApplyResult {
  columns: number;
  indexes: number;
  rows: number;
  segments: number;
  encrypted: number;
  key: boolean;
  syncMs: number;
  rowsPerSecond: number;
}

/**
 * A fresh replica bootstraps `rows` rows of a `width`-column table through a
 * real `SyncClient`: one response with `segments` rows-segment references of
 * 1,000-row blocks, the shape a server bootstrap sends. Segments are encoded
 * before the clock; download is a lookup. The first `encrypted` columns carry
 * §5.11 envelopes; without `key` every row lands sealed.
 */
export async function runClientApply(
  database: ClientDatabase,
  width: number,
  indexes: number,
  rows: number,
  segments: number,
  encrypted = 0,
  key = false,
  onClient?: (client: SyncClient) => void,
): Promise<ClientApplyResult> {
  const clientSchema = wideSchema(width, indexes, encrypted);
  const keyBytes = new Uint8Array(32).fill(7);
  const compiled = compileClientSchema(clientSchema).tables.get('wide')!;
  const scope = { project_id: ['p1'] };
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(scope)),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const perSegment = Math.ceil(rows / segments);
  const payloads = new Map<string, { bytes: Uint8Array; rows: number }>();
  for (let s = 0; s < segments; s++) {
    const blocks: SegmentRow[][] = [];
    const end = Math.min(rows, (s + 1) * perSegment);
    for (let start = s * perSegment; start < end; start += 1000) {
      const block: SegmentRow[] = [];
      for (let i = start; i < Math.min(end, start + 1000); i++)
        block.push({
          serverVersion: 1,
          values: await Promise.all(
            compiled.columns.map((column, c) =>
              c === 0
                ? `row-${String(i).padStart(6, '0')}`
                : c === 1
                  ? 'p1'
                  : column.encrypted
                    ? encryptValue('string', `secret ${i}`, 'k1', keyBytes)
                    : wideValue(column.type, i, c),
            ),
          ),
        });
      blocks.push(block);
    }
    const bytes = encodeRowsSegment({
      table: 'wide',
      schemaVersion: 1,
      columns: compiled.columns,
      blocks,
    });
    payloads.set(await computeBlobId(bytes), {
      bytes,
      rows: end - s * perSegment,
    });
  }
  let subId = '';
  let delivered = false;
  const client = new SyncClient({
    database,
    schema: clientSchema,
    ...(encrypted > 0
      ? {
          encryption: {
            keyProvider: (keyId: string) =>
              key && keyId === 'k1' ? keyBytes : undefined,
            missingKey: 'seal' as const,
          },
        }
      : {}),
    segments: async (request) => payloads.get(request.segmentId)!.bytes,
    transport: async () => {
      const bootstrap = !delivered;
      delivered = true;
      return encodeMessage({
        wireVersion: PROTOCOL_WIRE_VERSION,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'benchmark', resetRequired: false },
          ...(bootstrap
            ? [
                {
                  type: 'SUB_START' as const,
                  id: subId,
                  status: 'active' as const,
                  reasonCode: '',
                  bootstrap: true,
                  fenced: [],
                },
                ...[...payloads].map(([segmentId, payload]) => ({
                  type: 'SEGMENT_REF' as const,
                  segmentId,
                  mediaType: 'rows' as const,
                  table: 'wide',
                  byteLength: payload.bytes.byteLength,
                  rowCount: payload.rows,
                  asOfCommitSeq: 1,
                  scopeDigest: digest,
                })),
                { type: 'SUB_END' as const, nextCursor: 1 },
              ]
            : []),
          { type: 'LIVE_START', status: 'active', reasonCode: '' },
          {
            type: 'LIVE_END',
            throughSeq: 1,
            echoDigest: echoDigest([
              { id: subId, status: 'active', fenced: [] },
            ]),
          },
        ],
      });
    },
  });
  try {
    await client.start();
    database.exec(
      "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES ('logEpoch','benchmark')",
    );
    await client.setWindow({ variable: 'project_id' }, ['p1']);
    subId = client.units()[0]!.id;
    onClient?.(client);
    const started = performance.now();
    await client.sync();
    const syncMs = performance.now() - started;
    const stored = Number(client.query('SELECT count(*) AS n FROM wide')[0]?.n);
    if (stored !== rows) throw new Error(`stored ${stored} of ${rows}`);
    return {
      columns: width,
      indexes,
      rows,
      segments,
      encrypted,
      key,
      syncMs: Math.round(syncMs),
      rowsPerSecond: Math.round((rows / syncMs) * 1000),
    };
  } finally {
    await client.close();
  }
}

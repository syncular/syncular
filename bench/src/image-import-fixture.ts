/**
 * Shared by the Bun and browser halves of the image import lane: a two-table
 * catalogue shaped like the one that reported the cost (string primary keys,
 * two secondary indexes per table, one unique), and one synthetic SSP2
 * bootstrap response that carries both tables as §5.3 SQLite images.
 */
import {
  echoDigest,
  encodeMessage,
  PROTOCOL_WIRE_VERSION,
} from '../../packages/core/src/index';
import { SyncClient } from '../../packages/web-client/src/client';
import type { ClientDatabase } from '../../packages/web-client/src/database';
import type { SyncProgress } from '../../packages/web-client/src/progress';
import type { ClientSchema } from '../../packages/web-client/src/schema';

export const IMAGE_SCOPE = { catalogue_set_id: ['set-1'] };

const scopes = ['set:{catalogue_set_id}'];

export const IMAGE_SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'codes',
      primaryKey: 'id',
      scopes,
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'catalogue_set_id', type: 'string', nullable: false },
        { name: 'release_id', type: 'string', nullable: false },
        { name: 'catalogue', type: 'string', nullable: false },
        { name: 'code', type: 'string', nullable: false },
        { name: 'parent_code_id', type: 'string', nullable: true },
        { name: 'sort_key', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'description', type: 'string', nullable: true },
        { name: 'texts_json', type: 'string', nullable: true },
        { name: 'selectable', type: 'boolean', nullable: false },
      ],
      indexes: [
        {
          name: 'codes_by_release_parent',
          columns: [
            'catalogue_set_id',
            'release_id',
            'parent_code_id',
            'sort_key',
            'id',
          ],
          unique: false,
        },
        {
          name: 'codes_by_set_release_catalogue_code',
          columns: ['catalogue_set_id', 'release_id', 'catalogue', 'code'],
          unique: true,
        },
      ],
    },
    {
      name: 'relations',
      primaryKey: 'id',
      scopes,
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'catalogue_set_id', type: 'string', nullable: false },
        { name: 'release_id', type: 'string', nullable: false },
        { name: 'source_code_id', type: 'string', nullable: false },
        { name: 'relation_type', type: 'string', nullable: false },
        { name: 'target_code_id', type: 'string', nullable: false },
        { name: 'note', type: 'string', nullable: true },
        { name: 'sort_order', type: 'integer', nullable: false },
        { name: 'metadata_json', type: 'string', nullable: true },
      ],
      indexes: [
        {
          name: 'relations_by_source',
          columns: ['catalogue_set_id', 'source_code_id', 'sort_order', 'id'],
          unique: false,
        },
        {
          name: 'relations_by_target',
          columns: ['catalogue_set_id', 'target_code_id', 'sort_order', 'id'],
          unique: false,
        },
      ],
    },
  ],
};

/**
 * Image DDL and the row generator per table. Ids are a multiplicative hash of
 * the row number, so primary-key order and index order disagree the way
 * random ids do. `$fill` pads the large text column to the requested width.
 */
export const IMAGE_TABLES = {
  codes: {
    ddl: 'id TEXT PRIMARY KEY NOT NULL, catalogue_set_id TEXT NOT NULL, release_id TEXT NOT NULL, catalogue TEXT NOT NULL, code TEXT NOT NULL, parent_code_id TEXT, sort_key TEXT NOT NULL, title TEXT NOT NULL, description TEXT, texts_json TEXT, selectable INTEGER NOT NULL',
    select:
      "printf('c%08x', (x*2654435761)%4294967296), 'set-1', 'rel-1', 'ops', printf('%d-%d.%d', x/1000, x%1000, x%7), CASE WHEN x%50=0 THEN NULL ELSE printf('c%08x', ((x/50*50)*2654435761)%4294967296) END, printf('%010d', x), printf('Code %d title text', x), printf('Description %d ', x)||substr(replace(hex(zeroblob(200)),'0','d'),1,200), substr(replace(hex(zeroblob($fill)),'0','t'),1,$fill), x%3<>0",
  },
  relations: {
    ddl: 'id TEXT PRIMARY KEY NOT NULL, catalogue_set_id TEXT NOT NULL, release_id TEXT NOT NULL, source_code_id TEXT NOT NULL, relation_type TEXT NOT NULL, target_code_id TEXT NOT NULL, note TEXT, sort_order INTEGER NOT NULL, metadata_json TEXT',
    select:
      "printf('r%08x', (x*2246822519)%4294967296), 'set-1', 'rel-1', printf('c%08x', ((x*7)%67302*2654435761)%4294967296), CASE x%3 WHEN 0 THEN 'see' WHEN 1 THEN 'excl' ELSE 'incl' END, printf('c%08x', ((x*13)%67302*2654435761)%4294967296), printf('note %d', x), x%17, substr(replace(hex(zeroblob($fill)),'0','m'),1,$fill)",
  },
} as const;

export interface LaneImage {
  readonly table: 'codes' | 'relations';
  readonly bytes: Uint8Array;
  readonly rows: number;
  readonly segmentId: string;
}

export interface LaneResult {
  readonly importMs: number;
  readonly transactions: Record<string, number>;
  /** One entry per payload: the last import-phase progress snapshot. */
  readonly payloads: readonly SyncProgress[];
  /** How often `rowsProcessed` started again from a lower value. */
  readonly progressRestarts: number;
  readonly progressUpdates: number;
  /** Largest per-transaction step of importWriteMs + importCommitMs. */
  readonly longestTransactionMs: number;
  readonly rows: Record<string, number>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export const IMAGE_SCOPE_DIGEST = () => sha256Hex(JSON.stringify(IMAGE_SCOPE));

/** Bootstrap both images through a real `SyncClient` in one response. */
export async function runImageImport(
  database: ClientDatabase,
  images: readonly LaneImage[],
): Promise<LaneResult> {
  const digest = await IMAGE_SCOPE_DIGEST();
  let subId = '';
  let delivered = false;
  const client = new SyncClient({
    database,
    schema: IMAGE_SCHEMA,
    segments: async (request) => {
      const image = images.find(
        (candidate) => candidate.segmentId === request.segmentId,
      );
      if (image === undefined) throw new Error('unknown segment');
      return image.bytes;
    },
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
                ...images.map((image) => ({
                  type: 'SEGMENT_REF' as const,
                  segmentId: image.segmentId,
                  mediaType: 'sqlite' as const,
                  table: image.table,
                  byteLength: image.bytes.byteLength,
                  rowCount: image.rows,
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
    await client.setWindow({ variable: 'catalogue_set_id' }, ['set-1']);
    subId = client.units()[0]!.id;
    const transactions: Record<string, number> = {};
    const offChange = client.onChange((batch) => {
      for (const { table } of batch.tables)
        transactions[table] = (transactions[table] ?? 0) + 1;
    });
    const payloads: SyncProgress[] = [];
    let progressRestarts = 0;
    let progressUpdates = 0;
    let longestTransactionMs = 0;
    let previous: SyncProgress | undefined;
    const spent = (progress: SyncProgress | undefined) =>
      (progress?.importWriteMs ?? 0) + (progress?.importCommitMs ?? 0);
    const offProgress = client.onProgress((progress) => {
      if (progress.phase !== 'import') return;
      progressUpdates++;
      if (
        previous !== undefined &&
        progress.rowsProcessed < previous.rowsProcessed
      )
        progressRestarts++;
      if (previous !== undefined && previous.segmentId !== progress.segmentId)
        payloads.push(previous);
      longestTransactionMs = Math.max(
        longestTransactionMs,
        spent(progress) -
          (previous?.segmentId === progress.segmentId ? spent(previous) : 0),
      );
      previous = progress;
    });
    const started = performance.now();
    await client.sync();
    const importMs = performance.now() - started;
    if (previous !== undefined) payloads.push(previous);
    offChange();
    offProgress();
    const rows = Object.fromEntries(
      images.map((image) => [
        image.table,
        Number(client.query(`SELECT count(*) AS n FROM ${image.table}`)[0]?.n),
      ]),
    );
    for (const image of images)
      if (rows[image.table] !== image.rows)
        throw new Error(`${image.table}: imported ${rows[image.table]}`);
    return {
      importMs,
      transactions,
      payloads,
      progressRestarts,
      progressUpdates,
      longestTransactionMs,
      rows,
    };
  } finally {
    await client.close();
  }
}

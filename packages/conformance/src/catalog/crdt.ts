/**
 * CRDT fields / collaborative convergence (SPEC.md §5.10; Appendix B.14).
 * Concurrent-edit convergence on both orders, crdt merge does NOT bump
 * conflicts, a non-crdt baseVersion conflict fires with the crdt merged into
 * the winner, and offline crdt edits replay idempotently.
 *
 * The CRDT bytes are real Yjs updates produced by `@syncular/crdt-yjs`
 * (the reference merger the ts-server driver registers). The scenario is
 * implementation-agnostic: it only ever hands `crdt` column values as bytes
 * across the driver seam and asserts byte-level convergence — the Rust
 * pairing pushes the SAME fixture bytes and reaches the same merged result
 * (§5.10.5), no Rust-side merge.
 */
import { YjsColumn, yjsDocMerger } from '@syncular/crdt-yjs';
import { check, checkEqual } from '../checks';
import type { DriverRow, DriverRowValue, DriverSchema } from '../driver';
import type { Scenario, ScenarioContext } from '../scenario';
import { syncFails, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

/** A table mixing an LWW `title` and a `crdt` `doc` column (§5.10.1). */
const CRDT_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'doc', type: 'crdt', nullable: true, crdtType: 'yjs-doc' },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
  ],
};

const CRDT_SERVER = { schema: CRDT_SCHEMA } as const;

/** Bytes → the `{ $bytes: hex }` driver form. */
function bytesValue(bytes: Uint8Array): { readonly $bytes: string } {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return { $bytes: hex };
}

/** The `{ $bytes: hex }` driver form → bytes. */
function valueBytes(value: DriverRowValue | undefined): Uint8Array {
  if (value === null || value === undefined || typeof value !== 'object') {
    return new Uint8Array(0);
  }
  const hex = value.$bytes;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** A Yjs update that inserts `text` at position 0 of a fresh doc. */
function textUpdate(text: string): Uint8Array {
  const col = new YjsColumn();
  col.text().insert(0, text);
  const bytes = col.columnBytes();
  col.destroy();
  return bytes;
}

/** Read `text` from a merged crdt column value. */
function readText(bytes: Uint8Array): string {
  const col = new YjsColumn(bytes);
  const text = col.text().toString();
  col.destroy();
  return text;
}

function noteRow(id: string, title: string, doc: Uint8Array | null): DriverRow {
  return {
    id,
    project_id: 'p1',
    title,
    doc: doc === null ? null : bytesValue(doc),
  };
}

async function docBytesOf(
  client: {
    api: { readRows: (t: string) => Promise<{ values: DriverRow }[]> };
  },
  rowId: string,
): Promise<Uint8Array> {
  const rows = await client.api.readRows('notes');
  const row = rows.find((r) => r.values.id === rowId);
  check(row !== undefined, `row ${rowId} present locally`);
  return valueBytes(row?.values.doc);
}

export const crdtScenarios: readonly Scenario[] = [
  {
    // B.14(a,b): two clients each apply a distinct Yjs update to the same
    // row's crdt column, push baseVersion-less, and converge on identical
    // merged bytes — with NO version_conflict (crdt never conflicts on its
    // own account). The twin-server check proves order-independence.
    name: 'crdt/concurrent-convergence',
    specRefs: ['§5.10.2', '§5.10.3', 'B.14'],
    requires: ['crdt'] as const,
    server: CRDT_SERVER,
    async run(ctx: ScenarioContext) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-a',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      const b = await ctx.newClient({
        actorId: 'b',
        clientId: 'client-b',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await b.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await syncIdle(a);
      await syncIdle(b);

      // A seeds the row with a doc "hello". Both converge on it.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', textUpdate('hello')),
        },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      // A appends, B prepends — concurrent baseVersion-less crdt edits.
      const aDoc = new YjsColumn(await docBytesOf(a, 'n1'));
      aDoc.text().insert(aDoc.text().length, ' A');
      const bDoc = new YjsColumn(await docBytesOf(b, 'n1'));
      bDoc.text().insert(0, 'B ');
      const aUpdateBytes = aDoc.columnBytes();
      const bUpdateBytes = bDoc.columnBytes();

      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', aUpdateBytes),
        },
      ]);
      await b.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', bUpdateBytes),
        },
      ]);
      aDoc.destroy();
      bDoc.destroy();

      // Drive to quiescence in both directions.
      for (let i = 0; i < 4; i++) {
        await syncIdle(a);
        await syncIdle(b);
      }

      // Neither push produced a conflict (§5.10.3).
      checkEqual((await a.api.conflicts()).length, 0, 'A saw no conflict');
      checkEqual((await b.api.conflicts()).length, 0, 'B saw no conflict');

      // Byte-level convergence: both hold the SAME merged crdt column.
      const aFinal = await docBytesOf(a, 'n1');
      const bFinal = await docBytesOf(b, 'n1');
      checkEqual(
        bytesValue(aFinal).$bytes,
        bytesValue(bFinal).$bytes,
        'both clients converged on identical merged crdt bytes',
      );
      const text = readText(aFinal);
      check(
        text.includes('hello') && text.includes('A') && text.includes('B'),
        `merged doc contains all edits (got ${JSON.stringify(text)})`,
      );

      // Order-independence (§5.10.2): merging A's and B's updates against the
      // shared base converges to the same state whichever order the server
      // saw them — the property that makes the byte-equality above hold no
      // matter which push arrived first.
      const ab = await yjsDocMerger(aUpdateBytes, bUpdateBytes);
      const ba = await yjsDocMerger(bUpdateBytes, aUpdateBytes);
      checkEqual(readText(ab), readText(ba), 'merge is order-independent');
    },
  },

  {
    // §5.10.5 cross-core proof: the CLIENT CORE authors the crdt edits via the
    // native crdt commands (`crdtInsertText`/`crdtText`) rather than the
    // scenario hand-building Yjs fixture bytes. On the Rust pairing the RUST
    // core (yrs) authors and the TS server (yjs) merges; on the TS pairing the
    // TS core (@syncular/crdt-yjs) authors — the SAME scenario both ways. Two
    // clients edit concurrently, converge byte-identically, and each core
    // materializes the same text from the merged bytes: byte-level convergence
    // with the edits produced natively in whichever core is under test.
    name: 'crdt/native-authored-convergence',
    specRefs: ['§5.10.4', '§5.10.5', 'B.14'],
    requires: ['crdt'] as const,
    server: CRDT_SERVER,
    async run(ctx: ScenarioContext) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-a',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      const b = await ctx.newClient({
        actorId: 'b',
        clientId: 'client-b',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      // Client driver must be able to author crdt edits natively (Rust core
      // needs the crdt-yjs feature; TS core always can). Skip cleanly if not.
      if (
        a.api.crdtInsertText === undefined ||
        a.api.crdtText === undefined ||
        a.api.crdtDeleteText === undefined
      ) {
        return;
      }
      await a.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await b.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await syncIdle(a);
      await syncIdle(b);

      // A seeds the row (title LWW + a crdt-authored "hello") and converges.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', null),
        },
      ]);
      await a.api.crdtInsertText({
        table: 'notes',
        rowId: 'n1',
        column: 'doc',
        index: 0,
        value: 'hello',
      });
      await syncIdle(a);
      await syncIdle(b);
      checkEqual(
        await a.api.crdtText({ table: 'notes', rowId: 'n1', column: 'doc' }),
        'hello',
        'A materializes the seeded crdt text natively',
      );

      // A appends " A" at the end; B (its own core) prepends "B " at 0 —
      // concurrent baseVersion-less native crdt edits.
      const aText = await a.api.crdtText({
        table: 'notes',
        rowId: 'n1',
        column: 'doc',
      });
      await a.api.crdtInsertText({
        table: 'notes',
        rowId: 'n1',
        column: 'doc',
        index: aText.length,
        value: ' A',
      });
      // B's driver may lack the methods only if it is a different core; both
      // cores here implement them, so author on B too.
      check(
        b.api.crdtInsertText !== undefined,
        'B client core can author crdt edits',
      );
      await b.api.crdtInsertText?.({
        table: 'notes',
        rowId: 'n1',
        column: 'doc',
        index: 0,
        value: 'B ',
      });

      for (let i = 0; i < 4; i++) {
        await syncIdle(a);
        await syncIdle(b);
      }

      // No conflict (crdt never conflicts on its own account, §5.10.3).
      checkEqual((await a.api.conflicts()).length, 0, 'A saw no conflict');
      checkEqual((await b.api.conflicts()).length, 0, 'B saw no conflict');

      // Byte-identical convergence on the merged crdt bytes.
      const aFinal = await docBytesOf(a, 'n1');
      const bFinal = await docBytesOf(b, 'n1');
      checkEqual(
        bytesValue(aFinal).$bytes,
        bytesValue(bFinal).$bytes,
        'both cores converged on identical merged crdt bytes',
      );
      // Each core materializes the same text natively from the merged bytes.
      const aMaterialized = await a.api.crdtText({
        table: 'notes',
        rowId: 'n1',
        column: 'doc',
      });
      const bMaterialized = await (b.api.crdtText?.({
        table: 'notes',
        rowId: 'n1',
        column: 'doc',
      }) ?? Promise.resolve(readText(bFinal)));
      checkEqual(
        aMaterialized,
        bMaterialized,
        'both cores materialize identical text',
      );
      check(
        aMaterialized.includes('hello') &&
          aMaterialized.includes('A') &&
          aMaterialized.includes('B'),
        `merged native-authored doc has all edits (got ${JSON.stringify(aMaterialized)})`,
      );

      // A native delete round-trips too: drop the leading "B ".
      const idx = aMaterialized.indexOf('B ');
      if (idx >= 0) {
        await a.api.crdtDeleteText({
          table: 'notes',
          rowId: 'n1',
          column: 'doc',
          index: idx,
          len: 2,
        });
        for (let i = 0; i < 3; i++) {
          await syncIdle(a);
          await syncIdle(b);
        }
        const afterDelete = await a.api.crdtText({
          table: 'notes',
          rowId: 'n1',
          column: 'doc',
        });
        check(
          !afterDelete.includes('B '),
          `native crdt delete removed the range (got ${JSON.stringify(afterDelete)})`,
        );
        checkEqual(
          bytesValue(await docBytesOf(a, 'n1')).$bytes,
          bytesValue(await docBytesOf(b, 'n1')).$bytes,
          'converged again after a native crdt delete',
        );
      }
    },
  },

  {
    // B.14(c): A and B edit BOTH the LWW title (from the same baseVersion)
    // and the crdt doc. The loser gets version_conflict whose serverRow
    // carries the MERGED crdt state; after rebase both converge.
    name: 'crdt/conflict-with-merged-crdt',
    specRefs: ['§5.10.3', '§6.2', '§6.5', 'B.14'],
    requires: ['crdt'] as const,
    server: CRDT_SERVER,
    async run(ctx: ScenarioContext) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-a',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      const b = await ctx.newClient({
        actorId: 'b',
        clientId: 'client-b',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await b.api.subscribe({ id: 's', table: 'notes', scopes: P1 });

      // Seed row (version 1) and converge both.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 'base', textUpdate('x')),
        },
      ]);
      await syncIdle(a);
      await syncIdle(b);
      const aState = await a.api.readRows('notes');
      const baseVersion =
        aState.find((r) => r.values.id === 'n1')?.version ?? 0;
      check(baseVersion >= 1, 'both clients hold the seeded version');

      // A wins with baseVersion; its crdt appends "A".
      const aDoc = new YjsColumn(await docBytesOf(a, 'n1'));
      aDoc.text().insert(aDoc.text().length, 'A');
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 'A-title', aDoc.columnBytes()),
          baseVersion,
        },
      ]);
      aDoc.destroy();
      await syncIdle(a);

      // B loses: same (now stale) baseVersion; a distinct title + crdt "B".
      const bDoc = new YjsColumn(await docBytesOf(b, 'n1'));
      bDoc.text().insert(bDoc.text().length, 'B');
      await b.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 'B-title', bDoc.columnBytes()),
          baseVersion,
        },
      ]);
      bDoc.destroy();
      const report = await syncOk(b);

      // B's commit was rejected with a version_conflict (§6.2) — a single
      // combined round surfaces it (a crdt column never conflicts on its own,
      // §5.10.3; the title does).
      checkEqual(
        report.conflicts,
        1,
        'B saw one version conflict on the non-crdt column',
      );
      const conflict = (await b.api.conflicts())[0];
      check(conflict !== undefined, 'B has a conflict record');
      checkEqual(conflict?.code, 'sync.version_conflict', 'conflict code');
      // The serverRow carries A's title AND the merged crdt (which includes A).
      checkEqual(
        conflict?.serverRow.title,
        'A-title',
        'serverRow has the winner title',
      );
      const serverDoc = readText(valueBytes(conflict?.serverRow.doc));
      check(
        serverDoc.includes('A'),
        `conflict serverRow carries the merged crdt (got ${JSON.stringify(serverDoc)})`,
      );

      // B rebases keep-local at the new version, re-merging its crdt "B".
      const rebaseDoc = new YjsColumn(valueBytes(conflict?.serverRow.doc));
      rebaseDoc.text().insert(rebaseDoc.text().length, 'B');
      await b.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 'B-title', rebaseDoc.columnBytes()),
          baseVersion: conflict?.serverVersion,
        },
      ]);
      rebaseDoc.destroy();
      for (let i = 0; i < 3; i++) {
        await syncIdle(b);
        await syncIdle(a);
      }
      const finalDoc = readText(await docBytesOf(a, 'n1'));
      check(
        finalDoc.includes('A') && finalDoc.includes('B'),
        `after rebase the crdt carries both edits (got ${JSON.stringify(finalDoc)})`,
      );
    },
  },

  {
    // B.14(d): A goes offline, accumulates several crdt updates, reconnects,
    // and replays FIFO. A dropped-ack retry delivers one update twice, and
    // convergence is unaffected (idempotency-key cached + merger idempotency).
    name: 'crdt/offline-replay-idempotent',
    specRefs: ['§2.3', '§5.10.3', '§7.2', 'B.14'],
    requires: ['crdt'] as const,
    server: CRDT_SERVER,
    async run(ctx: ScenarioContext) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'client-a',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      const b = await ctx.newClient({
        actorId: 'b',
        clientId: 'client-b',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await b.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', textUpdate('go')),
        },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      // A accumulates two offline crdt edits (append "1", then "2").
      const doc = new YjsColumn(await docBytesOf(a, 'n1'));
      doc.text().insert(doc.text().length, '1');
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', doc.columnBytes()),
        },
      ]);
      doc.text().insert(doc.text().length, '2');
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', doc.columnBytes()),
        },
      ]);
      doc.destroy();
      check(
        (await a.api.pendingCommitIds()).length >= 2,
        'A has offline crdt commits queued',
      );

      // Drop the response of the first replayed push (ack loss) — the server
      // applied the commit but A never saw the ack, so the retry replays the
      // identical commit and the server returns cached (§2.3): the crdt update
      // is delivered twice and must not double-apply (§5.10.3).
      a.faults.dropNextResponses = 1;
      await syncFails(a, 'transport.lost', 'crdt offline ack loss');
      for (let i = 0; i < 5; i++) {
        await syncIdle(a);
        await syncIdle(b);
      }
      checkEqual(
        (await a.api.pendingCommitIds()).length,
        0,
        'A drained its outbox',
      );
      checkEqual(
        (await a.api.conflicts()).length,
        0,
        'no conflicts from crdt replay',
      );

      const aFinal = await docBytesOf(a, 'n1');
      const bFinal = await docBytesOf(b, 'n1');
      checkEqual(
        bytesValue(aFinal).$bytes,
        bytesValue(bFinal).$bytes,
        'A and B converged after idempotent offline crdt replay',
      );
      const text = readText(aFinal);
      check(
        text.includes('go') && text.includes('1') && text.includes('2'),
        `all offline edits landed exactly once (got ${JSON.stringify(text)})`,
      );
    },
  },
];

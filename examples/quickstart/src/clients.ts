/**
 * Two clients, one server, terminal-visible convergence.
 *
 * A writes a note; B — a completely independent client core with its own
 * local database — bootstraps, syncs, and reads the same row back. This is
 * the ≤5-minute proof that sync works end to end, no browser required.
 *
 * Run the server first (`bun run server`), then this script (`bun run
 * clients`). Both talk real HTTP to http://localhost:8787.
 */
import { makeClient } from './make-client';

const BASE_URL = process.env.QUICKSTART_URL ?? 'http://localhost:8787';
const LIST_ID = 'welcome';

const a = makeClient(BASE_URL, 'client-a');
const b = makeClient(BASE_URL, 'client-b');
await a.start();
await b.start();

// Both clients subscribe to the same list (the requested scope).
const sub = { id: 'notes', table: 'notes', scopes: { list_id: [LIST_ID] } };
a.subscribe(sub);
b.subscribe(sub);

// A writes a note. mutate() records it locally + queues it for the next push.
const now = Date.now();
a.mutate([
  {
    table: 'notes',
    op: 'upsert',
    values: {
      id: 'note-1',
      list_id: LIST_ID,
      body: 'Hello from client A',
      updated_at_ms: now,
    },
  },
]);
console.log('A: wrote note-1, pushing…');
await a.syncUntilIdle(); // push A's outbox to the server

console.log('B: syncing…');
await b.syncUntilIdle(); // B bootstraps the list and applies A's note

const rows = b.query('SELECT id, body FROM notes ORDER BY id');
console.log('B sees:', rows);

const converged = rows.length === 1 && rows[0]?.body === 'Hello from client A';
console.log(converged ? '\n✓ converged' : '\n✗ did NOT converge');

await a.close();
await b.close();
process.exit(converged ? 0 : 1);

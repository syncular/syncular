/**
 * Two clients, one server, terminal-visible convergence.
 *
 * A writes a todo; B (a completely independent client core with its own local
 * database) bootstraps, syncs, and reads the same row back. This is the proof
 * that sync works end to end, no browser required.
 *
 * Run the server first (`bun run server`), then this script (`bun run
 * clients`). Both talk real HTTP to http://localhost:8787.
 */
import { makeClient } from './make-client';

const BASE_URL = process.env.SERVER_URL ?? 'http://localhost:8787';
const LIST_ID = 'groceries';

const a = makeClient(BASE_URL, 'client-a');
const b = makeClient(BASE_URL, 'client-b');
await a.start();
await b.start();

// Both clients subscribe to the same list (the requested scope).
const sub = { id: 'todos', table: 'todos', scopes: { list_id: [LIST_ID] } };
a.subscribe(sub);
b.subscribe(sub);

// A writes a todo. mutate() records it locally + queues it for the next push.
a.mutate([
  {
    table: 'todos',
    op: 'upsert',
    values: {
      id: 'todo-1',
      list_id: LIST_ID,
      title: 'Buy milk',
      done: false,
      position: 1,
      updated_at_ms: Date.now(),
    },
  },
]);
console.log('A: wrote todo-1, pushing…');
await a.syncUntilIdle(); // push A's outbox to the server

console.log('B: syncing…');
await b.syncUntilIdle(); // B bootstraps the list and applies A's todo

const rows = b.query('SELECT id, title FROM todos ORDER BY id');
console.log('B sees:', rows);

const converged = rows.length === 1 && rows[0]?.title === 'Buy milk';
console.log(converged ? '\n✓ converged' : '\n✗ did NOT converge');

await a.close();
await b.close();
process.exit(converged ? 0 : 1);

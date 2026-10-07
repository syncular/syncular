/// <reference lib="webworker" />

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  compileSyqlSource,
  formatSyqlSource,
} from '@syncular/typegen/syql-browser';
import { BOARD_SCHEMA, BOARD_SEED } from './examples';
import type {
  PlaygroundWorkerRequest,
  PlaygroundWorkerResponse,
} from './protocol';
import {
  executeStatement,
  openPlaygroundDatabase,
  type PlaygroundDatabase,
  playgroundDiagnostic,
  serializeQuery,
} from './runtime';

const MAX_SOURCE_LENGTH = 64 * 1024;
const context = globalThis as unknown as DedicatedWorkerGlobalScope;

// One seeded database answers both compile-time analysis and Run requests.
let databasePromise: Promise<PlaygroundDatabase> | undefined;

function database(): Promise<PlaygroundDatabase> {
  databasePromise ??= sqlite3InitModule().then((sqlite3) =>
    openPlaygroundDatabase(sqlite3, BOARD_SCHEMA, BOARD_SEED),
  );
  return databasePromise;
}

function post(response: PlaygroundWorkerResponse): void {
  context.postMessage(response);
}

async function handle(request: PlaygroundWorkerRequest): Promise<void> {
  try {
    if (request.kind === 'run') {
      const { database: db } = await database();
      const started = performance.now();
      const result = executeStatement(db, request.sql, request.values);
      post({
        kind: 'rows',
        requestId: request.requestId,
        elapsedMs: performance.now() - started,
        ...result,
      });
      return;
    }
    if (request.source.length > MAX_SOURCE_LENGTH) {
      throw new Error(
        `PLAYGROUND_SOURCE_TOO_LARGE: the playground compiles up to ${MAX_SOURCE_LENGTH / 1024} KiB`,
      );
    }
    if (request.kind === 'format') {
      post({
        kind: 'formatted',
        requestId: request.requestId,
        source: formatSyqlSource(request.source),
      });
      return;
    }
    const { queryDb } = await database();
    const started = performance.now();
    const result = compileSyqlSource(request.source, BOARD_SCHEMA, queryDb);
    if (result.queries.length === 0) {
      throw new Error('PLAYGROUND_NO_QUERY: declare at least one query');
    }
    post({
      kind: 'compiled',
      requestId: request.requestId,
      elapsedMs: performance.now() - started,
      queries: result.queries.map(serializeQuery),
    });
  } catch (error) {
    post({
      kind: 'diagnostics',
      requestId: request.requestId,
      diagnostics: [playgroundDiagnostic(error)],
    });
  }
}

context.addEventListener(
  'message',
  (event: MessageEvent<PlaygroundWorkerRequest>) => {
    void handle(event.data);
  },
);

post({ kind: 'ready' });

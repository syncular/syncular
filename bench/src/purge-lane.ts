import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalTaskRows,
  PROJECT_ID,
  RETAINED_PROJECT_ID,
  sqliteConfiguration,
  SQLITE_CONFIGURATION_SQL,
} from './fixture';
import {
  createProcessDriver,
  processObject,
  assertProcessSync,
} from './process-driver';
import { closeBenchClients } from './loopback';
import { startSocketServer } from './socket-server';

/** Revocation uses the server resolver and shipping purge path in both cores. */
export async function runProcessPurge(options: {
  binary: string | readonly string[];
  core: 'ts' | 'rust';
  rows: number;
  backend: 'sqlite' | 'postgres';
  boundary: 'direct' | 'command';
}) {
  const directory = await mkdtemp(join(tmpdir(), 'syncular-purge-'));
  const server = await startSocketServer(options.rows, options.backend, {
    revocation: true,
  }).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const clients: Array<Awaited<ReturnType<typeof createProcessDriver>>> = [];
  const clientSqlite = [];
  try {
    const path = join(directory, 'reader.sqlite');
    const reader = await createProcessDriver(
      options.binary,
      server.endpoints,
      path,
    );
    clients.push(reader);
    const sqlite = sqliteConfiguration(
      processObject(
        await reader.invoke('query', {
          sql: SQLITE_CONFIGURATION_SQL,
        }),
      ).rows,
      true,
    );
    clientSqlite.push({
      role: 'reader',
      pid: reader.pid,
      clientId: reader.clientId,
      ...sqlite,
    });
    await reader.invoke('subscribe', {
      id: 'retained',
      table: 'tasks',
      scopes: { project_id: [RETAINED_PROJECT_ID] },
    });
    assertProcessSync(
      processObject(
        await reader.invoke('benchSync', { mode: options.boundary }),
      ).outcome,
    );
    const retained = {
      id: 'retained-row',
      project_id: RETAINED_PROJECT_ID,
      title: 'Keep authorized data',
      done: false,
      priority: 2,
      updated_at_ms: 1_750_000_000_000,
    };
    await reader.invoke('benchMutate', {
      mode: options.boundary,
      commits: [
        { mutations: [{ table: 'tasks', op: 'upsert', values: retained }] },
      ],
    });
    assertProcessSync(await reader.invoke('syncUntilIdle'), 1);
    const sql =
      'SELECT id, project_id, title, done, priority, updated_at_ms FROM tasks ORDER BY id';
    const countSql =
      'SELECT project_id, COUNT(*) AS count FROM tasks GROUP BY project_id ORDER BY project_id';
    const grouped = processObject(
      await reader.invoke('query', { sql: countSql }),
    ).rows;
    if (
      !Array.isArray(grouped) ||
      grouped.length !== 2 ||
      !grouped.some((row: unknown) => {
        const group = processObject(row);
        return group.project_id === PROJECT_ID && group.count === options.rows;
      }) ||
      !grouped.some((row: unknown) => {
        const group = processObject(row);
        return group.project_id === RETAINED_PROJECT_ID && group.count === 1;
      })
    )
      throw new Error('Purge bootstrap differs from fixture');
    const expected = canonicalTaskRows([retained]);
    const expectedJson = JSON.stringify(expected);
    const validateRetainedRows = async (client: typeof reader) => {
      const groups = processObject(
        await client.invoke('query', { sql: countSql }),
      ).rows;
      if (
        !Array.isArray(groups) ||
        groups.length !== 1 ||
        processObject(groups[0]).project_id !== RETAINED_PROJECT_ID ||
        processObject(groups[0]).count !== 1
      )
        throw new Error('Purge removed retained rows or kept revoked rows');
      if (
        JSON.stringify(
          canonicalTaskRows(
            processObject(await client.invoke('query', { sql })).rows,
          ),
        ) !== expectedJson
      )
        throw new Error('Retained row values changed');
    };
    const initialSeq = (await server.metrics(true)).maxCommitSeq;
    await reader.invoke('stats', { reset: true });
    await server.revokeProject();
    const started = performance.now();
    const sync = processObject(
      await reader.invoke('benchSync', { mode: options.boundary }),
    );
    const purgeMs = performance.now() - started;
    const report = assertProcessSync(sync.outcome, 0);
    if (
      !Array.isArray(report.revoked) ||
      JSON.stringify(report.revoked) !== JSON.stringify(['bench'])
    )
      throw new Error('Expected exactly one revoked subscription');
    if (
      typeof sync.elapsedNs !== 'number' ||
      !Number.isFinite(sync.elapsedNs) ||
      sync.elapsedNs < 0
    )
      throw new Error('Purge operation timing missing');
    const state = processObject(
      processObject(await reader.invoke('subscriptionState', { id: 'bench' }))
        .state,
    );
    const retainedState = processObject(
      processObject(
        await reader.invoke('subscriptionState', { id: 'retained' }),
      ).state,
    );
    if (
      state.status !== 'revoked' ||
      state.reasonCode !== 'sync.scope_revoked' ||
      retainedState.status !== 'active'
    )
      throw new Error('Purge subscription state differs from fixture');
    await validateRetainedRows(reader);
    if (processObject(await reader.invoke('statusSnapshot')).outbox !== 0)
      throw new Error('Purge fixture has pending writes');
    const serverMetrics = await server.metrics();
    if (serverMetrics.maxCommitSeq !== initialSeq)
      throw new Error('Purge changed the authoritative commit sequence');
    await reader.close();
    const reopenStarted = performance.now();
    const reopened = await createProcessDriver(
      options.binary,
      server.endpoints,
      path,
      reader.clientId,
    );
    clients.push(reopened);
    const reopenMs = performance.now() - reopenStarted;
    clientSqlite.push({
      role: 'reopened-reader',
      pid: reopened.pid,
      clientId: reopened.clientId,
      ...sqliteConfiguration(
        processObject(
          await reopened.invoke('query', {
            sql: SQLITE_CONFIGURATION_SQL,
          }),
        ).rows,
        true,
      ),
    });
    if (reader.clientId !== reopened.clientId || reader.pid === reopened.pid)
      throw new Error(
        'Purge reopen did not preserve identity in a fresh process',
      );
    await validateRetainedRows(reopened);
    assertProcessSync(await reopened.invoke('syncUntilIdle'), 0);
    await validateRetainedRows(reopened);
    await closeBenchClients(clients);
    return {
      purgeMs,
      operationPurgeMs: sync.elapsedNs / 1_000_000,
      reopenMs,
      clientStats: sync.stats,
      serverMetrics,
      sqlite,
      clientSqlite,
      revokedState: state,
      retainedState,
      validatedPurgedRows: options.rows,
      validatedRetainedRows: expected.length,
      validatedReopen: true,
      validatedCommits: 0,
      digest: createHash('sha256').update(expectedJson).digest('hex'),
      clientResources: clients.map((client, index) => ({
        role: index === 0 ? 'reader' : 'reopened-reader',
        ...client.resourceUsage(),
      })),
      boundaries: `Socket permission purge, ${options.core} ${options.boundary}. Grant removal completes before timing. Purge measures an explicit sync round through completion, including authorization and local apply; it excludes automatic revocation discovery. operationPurgeMs excludes controller delivery. SQL and subscription validation, process close, and reopen are outside purge timing. Reopen includes process launch and client setup. Both processes use the same persistent SQLite file. Resource counters cover each complete process lifetime.`,
    };
  } finally {
    try {
      await closeBenchClients(clients);
    } finally {
      try {
        await server.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

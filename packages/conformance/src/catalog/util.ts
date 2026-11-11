/**
 * Catalog-internal helpers: seeding through the raw surface, sync-result
 * unwrapping, and convergence assertions (client mirror ≡ server state,
 * row for row and version for version).
 */
import {
  type PushResultFrame,
  type ResponseMessage,
  unitId,
} from '@syncular/core';
import { check, checkEqual } from '../checks';
import type { ClientSyncReport, DriverRow, DriverUnitScopes } from '../driver';
import { ALL_SCOPES } from '../fixture';
import {
  decodeResponse,
  rawPushCommit,
  rawUpsert,
  responsePushResults,
} from '../raw';
import type { ClientHandle, ScenarioContext } from '../scenario';

export async function syncOk(handle: ClientHandle): Promise<ClientSyncReport> {
  const result = await handle.api.sync();
  check(
    result.ok,
    `sync() failed for ${handle.clientId}: ${result.ok ? '' : `${result.errorCode}: ${result.message}`}`,
  );
  return result.report;
}

export async function syncIdle(
  handle: ClientHandle,
): Promise<ClientSyncReport> {
  const result = await handle.api.syncUntilIdle();
  check(
    result.ok,
    `syncUntilIdle() failed for ${handle.clientId}: ${result.ok ? '' : `${result.errorCode}: ${result.message}`}`,
  );
  check(
    result.budgetExhausted !== true,
    `syncUntilIdle() exhausted its default budget for ${handle.clientId}`,
  );
  return result.report;
}

export async function syncFails(
  handle: ClientHandle,
  expectedCode: string,
  what: string,
): Promise<void> {
  const result = await handle.api.sync();
  check(!result.ok, `${what}: expected sync() to fail, but it succeeded`);
  if (!result.ok) {
    checkEqual(result.errorCode, expectedCode, `${what}: error code`);
  }
}

/**
 * The cursor through which a unit's rows are complete (§4.5): its own cursor
 * while it catches up, the replica cursor while it is live. `undefined` when
 * the client holds no such unit.
 */
export async function unitCursor(
  handle: ClientHandle,
  unit: DriverUnitScopes,
): Promise<number | undefined> {
  const state = await handle.api.unitState(unitId(unit));
  if (state === undefined) return undefined;
  return state.cursor ?? (await handle.api.replicaCursor());
}

/** A unit's state with the replica cursor: everything a round can advance. */
export async function unitProgress(
  handle: ClientHandle,
  unit: DriverUnitScopes,
): Promise<unknown> {
  return {
    unit: await handle.api.unitState(unitId(unit)),
    replicaCursor: await handle.api.replicaCursor(),
  };
}

/** A `PUSH_RESULT` reduced to what §6.3 pins: status, `commitSeq`, and one
 * `opIndex:status` (or `opIndex:code:retryable|final`) entry per result. */
export function pushOutcome(push: PushResultFrame | undefined): unknown {
  return (
    push && {
      status: push.status,
      ...(push.commitSeq !== undefined ? { commitSeq: push.commitSeq } : {}),
      results: push.results.map((result) =>
        result.status === 'error'
          ? `${result.opIndex}:${result.code}:${result.retryable ? 'retryable' : 'final'}`
          : `${result.opIndex}:${result.status}`,
      ),
    }
  );
}

/**
 * Every round response `handle` receives from now on, decoded: its HTTP
 * responses, then its socket rounds (§8.7). A scenario drives one of the two.
 */
export function captureResponses(
  ctx: ScenarioContext,
  handle: ClientHandle,
): () => ResponseMessage[] {
  const http: ResponseMessage[] = [];
  const original = ctx.server.handleSyncRequest.bind(ctx.server);
  ctx.server.handleSyncRequest = async (actor, request) => {
    const result = await original(actor, request);
    if (result.ok && actor === handle.actorId)
      http.push(decodeResponse(result.bytes));
    return result;
  };
  const from = handle.realtime.roundResponses.length;
  return () => [...http, ...handle.realtime.roundResponses.slice(from)];
}

let seedCounter = 0;

/** Push rows as one commit through the raw surface (seed data). */
export async function seedRows(
  ctx: ScenarioContext,
  table: string,
  rows: readonly DriverRow[],
  actorId = 'seed-actor',
): Promise<void> {
  await ctx.server.setAllowedScopes(actorId, ALL_SCOPES);
  seedCounter += 1;
  // Seed at the SERVER's schema version (§7.4 scenarios run a bumped
  // server): the codec and the REQ_HEADER schemaVersion must both match
  // the version the server serves, or the push hits the schema floor.
  const result = await ctx.rawSync(
    actorId,
    [
      rawPushCommit(
        `seed-${seedCounter}-${crypto.randomUUID()}`,
        rows.map((row) => rawUpsert(ctx.serverSchema, table, row)),
      ),
    ],
    { clientId: `seed-${actorId}`, schemaVersion: ctx.serverSchema.version },
  );
  check(result.ok, 'seed push failed at request level');
  if (result.ok) {
    const push = responsePushResults(result.message)[0];
    check(push?.status === 'applied', `seed push not applied: ${push?.status}`);
  }
}

export async function seedTasks(
  ctx: ScenarioContext,
  rows: readonly DriverRow[],
  actorId = 'seed-actor',
): Promise<void> {
  await seedRows(ctx, 'tasks', rows, actorId);
}

/**
 * Assert a client's local table mirrors the server's rows exactly —
 * same rowIds, same values, and same versions. Versions are compared
 * unconditionally: every delivery path carries the row's
 * `server_version` — `COMMIT` changes (§4.5), conflict records (§6.3),
 * and segment row records (§5.2/§5.6) — so a bootstrapped client's
 * version knowledge MUST equal the server's. `scopeFilter` restricts
 * the server side to the subset the client is entitled to see.
 */
export async function expectConverged(
  ctx: ScenarioContext,
  table: string,
  clients: readonly ClientHandle[],
  scopeFilter?: {
    readonly variable: string;
    readonly values: readonly string[];
  },
): Promise<void> {
  const serverRows = (await ctx.server.readRows(table)).filter(
    (row) =>
      scopeFilter === undefined ||
      scopeFilter.values.includes(row.scopes[scopeFilter.variable] ?? ''),
  );
  const expected = serverRows.map((row) => ({
    rowId: row.rowId,
    version: row.version,
    values: row.values,
  }));
  for (const client of clients) {
    const rows = (await client.api.readRows(table)).map((row) => ({
      rowId: row.rowId,
      version: row.version,
      values: row.values,
    }));
    checkEqual(
      rows,
      expected,
      `client ${client.clientId} has not converged with the server on ${table}`,
    );
  }
}

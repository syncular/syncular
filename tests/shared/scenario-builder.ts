/**
 * Fluent scenario builder for multi-client sync tests.
 *
 * Provides a declarative API for setting up complex sync scenarios
 * involving multiple clients, conflicts, and state verification.
 *
 * @example
 * await scenario()
 *   .withServer('sqlite')
 *   .addClient('alice')
 *   .addClient('bob')
 *   .alice.insert('tasks', { id: '1', title: 'Task' })
 *   .alice.push()
 *   .bob.pull()
 *   .expect.bob.hasRow('tasks', '1')
 *   .run();
 */

import type { SyncClientDb } from '@syncular/client';
import type { SyncTransport } from '@syncular/core';
import type { SyncCoreDb } from '@syncular/server';
import type { Kysely } from 'kysely';

// ============================================================================
// Types
// ============================================================================

interface ScenarioClient {
  id: string;
  actorId: string;
  db: Kysely<SyncClientDb & Record<string, Record<string, unknown>>>;
  transport: SyncTransport;
}

interface ScenarioServer {
  db: Kysely<SyncCoreDb>;
  dialect: unknown;
}

type ScenarioAction =
  | {
      type: 'insert';
      client: string;
      table: string;
      values: Record<string, unknown>;
    }
  | {
      type: 'update';
      client: string;
      table: string;
      rowId: string;
      values: Record<string, unknown>;
    }
  | { type: 'delete'; client: string; table: string; rowId: string }
  | { type: 'push'; client: string }
  | { type: 'pull'; client: string }
  | { type: 'wait'; ms: number }
  | { type: 'custom'; fn: () => Promise<void> };

type ScenarioExpectation =
  | {
      type: 'hasRow';
      client: string;
      table: string;
      rowId: string;
      values?: Record<string, unknown>;
    }
  | { type: 'noRow'; client: string; table: string; rowId: string }
  | { type: 'outboxEmpty'; client: string }
  | { type: 'outboxCount'; client: string; count: number }
  | { type: 'conflictCount'; client: string; count: number }
  | { type: 'serverCommitCount'; count: number }
  | { type: 'custom'; fn: () => Promise<void> };

interface ScenarioConfig {
  clients: Map<string, ScenarioClient>;
  server: ScenarioServer | null;
  actions: ScenarioAction[];
  expectations: ScenarioExpectation[];
}

// ============================================================================
// Client Proxy
// ============================================================================

interface ClientProxy {
  insert(table: string, values: Record<string, unknown>): ScenarioBuilder;
  update(
    table: string,
    rowId: string,
    values: Record<string, unknown>
  ): ScenarioBuilder;
  delete(table: string, rowId: string): ScenarioBuilder;
  push(): ScenarioBuilder;
  pull(): ScenarioBuilder;
}

interface ClientExpectProxy {
  hasRow(
    table: string,
    rowId: string,
    values?: Record<string, unknown>
  ): ScenarioBuilder;
  noRow(table: string, rowId: string): ScenarioBuilder;
  outboxEmpty(): ScenarioBuilder;
  outboxCount(count: number): ScenarioBuilder;
  conflictCount(count: number): ScenarioBuilder;
}

// ============================================================================
// Scenario Builder
// ============================================================================

class ScenarioBuilder {
  private config: ScenarioConfig = {
    clients: new Map(),
    server: null,
    actions: [],
    expectations: [],
  };

  private clientProxies: Map<string, ClientProxy> = new Map();
  private expectProxies: Map<string, ClientExpectProxy> = new Map();

  /**
   * Set up the server database.
   */
  withServer(server: ScenarioServer): this {
    this.config.server = server;
    return this;
  }

  /**
   * Add a client to the scenario.
   */
  addClient(name: string, client: ScenarioClient): this {
    this.config.clients.set(name, client);

    // Create action proxy for this client
    const actionProxy: ClientProxy = {
      insert: (table, values) => {
        this.config.actions.push({
          type: 'insert',
          client: name,
          table,
          values,
        });
        return this;
      },
      update: (table, rowId, values) => {
        this.config.actions.push({
          type: 'update',
          client: name,
          table,
          rowId,
          values,
        });
        return this;
      },
      delete: (table, rowId) => {
        this.config.actions.push({
          type: 'delete',
          client: name,
          table,
          rowId,
        });
        return this;
      },
      push: () => {
        this.config.actions.push({ type: 'push', client: name });
        return this;
      },
      pull: () => {
        this.config.actions.push({ type: 'pull', client: name });
        return this;
      },
    };
    this.clientProxies.set(name, actionProxy);

    // Create expect proxy for this client
    const expectProxy: ClientExpectProxy = {
      hasRow: (table, rowId, values) => {
        this.config.expectations.push({
          type: 'hasRow',
          client: name,
          table,
          rowId,
          values,
        });
        return this;
      },
      noRow: (table, rowId) => {
        this.config.expectations.push({
          type: 'noRow',
          client: name,
          table,
          rowId,
        });
        return this;
      },
      outboxEmpty: () => {
        this.config.expectations.push({ type: 'outboxEmpty', client: name });
        return this;
      },
      outboxCount: (count) => {
        this.config.expectations.push({
          type: 'outboxCount',
          client: name,
          count,
        });
        return this;
      },
      conflictCount: (count) => {
        this.config.expectations.push({
          type: 'conflictCount',
          client: name,
          count,
        });
        return this;
      },
    };
    this.expectProxies.set(name, expectProxy);

    return this;
  }

  /**
   * Get client action proxy.
   */
  client(name: string): ClientProxy {
    const proxy = this.clientProxies.get(name);
    if (!proxy) {
      throw new Error(
        `Client '${name}' not found. Add it with addClient() first.`
      );
    }
    return proxy;
  }

  /**
   * Add a wait action.
   */
  wait(ms: number): this {
    this.config.actions.push({ type: 'wait', ms });
    return this;
  }

  /**
   * Add a custom action.
   */
  do(fn: () => Promise<void>): this {
    this.config.actions.push({ type: 'custom', fn });
    return this;
  }

  /**
   * Get expectation builder.
   */
  get expect(): ExpectBuilder {
    return new ExpectBuilder(this, this.config, this.expectProxies);
  }

  /**
   * Run the scenario.
   */
  async run(): Promise<void> {
    // Execute all actions in order
    for (const action of this.config.actions) {
      await this.executeAction(action);
    }

    // Verify all expectations
    for (const expectation of this.config.expectations) {
      await this.verifyExpectation(expectation);
    }
  }

  private async executeAction(action: ScenarioAction): Promise<void> {
    switch (action.type) {
      case 'insert': {
        const client = this.getClient(action.client);
        await client.db
          .insertInto(action.table)
          .values(action.values)
          .execute();
        break;
      }

      case 'update': {
        const client = this.getClient(action.client);
        await client.db
          .updateTable(action.table)
          .set(action.values)
          .where('id', '=', action.rowId)
          .execute();
        break;
      }

      case 'delete': {
        const client = this.getClient(action.client);
        await client.db
          .deleteFrom(action.table)
          .where('id', '=', action.rowId)
          .execute();
        break;
      }

      case 'push': {
        const client = this.getClient(action.client);
        const commits = await client.db
          .selectFrom('sync_outbox_commits')
          .where('status', '=', 'pending')
          .selectAll()
          .execute();

        for (const commit of commits) {
          const operations = JSON.parse(commit.operations_json);

          const combined = await client.transport.sync({
            clientId: client.id,
            push: {
              clientCommitId: commit.client_commit_id,
              operations,
              schemaVersion: 1,
            },
          });

          const response = combined.push;
          const newStatus =
            response?.ok && response?.status === 'applied' ? 'acked' : 'failed';
          await client.db
            .updateTable('sync_outbox_commits')
            .set({
              status: newStatus,
              acked_commit_seq: response?.commitSeq ?? null,
              updated_at: Date.now(),
            })
            .where('id', '=', commit.id)
            .execute();
        }
        break;
      }

      case 'pull': {
        const client = this.getClient(action.client);
        const subscriptions = await client.db
          .selectFrom('sync_subscription_state')
          .selectAll()
          .execute();

        const combined = await client.transport.sync({
          clientId: client.id,
          pull: {
            limitCommits: 100,
            subscriptions: subscriptions.map((s) => ({
              id: s.subscription_id,
              table: s.table,
              scopes: JSON.parse(s.scopes_json),
              params: JSON.parse(s.params_json),
              cursor: s.cursor,
              bootstrapState: s.bootstrap_state_json
                ? JSON.parse(s.bootstrap_state_json)
                : null,
            })),
          },
        });

        const response = combined.pull;
        if (!response) break;

        for (const sub of response.subscriptions) {
          for (const commit of sub.commits) {
            for (const change of commit.changes) {
              if (change.op === 'upsert' && change.row_json) {
                const row = change.row_json as Record<string, unknown>;
                try {
                  await client.db
                    .insertInto(change.table)
                    .values(row)
                    .execute();
                } catch {
                  await client.db
                    .updateTable(change.table)
                    .set(row)
                    .where('id', '=', change.row_id)
                    .execute();
                }
              } else if (change.op === 'delete') {
                await client.db
                  .deleteFrom(change.table)
                  .where('id', '=', change.row_id)
                  .execute();
              }
            }
          }

          await client.db
            .updateTable('sync_subscription_state')
            .set({
              cursor: sub.nextCursor,
              status: sub.status,
              updated_at: Date.now(),
            })
            .where('subscription_id', '=', sub.id)
            .execute();
        }
        break;
      }

      case 'wait': {
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        break;
      }

      case 'custom': {
        await action.fn();
        break;
      }
    }
  }

  private async verifyExpectation(
    expectation: ScenarioExpectation
  ): Promise<void> {
    const { expect } = await import('bun:test');

    switch (expectation.type) {
      case 'hasRow': {
        const client = this.getClient(expectation.client);
        const row = await client.db
          .selectFrom(expectation.table)
          .where('id', '=', expectation.rowId)
          .selectAll()
          .executeTakeFirst();

        expect(row).toBeDefined();

        if (expectation.values) {
          for (const [key, value] of Object.entries(expectation.values)) {
            expect((row as Record<string, unknown>)[key]).toEqual(value);
          }
        }
        break;
      }

      case 'noRow': {
        const client = this.getClient(expectation.client);
        const row = await client.db
          .selectFrom(expectation.table)
          .where('id', '=', expectation.rowId)
          .selectAll()
          .executeTakeFirst();

        expect(row).toBeUndefined();
        break;
      }

      case 'outboxEmpty': {
        const client = this.getClient(expectation.client);
        const count = await client.db
          .selectFrom('sync_outbox_commits')
          .where('status', '!=', 'acked')
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow();

        expect(Number(count.count)).toBe(0);
        break;
      }

      case 'outboxCount': {
        const client = this.getClient(expectation.client);
        const count = await client.db
          .selectFrom('sync_outbox_commits')
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow();

        expect(Number(count.count)).toBe(expectation.count);
        break;
      }

      case 'conflictCount': {
        const client = this.getClient(expectation.client);
        const count = await client.db
          .selectFrom('sync_conflicts')
          .where('resolved_at', 'is', null)
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow();

        expect(Number(count.count)).toBe(expectation.count);
        break;
      }

      case 'serverCommitCount': {
        if (!this.config.server) {
          throw new Error('Server not configured');
        }
        const count = await this.config.server.db
          .selectFrom('sync_commits')
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow();

        expect(Number(count.count)).toBe(expectation.count);
        break;
      }

      case 'custom': {
        await expectation.fn();
        break;
      }
    }
  }

  private getClient(name: string): ScenarioClient {
    const client = this.config.clients.get(name);
    if (!client) {
      throw new Error(`Client '${name}' not found`);
    }
    return client;
  }
}

// ============================================================================
// Expect Builder
// ============================================================================

class ExpectBuilder {
  constructor(
    private builder: ScenarioBuilder,
    private config: ScenarioConfig,
    private expectProxies: Map<string, ClientExpectProxy>
  ) {}

  /**
   * Get client expectation proxy.
   */
  client(name: string): ClientExpectProxy {
    const proxy = this.expectProxies.get(name);
    if (!proxy) {
      throw new Error(
        `Client '${name}' not found. Add it with addClient() first.`
      );
    }
    return proxy;
  }

  /**
   * Assert server commit count.
   */
  serverCommitCount(count: number): ScenarioBuilder {
    this.config.expectations.push({ type: 'serverCommitCount', count });
    return this.builder;
  }

  /**
   * Add a custom expectation.
   */
  that(fn: () => Promise<void>): ScenarioBuilder {
    this.config.expectations.push({ type: 'custom', fn });
    return this.builder;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new scenario builder.
 *
 * @example
 * const alice = await createTestClient('alice');
 * const bob = await createTestClient('bob');
 *
 * await scenario()
 *   .addClient('alice', alice)
 *   .addClient('bob', bob)
 *   .client('alice').insert('tasks', { id: '1', title: 'Task' })
 *   .client('alice').push()
 *   .client('bob').pull()
 *   .expect.client('bob').hasRow('tasks', '1')
 *   .run();
 */
export function scenario(): ScenarioBuilder {
  return new ScenarioBuilder();
}

import { afterEach, describe, expect, it } from 'bun:test';
import type {
  DatabaseConnection,
  Dialect,
  Driver,
  Kysely,
  QueryResult,
  TransactionSettings,
} from 'kysely';
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import type {
  ElectronAppLike,
  ElectronIpcMainEventLike,
  ElectronIpcMainLike,
  ElectronIpcRendererLike,
  ElectronSqliteBridge,
  ElectronSqliteExecuteRequest,
  ElectronSqliteExecuteResponse,
  ElectronSqliteWindowLike,
} from './index';
import {
  createElectronSqliteBridgeFromDialect,
  createElectronSqliteBridgeFromIpc,
  createElectronSqliteDb,
  createElectronSqliteDbFromWindow,
  registerElectronSqliteIpc,
} from './index';

interface TestDb {
  tasks: {
    id: string;
    title: string;
  };
}

class FakeIpcRenderer implements ElectronIpcRendererLike {
  readonly calls: Array<{ channel: string; args: readonly unknown[] }> = [];

  async invoke<TResult>(
    channel: string,
    ...args: readonly unknown[]
  ): Promise<TResult> {
    this.calls.push({ channel, args });

    if (channel === 'sqlite:open') {
      return { open: true } as TResult;
    }

    if (channel === 'sqlite:execute') {
      return {
        rows: [{ id: 'task-ipc', title: 'from-ipc' }],
        numAffectedRows: 1,
      } as TResult;
    }

    if (channel === 'sqlite:close') {
      return true as TResult;
    }

    throw new Error(`Unsupported channel "${channel}"`);
  }
}

type FakeIpcHandler = (
  event: ElectronIpcMainEventLike,
  ...args: readonly unknown[]
) => Promise<unknown> | unknown;

class FakeIpcMain implements ElectronIpcMainLike {
  readonly #handlers = new Map<string, FakeIpcHandler>();

  handle<TArgs extends readonly unknown[], TResult>(
    channel: string,
    listener: (
      event: ElectronIpcMainEventLike,
      ...args: TArgs
    ) => TResult | Promise<TResult>
  ): void {
    this.#handlers.set(
      channel,
      (event: ElectronIpcMainEventLike, ...args: readonly unknown[]) =>
        listener(event, ...(args as TArgs))
    );
  }

  async invoke<TResult>(
    channel: string,
    ...args: readonly unknown[]
  ): Promise<TResult> {
    const handler = this.#handlers.get(channel);
    if (!handler) {
      throw new Error(`Missing IPC handler for channel "${channel}"`);
    }

    const event: ElectronIpcMainEventLike = {};
    return (await handler(event, ...args)) as TResult;
  }
}

class FakeApp implements ElectronAppLike {
  readonly #willQuitListeners: Array<() => void> = [];

  on(event: 'will-quit', listener: () => void): void {
    if (event === 'will-quit') {
      this.#willQuitListeners.push(listener);
    }
  }

  emitWillQuit(): void {
    for (const listener of this.#willQuitListeners) {
      listener();
    }
  }
}

interface FakeDialectState {
  createDriverCalls: number;
  initCalls: number;
  acquireCalls: number;
  releaseCalls: number;
  destroyCalls: number;
  executedSql: string[];
}

class FakeDialectConnection implements DatabaseConnection {
  readonly #state: FakeDialectState;

  constructor(state: FakeDialectState) {
    this.#state = state;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    this.#state.executedSql.push(compiledQuery.sql);

    if (/^\s*select\b/i.test(compiledQuery.sql)) {
      return { rows: [{ id: 'task-main', title: 'from-main' }] as R[] };
    }

    return {
      rows: [],
      numAffectedRows: 1n,
      insertId: 9007199254740993n,
    };
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiledQuery);
  }
}

class FakeDialectDriver implements Driver {
  readonly #state: FakeDialectState;
  readonly #connection: FakeDialectConnection;

  constructor(state: FakeDialectState) {
    this.#state = state;
    this.#connection = new FakeDialectConnection(state);
  }

  async init(): Promise<void> {
    this.#state.initCalls += 1;
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    this.#state.acquireCalls += 1;
    return this.#connection;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    this.#state.releaseCalls += 1;
  }

  async destroy(): Promise<void> {
    this.#state.destroyCalls += 1;
  }
}

function createFakeDialect(state: FakeDialectState): Dialect {
  return {
    createDriver: () => {
      state.createDriverCalls += 1;
      return new FakeDialectDriver(state);
    },
    createAdapter: () => new SqliteAdapter(),
    createQueryCompiler: () => new SqliteQueryCompiler(),
    createIntrospector: (db: Kysely<unknown>) => new SqliteIntrospector(db),
  } satisfies Dialect;
}

describe('electron sqlite dialect', () => {
  let db: Kysely<TestDb> | undefined;

  afterEach(async () => {
    if (!db) {
      return;
    }
    await db.destroy();
    db = undefined;
  });

  it('executes UPDATE ... RETURNING through bridge and opens once', async () => {
    let openCalls = 0;
    let closeCalls = 0;
    const sqlLog: string[] = [];

    const bridge: ElectronSqliteBridge = {
      open: async () => {
        openCalls += 1;
        return { open: true };
      },
      execute: async <Row>(request: ElectronSqliteExecuteRequest) => {
        sqlLog.push(request.sql);
        if (/\breturning\b/i.test(request.sql)) {
          const rows = [{ id: 'task-1', title: 'after' }];
          return {
            rows: rows as Row[],
            numAffectedRows: rows.length,
          };
        }
        return { rows: [], numAffectedRows: 1 };
      },
      close: async () => {
        closeCalls += 1;
      },
    };

    db = createElectronSqliteDb<TestDb>(bridge);

    const updated = await db
      .updateTable('tasks')
      .set({ title: 'after' })
      .where('id', '=', 'task-1')
      .returning(['id', 'title'])
      .executeTakeFirstOrThrow();

    expect(updated).toEqual({ id: 'task-1', title: 'after' });
    expect(sqlLog).toHaveLength(1);
    expect(openCalls).toBe(1);

    await db.destroy();
    db = undefined;

    expect(closeCalls).toBe(1);
  });

  it('resolves bridge from window.electronAPI using bridgeKey', async () => {
    const bridge: ElectronSqliteBridge = {
      execute: async <Row>(_request: ElectronSqliteExecuteRequest) => ({
        rows: [{ id: 'task-window', title: 'from-window' }] as Row[],
      }),
    };

    const windowLike: ElectronSqliteWindowLike = {
      electronAPI: { app: bridge },
    };

    db = createElectronSqliteDbFromWindow<TestDb>({
      bridgeKey: 'app',
      window: windowLike,
    });

    const row = await db
      .selectFrom('tasks')
      .select(['id', 'title'])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ id: 'task-window', title: 'from-window' });
  });
});

describe('electron sqlite bridge helpers', () => {
  it('adapts an existing Kysely dialect for main-process execution', async () => {
    const state: FakeDialectState = {
      createDriverCalls: 0,
      initCalls: 0,
      acquireCalls: 0,
      releaseCalls: 0,
      destroyCalls: 0,
      executedSql: [],
    };

    const bridge = createElectronSqliteBridgeFromDialect({
      dialect: createFakeDialect(state),
      openResult: { open: true, path: '/tmp/app.sqlite' },
    });

    const selectResult = await bridge.execute<{ id: string; title: string }>({
      sql: 'select id, title from tasks',
      parameters: [],
    });
    const writeResult = await bridge.execute({
      sql: 'insert into tasks(id, title) values (?, ?)',
      parameters: ['task-2', 'hello'],
    });

    expect(selectResult.rows).toEqual([
      { id: 'task-main', title: 'from-main' },
    ]);
    expect(writeResult.numAffectedRows).toBe(1);
    expect(writeResult.insertId).toBe('9007199254740993');
    expect(state.initCalls).toBe(1);
    expect(state.acquireCalls).toBe(1);
    expect(state.executedSql).toEqual([
      'select id, title from tasks',
      'insert into tasks(id, title) values (?, ?)',
    ]);

    const openResult = await bridge.open?.();
    expect(openResult).toEqual({ open: true, path: '/tmp/app.sqlite' });
    expect(state.createDriverCalls).toBe(1);

    await bridge.close?.();
    expect(state.releaseCalls).toBe(1);
    expect(state.destroyCalls).toBe(1);
  });

  it('creates bridge from ipcRenderer.invoke channels', async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const bridge = createElectronSqliteBridgeFromIpc({
      ipcRenderer,
      openChannel: 'sqlite:open',
      executeChannel: 'sqlite:execute',
      closeChannel: 'sqlite:close',
    });

    await bridge.open?.();
    const result = await bridge.execute<{ id: string; title: string }>({
      sql: 'select id, title from tasks',
      parameters: [],
    });
    await bridge.close?.();

    expect(result.rows).toEqual([{ id: 'task-ipc', title: 'from-ipc' }]);
    expect(ipcRenderer.calls.map((call) => call.channel)).toEqual([
      'sqlite:open',
      'sqlite:execute',
      'sqlite:close',
    ]);
  });

  it('defaults executeChannel to sqlite:execute when omitted', async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const bridge = createElectronSqliteBridgeFromIpc({
      ipcRenderer,
    });

    const result = await bridge.execute<{ id: string; title: string }>({
      sql: 'select id, title from tasks',
      parameters: [],
    });

    expect(result.rows).toEqual([{ id: 'task-ipc', title: 'from-ipc' }]);
    expect(ipcRenderer.calls.map((call) => call.channel)).toEqual([
      'sqlite:execute',
    ]);
  });

  it('registers main-process IPC handlers with auto-open', async () => {
    const ipcMain = new FakeIpcMain();
    const app = new FakeApp();

    let openCalls = 0;
    let executeCalls = 0;
    let closeCalls = 0;

    registerElectronSqliteIpc({
      ipcMain,
      app,
      bridge: {
        open: async () => {
          openCalls += 1;
          return { open: true };
        },
        execute: async <Row>(request: ElectronSqliteExecuteRequest) => {
          executeCalls += 1;
          return { rows: [{ sql: request.sql }] as Row[], numAffectedRows: 1 };
        },
        close: async () => {
          closeCalls += 1;
        },
      },
    });

    const response = await ipcMain.invoke<
      ElectronSqliteExecuteResponse<{ sql: string }>
    >('sqlite:execute', {
      sql: 'select 1',
      parameters: [],
    });

    expect(response.rows).toEqual([{ sql: 'select 1' }]);
    expect(openCalls).toBe(1);
    expect(executeCalls).toBe(1);

    await ipcMain.invoke<boolean>('sqlite:close');
    expect(closeCalls).toBe(1);

    app.emitWillQuit();
    expect(closeCalls).toBe(2);
  });
});

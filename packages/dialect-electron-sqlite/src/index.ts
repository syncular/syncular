/**
 * @syncular/dialect-electron-sqlite - Electron IPC SQLite dialect for sync
 *
 * Provides a Kysely SQLite dialect for Electron renderer processes that
 * execute SQL through an IPC bridge exposed by preload.
 *
 * This keeps database access in the Electron main process while preserving a
 * standard Kysely API in renderer code.
 */

import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from 'kysely';
import {
  CompiledQuery,
  type Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';

export type ElectronSqliteInteger = bigint | number | string;

export interface ElectronSqliteExecuteRequest {
  sql: string;
  parameters: readonly unknown[];
}

export interface ElectronSqliteExecuteResponse<Row = Record<string, unknown>> {
  rows: Row[];
  numAffectedRows?: ElectronSqliteInteger;
  insertId?: ElectronSqliteInteger | null;
}

export type ElectronSqliteOpenResult =
  | undefined
  | {
      open?: boolean;
      path?: string;
      version?: string | null;
      [key: string]: boolean | number | string | null | undefined;
    };

export interface ElectronSqliteBridge {
  open?(): Promise<ElectronSqliteOpenResult> | ElectronSqliteOpenResult;
  execute<Row = Record<string, unknown>>(
    request: ElectronSqliteExecuteRequest
  ):
    | Promise<ElectronSqliteExecuteResponse<Row>>
    | ElectronSqliteExecuteResponse<Row>;
  close?(): Promise<void> | void;
}

export type ElectronSqliteOptions = ElectronSqliteBridge;

export interface ElectronSqliteWindowLike {
  electronAPI?: Record<string, ElectronSqliteBridge | undefined>;
}

export interface ElectronSqliteWindowOptions {
  bridgeKey?: string;
  window?: ElectronSqliteWindowLike;
}

export interface ElectronIpcRendererLike {
  invoke<TResult>(
    channel: string,
    ...args: readonly unknown[]
  ): Promise<TResult>;
}

export interface ElectronSqliteBridgeFromIpcOptions {
  ipcRenderer: ElectronIpcRendererLike;
  executeChannel?: string;
  openChannel?: string;
  closeChannel?: string;
}

export interface ElectronSqliteBridgeFromDialectOptions {
  dialect: Dialect;
  openResult?: Exclude<ElectronSqliteOpenResult, undefined>;
}

export type ElectronIpcMainEventLike = object;

export interface ElectronIpcMainLike {
  handle<TArgs extends readonly unknown[], TResult>(
    channel: string,
    listener: (
      event: ElectronIpcMainEventLike,
      ...args: TArgs
    ) => TResult | Promise<TResult>
  ): void;
}

export interface ElectronAppLike {
  on(event: 'will-quit', listener: () => void): void;
}

export interface ElectronSqliteIpcChannels {
  open: string;
  execute: string;
  close: string;
}

export interface RegisterElectronSqliteIpcOptions {
  ipcMain: ElectronIpcMainLike;
  bridge: ElectronSqliteBridge;
  channels?: Partial<ElectronSqliteIpcChannels>;
  autoOpen?: boolean;
  app?: ElectronAppLike;
}

const DEFAULT_WINDOW_BRIDGE_KEY = 'sqlite';

const DEFAULT_ELECTRON_SQLITE_CHANNELS: ElectronSqliteIpcChannels = {
  open: 'sqlite:open',
  execute: 'sqlite:execute',
  close: 'sqlite:close',
};

const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Create the Electron IPC SQLite dialect directly.
 */
export function createElectronSqliteDialect(
  options: ElectronSqliteOptions
): ElectronSqliteDialect {
  return new ElectronSqliteDialect(options);
}

/**
 * Create the Electron dialect using `window.electronAPI[bridgeKey]`.
 *
 * `bridgeKey` defaults to `sqlite`.
 */
export function createElectronSqliteDialectFromWindow(
  options: ElectronSqliteWindowOptions = {}
): ElectronSqliteDialect {
  return createElectronSqliteDialect(resolveWindowBridge(options));
}

/**
 * Build an Electron SQLite bridge from `ipcRenderer.invoke(...)`.
 *
 * `executeChannel` defaults to `sqlite:execute`.
 */
export function createElectronSqliteBridgeFromIpc(
  options: ElectronSqliteBridgeFromIpcOptions
): ElectronSqliteBridge {
  const {
    ipcRenderer,
    executeChannel = DEFAULT_ELECTRON_SQLITE_CHANNELS.execute,
    openChannel,
    closeChannel,
  } = options;

  const bridge: ElectronSqliteBridge = {
    execute: <Row>(request: ElectronSqliteExecuteRequest) =>
      ipcRenderer.invoke<ElectronSqliteExecuteResponse<Row>>(
        executeChannel,
        request
      ),
  };

  if (openChannel) {
    bridge.open = () =>
      ipcRenderer.invoke<ElectronSqliteOpenResult>(openChannel);
  }

  if (closeChannel) {
    bridge.close = async () => {
      await ipcRenderer.invoke<boolean>(closeChannel);
    };
  }

  return bridge;
}

/**
 * Build an Electron SQLite bridge from a Kysely dialect in main process.
 *
 * This allows renderer IPC queries to reuse existing SQLite dialects such as:
 * - `@syncular/dialect-better-sqlite3`
 * - `@syncular/dialect-sqlite3`
 * - `@syncular/dialect-libsql`
 *
 * The bridge keeps a single acquired connection for its lifetime so
 * transaction statements (`BEGIN` / `COMMIT` / `ROLLBACK`) stay on the same
 * connection.
 */
export function createElectronSqliteBridgeFromDialect(
  options: ElectronSqliteBridgeFromDialectOptions
): ElectronSqliteBridge {
  return new DialectBackedElectronSqliteBridge(options);
}

/**
 * Register standard Electron IPC handlers for a SQLite bridge.
 *
 * This helper enables a pluggable main-process backend: any adapter that
 * implements `open/execute/close` can be exposed to renderer code through one
 * channel contract.
 */
export function registerElectronSqliteIpc(
  options: RegisterElectronSqliteIpcOptions
): ElectronSqliteIpcChannels {
  const channels: ElectronSqliteIpcChannels = {
    ...DEFAULT_ELECTRON_SQLITE_CHANNELS,
    ...options.channels,
  };
  const autoOpen = options.autoOpen ?? true;
  let isOpen = false;

  const open = async (): Promise<ElectronSqliteOpenResult> => {
    if (isOpen) {
      return { open: true };
    }

    if (!options.bridge.open) {
      isOpen = true;
      return { open: true };
    }

    const result = await options.bridge.open();
    isOpen = true;
    return result;
  };

  options.ipcMain.handle<[], ElectronSqliteOpenResult>(
    channels.open,
    async () => open()
  );

  options.ipcMain.handle<
    [ElectronSqliteExecuteRequest],
    ElectronSqliteExecuteResponse
  >(channels.execute, async (_event, request) => {
    if (autoOpen && !isOpen) {
      await open();
    }
    return options.bridge.execute(request);
  });

  options.ipcMain.handle<[], boolean>(channels.close, async () => {
    if (options.bridge.close) {
      await options.bridge.close();
    }
    isOpen = false;
    return true;
  });

  if (options.app) {
    options.app.on('will-quit', () => {
      if (!options.bridge.close) {
        return;
      }
      Promise.resolve(options.bridge.close()).catch(() => undefined);
    });
  }

  return channels;
}

class DialectBackedElectronSqliteBridge implements ElectronSqliteBridge {
  readonly #dialect: Dialect;
  readonly #openResult: Exclude<ElectronSqliteOpenResult, undefined>;
  readonly #mutex = new ConnectionMutex();

  #driver: Driver | undefined;
  #connection: DatabaseConnection | undefined;
  #opened = false;

  constructor(options: ElectronSqliteBridgeFromDialectOptions) {
    this.#dialect = options.dialect;
    this.#openResult = options.openResult ?? { open: true };
  }

  async open(): Promise<ElectronSqliteOpenResult> {
    await this.#mutex.lock();
    try {
      await this.#ensureOpenLocked();
      return this.#openResult;
    } finally {
      this.#mutex.unlock();
    }
  }

  async execute<Row = Record<string, unknown>>(
    request: ElectronSqliteExecuteRequest
  ): Promise<ElectronSqliteExecuteResponse<Row>> {
    await this.#mutex.lock();
    try {
      await this.#ensureOpenLocked();

      const connection = this.#connection;
      if (!connection) {
        throw new Error('SQLite connection was not initialized');
      }

      const result = await connection.executeQuery<Row>(
        CompiledQuery.raw(request.sql, [...request.parameters])
      );
      const numAffectedRows = toWireInteger(result.numAffectedRows);
      const insertId = toWireInteger(result.insertId);

      return {
        rows: result.rows,
        ...(numAffectedRows === undefined ? {} : { numAffectedRows }),
        ...(insertId === undefined ? {} : { insertId }),
      };
    } finally {
      this.#mutex.unlock();
    }
  }

  async close(): Promise<void> {
    await this.#mutex.lock();
    try {
      if (!this.#opened) {
        return;
      }

      const connection = this.#connection;
      const driver = this.#driver;

      this.#connection = undefined;
      this.#driver = undefined;
      this.#opened = false;

      if (driver && connection) {
        await driver.releaseConnection(connection);
      }

      if (driver) {
        await driver.destroy();
      }
    } finally {
      this.#mutex.unlock();
    }
  }

  async #ensureOpenLocked(): Promise<void> {
    if (this.#opened) {
      return;
    }

    const driver = this.#dialect.createDriver();

    try {
      await driver.init();
      const connection = await driver.acquireConnection();

      this.#driver = driver;
      this.#connection = connection;
      this.#opened = true;
    } catch (error) {
      await driver.destroy().catch(() => undefined);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Kysely Dialect implementation for Electron IPC SQLite
// ---------------------------------------------------------------------------

class ElectronSqliteDialect implements Dialect {
  readonly #options: ElectronSqliteOptions;

  constructor(options: ElectronSqliteOptions) {
    this.#options = options;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new ElectronSqliteDriver(this.#options);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class ElectronSqliteDriver implements Driver {
  readonly #bridge: ElectronSqliteBridge;
  readonly #connectionMutex = new ConnectionMutex();
  readonly #connection: ElectronSqliteConnection;

  #opened = false;

  constructor(bridge: ElectronSqliteBridge) {
    this.#bridge = bridge;
    this.#connection = new ElectronSqliteConnection(bridge.execute);
  }

  async init(): Promise<void> {
    await this.#ensureOpen();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#connectionMutex.lock();
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
    this.#connectionMutex.unlock();
  }

  async destroy(): Promise<void> {
    if (this.#bridge.close) {
      await this.#bridge.close();
    }
    this.#opened = false;
  }

  async #ensureOpen(): Promise<void> {
    if (this.#opened) {
      return;
    }

    if (this.#bridge.open) {
      await this.#bridge.open();
    }

    this.#opened = true;
  }
}

class ElectronSqliteConnection implements DatabaseConnection {
  readonly #execute: ElectronSqliteBridge['execute'];

  constructor(execute: ElectronSqliteBridge['execute']) {
    this.#execute = execute;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const response = await this.#execute<R>({
      sql: compiledQuery.sql,
      parameters: compiledQuery.parameters,
    });

    const hasReturning = /\breturning\b/i.test(compiledQuery.sql);
    const numAffectedRows = toBigInt(
      response.numAffectedRows ??
        (hasReturning ? response.rows.length : undefined)
    );
    const insertId = toBigInt(response.insertId);

    return {
      rows: response.rows,
      ...(numAffectedRows === undefined ? {} : { numAffectedRows }),
      ...(insertId === undefined ? {} : { insertId }),
    };
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiledQuery);
  }
}

class ConnectionMutex {
  #promise: Promise<void> | undefined;
  #resolve: (() => void) | undefined;

  async lock(): Promise<void> {
    while (this.#promise) {
      await this.#promise;
    }

    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}

function toBigInt(
  value: ElectronSqliteInteger | null | undefined
): bigint | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`Expected integer number but received: ${value}`);
    }
    return BigInt(value);
  }

  if (!INTEGER_PATTERN.test(value)) {
    throw new Error(`Expected integer string but received: ${value}`);
  }

  return BigInt(value);
}

function toWireInteger(
  value: bigint | undefined
): ElectronSqliteInteger | undefined {
  if (value === undefined) {
    return undefined;
  }

  const asNumber = Number(value);
  if (Number.isSafeInteger(asNumber)) {
    return asNumber;
  }

  return value.toString();
}

function resolveWindowBridge(
  options: ElectronSqliteWindowOptions
): ElectronSqliteBridge {
  const bridgeKey = options.bridgeKey ?? DEFAULT_WINDOW_BRIDGE_KEY;
  const windowRef = resolveWindowRef(options.window);
  const bridge = windowRef.electronAPI?.[bridgeKey];

  if (!bridge) {
    throw new Error(
      `Electron sqlite API not available at window.electronAPI.${bridgeKey}`
    );
  }

  return bridge;
}

function resolveWindowRef(
  explicitWindow: ElectronSqliteWindowLike | undefined
): ElectronSqliteWindowLike {
  if (explicitWindow) {
    return explicitWindow;
  }

  if (typeof window === 'undefined') {
    throw new Error(
      'window is not available. Pass options.window explicitly in non-renderer environments.'
    );
  }

  return window;
}

declare global {
  interface Window extends ElectronSqliteWindowLike {}
}

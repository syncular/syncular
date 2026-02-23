/**
 * Electron runtime bridge test (simulated IPC).
 *
 * Proves renderer/main-process IPC flow using:
 * - renderer: createElectronSqliteDb + createElectronSqliteBridgeFromIpc
 * - main: registerElectronSqliteIpc + createElectronSqliteBridgeFromDialect
 * - backend dialect: sqlite3
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createElectronSqliteBridgeFromDialect,
  createElectronSqliteBridgeFromIpc,
  createElectronSqliteDb,
  type ElectronIpcMainEventLike,
  type ElectronIpcMainLike,
  type ElectronIpcRendererLike,
  registerElectronSqliteIpc,
} from '@syncular/dialect-electron-sqlite';
import { createSqlite3Dialect } from '@syncular/dialect-sqlite3';

interface RuntimeDb {
  tasks: {
    id: string;
    title: string;
  };
}

type IpcHandler = (
  event: ElectronIpcMainEventLike,
  ...args: readonly unknown[]
) => Promise<unknown> | unknown;

class InMemoryIpcMain implements ElectronIpcMainLike {
  readonly #handlers = new Map<string, IpcHandler>();

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
    return (await handler({}, ...args)) as TResult;
  }
}

class InMemoryIpcRenderer implements ElectronIpcRendererLike {
  readonly #ipcMain: InMemoryIpcMain;

  constructor(ipcMain: InMemoryIpcMain) {
    this.#ipcMain = ipcMain;
  }

  invoke<TResult>(
    channel: string,
    ...args: readonly unknown[]
  ): Promise<TResult> {
    return this.#ipcMain.invoke<TResult>(channel, ...args);
  }
}

const runtimeDbFile = path.join(
  tmpdir(),
  `syncular-electron-runtime-${crypto.randomUUID()}.sqlite`
);

afterAll(() => {
  rmSync(runtimeDbFile, { force: true });
});

describe('Electron runtime bridge (IPC + main-process dialect)', () => {
  it('executes queries through IPC and preserves transaction rollback', async () => {
    const ipcMain = new InMemoryIpcMain();
    const ipcRenderer = new InMemoryIpcRenderer(ipcMain);

    registerElectronSqliteIpc({
      ipcMain,
      bridge: createElectronSqliteBridgeFromDialect({
        dialect: createSqlite3Dialect({ path: runtimeDbFile }),
        openResult: { open: true, path: runtimeDbFile },
      }),
      channels: {
        open: 'electron:test:open',
        execute: 'electron:test:execute',
        close: 'electron:test:close',
      },
    });

    const db = createElectronSqliteDb<RuntimeDb>(
      createElectronSqliteBridgeFromIpc({
        ipcRenderer,
        openChannel: 'electron:test:open',
        executeChannel: 'electron:test:execute',
        closeChannel: 'electron:test:close',
      })
    );

    try {
      await db.schema
        .createTable('tasks')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('title', 'text', (col) => col.notNull())
        .execute();

      await db
        .insertInto('tasks')
        .values({ id: 'task-1', title: 'before' })
        .execute();

      await expect(
        db.transaction().execute(async (trx) => {
          await trx
            .updateTable('tasks')
            .set({ title: 'inside-tx' })
            .where('id', '=', 'task-1')
            .execute();
          throw new Error('rollback-intentional');
        })
      ).rejects.toThrow('rollback-intentional');

      const row = await db
        .selectFrom('tasks')
        .select(['id', 'title'])
        .where('id', '=', 'task-1')
        .executeTakeFirstOrThrow();

      // Confirms BEGIN/ROLLBACK were executed against the same backend connection.
      expect(row).toEqual({ id: 'task-1', title: 'before' });
    } finally {
      await db.destroy();
    }
  });
});

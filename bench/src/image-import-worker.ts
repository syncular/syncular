/**
 * Browser half of the image import lane: a module worker imports the images
 * into the production OPFS SAH-pool replica and reports the lane result, the
 * VFS write/sync totals the vendor shim recorded, and the origin's storage
 * estimate while the replica is open and after it closed.
 */
import { openPersistentWasmDatabase } from '../../packages/web-client/src/wasm-database';
import { runImageImport, type LaneImage } from './image-import-fixture';

interface VfsTotals {
  xWrite: { ms: number; calls: number; bytes: number };
  xSync: { ms: number; calls: number };
}

const scope = globalThis as typeof globalThis & {
  __vfs?: VfsTotals;
  postMessage(message: unknown): void;
};

async function opfsFiles(): Promise<Record<string, number>> {
  const files: Record<string, number> = {};
  const walk = async (directory: FileSystemDirectoryHandle, path: string) => {
    for await (const [name, handle] of (
      directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }
    ).entries()) {
      if (handle.kind === 'directory')
        await walk(handle as FileSystemDirectoryHandle, `${path}/${name}`);
      else
        files[`${path}/${name}`] = (
          await (handle as FileSystemFileHandle).getFile()
        ).size;
    }
  };
  await walk(await navigator.storage.getDirectory(), '');
  return files;
}

scope.onmessage = async (event: MessageEvent) => {
  try {
    const { images } = event.data as {
      images: readonly Omit<LaneImage, 'bytes'>[];
    };
    const loaded: LaneImage[] = [];
    for (const image of images)
      loaded.push({
        ...image,
        bytes: new Uint8Array(
          await (await fetch(`/image/${image.table}`)).arrayBuffer(),
        ),
      });
    const database = await openPersistentWasmDatabase('image-lane');
    const before = structuredClone(scope.__vfs);
    const result = await runImageImport(database, loaded);
    const after = scope.__vfs!;
    const usageOpen = (await navigator.storage.estimate()).usage;
    const filesOpen = await opfsFiles();
    database.close();
    const usageClosed = (await navigator.storage.estimate()).usage;
    scope.postMessage({
      t: 'done',
      value: {
        result,
        vfs: {
          writeMs: after.xWrite.ms - (before?.xWrite.ms ?? 0),
          writeCalls: after.xWrite.calls - (before?.xWrite.calls ?? 0),
          writtenBytes: after.xWrite.bytes - (before?.xWrite.bytes ?? 0),
          syncMs: after.xSync.ms - (before?.xSync.ms ?? 0),
          syncCalls: after.xSync.calls - (before?.xSync.calls ?? 0),
        },
        usageOpen,
        usageClosed,
        filesOpen,
        filesClosed: await opfsFiles(),
      },
    });
  } catch (error) {
    scope.postMessage({
      t: 'error',
      message:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};

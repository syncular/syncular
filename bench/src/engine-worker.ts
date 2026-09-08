import {
  CString,
  dlopen,
  JSCallback,
  ptr,
  toArrayBuffer,
  type Pointer,
} from 'bun:ffi';
import { processObject } from './process-driver';

// This callback runs synchronously on the Bun worker that owns the Rust client.
// The main thread publishes the response before waking it. It never writes this
// buffer again until the worker submits its next request.
self.onmessage = ({ data }: MessageEvent<unknown>) => {
  const setup = processObject(data);
  if (
    !(setup.shared instanceof SharedArrayBuffer) ||
    typeof setup.library !== 'string'
  )
    throw new Error('Invalid engine worker setup');
  const control = new Int32Array(setup.shared, 0, 4);
  const response = new Uint8Array(setup.shared, 16);
  const library = dlopen(setup.library, {
    syncular_bench_engine_new: {
      args: ['function', 'ptr', 'u32'],
      returns: 'ptr',
    },
    syncular_bench_engine_command: { args: ['ptr', 'cstring'], returns: 'ptr' },
    syncular_bench_engine_close: { args: ['ptr'], returns: 'i32' },
    syncular_bench_engine_free: { args: ['ptr'], returns: 'void' },
  });
  let sequence = 0;
  const callback = new JSCallback(
    (method: number, pointer: Pointer, length: number) => {
      try {
        const bytes = length
          ? new Uint8Array(toArrayBuffer(pointer, 0, length)).slice()
          : new Uint8Array();
        const id = ++sequence;
        Atomics.store(control, 0, 0);
        postMessage({ host: id, method, bytes }, [bytes.buffer]);
        // Deadlines live on the main thread, where the async server runs. A single
        // publisher wins there; a late server result cannot overwrite this buffer.
        while (Atomics.load(control, 0) !== id) Atomics.wait(control, 0, 0);
        return Atomics.load(control, 1);
      } catch {
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            code: 'bench.callback_failed',
            message: 'Engine callback failed',
          }),
        );
        response.set(bytes);
        return -(bytes.length + 1);
      }
    },
    { args: ['u32', 'ptr', 'u32'], returns: 'i32' },
  );
  const handle = library.symbols.syncular_bench_engine_new(
    callback.ptr,
    ptr(response),
    response.length,
  );
  if (!handle) {
    callback.close();
    library.close();
    throw new Error('Engine handle creation failed');
  }
  self.onmessage = ({ data }: MessageEvent<unknown>) => {
    const message = processObject(data);
    if (message.close === true) {
      const result = library.symbols.syncular_bench_engine_close(handle);
      callback.close();
      library.close();
      postMessage({ closed: result });
      self.close();
      return;
    }
    let result;
    try {
      const request = Buffer.from(
        `${JSON.stringify({ method: message.method, params: message.params })}\0`,
      );
      const pointer = library.symbols.syncular_bench_engine_command(
        handle,
        request,
      );
      if (!pointer) throw new Error('Engine command returned no response');
      try {
        result = JSON.parse(new CString(pointer).toString());
      } finally {
        library.symbols.syncular_bench_engine_free(pointer);
      }
    } catch (error) {
      result = {
        error: { code: 'bench.worker_failed', message: String(error) },
      };
    }
    postMessage({ id: message.id, envelope: result });
  };
  postMessage({ ready: true });
};

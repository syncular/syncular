export interface AsyncDisposableResource<T> {
  value: T;
  dispose: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

export type ResourceRunner<T, TResult> =
  | ((value: T) => Promise<TResult>)
  | ((value: T) => TResult);

export function createAsyncDisposableResource<T>(
  value: T,
  dispose: () => Promise<void> | void
): AsyncDisposableResource<T> {
  let disposed = false;

  const disposeOnce = async () => {
    if (disposed) {
      return;
    }

    disposed = true;
    await dispose();
  };

  return {
    value,
    dispose: disposeOnce,
    [Symbol.asyncDispose]: disposeOnce,
  };
}

export async function withAsyncDisposableResource<T, TResult>(
  resource: AsyncDisposableResource<T>,
  run: ResourceRunner<T, TResult>
): Promise<TResult> {
  try {
    return await run(resource.value);
  } finally {
    await resource.dispose();
  }
}

export async function withAsyncDisposableFactory<T, TResult>(
  create: () => Promise<AsyncDisposableResource<T>>,
  run: ResourceRunner<T, TResult>
): Promise<TResult> {
  const resource = await create();
  return withAsyncDisposableResource(resource, run);
}

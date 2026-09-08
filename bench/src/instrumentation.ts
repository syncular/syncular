export interface MethodMeasurement {
  calls: number;
  elapsedMs: number;
  failures: number;
  rowsReturned?: number;
  /** Async calls started in this collection epoch and not yet settled. */
  pending?: number;
  /** Maximum pending async calls for this method or SQL shape. */
  maxPending?: number;
  /** Calls started while an earlier async call was still pending. */
  overlappingCalls?: number;
}

/** Inclusive method durations; nested phases must not be summed. */
export function measureMethods<T extends object>(
  target: T,
  measurements: Record<string, MethodMeasurement>,
  prefix: string,
  includeSql = false,
): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== 'function' || typeof key !== 'string') return value;
      return (...args: unknown[]) => {
        const name = `${prefix}.${key}`;
        const names = [name];
        // SQL shapes exclude bound values and share the method's elapsed time.
        // Only clientSqlite.run takes SQL; prepared-statement run takes bindings.
        if (
          includeSql &&
          (key === 'query' ||
            key === 'exec' ||
            (prefix === 'clientSqlite' && key === 'run')) &&
          typeof args[0] === 'string'
        )
          names.push(`${name}: ${args[0].replace(/\s+/g, ' ').trim()}`);
        const records = names.map((name) => {
          const measurement = (measurements[name] ??= {
            calls: 0,
            elapsedMs: 0,
            failures: 0,
          });
          measurement.calls++;
          return measurement;
        });
        const started = performance.now();
        try {
          const result: unknown = Reflect.apply(value, object, args);
          if (result instanceof Promise) {
            for (const measurement of records) {
              measurement.overlappingCalls =
                (measurement.overlappingCalls ?? 0) +
                ((measurement.pending ?? 0) > 0 ? 1 : 0);
              measurement.pending = (measurement.pending ?? 0) + 1;
              measurement.maxPending = Math.max(
                measurement.maxPending ?? 0,
                measurement.pending,
              );
            }
            return result.then(
              (resolved: unknown) => {
                const elapsedMs = performance.now() - started;
                for (const measurement of records) {
                  measurement.pending!--;
                  measurement.elapsedMs += elapsedMs;
                  if (includeSql && key === 'query' && Array.isArray(resolved))
                    measurement.rowsReturned =
                      (measurement.rowsReturned ?? 0) + resolved.length;
                }
                if (
                  key === 'begin' &&
                  typeof resolved === 'object' &&
                  resolved !== null
                ) {
                  return measureMethods(
                    resolved,
                    measurements,
                    'transaction',
                    includeSql,
                  );
                }
                return resolved;
              },
              (error: unknown) => {
                const elapsedMs = performance.now() - started;
                for (const measurement of records) {
                  measurement.pending!--;
                  measurement.elapsedMs += elapsedMs;
                  measurement.failures++;
                }
                throw error;
              },
            );
          }
          const elapsedMs = performance.now() - started;
          for (const measurement of records) {
            measurement.elapsedMs += elapsedMs;
            if (includeSql && key === 'query' && Array.isArray(result))
              measurement.rowsReturned =
                (measurement.rowsReturned ?? 0) + result.length;
          }
          if (
            prefix === 'serverDatabase' &&
            key === 'query' &&
            typeof result === 'object' &&
            result !== null
          ) {
            return measureMethods(
              result,
              measurements,
              'serverStatement',
              includeSql,
            );
          }
          return result;
        } catch (error) {
          const elapsedMs = performance.now() - started;
          for (const measurement of records) {
            measurement.elapsedMs += elapsedMs;
            measurement.failures++;
          }
          throw error;
        }
      };
    },
  });
}

/** Deadlines fail a benchmark attempt; readiness still comes from client events. */
export async function withinDeadline<T>(
  operation: Promise<T>,
  label: string,
  milliseconds = 120_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Benchmark deadline exceeded: ${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

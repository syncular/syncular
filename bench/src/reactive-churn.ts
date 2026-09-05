/** Browser workload for observer ownership. Bundle for the browser, import it,
 * run churn, collect garbage, then inspect Runtime.getHeapUsage through CDP.
 * Keep the returned store alive until after the heap measurement. */
import {
  ReactiveClientStore,
  type ClientChangeListener,
  type QuerySnapshot,
  type QueryReadSpec,
  type ReactiveQueryClient,
} from '@syncular/client';

export async function reactiveChurn(count = 10_000) {
  let change: ClientChangeListener | undefined;
  let revision = 1n;
  const client: ReactiveQueryClient = {
    onChange(listener) {
      change = listener;
      return () => {
        change = undefined;
      };
    },
    querySnapshot<Row>(spec: QueryReadSpec): QuerySnapshot<Row> {
      const rows = Array.from({ length: 10 }, (_, index) => ({
        id: `${spec.params?.[0]}:${index}`,
        title: 'x'.repeat(200),
      }));
      return {
        revision,
        rows: rows as Row[],
        coverage: { complete: true, pending: [], missing: [] },
      };
    },
    statusSnapshot: () => ({
      currentSchemaVersion: 1,
      outbox: 0,
      upgrading: false,
      leaseState: undefined,
      schemaFloor: undefined,
      syncNeeded: false,
    }),
    conflicts: () => [],
    rejections: () => [],
    commitOutcomes: () => [],
    setWindow: () => undefined,
    windowState: () => ({ units: [], pending: [] }),
  };
  const store = new ReactiveClientStore(client);
  const spec = {
    id: 'churn',
    sql: 'SELECT id, title FROM tasks WHERE project_id = ?',
    dependencies: [{ table: 'tasks' }],
  };
  store.query({ ...spec, params: ['active'] }).subscribe(() => undefined);
  for (let index = 0; index < count; index += 1) {
    const entry = store.query({ ...spec, params: [String(index)] });
    const off = index % 2 === 0 ? entry.subscribe(() => undefined) : undefined;
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    off?.();
  }
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  const dispatchMs: number[] = [];
  for (let index = 0; index < 200; index += 1) {
    revision += 1n;
    const start = performance.now();
    change?.({
      revision,
      tables: [{ table: 'tasks' }],
      windows: [],
      conflictsChanged: false,
      rejectionsChanged: false,
      outcomesChanged: false,
    });
    dispatchMs.push(performance.now() - start);
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  }
  dispatchMs.sort((left, right) => left - right);
  return {
    store,
    p50Ms: dispatchMs[100],
    p95Ms: dispatchMs[190],
    totalMs: dispatchMs.reduce((sum, value) => sum + value, 0),
  };
}

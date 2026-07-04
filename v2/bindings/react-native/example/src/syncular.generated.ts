/**
 * A hand-written stand-in for what `@syncular-v2/typegen` emits from an app's
 * IR (see `apps/demo-react/src/syncular.generated.ts` for the real generated
 * shape). Inlined here so the example stays self-contained — no manifest / no
 * generate step to run — while carrying the SAME schema object + row type a
 * real app would pass to `createNativeSyncClient`.
 *
 * One `todos` table, value-sharded by `list_id` (the §3.1 scope) — the exact
 * shape the two-pane and demo-react apps use, so the RN example is the same
 * todo, proving the hooks work unchanged over the native core.
 */

/** ServerSchema-compatible schema object (SPEC §2.4, §3.1). */
export const schema = {
  version: 1,
  tables: [
    {
      name: 'todos',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'done', type: 'boolean', nullable: false },
        { name: 'position', type: 'integer', nullable: false },
        { name: 'updated_at_ms', type: 'integer', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'list:{list_id}', column: 'list_id' }],
    },
  ],
} as const;

/** One todos row (§2.4 column order). */
export interface TodosRow {
  id: string;
  list_id: string;
  title: string;
  done: boolean;
  position: number;
  updated_at_ms: number;
}

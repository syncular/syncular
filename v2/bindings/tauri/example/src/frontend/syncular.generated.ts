// Hand-written stand-in for a typegen-emitted module (the example ships no
// manifest — see the note below). Its SHAPE matches what
// `syncular-v2 generate` emits (cf. apps/demo-react/src/syncular.generated.ts)
// and its schema is byte-identical to the demo-react / demo server's `todos`
// table, so this Tauri app talks to the SAME dev server unchanged.

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
        { name: 'attachment', type: 'blob_ref', nullable: true },
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
  attachment: string | null;
}

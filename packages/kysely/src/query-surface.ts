/**
 * The minimal query surface the dialect drives. Every syncular host exposes
 * it — the direct `SyncClient` (sync `query`), the worker `SyncClientHandle`
 * and the multi-tab follower (async `query`), and the native bridges
 * (`@syncular-v2/tauri`, `@syncular-v2/react-native`, async `query`). The
 * dialect targets the union so ONE dialect works on ALL hosts: it never
 * reaches for a `ClientDatabase`, only `query(sql, params)`.
 *
 * Declared structurally here so the package depends on neither `@syncular-v2/
 * react`'s `SyncClientLike` nor a specific host — any object with a
 * conforming `query` is a valid target.
 */
import type { SqlRow, SqlValue } from '@syncular-v2/web-client';

/** The one method the dialect needs — sync OR async, mirroring the hosts. */
export interface SyncularQuerySurface {
  query(
    sql: string,
    params?: readonly SqlValue[],
  ): SqlRow[] | Promise<SqlRow[]>;
}

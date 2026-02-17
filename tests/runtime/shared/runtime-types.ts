/**
 * Shared types for runtime test apps (browser, D1, Node).
 * Imported by bundled entry points — both Bun.build() and wrangler resolve these.
 */

import type { SyncClientDb } from '@syncular/client';

export interface ConformanceDb {
  dialect_conformance: {
    id: string;
    n_int: number;
    n_bigint: number;
    bigint_text: string;
    t_text: string;
    u_unique: string;
    b_bool: boolean;
    j_json: unknown;
    j_large: unknown;
    d_date: Date;
    bytes: Uint8Array | ArrayBuffer;
    nullable_text: string | null;
    nullable_int: number | null;
    nullable_bigint: number | null;
    nullable_bool: boolean | null;
    nullable_bytes: (Uint8Array | ArrayBuffer) | null;
    nullable_json: unknown;
    nullable_date: Date | null;
  };
}

export interface RuntimeClientDb extends SyncClientDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    project_id: string;
    server_version: number;
  };
}

export type TaskRow = {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string;
  server_version: number;
};

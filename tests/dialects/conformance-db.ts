import type { JsonValue } from './json';

export interface DialectConformanceRow {
  id: string;
  n_int: number;
  n_bigint: bigint | number;
  bigint_text: string;
  t_text: string;
  u_unique: string;
  b_bool: boolean;
  j_json: JsonValue;
  j_large: JsonValue;
  d_date: Date;
  bytes: Uint8Array | ArrayBuffer;
  nullable_text: string | null;
  nullable_int: number | null;
  nullable_bigint: bigint | number | null;
  nullable_bool: boolean | null;
  nullable_bytes: Uint8Array | ArrayBuffer | null;
  nullable_json: JsonValue | null;
  nullable_date: Date | null;
}

export interface DialectConformanceDb {
  dialect_conformance: DialectConformanceRow;
}

/**
 * Client-side encryption wiring (SPEC.md §5.11).
 *
 * The wire-boundary seam: encrypt configured columns when the outbox encodes
 * a commit for send, decrypt them when a COMMIT/segment applies. The local
 * SQLite mirror stays plaintext; the row codec (§2.4) is untouched — it only
 * ever sees a `bytes` value for an encrypted column. This module is the
 * bridge between the positional `RowValue[]` and the `@syncular/core` §5.11
 * envelope primitives.
 */
import {
  type DeclaredType,
  DecryptError,
  decryptValue,
  encryptValue,
  type NonceSource,
  type PlainValue,
  type RowColumn,
  type RowValue,
} from '@syncular/core';
import type { CompiledClientTable } from './schema';

/**
 * App-supplied key material and selection. `keyProvider` maps a key-id to its
 * 32-byte key; `keyIdFor` names the key for a given write (default:
 * per-table, `keyId = table`). Keys travel as raw bytes — the app owns key
 * storage, rotation, and distribution (§5.11; the docs give the synced
 * wrapped-keys recipe).
 */
export interface EncryptionConfig {
  /** `keyId → 32-byte key`, or `undefined` if unknown (decrypt fails loud). */
  readonly keyProvider: (keyId: string) => Uint8Array | undefined;
  /** Choose the key-id for an encrypt. Default: per-table (`table`). */
  readonly keyIdFor?: (table: string, rowId: string) => string;
  /**
   * Nonce source (§5.11). Production omits this (secure RNG). ONLY the crypto
   * golden-vector generator injects a fixed nonce — never a production path.
   */
  readonly nonceSource?: NonceSource;
}

function declaredTypeOf(column: RowColumn): DeclaredType {
  // An encrypted column always carries declaredType (typegen guarantees it;
  // §5.11). Fall back to the wire type defensively.
  return (column.declaredType ?? column.type) as DeclaredType;
}

/**
 * Encrypt the encrypted columns of a positional row value array in place-safe
 * fashion (returns a new array). Called at the outbox encode-at-send seam
 * (§6.1) BEFORE the row codec serializes: an encrypted column's plaintext
 * value becomes the §5.11 ciphertext-envelope `bytes`. NULLs pass through
 * unencrypted (§5.11).
 */
export async function encryptRowValues(
  config: EncryptionConfig,
  table: CompiledClientTable,
  rowId: string,
  values: readonly RowValue[],
): Promise<RowValue[]> {
  if (!table.hasEncryptedColumns) return values.slice();
  const keyIdFor = config.keyIdFor ?? ((t: string) => t);
  const out = values.slice();
  for (let i = 0; i < table.columns.length; i++) {
    const column = table.columns[i];
    if (column === undefined || !column.encrypted) continue;
    const value = out[i];
    if (value === null || value === undefined) continue; // NULL stays NULL
    const keyId = keyIdFor(table.name, rowId);
    const key = config.keyProvider(keyId);
    if (key === undefined) {
      throw new DecryptError(
        `no encryption key for keyId ${JSON.stringify(keyId)} (table ${table.name})`,
      );
    }
    out[i] = await encryptValue(
      declaredTypeOf(column),
      value as PlainValue,
      keyId,
      key,
      config.nonceSource,
    );
  }
  return out;
}

/**
 * Decrypt the encrypted columns of a decoded positional row value array
 * (returns a new array). Called at the apply seam (§4.5 COMMIT, §5.6 rows
 * segment) AFTER the row codec decodes: an encrypted column's ciphertext
 * envelope `bytes` becomes its plaintext declared-type value for the local
 * mirror. A wrong/missing key or malformed envelope throws
 * {@link DecryptError} (`client.decrypt_failed`, §5.11).
 */
export async function decryptRowValues(
  config: EncryptionConfig,
  table: CompiledClientTable,
  values: readonly RowValue[],
): Promise<RowValue[]> {
  if (!table.hasEncryptedColumns) return values.slice();
  const out = values.slice();
  for (let i = 0; i < table.columns.length; i++) {
    const column = table.columns[i];
    if (column === undefined || !column.encrypted) continue;
    const value = out[i];
    if (value === null || value === undefined) continue;
    if (!(value instanceof Uint8Array)) {
      throw new DecryptError(
        `encrypted column ${column.name} decoded to a non-bytes value`,
      );
    }
    out[i] = deserializeGuard(
      await decryptValue(declaredTypeOf(column), value, config.keyProvider),
    );
  }
  return out;
}

// decryptValue already returns a PlainValue; RowValue is a superset, so this
// is just the type widening (kept explicit for clarity at the seam).
function deserializeGuard(value: PlainValue): RowValue {
  return value;
}

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
  EncryptError,
  encryptValue,
  KEY_LENGTH,
  type PlainValue,
  type RowColumn,
  type RowValue,
} from '@syncular/core';
import { invalidRequest } from './errors';
import type { CompiledClientTable } from './schema';

/**
 * The keyring every host accepts (§5.11): `keys` maps a key id to its
 * 32-byte key; `keyIdColumns` names, per table, the plaintext string column
 * whose row value selects the key for a write (default: `keyId = table`).
 * The app owns key storage, rotation and distribution; a key that arrives
 * after activation goes through `addEncryptionKeys`.
 */
export interface EncryptionKeyringConfig {
  readonly keys: Readonly<Record<string, Uint8Array>>;
  readonly keyIdColumns?: Readonly<Record<string, string>>;
}

/** The core-owned installed keyring. */
export interface Keyring {
  readonly keys: ReadonlyMap<string, Uint8Array>;
  readonly keyIdColumns?: Readonly<Record<string, string>> | undefined;
}

/**
 * `keyring` (a new one with `config.keyIdColumns` when absent) plus
 * `config.keys` (§5.11), validated in key-id order. A refused call changes
 * nothing: every key is
 * {@link KEY_LENGTH} bytes, and a held key id keeps its bytes (the same bytes
 * again are a no-op). The keyring holds copies, so the app may zero its own
 * buffers after the call.
 */
export function installKeys(
  config: EncryptionKeyringConfig,
  keyring: Keyring = { keys: new Map(), keyIdColumns: config.keyIdColumns },
): Keyring {
  const keys = new Map(keyring.keys);
  // Key-id order, so a refusal names the same key id as the Rust core.
  for (const [keyId, key] of Object.entries(config.keys).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const held = keys.get(keyId);
    if (!(key instanceof Uint8Array) || key.length !== KEY_LENGTH)
      throw invalidRequest('encryption key must be 32 bytes (AES-256)', false, {
        keyId,
      });
    if (held?.some((byte, i) => byte !== key[i]))
      throw invalidRequest(
        'encryption key id is already held with different key bytes',
        false,
        {
          keyId,
        },
      );
    keys.set(keyId, held ?? key.slice());
  }
  return { ...keyring, keys };
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
export async function encryptRowValues<T extends RowValue | undefined>(
  config: Keyring | undefined,
  table: CompiledClientTable,
  values: readonly T[],
  storedKeyId?: string,
): Promise<T[]> {
  const out = values.slice();
  // Sparse semantics: absent (undefined) and NULL columns are never
  // re-encrypted, so a patch that presents no encrypted value needs no key.
  if (!table.columns.some((column, i) => column.encrypted && out[i] != null))
    return out;
  if (config === undefined) {
    throw new EncryptError('encrypted columns need an encryption config');
  }
  // Key selection: the configured `keyIdColumns[table]`, then the table name.
  // The selector reads the presence set first, then the stored local row:
  // only an ABSENT selector slot is filled from the stored row, never a
  // present NULL (§6.1). The column must stay plaintext and hold a non-empty
  // string.
  const selectorColumn = config.keyIdColumns?.[table.name];
  let keyId = table.name;
  if (selectorColumn !== undefined) {
    const index = table.columns.findIndex(
      (column) => column.name === selectorColumn && column.encrypted !== true,
    );
    const selected =
      index < 0
        ? null
        : values[index] === undefined
          ? storedKeyId
          : values[index];
    if (typeof selected !== 'string' || selected.length === 0) {
      throw new EncryptError(
        `encryption key-id column ${JSON.stringify(selectorColumn)} on table ${JSON.stringify(table.name)} must be a plaintext column holding a non-empty string`,
      );
    }
    keyId = selected;
  }
  const key = config.keys.get(keyId);
  for (let i = 0; i < table.columns.length; i++) {
    const column = table.columns[i];
    if (column === undefined || !column.encrypted) continue;
    const value = out[i];
    if (value === null || value === undefined) continue; // NULL stays NULL
    if (key === undefined) {
      throw new EncryptError(
        `no encryption key for keyId ${JSON.stringify(keyId)} (table ${table.name})`,
      );
    }
    out[i] = (await encryptValue(
      declaredTypeOf(column),
      value as PlainValue,
      keyId,
      key,
    )) as T;
  }
  return out;
}

/** §5.11 sealed state of a row: the `_sync_sealed_key` and `_sync_sealed` cells. */
export interface SealedRow {
  readonly keyId: string;
  /** JSON object of encrypted column name → envelope bytes. */
  readonly envelopes: string;
}

/**
 * The apply seam (§4.5 COMMIT, §5.6 rows segment): {@link decryptRowValues},
 * except that a missing key leaves every encrypted column NULL and `sealed` carries the first missing key id and
 * the envelopes (§5.11).
 */
export async function decryptOrSealRowValues(
  config: Keyring | undefined,
  table: CompiledClientTable,
  values: readonly RowValue[],
): Promise<{ values: RowValue[]; sealed?: SealedRow }> {
  try {
    return { values: await decryptRowValues(config, table, values) };
  } catch (error) {
    if (
      !(error instanceof DecryptError) ||
      error.code !== 'client.encryption_key_missing'
    )
      throw error;
    // §5.11: every encrypted column is NULL; `_sync_sealed` keeps the
    // envelopes as byte arrays for the reveal.
    return {
      values: values.map((value, i) =>
        table.columns[i]?.encrypted ? null : value,
      ),
      sealed: {
        keyId: error.details!.keyId,
        envelopes: JSON.stringify(
          Object.fromEntries(
            table.columns.flatMap((column, i) => {
              const value = values[i];
              return column.encrypted && value instanceof Uint8Array
                ? [[column.name, [...value]]]
                : [];
            }),
          ),
        ),
      },
    };
  }
}

/**
 * Decrypt the encrypted columns of a decoded positional row value array
 * (returns a new array). Called at the apply seam (§4.5 COMMIT, §5.6 rows
 * segment) AFTER the row codec decodes: an encrypted column's ciphertext
 * envelope `bytes` becomes its plaintext declared-type value for the local
 * mirror. A missing key throws {@link DecryptError} coded
 * `client.encryption_key_missing` with the table and key id in `details`; a
 * wrong key or malformed envelope throws `client.decrypt_failed` (§5.11).
 */
export async function decryptRowValues(
  config: Keyring | undefined,
  table: CompiledClientTable,
  values: readonly RowValue[],
): Promise<RowValue[]> {
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
    if (config === undefined) {
      throw new DecryptError('encrypted columns need an encryption config');
    }
    out[i] = await decryptValue(
      declaredTypeOf(column),
      value,
      (keyId) => config.keys.get(keyId),
      table.name,
    );
  }
  return out;
}

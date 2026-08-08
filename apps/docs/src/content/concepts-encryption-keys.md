# Encryption keys

[Client-side encryption](/concepts-encryption/) never sends a key to the
server, so the application owns the key lifecycle: supplying keys to each
client, handing them to new members, rotating them, and revoking them on a
device. This page covers each stage.

## Supplying keys

Pass an `encryption` config to the client. `keyProvider` maps a **key-id** to
its 32-byte key; `keyIdFor` picks the key for a write (default: one key per
table).

```ts
import { SyncClient } from '@syncular/client';

const keys = new Map<string, Uint8Array>([
  ['patient_notes', myTableKey], // 32 bytes
]);

const client = new SyncClient({
  // …database, schema, transport…
  encryption: {
    keyProvider: (keyId) => keys.get(keyId),
    // optional; default is per-table (keyId === table name):
    // keyIdFor: (table, rowId) => `${table}:${scopeOf(rowId)}`,
  },
});
```

The key-id travels **inside** the envelope, so rotation and per-scope keys work
without a schema change: on decrypt the client reads the key-id from the
envelope and asks your `keyProvider` for it. A missing key or a wrong key
surfaces as `client.decrypt_failed` (local to the client, non-retryable) at
the apply seam. The app decides whether to skip the row, halt, or prompt for a
re-key.

## Worker, Tauri, and React Native keyrings

Functions do not cross a Web Worker or native command bridge, so Worker,
Tauri, and React Native hosts accept the portable equivalent: raw keys plus an
optional mapping from table to a plaintext string column containing the active
key id.

```ts
const encryption = {
  keys: {
    'key-2026-07': activeKey,
    'key-2026-06': previousKey, // retained while old envelopes remain
  },
  keyIdColumns: {
    patient_notes: 'encryption_key_id',
  },
};

const web = await createSyncClientHandle({
  // …worker, database, schema, endpoints…
  encryption,
});

const desktop = await createTauriSyncClient({ schema, encryption });
const mobile = await createNativeSyncClient({ schema, encryption });
```

`keyIdColumns.patient_notes` must name a non-encrypted string column. Its value
selects the write key for each row; the envelope's own key id still selects the
correct key while decrypting older data. Raw keys are installed inside the
worker/native core and are never sent to the server. The Tauri plugin must be
built with its `e2ee` feature.

When authentication or a signed revocation must run first, create with
`securityPreflight: true` instead of supplying `encryption`, apply the exact
[authorized local purge](/concepts-local-data-purge/), then install the
accepted keyring through `activateSecurity({ encryption })`. Protected work
fails closed with `client.security_preflight_required` until activation. Use
`beginSecurityPreflight()` for live key rotation/removal.

## Sharing a key: asymmetric ("async") encryption

Handing a symmetric key to a **new member** is what the asymmetric utilities
are for: **X25519 sealed-box key wrapping**, in `@syncular/crypto` (TS) and
`ssp2::wrap` (Rust). These are standalone
utilities that sit outside the sync wire protocol. Key distribution travels
over your own channel or a synced table.

```ts
import { generateKeyPair, wrapKey, unwrapKey } from '@syncular/crypto';

// Each member has an X25519 keypair; publish the public half.
const alice = await generateKeyPair();

// Anyone with Alice's public key can wrap the table key to her:
const wrapped = await wrapKey(myTableKey, alice.publicKey);

// Only Alice unwraps it with her private key:
const tableKey = await unwrapKey(wrapped, alice.privateKey);
```

### The synced-wrapped-keys recipe

Keep the wrapped keys in a **synced table**.

```sql
-- Not encrypted (encryptedColumns is empty): wrapped_key is already
-- ciphertext; the server sees only wrapped bytes it cannot open.
CREATE TABLE key_grants (
  id           TEXT PRIMARY KEY,   -- e.g. "patient-notes/alice"
  clinic_id    TEXT NOT NULL,      -- scope
  recipient    TEXT NOT NULL,      -- member id
  wrapped_key  BLOB NOT NULL       -- wrapKey(tableKey, recipientPublicKey)
);
```

To grant access, one member wraps the table key to the newcomer's public key
and writes a `key_grants` row. It syncs like any other row. The newcomer reads
their grant, `unwrapKey`s it with their private key, and feeds the recovered
key to their `keyProvider`. The server only ever stores the wrapped bytes.

## Revoking a key on one device

Key revocation is an application authority workflow; the sync protocol cannot
infer it from ciphertext. After the application validates a
server-authoritative revocation directive, it removes the affected rows with
`purgeLocalData()`, using a plaintext routing column such as
`encryption_key_id` as the selector, and removes the raw key from the OS
secure store. The complete authority workflow, the selector rules, and the
atomicity guarantees are in
[Authorized local purge](/concepts-local-data-purge/).

`purgeLocalData()` does **not** authenticate the directive or revoke server
access, and a powered-off device remains unconfirmed and may still hold its
local data.

# Client-side encryption (E2EE)

Most columns sync as plaintext: the server sees their values, extracts scopes
from them, runs write-validators over them, and merges CRDT bytes. Some
columns hold data the server should **never** see: a private note, a medical
field, an API token. Mark those columns **encrypted**, and Syncular encrypts
them on the device before they leave and decrypts them on the device after they
arrive. The server stores and serves **ciphertext** and never holds a key.

Normative detail: [SPEC.md §5.11](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#511-client-side-encryption-e2ee--opt-in-per-column).

## The model: plaintext locally, ciphertext on the wire

The one idea to hold onto: **encryption applies at the wire boundary.** The
local database always holds plaintext.

- Your **local SQLite mirror stays plaintext.** Local queries, named queries,
  and indexes all keep working over the real values: an encrypted `amount`
  column is a real integer locally, an encrypted `note` is a real string.
- A column is encrypted **only in transit and at rest on the server.** The
  client encrypts it when the outbox encodes a commit for send, and decrypts it
  when a commit or a bootstrap segment applies.

```
 device A                          server                       device B
┌──────────────┐   encrypt on     ┌──────────────┐  decrypt on  ┌──────────────┐
│ note = "hi"  │ ───────────────▶ │  note = 🔒   │ ───────────▶ │ note = "hi"  │
│ (plaintext)  │   outbox send    │ (ciphertext) │  apply       │ (plaintext)  │
└──────────────┘                  └──────────────┘              └──────────────┘
        local queries work                 keys never                local queries work
        over plaintext                     reach here                over plaintext
```

The wire/stored type of an encrypted column is always `bytes`. It carries a
[ciphertext envelope](#the-envelope). Your generated types still show the
**declared** type (`string`, `number`, …), because that is what your app reads
and writes; the envelope is invisible above the wire boundary.

## Declaring an encrypted column

Encryption is **app configuration.** The column stays an ordinary SQL column
in your migration, and you list it in `syncular.json`:

```jsonc
// syncular.json
{
  "tables": [
    {
      "name": "secrets",
      "scopes": ["project:{project_id}"],
      "encryptedColumns": ["note", "amount"]  // ← these two are E2EE
    }
  ]
}
```

Regenerate your client. The generated `SecretsRow.note` is still typed
`string`; only the wire contract changed. Three columns can **never** be
encrypted; codegen refuses to build if you try:

- a **scope column**: the server extracts scopes from it, so it must stay
  plaintext;
- a **`crdt` column**: the server merges its bytes, which is impossible over
  ciphertext;
- the **primary key**: it renders the row's server-side id.

## Supplying keys

Pass an `encryption` config to the client. `keyProvider` maps a **key-id** to
its 32-byte key; `keyIdFor` picks the key for a write (default: one key per
table).

```ts
import { SyncClient } from '@syncular/client';

const keys = new Map<string, Uint8Array>([
  ['secrets', myTableKey], // 32 bytes
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

### Worker, Tauri, and React Native keyrings

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
authorized local purge, then install the accepted keyring through
`activateSecurity({ encryption })`. Protected work fails closed with
`client.security_preflight_required` until activation. Use
`beginSecurityPreflight()` for live key rotation/removal.

## The envelope

Each encrypted value is a self-describing blob (byte-exact across the TS and
Rust cores, pinned by golden vectors in `spec/vectors/crypto/`):

```
0x01 │ keyIdLen(u8) │ keyId(utf8) │ nonce(12) │ AES-256-GCM(ciphertext+tag)
```

AES-256-GCM with a fresh random 96-bit nonce per encrypt. A `NULL` value stays
`NULL`: it is not encrypted, since the null bitmap already hides it.

## Sharing a key: asymmetric ("async") encryption

Symmetric keys are great until you need to give one to a **new member**. That
is what the asymmetric utilities are for: **X25519 sealed-box key wrapping**,
in `@syncular/crypto` (TS) and `ssp2::wrap` (Rust). These are standalone
utilities that sit outside the sync wire protocol. Key distribution travels
over your own channel or a synced table.

```ts
import { generateKeyPair, wrapKey, unwrapKey } from '@syncular/crypto';

// Each member has an X25519 keypair; publish the public half.
const alice = await generateKeyPair();

// Anyone with Alice's public key can wrap the table key to her:
const wrapped = await wrapKey(myTableKey, alice.publicKey);

// Alice — and only Alice — unwraps it with her private key:
const tableKey = await unwrapKey(wrapped, alice.privateKey);
```

### The synced-wrapped-keys recipe

The clean pattern: keep the wrapped keys in a **synced table**.

```sql
-- Not encrypted (encryptedColumns is empty): wrapped_key is already
-- ciphertext — the server sees only wrapped bytes it cannot open.
CREATE TABLE key_grants (
  id           TEXT PRIMARY KEY,   -- e.g. "secrets/alice"
  project_id   TEXT NOT NULL,      -- scope
  recipient    TEXT NOT NULL,      -- member id
  wrapped_key  BLOB NOT NULL       -- wrapKey(tableKey, recipientPublicKey)
);
```

To grant access, one member wraps the table key to the newcomer's public key
and writes a `key_grants` row. It syncs like any other row. The newcomer reads
their grant, `unwrapKey`s it with their private key, and feeds the recovered
key to their `keyProvider`. The server only ever stores the wrapped bytes.

## Revoking a key on one device

Key revocation is an application authority workflow, not something the sync
protocol can infer from ciphertext. The safe order is:

1. validate a fresh, server-authoritative revocation/purge directive and its
   exact device and key version;
2. quarantine the protected feature and gate/remove subscriptions that could
   re-download those rows;
3. call `purgeLocalData()` with plaintext routing columns such as
   `encryption_key_id`;
4. purge app-owned drafts/files outside Syncular and remove the raw key from
   the OS secure store;
5. acknowledge the directive only after every local stage succeeds.

```ts
await client.purgeLocalData({
  purgeId: directive.id,
  targets: [{
    table: 'patient_notes',
    selectors: { encryption_key_id: [directive.keyVersionId] },
  }],
});
```

The local engine performs exact row/FTS cleanup, rejects any whole pending
commit that touches the target, replays safe later edits, reconciles cached
blob references, and durably records the purge id in one SQLite transaction.
Retries are no-ops; an id reused with a different plan fails closed. This API
does **not** authenticate the directive or revoke server access, and a powered-
off device remains unconfirmed—it has not been remotely erased. See
[Authorized local purge](/concepts-local-data-purge/) for selector rules,
host coverage, and the complete authority workflow.

## What the server can and cannot see: threat model

Be honest about the boundary. With an encrypted column, the server:

- **cannot** read the plaintext;
- **can** see the value's **length** (the ciphertext is length-revealing; pad
  before encrypting if length is sensitive);
- **can** see **which rows change and when** (metadata: row ids, scopes,
  versions, timestamps are plaintext by design; that is how sync works);
- sees **ciphertext** in a [write-validator](concepts-conflicts.md): a §6.7
  validator cannot assert on an encrypted column's contents, so business rules
  over encrypted data run on the client, before the write;
- serves an encrypted table only on the **rows lane**, and skips the
  whole-table sqlite image (an image is copied wholesale with no per-row
  decrypt pass, so the server excludes encrypted tables from image eligibility
  automatically).

E2EE also shifts responsibility to **you**: if a member loses their key, their
data is unrecoverable. There is no server-side reset. Plan key backup and
rotation deliberately.

## Cross-core

The envelope, the value serializer, and the X25519 wrap are **byte-identical**
between the TypeScript and Rust cores, proven by committed vectors
(`spec/vectors/crypto/`) and cross-core conformance scenarios: a value one core
encrypts, the other decrypts with the same key; a Rust-wrapped key unwraps in
the browser and vice versa. A ciphertext written on iOS opens on the web with
the same key.

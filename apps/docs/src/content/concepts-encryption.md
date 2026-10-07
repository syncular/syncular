# Client-side encryption

Use client-side encryption when a column holds data the server must never read, such as a private note, a medical field, or an API token. Syncular encrypts the column on the device before the value leaves and decrypts it on the device after it arrives. The server stores and serves ciphertext and never holds a key. This page is for developers who own the key lifecycle, because a lost key makes the data unrecoverable.

::meta{for="App developers protecting columns from the server" time="15 minutes" first="concepts-scopes" spec="5.11"}

:::terms
- **Encrypted column**: A column listed in `encryptedColumns` in `syncular.json`. Its wire and stored type is `bytes`; its declared type stays what your app reads.
- **Envelope**: The self-describing ciphertext blob an encrypted value becomes on the wire.
- **Key id**: The name of the key that sealed an envelope. It travels inside the envelope.
- **Keyring**: The keys a client holds, by key id.
- **Sidecar table**: A separate synced table that holds an optional protected value under its own scope, key, and subscription.
:::

:::figure{title="Plaintext on devices, ciphertext on the server" note="Encryption applies at the wire boundary" ticks}
<div class="d-row">
<div class="d-box">
<p class="d-label">Device A</p>
<div class="node ok"><span class="t">Local SQLite</span>body = "hi"<br>queries and indexes see plaintext</div>
</div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Server</p>
<div class="node bad"><span class="t">Stored and served</span>body = ████<br>no key reaches here</div>
</div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Device B</p>
<div class="node ok"><span class="t">Local SQLite</span>body = "hi"<br>queries and indexes see plaintext</div>
</div>
</div>

::caption[The client encrypts when the outbox encodes a commit and decrypts when a commit or segment applies. An encrypted `amount` column is a real integer locally and an encrypted `body` is a real string. Generated types show the declared type; the envelope is invisible above the wire boundary.]
:::

## How it works

The local database always holds plaintext, so local queries, [named queries](/tooling-queries/), and indexes keep working over real values. The client encrypts a column when the outbox encodes a commit for sending and decrypts it when a commit or a bootstrap segment applies. Decryption happens at the whole-row boundary: a row applies only if the client can decrypt every non-`NULL` encrypted value in it.

### The envelope

Each encrypted value is a self-describing blob, byte-exact across the TypeScript and Rust cores and pinned by golden vectors in `spec/vectors/crypto/`:

```text
0x01 │ keyIdLen(u8) │ keyId(utf8) │ nonce(12) │ AES-256-GCM(ciphertext + tag)
```

Each encryption uses AES-256-GCM with a fresh random 96-bit nonce. A `NULL` value stays `NULL` on the wire, because the null bitmap already hides it, and it needs no key.

### What the server can see

With an encrypted column, the server:

- cannot read the plaintext;
- can see the value's length, because ciphertext reveals it (pad before encrypting if length is sensitive);
- can see which rows change and when, because row ids, scopes, versions, and timestamps are plaintext by design;
- sees ciphertext in a [write validator](/concepts-conflicts/), so a validator cannot assert on an encrypted column and business rules over encrypted data run on the client before the write;
- serves an encrypted table only on the rows lane. The server excludes encrypted tables from sqlite-image bootstrap eligibility automatically, because an image copies rows wholesale with no per-row decrypt pass.

A value one core encrypts, the other decrypts with the same key, and a key wrapped by the Rust core unwraps in the TypeScript core, in both directions. Committed vectors and cross-core conformance scenarios pin this.

## Set it up

:::::steps
::::step{title="Mark the columns" time="2 min"}
The column stays an ordinary SQL column in your migration. List it in `syncular.json`:

```jsonc title="syncular.json"
{
  "tables": [
    {
      "name": "patient_notes",
      "scopes": ["clinic:{clinic_id}"],
      "encryptedColumns": ["body", "amount"]
    }
  ]
}
```

Three kinds of column cannot be encrypted, and codegen refuses to build if you list one:

- a scope column, because the server extracts scopes from it;
- a `crdt` column, because the server merges its bytes ([CRDT columns](/concepts-crdt/));
- the primary key, because it renders the row's server-side id.

An unknown column name also fails generation.

::checkpoint[`syncular generate` succeeds, and the generated `PatientNotesRow.body` is still typed `string`.]
::::
::::step{title="Supply the keys" time="5 min"}
Pass an `encryption` config when you create the client. Each SDK takes the same key material in the form its host allows; [Supplying keys](#supplying-keys) explains the options.

:::tabs
```ts sdk=web title="src/sync.ts"
const web = await createSyncClientHandle({
  // …worker, database, schema, endpoints…
  encryption: {
    keys: { 'patient_notes': tableKey }, // 32 bytes each
    keyIdColumns: { patient_notes: 'encryption_key_id' }, // optional
  },
});
```
```ts sdk=tauri title="src/sync.ts"
const client = await createTauriSyncClient({
  schema,
  encryption: {
    keys: { 'patient_notes': tableKey },
    keyIdColumns: { patient_notes: 'encryption_key_id' },
  },
});
```
```ts sdk=react-native title="src/sync.ts"
const client = await createNativeSyncClient({
  schema,
  encryption: {
    keys: { 'patient_notes': tableKey },
    keyIdColumns: { patient_notes: 'encryption_key_id' },
  },
});
```
```rust sdk=rust title="src/sync.rs"
use syncular_client::values::EncryptionConfig;

let mut encryption = EncryptionConfig::default();
encryption.keys.insert("patient_notes".into(), table_key.to_vec());
encryption.key_id_columns
    .insert("patient_notes".into(), "encryption_key_id".into());
client.set_encryption(encryption);
```
:::

The Tauri plugin, the FFI crate, and the Rust client need the `e2ee` cargo feature. The Swift, Kotlin, and Flutter wrappers expose no `encryption` option.

::checkpoint[A write to `patient_notes` completes with no `client.encrypt_failed`.]
::::
::::step{title="Confirm the server sees ciphertext" time="2 min"}
Write a row from one client, then read the stored value through a server-side query or your storage backend. The column holds the envelope bytes starting with `0x01`. Read the row on a second client with the same keyring and see the plaintext.

::checkpoint[The server stores bytes beginning with `0x01`, and the second client reads the original value.]
::::
:::::

## Encryption keys

Client-side encryption never sends a key to the server, so the application owns the key lifecycle: supplying keys to each client, handing them to new members, rotating them, and revoking them on a device.

### Supplying keys

`keyProvider` maps a key id to its 32-byte key, and `keyIdFor` picks the key for a write. The default is one key per table (key id equals the table name). A direct TypeScript `SyncClient` takes functions:

```ts title="src/sync.ts"
import { SyncClient } from '@syncular/client';

const keys = new Map<string, Uint8Array>([
  ['patient_notes', myTableKey], // 32 bytes
]);

const client = new SyncClient({
  // …database, schema, transport…
  encryption: {
    keyProvider: (keyId) => keys.get(keyId),
    // optional; the default is per table (keyId === table name):
    // keyIdFor: (table, rowId) => `${table}:${scopeOf(rowId)}`,
  },
});
```

The key id travels inside the envelope, so rotation and per-scope keys need no schema change. On decrypt, the client reads the key id from the envelope and asks the keyring for it. A missing or wrong key surfaces as `client.decrypt_failed` (local to the client, non-retryable) at the apply seam, and your app decides whether to skip the row, halt, or prompt for a re-key.

Functions do not cross a Web Worker or a native command bridge. The browser worker, Tauri, and React Native hosts therefore accept a portable keyring: raw keys plus an optional map from table to a plaintext string column that holds the active key id. The example in step 2 uses it; keep old keys in the ring while old envelopes remain.

```ts title="src/sync.ts"
const encryption = {
  keys: {
    'key-2026-07': activeKey,
    'key-2026-06': previousKey, // retained while old envelopes remain
  },
  keyIdColumns: { patient_notes: 'encryption_key_id' },
};
```

`keyIdColumns.patient_notes` must name a non-encrypted string column. Its value selects the write key for each row; the envelope's own key id still selects the correct key when decrypting older data. A `patch` that omits the key-id column resolves it from the stored local row, and a `patch` that writes no encrypted column needs no key. An encode-time selection failure surfaces as `client.encrypt_failed`, a durable per-commit rejection that never aborts the round. Raw keys install inside the worker or native core and never reach the server.

When authentication or a signed revocation must run first, create the client with `securityPreflight: true` instead of `encryption`, apply the exact [authorized local purge](/concepts-local-data-purge/#race-free-security-bootstrap), then install the accepted keyring with `activateSecurity({ encryption })`. Protected work fails with `client.security_preflight_required` until activation. Use `beginSecurityPreflight()` for live key rotation or removal.

### What a write sends

A mutation sends the columns it presents. A `patch` carries the primary key plus the columns you set, and only those columns are encrypted and replaced on the server. An encrypted column that a patch omits stays byte-identical on the server, so ciphertext and nonce are never reused, and an immutable value inside a mutable row survives without a resend.

The presence set is the intent, and the server sees only encrypted values for the columns that are present. It cannot tell an omitted encrypted column from an unchanged one. A client that must not rewrite an encrypted value omits it from the patch.

### Sharing a key with a new member

Handing a symmetric key to a new member uses X25519 sealed-box key wrapping, in `@syncular/crypto` (TypeScript) and `ssp2::wrap` (Rust). These utilities sit outside the sync wire protocol; key distribution travels over your own channel or a synced table.

```ts title="src/keys.ts"
import { generateKeyPair, wrapKey, unwrapKey } from '@syncular/crypto';

// Each member has an X25519 keypair and publishes the public half.
const alice = await generateKeyPair();

// Anyone with Alice's public key can wrap the table key to her.
const wrapped = await wrapKey(myTableKey, alice.publicKey);

// Only Alice unwraps it with her private key.
const tableKey = await unwrapKey(wrapped, alice.privateKey);
```

Keep the wrapped keys in a synced table. The column holds ciphertext already, so the table lists no `encryptedColumns`:

```sql title="migrations/002_key_grants.sql"
CREATE TABLE key_grants (
  id           TEXT PRIMARY KEY,   -- e.g. "patient-notes/alice"
  clinic_id    TEXT NOT NULL,      -- scope
  recipient    TEXT NOT NULL,      -- member id
  wrapped_key  BLOB NOT NULL       -- wrapKey(tableKey, recipientPublicKey)
);
```

To grant access, one member wraps the table key to the newcomer's public key and writes a `key_grants` row, which syncs like any other row. The newcomer reads the grant, calls `unwrapKey` with their private key, and gives the recovered key to their keyring. The server stores only the wrapped bytes.

### Revoking a key on one device

Revocation is an application authority workflow; the sync protocol cannot infer it from ciphertext. After the application validates a server-authoritative revocation directive, it removes the affected rows with `purgeLocalData()`, using a plaintext routing column such as `encryption_key_id` as the selector, and then removes the raw key from the OS secure store. Delete the key only after the SQLite cleanup succeeds; otherwise the app may be unable to inspect or clean its remaining protected data. [Authorized local purge](/concepts-local-data-purge/) covers the workflow, the selector rules, and the atomicity guarantees.

`purgeLocalData()` does not authenticate the directive or revoke server access, and a powered-off device stays unconfirmed and may still hold its data.

## Known limitations

Each limitation below comes from the whole-row decrypt boundary or from the receiver-side manifest. Match your symptom to the entry.

| Symptom | Cause | Fix |
|---|---|---|
| A client without the key cannot apply any column of a row | A non-`NULL` protected value shares a row with shared data | [Move the protected value to a sidecar table](#a-protected-value-shares-a-row-with-shared-data) |
| A no-key client cannot tell whether a protected value exists | The presence marker sits inside the encrypted row | [Put the marker on the plaintext primary](#a-no-key-client-needs-a-presence-signal) |
| The sync round aborts and unrelated frames starve | A no-key client subscribed to the sidecar | [Subscribe only keyholders to the sidecar](#a-no-key-client-is-subscribed-to-the-sidecar) |
| Codegen printed no warning for a mixed table | No diagnostic exists for the mixed shape | [Choose the shape in the schema](#codegen-gives-no-warning) |
| Garbled or failing values on one peer only | Peers disagree on `encryptedColumns` | [Align the manifest](#peers-disagree-on-encryptedcolumns) |

### A protected value shares a row with shared data

A non-`NULL` protected value in a row that also holds shared operational data blocks a client without the key: that client cannot apply any column of the row, and the failed apply aborts the rest of the sync round, even though the client is authorized for the shared columns.

Keep the shared row key-free and move the protected value into a sidecar table. The sidecar holds the value under its own `encryptedColumns` entry, its own scope, and its own subscription, keyed by the primary row id. It resolves its key by the normal selection: the per-table default (key id equals the table name) is enough, and `keyIdColumns` selects per-scope keys or rotation.

```jsonc title="syncular.json"
{
  "tables": [
    {
      "name": "records",
      "scopes": ["project:{project_id}"]
    },
    {
      "name": "record_details",
      "scopes": ["detail:{detail_scope}"],
      "encryptedColumns": ["value"]
    }
  ]
}
```

`records` is the plaintext primary and lists no `encryptedColumns`. `record_details` is the sidecar. A client without the sidecar key subscribes to `records` and reads every primary column; the server never delivers the protected value to it.

### A no-key client needs a presence signal

A presence marker inside the encrypted sidecar row cannot serve a no-key client, because apply decrypts at the whole-row boundary and the attempt aborts the sync round. Markers inside the encrypted row remain valid for keyholders.

Put a signal for no-key clients in the plaintext primary or in another plaintext shape the client may already read. Publishing that a protected value exists is itself a disclosure, so do it only where the primary shape's authorization already covers it.

| State | What a no-key client sees |
|---|---|
| Disclosure authorized, no value recorded | The primary row's plaintext marker says so |
| Disclosure authorized, value recorded | The primary row's plaintext marker says a protected value exists; the value is not delivered |
| Disclosure not authorized | `unknown`, with no claim either way |

### A no-key client is subscribed to the sidecar

An undecryptable row aborts the rest of the sync round and starves unrelated frames in the same response. Subscribe a client without the sidecar key to the primary only. The sidecar subscription belongs to clients that hold the sidecar key.

### Codegen gives no warning

Codegen has no diagnostic for an encrypted column that shares a row with plaintext operational data. A correct encrypted table necessarily mixes a plaintext primary key, plaintext scope columns, and a plaintext key selector with the protected payload, so a heuristic over the mixed shape would warn on every correct design. Choose the sidecar shape when you write the schema.

### Peers disagree on `encryptedColumns`

The receiver's own manifest gates decrypt-on-apply, and the wire carries no envelope marker. If two peers disagree about a column's `encryptedColumns` entry, the receiver that does not mark the column encrypted decodes the envelope as its local type. A receiver whose local column is not `bytes` may fail to decode the envelope or decode it incorrectly, depending on the type; a `bytes` receiver stores the envelope as raw bytes. Nothing detects this today, so every peer must agree on the manifest before it exchanges encrypted data.

# Client-side encryption (E2EE)

Most columns sync as plaintext: the server sees their values, extracts scopes
from them, runs write-validators over them, and merges CRDT bytes. Some
columns hold data the server should **never** see: a private note, a medical
field, an API token. Mark those columns **encrypted**, and Syncular encrypts
them on the device before they leave and decrypts them on the device after they
arrive. The server stores and serves **ciphertext** and never holds a key.

Normative detail: [SPEC.md §5.11](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#511-client-side-encryption-e2ee--opt-in-per-column).
Supplying, sharing, rotating, and revoking keys is
[Encryption keys](/concepts-encryption-keys/).

## Plaintext locally, ciphertext on the wire

**Encryption applies at the wire boundary.** The local database always holds
plaintext.

- Your **local SQLite mirror stays plaintext.** Local queries, named queries,
  and indexes all keep working over the real values: an encrypted `amount`
  column is a real integer locally, an encrypted `body` is a real string.
- A column is encrypted **only in transit and at rest on the server.** The
  client encrypts it when the outbox encodes a commit for send, and decrypts it
  when a commit or a bootstrap segment applies.

```
 device A                          server                       device B
┌──────────────┐   encrypt on     ┌──────────────┐  decrypt on  ┌──────────────┐
│ body = "hi"  │ ───────────────▶ │  body = ███  │ ───────────▶ │ body = "hi"  │
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
      "name": "patient_notes",
      "scopes": ["clinic:{clinic_id}"],
      "encryptedColumns": ["body", "amount"]  // ← these two are E2EE
    }
  ]
}
```

Regenerate your client. The generated `PatientNotesRow.body` is still typed
`string`; only the wire contract changed. Three columns can **never** be
encrypted; codegen refuses to build if you try:

- a **scope column**: the server extracts scopes from it, so it must stay
  plaintext;
- a **`crdt` column**: the server merges its bytes, which is impossible over
  ciphertext;
- the **primary key**: it renders the row's server-side id.

## The envelope

Each encrypted value is a self-describing blob (byte-exact across the TS and
Rust cores, pinned by golden vectors in `spec/vectors/crypto/`):

```
0x01 │ keyIdLen(u8) │ keyId(utf8) │ nonce(12) │ AES-256-GCM(ciphertext+tag)
```

AES-256-GCM with a fresh random 96-bit nonce per encrypt. A `NULL` value stays
`NULL`: it is not encrypted, since the null bitmap already hides it.

## What the server can and cannot see: threat model

With an encrypted column, the server:

- **cannot** read the plaintext;
- **can** see the value's **length** (the ciphertext is length-revealing; pad
  before encrypting if length is sensitive);
- **can** see **which rows change and when** (metadata: row ids, scopes,
  versions, timestamps are plaintext by design);
- sees **ciphertext** in a [write-validator](/concepts-conflicts/): a §6.7
  validator cannot assert on an encrypted column's contents, so business rules
  over encrypted data run on the client, before the write;
- serves an encrypted table only on the **rows lane**, and skips the
  whole-table sqlite image (an image is copied wholesale with no per-row
  decrypt pass, so the server excludes encrypted tables from image eligibility
  automatically).

E2EE also shifts responsibility to **you**: if a member loses their key, their
data is unrecoverable. There is no server-side reset. Plan key backup and
rotation deliberately; [Encryption keys](/concepts-encryption-keys/) covers
the mechanics.

## Cross-core

The envelope, the value serializer, and the X25519 wrap are **byte-identical**
between the TypeScript and Rust cores, proven by committed vectors
(`spec/vectors/crypto/`) and cross-core conformance scenarios: a value one core
encrypts, the other decrypts with the same key; a Rust-wrapped key unwraps in
the browser and vice versa. A ciphertext written on iOS opens on the web with
the same key.

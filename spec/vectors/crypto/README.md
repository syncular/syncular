# Crypto golden vectors (§5.11)

Cross-core, CI-blocking test vectors for client-side encryption (SPEC.md
§5.11, Appendix A cases 22–23). Both cores — the TS `@syncular/core` /
`@syncular/crypto` and the Rust `ssp2` (`e2ee` feature) — reproduce every
`envelopeHex` **byte-for-byte** and round-trip decrypt/unwrap.

Unlike the wire vectors (`request/`, `response/`, …), the §5.11 envelope is a
**codec-level value**, not an SSP2 frame, so it is exercised directly rather
than inside a message. The vectors live in a single `vectors.json`:

- **`aesGcm`** — one case per declared type (`string`, `json`, `blob_ref`,
  `integer`, `float`, `boolean`, `bytes`). Each records the fixed `keyId`, the
  value-serializer output (`valueHex`), and the expected AES-256-GCM envelope
  (`envelopeHex`) under the fixed `keyHex` + `nonceHex`.
- **`x25519Wrap`** — the §5.11 sealed-box key-wrap: a fixed recipient keypair,
  ephemeral secret, nonce, and 32-byte symmetric key, with the expected wrap
  envelope. Proves the async-encryption utilities are cross-core byte-compatible.

## Determinism

The key and nonce are **fixed test-only injections** (SPEC.md §5.11 nonce
discipline: a fixed nonce MUST NOT be reachable from a production encode path).
Regenerate with:

```
bun run packages/core/scripts/generate-crypto-vectors.ts
```

A regeneration must be byte-identical. Checkers:

- TS: `packages/core/src/crypto-vectors.test.ts`
- Rust: `rust/crates/ssp2/tests/crypto_vectors.rs` (run with `--features e2ee`)

# syncular-protocol

Wire protocol and integrity types for Rust-first Syncular clients.

This crate contains the stable Rust representation of Syncular protocol
messages, binary sync packs, snapshot chunks, scoped snapshot artifacts,
auth leases, blob references, realtime messages, and commit/root integrity
helpers.

Most application code should use `syncular-client` or the umbrella `syncular`
crate. Depend on `syncular-protocol` directly when implementing transports,
servers, test fixtures, or protocol validation.


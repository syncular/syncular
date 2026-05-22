# Binary Snapshot Chunk Format

This document defines the `binary-table-v1` snapshot chunk encoding for
Rust-capable clients.

`binary-table-v1` is the Rust-first and current-only snapshot chunk format for
app bootstraps.

## Goals

- Avoid per-row JSON parsing during bootstrap.
- Preserve table and column order so Rust can bind directly into generated SQLite statements.
- Keep chunks independently verifiable with the existing chunk SHA-256 and gzip envelope.
- Keep the production hot path binary and schema-driven.

## Selection

There is no request-time snapshot encoding negotiation in the current protocol.
Server snapshot chunk refs always use `binary-table-v1`; clients that cannot
decode that format should fail clearly instead of requesting an alternate
product path.

## Envelope

`binary-table-v1` uses this outer chunk contract:

- `compression`: `gzip`
- `sha256`: SHA-256 of the compressed chunk body
- `byteLength`: compressed byte length in the chunk reference

The payload described below is the uncompressed body.

The TypeScript reference helpers live in `packages/core/src/snapshot-chunks.ts`:

- `encodeBinarySnapshotTable`
- `decodeBinarySnapshotTable`

## Payload Layout

All multi-byte numeric fields are little-endian.

```text
magic                 4 bytes   "SBT1"
format_version        u16       1
flags                 u16       0 for v1
table_name_len        u16
table_name            utf8[table_name_len]
column_count          u16
columns               repeated column_count times
row_count             u32
rows                  repeated row_count times
```

Column descriptor:

```text
column_name_len       u16
column_name           utf8[column_name_len]
type_tag              u8
flags                 u8        bit 0 = nullable
```

Rows are encoded in schema column order:

```text
null_bitmap           ceil(column_count / 8) bytes
values                encoded non-null values in column order
```

The null bitmap uses least-significant-bit first within each byte. If bit `n` is `1`, the corresponding column value is null and no value bytes follow for that column.

## Type Tags

```text
1  utf8 string        u32 byte length + bytes
2  signed integer    i64
3  float             f64
4  boolean           u8, 0 false, 1 true
5  json              u32 byte length + UTF-8 JSON bytes
6  bytes             u32 byte length + bytes
```

Initial generated Rust support should target:

- `text` and equivalent string families -> tag `1`
- SQLite/Postgres integer families -> tag `2`
- boolean families -> tag `4`
- JSON/JSONB fields and unsupported scalar families -> tag `5`

Blob payload bytes do not belong in snapshot chunks; blob metadata columns can still use scalar tags.

## Decoder Contract

The Rust decoder must validate:

- magic is `SBT1`
- format version is `1`
- table name matches the snapshot table metadata
- column count and ordered column names match generated app schema metadata
- type tags are supported for that generated table
- row count and value lengths do not exceed the payload bounds

If validation fails, the client must reject the chunk. It should not fall back to interpreting a binary chunk as JSON.

## Apply Path

The target hot path is:

```text
gzip bytes
  -> verify SHA-256
  -> decode binary table rows
  -> generated per-table SQLite bind order
  -> optional generated read-model updates
```

The generic JSON/value apply path is not the target hot path. Keep it only
where the Rust client cannot use generated schema code yet, such as:

- ungenerated schemas
- encrypted fields or CRDT fields that still need the existing transform path

## Open Questions

- Whether the server should include a schema checksum in the payload header or rely on table/column validation plus the sync schema version.
- Whether `row_count` should be optional for streaming decoders. The first implementation can keep it required because chunks are already materialized for hashing.
- Whether repeated strings should gain a dictionary section. Keep v1 simple unless string duplication remains a dominant cost after JSON removal.

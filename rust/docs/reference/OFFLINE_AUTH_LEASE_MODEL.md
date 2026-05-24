# Offline Auth Lease Model

This is the WP-11 design contract for future Rust-first offline auth leases.
It is intentionally not an implementation plan for a Rust server rewrite.

## Decision

Offline auth leases are allowed to capture local user intent while the device
is offline. They are not server acceptance, they are not proof of current
authorization, and they do not bypass normal server table-handler validation.

Default policy:

1. A client may queue local mutations while offline if it has a valid,
   unexpired signed lease covering the actor, schema version, table, operation,
   and scope values.
2. Every queued commit records the lease provenance that was active when the
   local intent was captured.
3. On reconnect, the server still validates normal request auth, the lease
   signature/expiry, and current handler authorization before applying the
   commit.
4. If the lease or current authorization fails, Syncular preserves the local
   intent and reports a recoverable auth/conflict state. It must not silently
   discard the queued work.

This keeps the product contract intact: the server remains authoritative, while
apps get an explicit, bounded offline UX state.

## Existing JS Offline Auth

The current JS offline-auth plugin is a client UX primitive:

- local session and identity cache
- token expiry checks
- subject resolution for offline UI
- auth lifecycle bridge for token refresh
- local lock policy

It is not a signed mutation authority model. A Rust-first lease system should
not treat that package as the server contract. It can reuse the UX ideas, but
the lease model must be explicit and auditable.

## Lease Token

Use a compact signed token with a canonical JSON payload. The first
implementation should use one signature algorithm, not a negotiation fallback.

Recommended v1 algorithm: `ES256` over a JWS-style protected header and
canonical payload.

Reasoning:

- P-256/SHA-256 is supported by Rust crypto libraries and common server/edge
  crypto stacks.
- It avoids depending on host-specific Ed25519 availability for the first
  server/edge implementation.
- The protected header carries `alg`, `kid`, and `typ`.

Protected header:

```json
{
  "alg": "ES256",
  "kid": "lease-key-2026-05",
  "typ": "syncular-auth-lease+jws"
}
```

Payload:

```json
{
  "version": 1,
  "leaseId": "lease_...",
  "issuer": "syncular-server",
  "audience": "syncular-app-id",
  "actorId": "user-rust",
  "subject": {
    "teamId": "team-1"
  },
  "schemaVersion": 7,
  "protocolVersion": 1,
  "issuedAtMs": 1779360000000,
  "notBeforeMs": 1779360000000,
  "expiresAtMs": 1779446400000,
  "maxClockSkewMs": 30000,
  "scopes": [
    {
      "subscriptionId": "tasks:user-rust:p0",
      "table": "tasks",
      "values": {
        "user_id": ["user-rust"],
        "project_id": ["p0"]
      },
      "operations": ["insert", "update", "delete"]
    }
  ],
  "capabilities": {
    "allowBlobs": true,
    "allowCrdt": true,
    "allowEncryptedFields": true
  }
}
```

Red lines:

- No unlimited leases.
- No silent refresh without server contact.
- No broad wildcard scopes in v1.
- No lease that covers tables or operations absent from the generated app
  schema.
- No plaintext secrets, tokens, or encrypted-field plaintext in the lease.

## Client Behavior

The Rust runtime should store active and historical leases in a Syncular system
table, for example `sync_auth_leases`.

Minimum columns:

- `lease_id`
- `kid`
- `actor_id`
- `issued_at_ms`
- `not_before_ms`
- `expires_at_ms`
- `schema_version`
- `payload_json`
- `token`
- `status`: `active | expired | revoked | invalid`
- `last_validation_error`
- `created_at_ms`
- `updated_at_ms`

Outbox commits should record lease provenance:

- `lease_id`
- `lease_expires_at_ms`
- `lease_status_at_enqueue`
- optionally a bounded `lease_scope_summary_json`

The client may use a locally verified active lease to decide whether a queued
mutation is allowed to enter the outbox while offline. The queued mutation is
still only local intent until server acceptance.

If no lease covers the mutation:

- generated mutation APIs should fail with a stable local error code when the
  app asks for leased offline writes;
- or queue as normal unleased local intent if the app explicitly configures
  "allow local drafts without lease".

The default should be strict for synced mutations and permissive only for app
local draft tables.

## Server Behavior

The existing JS/Hono server remains the implementation host for v1.

Recommended routes:

- `POST /sync/auth-leases/issue`
- `POST /sync/auth-leases/revoke` for admin/test tooling where needed

The issue route must use current online auth and handler/scope policy. It
should return only scopes the actor is currently allowed to use.

During push replay the server must distinguish:

- `sync.auth_lease_missing`
- `sync.auth_lease_invalid`
- `sync.auth_lease_expired`
- `sync.auth_lease_schema_mismatch`
- `sync.auth_lease_scope_mismatch`
- `sync.auth_lease_scope_revoked`
- `sync.auth_lease_business_rejected`

Default replay order:

1. Validate request/session auth.
2. Validate lease signature, `kid`, issuer, audience, schema version, and
   expiry for each leased commit.
3. Check the lease covers every operation table/op/scope in the commit.
4. Run current server table-handler authorization and business validation.
5. Apply accepted commits; persist lease id/key id/expiry in audit metadata.
6. Preserve rejected local intent as conflict/auth state with the stable code.

The default server must not accept a mutation solely because an old lease was
valid when the device went offline. An app-specific future policy may choose to
honor leases until expiry after revocation, but that policy must be explicit,
auditable, and outside the default behavior.

## Scope Semantics

Lease scopes are subscription-shaped. They should mirror Syncular's existing
scope model instead of inventing query predicates.

Required checks:

- The mutation table must exist in the generated app schema.
- The operation must be listed for that table.
- The operation payload must include enough scope columns to prove it stays
  within one allowed scope tuple.
- Deletes must be checked against the previous server row when the payload does
  not contain scope columns.
- CRDT field updates and blob references inherit the row/table scope checks.

## Events And Diagnostics

Native/browser events should expose lease state without leaking full payloads:

- `AuthLeaseUpdated`
- `AuthLeaseExpired`
- `AuthLeaseRejected`
- `LocalWriteQueued` with `leaseId`
- `SyncFailed` / conflict events with stable `sync.auth_lease_*` codes

Diagnostic snapshot additions:

- active lease id
- key id
- expires-at timestamp
- covered table names
- covered subscription ids
- queued commit counts by lease status
- most recent lease validation error

Do not include full scope values by default; expose value counts and scope keys
unless the app opts into a local debug dump.

## Testkit And Conformance

`syncular-testkit` should grow lease helpers before app projects need to mock
this locally:

- issue a signed valid lease
- issue an expired lease
- issue a tampered lease
- revoke a lease id
- assert queued commits carry lease provenance
- assert rejected lease pushes preserve outbox/conflict state

Required first tests:

- valid lease lets a client queue offline and later push after reconnect
- expired lease produces `sync.auth_lease_expired`
- tampered lease produces `sync.auth_lease_invalid`
- scope mismatch produces `sync.auth_lease_scope_mismatch`
- server-side revocation produces `sync.auth_lease_scope_revoked`
- diagnostics and console/audit surfaces show lease id, key id, and expiry

## Implementation Sequence

1. Add Rust protocol structs for lease header/payload/validation result.
2. Add local lease storage and outbox provenance columns behind a migration.
3. Add generated/native/browser APIs:
   - set active lease
   - inspect active lease summary
   - queue leased mutation
   - clear/revoke local lease
4. Add testkit lease issuer/verifier helpers.
5. Add JS/Hono lease issue route and push replay validation.
6. Add diagnostics, console/audit links, and conformance tests.

Do not start a pure Rust server or Cloudflare Worker rewrite for this. The
server change is a narrow protocol/auth extension to the current server.

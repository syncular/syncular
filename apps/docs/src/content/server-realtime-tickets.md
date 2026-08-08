# Realtime tickets

The built-in WebSocket connectors authenticate with a URL query parameter,
because the standard `WebSocket` constructor cannot send headers. Proxy
access logs retain URLs, so the value on the URL must be a short-lived
**ticket** rather than a long-lived bearer. Several pages tell you to mint
one; this page shows a workable shape. The ticket format is entirely yours:
syncular only hands you the upgrade request to authenticate.

## Mint

Add an authenticated HTTP endpoint that exchanges the caller's normal bearer
for a signed, expiring ticket. An HMAC over `actorId`, `partition`, and an
expiry is enough; no storage is needed:

```ts
const encoder = new TextEncoder();
const key = await crypto.subtle.importKey(
  'raw',
  encoder.encode(process.env.TICKET_SECRET!),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign', 'verify'],
);

app.post('/realtime-ticket', async (c) => {
  const actor = await verify(c.req.raw); // your normal bearer auth
  if (actor === null) return c.body(null, 401);
  const payload = JSON.stringify({
    actorId: actor.id,
    partition: actor.tenant,
    expiresAtMs: Date.now() + 60_000,
  });
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload),
  );
  return c.json({
    ticket: `${btoa(payload)}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
  });
});
```

## Verify at the upgrade

The WebSocket upgrade is host-owned ([Server setup](/guide-server/)). Verify
the ticket there, reject expired or bad signatures before upgrading, and
pass the recovered identity to `hub.connect`:

```ts
const url = new URL(request.url);
const identity = await verifyTicket(url.searchParams.get('ticket'));
if (identity === null) return new Response(null, { status: 401 });
// … upgrade, then:
hub.connect({
  partition: identity.partition,
  actorId: identity.actorId,
  clientId,
  send,
  closeSocket,
});
```

On Cloudflare Workers the same check goes in the `authenticateRealtime`
callback ([Cloudflare Workers](/server-workers/)).

## Fetch per attempt on the client

A 60-second ticket outlives one connection attempt and no more. The built-in
connector takes a fixed URL, so a rotating flow supplies a custom connector
that fetches a fresh ticket for each attempt; the
[realtime supervisor](/platform-web/#the-realtime-supervisor) calls it on
every reconnect. `webSocketRealtimeConnector` with a fixed ticket URL stays
fine for tickets whose lifetime covers the process (a deploy-scoped service
credential).

A live socket authenticates only at handshake time: rotating the ticket does
not affect an established connection, and cutting off a revoked actor means
closing the socket server-side.

## Where to go next

- [Server-side sync clients](/guide-server-clients/): where the client-side
  ticket wiring appears.
- [Remote server operations](/guide-remote-operations/): the same rule for
  the operations watch socket.
- [Realtime](/concepts-realtime/): what runs over the socket once connected.

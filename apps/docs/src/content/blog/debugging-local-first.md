---
title: 'Local-First Is Great for Users and Blind for Developers'
description: Local-first apps answer instantly and survive any network, and the work behind that happens on devices the developer never sees. How a sync server can act as the witness for those devices, followed through one support ticket in Syncular's admin console.
summary: Local-first moves the hard parts from the user to the developer. One support ticket, followed from a person's name to the row and the reason, through the server that saw every device.
author: Benjamin Kniffler
publishedAt: '2026-10-13'
---

# Local-First Is Great for Users and Blind for Developers

Ada opens a support ticket: "I moved the photo-upload card to Review on my laptop on the train. When I got home it was in Done." She attached a screenshot of the board. She did not attach a request id, a timestamp, or a device id, because nothing in a local-first app ever showed her one.

This post is about that ticket. Local-first software is very good for the person using it, and the same design makes it hard to debug for the person building it. Syncular is an open-source sync engine that keeps local SQLite databases in sync with a server, and over the last weeks I built an admin console for it. The console exists for one job: to turn a ticket like Ada's into a row, a device, and a reason.

## What the user gets

In a local-first app every read comes from a database on the device, and every write lands there first. The app answers in the time a SQLite query takes. It keeps working in a tunnel, on a plane, and on hotel Wi-Fi that drops every few minutes. A write made offline waits in an outbox and goes to the server when a network returns, so a dead connection does not lose a change. The person using the app never sees a spinner and never sees a sync error, because there is nothing for them to act on.

## What the developer gets

Each of those properties hides something from the developer.

- Reads come from the device's database, so the server never sees what the user saw.
- Writes wait in an outbox and retry without telling anyone. Silent tolerance of failure is the design goal of an outbox.
- A device can stay offline for a week and then deliver a week of writes in one request.
- The report arrives long after the event, from a person, about a device, with no request id.

Request logs and tracing assume that the request is the unit of work and that the server sees all of it. In a local-first app the unit of work is a person's change, it starts on a device the server cannot see, and it may reach the server days later inside someone else's conflict.

:::figure{title="Where the state of Ada's card lives" note="The server sees only what devices send" ticks}
<div class="d-row">
<div class="d-box">
<p class="d-label">Ada's laptop</p>
<div class="node"><span class="t">Local SQLite</span>the card in her column<br>an outbox commit<br>a conflict record</div>
</div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Server</p>
<div class="node hot"><span class="t">Recorded</span>each device's cursor and subscriptions<br>each write's outcome<br>the commit log and row scopes</div>
</div>
<span class="d-arrow"></span>
<div class="d-box">
<p class="d-label">Ben's phone</p>
<div class="node"><span class="t">Local SQLite</span>the card in his column<br>an applied commit</div>
</div>
</div>

::caption[The developer has access to the middle column only. Both devices were offline when the cards moved.]
:::

Durable execution engines such as Temporal ran into the same gap. A workflow runs across retries, process crashes, and waits that last days, so no single process log explains it. Those engines became operable by recording every step of every workflow as a durable history and showing that history per workflow. A sync engine needs the same history, keyed by the ids a support ticket contains: the person, the device, the row, and the write.

## The server is the only witness

That history cannot come from the devices, which are out of reach. It can come from the server: every device eventually talks to it, and it already stores, for its own correctness, most of what an operator needs:

- each device's cursor, the last commit it has pulled, and its subscriptions, the tables and scope values it asked for
- each write's outcome, stored under its `clientCommitId` so a retried write gets the same answer
- the commit log, with every row change and the scopes of every row
- the scopes `resolveScopes` grants each person

Sync is deterministic given those inputs. A device with cursor 40, subscribed to `board_id: mobile`, holds every change to `mobile` rows up to commit 40, and nothing else. So the server can answer what a device should hold without asking the device. Syncular's console calls that answer the delivery trace, and it evaluates eight verdicts in a fixed order:

:::figure{title="The delivery trace for one device and one row" note="First match wins" ticks}
<div class="d-stack">
<div class="node bad"><span class="t">1 · client-unknown</span>The partition has no cursor record for the device.</div>
<div class="node bad"><span class="t">2 · row-missing</span>The partition holds no row with this id and no retained change to one.</div>
<div class="node"><span class="t">3 · no-subscription</span>The device does not subscribe to the table.</div>
<div class="node cool"><span class="t">4 · row-deleted</span>The row's last change is a delete, and the device has pulled it.</div>
<div class="node bad"><span class="t">5 · scope-mismatch</span>No subscription asks for the row's scope values.</div>
<div class="node bad"><span class="t">6 · scope-denied</span>A subscription asks for the row's scopes; <code>resolveScopes</code> refuses them.</div>
<div class="node cool"><span class="t">7 · pending-pull</span>The device's cursor is behind the row's last change.</div>
<div class="node ok"><span class="t">8 · delivered</span>The device has pulled the row's last change.</div>
</div>

::caption[Inputs: the row's stored scopes and last change, the device's subscriptions and cursor, and the person's allowed scopes. None of them come from the device at debugging time.]
:::

The trace has one limit. A device that is offline right now is invisible until it syncs. The console shows its last sync and how far its cursor trails the log, and that is all the server knows.

## One ticket, followed through

Ada's ticket names a person, so the console starts at People. Each person is listed with their devices, open sockets, cursor lag, and failures in the last five minutes. Ada has one failure. Opening it lists her failed and warned requests.

<figure class="shot">
  <img src="/blog/admin-console-people.webp" width="768" height="280" alt="The People view of the Syncular admin console filtered to ada: one device connected, cursor lag 0, one failure. Below, the failures panel lists one warned sync request from ada's laptop that conflicted on cards / c-mobile-13." />
  <figcaption>People, filtered to Ada. Her laptop is connected and caught up, and one sync request in the last five minutes conflicted on <code>cards / c-mobile-13</code>.</figcaption>
</figure>

A request opens its events in order. The laptop's request pushed one commit and pulled one, and the push conflicted on the card.

<figure class="shot">
  <img src="/blog/admin-console-request.webp" width="880" height="352" alt="A sync request dialog: ok, 3 ms, 1 pushed, 1 commit pulled, conflicted cards / c-mobile-13. Its events: request.handled, pull.served, and a push.conflicted warning on cards / c-mobile-13." />
  <figcaption>The laptop's sync request: <code>request.handled</code>, <code>pull.served</code>, and <code>push.conflicted</code> share one request id.</figcaption>
</figure>

The `push.conflicted` event carries the write's `clientCommitId`, and the write view shows the outcome the server stored for it: the operation conflicted with `sync.version_conflict` because the row was at version 2 and the laptop's write was based on version 1.

<figure class="shot">
  <img src="/blog/admin-console-write.webp" width="880" height="318" alt="The write dialog for one client commit id: rejected from ada's laptop. Operation 0 has status conflict, code sync.version_conflict, server version 2, message: present columns moved past baseVersion." />
  <figcaption>The stored outcome of Ada's write. A retry of the same <code>clientCommitId</code> gets this answer again.</figcaption>
</figure>

Version 2 came from somewhere. The row page shows the card's values, its history, and every device of the partition with its verdict. The history answers where version 2 came from: Ben's phone wrote it, one commit before Ada's laptop reconnected.

<figure class="shot">
  <img src="/blog/admin-console-row.webp" width="768" height="583" alt="The row page for cards / c-mobile-13 at version 2: values with column_id done, history with commit 2 from ben's phone and commit 1 from the seed client, and a who-has-this-row table where the seed client has no subscription and ada's and ben's devices are delivered." />
  <figcaption>The card at version 2. Ben's phone moved it to Done in commit 2, and both devices have pulled that change.</figcaption>
</figure>

The trace for Ada's laptop closes the ticket. Her laptop is `delivered`: its cursor is at commit 2, the `cards:mobile` subscription covers the row, and her allowed scopes include `mobile`.

<figure class="shot">
  <img src="/blog/admin-console-trace.webp" width="880" height="556" alt="The delivery trace for ada's laptop on cards / c-mobile-13: Delivered. Row version 2, last change commit 2 by ben, client cursor 2 and connected, allowed board_id web and mobile. The cards:web subscription mismatches the row's board, the cards:mobile subscription covers it. One rejected push: push.conflicted on the card." />
  <figcaption>The delivery trace for Ada's laptop. The verdict comes from the server's record of the row and the device.</figcaption>
</figure>

Both people moved the same card while offline. Ben's phone reconnected first and its move applied. Ada's laptop reconnected second, its write conflicted, and the laptop pulled Ben's version. The card moved to Done on her screen because the server's row says Done, and the conflict record on her laptop still holds her move until she picks a side. Support can tell her exactly that, and none of it came from her device.

:::figure{title="What happened to the card" note="Reconstructed from the server's record" ticks}
<div class="d-cols-2">
<div class="node"><span class="t">Ben's phone, offline</span>moves the card to Done</div>
<div class="node"><span class="t">Ada's laptop, offline</span>moves the card to Review</div>
</div>
<div class="d-cols-2">
<div class="d-down ok">▼ Reconnects first<small>commit 2 applies, version 2</small></div>
<div class="d-down">▼ Reconnects second<small>based on version 1</small></div>
</div>
<div class="node hot"><span class="t">Server</span>stores <code>sync.version_conflict</code> for Ada's write<br>sends commit 2 to both devices</div>
<div class="d-cols-2">
<div class="node ok"><span class="t">Ben's phone</span>Done, delivered</div>
<div class="node cool"><span class="t">Ada's laptop</span>Done, delivered<br><span class="chip amber">conflict record holds her move</span></div>
</div>

::caption[The two offline moves and Ada's conflict record live on the devices. The console read every other box from storage or from the event ring.]
:::

## Design decisions

The thesis drove most of the console's design. Several of these decisions came from getting it wrong first.

**Organize by what tickets contain.** The first version had nine views named after data types: clients, commits, rows, scopes, and so on. It was complete and useless with a ticket in hand, because a ticket names a person or a card. The rebuilt console starts from a find box that takes any id a ticket carries (a person, a device, a row, a commit, or a client commit id) and from a People view that groups devices by person.

**Read what correctness already stores.** Cursors, subscriptions, write outcomes, and the commit log exist because sync needs them. The console reads them through optional storage methods without new indexes, so the write path pays nothing for it. The only new state is an in-memory ring of recent server events, which the console uses for requests, failures, and latency.

:::figure{title="Two sources, two lifetimes"}
<div class="d-cols-2">
<div class="node ok"><span class="t">Server storage · durable</span>devices, cursors, subscriptions<br>write outcomes<br>rows, history, commits<br><span class="chip ok">kept as long as retention keeps it</span></div>
<div class="node cool"><span class="t">Event ring · in memory</span>requests and their events<br>failures by code and device<br>latency and volume<br><span class="chip cool">the last 1000 events per process</span></div>
</div>

::caption[A restart empties the ring and leaves everything in storage. Older events belong in your log pipeline.]
:::

**Get the noise floor right.** For a while, every new device showed up as a warning. A device's first sync is a normal handshake in which the server assigns it a log id, and the server logged it with the same outcome as a real log reset. Idle polls filled the event tail as well. A console that warns on normal behavior trains its operators to ignore warnings, so the handshake now has its own outcome and idle polls are hidden by default.

**Count failures once.** Two views counted failures differently: People counted rejected pushes, and the overview also counted rejected requests without crediting them to a device. A person showed zero failures on one screen and one on another. Both views now read the same per-device count.

**Make the safe setup the only setup.** Mounting the console used to take an event ring wired into three places. Forgetting the realtime hub's copy dropped every socket round from the console without an error. The console now mounts with one option, and that option wires the ring itself:

```ts title="src/server.ts"
const app = createSyncularHono({
  config,
  authenticate,
  admin: {
    authorize: ({ request }) => isOperator(request),
    authorizeActions: ({ request }) => isOnCall(request), // retry, prune, revoke
  },
});
```

**Ship it with the server.** The console is one HTML page of 110 KiB (31 KiB gzipped) with no build step and no external assets, served by the sync server under `/admin`. It runs in a Bun process, in a Cloudflare Worker that forwards each partition to its Durable Object, and inside a browser tab, where the sync lab runs its server in a Web Worker. Debugging a sync problem should not wait on setting up an observability stack.

**Treat admin access as data access.** The console shows decoded rows, so `authorize` is mandatory and runs on every route. A guard that grants one partition does not grant the list of all partitions, and an unauthorized caller cannot learn how many partitions exist.

## Limits

- A device that is offline now is invisible until it syncs. The console shows when it last synced and how far behind it is.
- The event ring holds minutes of history on a busy server, per process. Send the same events to your log pipeline for anything older.
- The delivery trace explains what the server sent. A row that a device has but does not show is a question for the app's local queries.
- Anyone with console access reads your users' data.

## Try it

The [sync lab](/demo/) runs two devices and a Syncular server in one browser tab. Select "Simulate conflict", then open "Server console" and follow the conflict from People to the request, the write, the row, and the trace. Nothing to install and no account. The setup for your own server is on [Admin console](/server-admin-console/).

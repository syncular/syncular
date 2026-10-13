---
title: 'Local-First Is Great for Users and Blind for Developers'
description: Local-first apps are fast and work offline, but when something goes wrong the developer can't see the device it happened on. How Syncular's admin console uses what the sync server already stores to answer a support ticket.
summary: Local-first makes apps better for users and harder to debug. One support ticket, worked through in Syncular's admin console.
author: Benjamin Kniffler
publishedAt: '2026-10-13'
---

# Local-First Is Great for Users and Blind for Developers

<figure class="shot">
  <img src="/blog/admin-console-overview.webp" width="1280" height="800" alt="The overview of the Syncular admin console for the demo partition: 8.2 requests per minute, 0% error rate, p95 latency 3 ms, one push applied and one conflicted, two of three clients connected, commit log head at 2, and a request-volume chart over the last five minutes." />
  <figcaption>The overview of Syncular's admin console in the sync lab, seconds after a simulated conflict: one push applied, one conflicted.</figcaption>
</figure>

Ada writes to support: "I moved the photo-upload card to Review on my laptop on the train. When I got home it was in Done." She attached a screenshot of the board. There's no request id or device id in her message, because a local-first app never shows the user either of those.

Syncular is an open-source sync engine that keeps local SQLite databases in sync with a server. Over the last weeks I built an admin console for it, and this post walks through how it answers a ticket like Ada's. The ticket is staged in Syncular's demo, so you can reproduce it yourself at the end.

## What the user gets

Local-first is a good deal for users. Reads come from a database on the device, so the app responds as fast as a SQLite query. Writes land locally first and wait in an outbox until there's a network, so the app keeps working on a train and a dropped connection loses nothing. Users don't see spinners or sync errors.

## What the developer gets

For the developer, the same properties hide what's going on:

- Reads are local, so the server never sees what the user saw.
- The outbox retries failed writes quietly. That's its job, and it means nobody gets told.
- A device can be offline for a week and then push a week of writes in one request.
- By the time someone reports a problem, the request behind it may be days old, and they can't tell you which one it was.

Most server-side debugging tools assume that the request is the unit of work and that the server saw all of it. In a local-first app the unit of work is a change someone made on a device you can't see. It may reach the server days later, as part of a conflict with someone else's change.

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

::caption[You can only look at the middle column. Both devices were offline when the card moved.]
:::

The closest comparison I know is durable execution engines like Temporal. A workflow there runs across retries, crashes and waits that last days, so the log of any single process won't explain it. Those systems became operable because they record every step as a durable history and let you inspect it per workflow. A sync engine needs something similar, searchable by what a support ticket mentions: a person, a device, a row or a write.

## What the server already knows

The devices are out of reach, but each of them talks to the server sooner or later, and the server already stores most of what you need, because sync needs it too:

- each device's cursor, the last commit it has pulled, and its subscriptions, the tables and scope values it asked for
- each write's outcome, stored under its `clientCommitId` so a retried write gets the same answer
- the commit log, with every row change and the scopes of every row
- the scopes `resolveScopes` grants each person

Given those, sync is deterministic. A device with cursor 40 that subscribes to `board_id: mobile` holds every change to `mobile` rows up to commit 40, and nothing else. So the server can work out what a device should have without asking the device. The console calls this the delivery trace. It checks eight conditions in order and stops at the first one that matches:

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

::caption[Inputs: the row's stored scopes and last change, the device's subscriptions and cursor, and the person's allowed scopes. All of them are on the server.]
:::

The obvious limit: if a device is offline right now, the server knows nothing newer than its last sync. The console shows when that was and how far behind the device is.

## Following the ticket

The ticket names a person, so I start at People. It lists each person with their devices, open sockets, cursor lag and recent failures. Ada has one failure in the last five minutes.

<figure class="shot">
  <img src="/blog/admin-console-people.webp" width="768" height="280" alt="The People view of the Syncular admin console filtered to ada: one device connected, cursor lag 0, one failure. Below, the failures panel lists one warned sync request from ada's laptop that conflicted on cards / c-mobile-13." />
  <figcaption>People, filtered to Ada: one device, connected and caught up, and one request that conflicted on <code>cards / c-mobile-13</code>.</figcaption>
</figure>

Opening the failure shows the request: the laptop pushed one commit and pulled one, and the push conflicted on the card.

<figure class="shot">
  <img src="/blog/admin-console-request.webp" width="880" height="352" alt="A sync request dialog: ok, 3 ms, 1 pushed, 1 commit pulled, conflicted cards / c-mobile-13. Its events: request.handled, pull.served, and a push.conflicted warning on cards / c-mobile-13." />
  <figcaption>The events of the laptop's sync request, grouped by request id.</figcaption>
</figure>

The `push.conflicted` event carries the write's `clientCommitId`, which leads to the outcome the server stored for that write: `sync.version_conflict`. The row was at version 2, and Ada's write was based on version 1.

<figure class="shot">
  <img src="/blog/admin-console-write.webp" width="880" height="318" alt="The write dialog for one client commit id: rejected from ada's laptop. Operation 0 has status conflict, code sync.version_conflict, server version 2, message: present columns moved past baseVersion." />
  <figcaption>The stored outcome of Ada's write. If the laptop retried it, the server would return this same answer.</figcaption>
</figure>

The row's history shows where version 2 came from: Ben's phone, one commit before Ada's laptop came back online. The same page lists every device in the partition with its verdict for this row.

<figure class="shot">
  <img src="/blog/admin-console-row.webp" width="768" height="583" alt="The row page for cards / c-mobile-13 at version 2: values with column_id done, history with commit 2 from ben's phone and commit 1 from the seed client, and a who-has-this-row table where the seed client has no subscription and ada's and ben's devices are delivered." />
  <figcaption>The card at version 2. Ben's phone moved it to Done in commit 2, and both devices have pulled it.</figcaption>
</figure>

The trace for Ada's laptop says `delivered`: its cursor is at commit 2, its `cards:mobile` subscription covers the row, and Ada is allowed to see the `mobile` board.

<figure class="shot">
  <img src="/blog/admin-console-trace.webp" width="880" height="556" alt="The delivery trace for ada's laptop on cards / c-mobile-13: Delivered. Row version 2, last change commit 2 by ben, client cursor 2 and connected, allowed board_id web and mobile. The cards:web subscription mismatches the row's board, the cards:mobile subscription covers it. One rejected push: push.conflicted on the card." />
  <figcaption>The delivery trace for Ada's laptop on the card.</figcaption>
</figure>

Put together: Ada and Ben both moved the card while offline. Ben's phone reconnected first and its move went through. Ada's laptop reconnected second, its write conflicted, and it pulled Ben's version, which is why the card shows Done. Her move is kept in a conflict record on the laptop until she chooses which version to keep. Support can tell her all of that without access to her laptop.

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

## What I got wrong along the way

The first version of the console had nine views, one per data type: clients, commits, rows, scopes and so on. Everything was in there, but with a ticket in hand it wasn't clear where to start, because tickets mention people and cards. I rebuilt it around a find box that accepts any id a ticket might contain, and a People view that groups devices by person.

The console adds nothing to the write path. Cursors, subscriptions, write outcomes and the commit log are stored anyway because sync needs them, and the console reads them through optional storage methods without extra indexes. The only new state is an in-memory ring of recent server events, which is where requests, failures and latency come from.

:::figure{title="Two sources, two lifetimes"}
<div class="d-cols-2">
<div class="node ok"><span class="t">Server storage · durable</span>devices, cursors, subscriptions<br>write outcomes<br>rows, history, commits<br><span class="chip ok">kept as long as retention keeps it</span></div>
<div class="node cool"><span class="t">Event ring · in memory</span>requests and their events<br>failures by code and device<br>latency and volume<br><span class="chip cool">the last 1000 events per process</span></div>
</div>

::caption[A restart empties the ring and leaves everything in storage. For older events, send the same stream to your log pipeline.]
:::

For a while every new device showed up as a warning. A device's first sync is a normal handshake in which the server assigns it a log id, but the server logged it with the same outcome as an actual log reset. Idle polls also crowded the event list. When normal behavior shows up as warnings, people stop reading warnings, so the handshake now has its own outcome and idle polls are hidden by default.

Two views also counted failures differently. People counted only rejected pushes, while the overview also counted rejected requests without attributing them to a device, so a person could have zero failures on one screen and one on the other. Both now use the same count.

Setting the console up used to mean wiring an event ring into three places. If you forgot the realtime hub, socket traffic went missing from the console without any error. Now it's one option, and the option wires the ring:

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

The console itself is a single HTML page of 110 KiB (31 KiB gzipped) with no build step and no external assets, served by the sync server under `/admin`. It runs in a Bun process, in a Cloudflare Worker that forwards each partition to its Durable Object, and in a browser tab, where the sync lab runs its whole server in a Web Worker. I didn't want debugging a sync issue to depend on setting up an observability stack first.

Since the console shows decoded rows, access to it is access to your users' data. `authorize` is required and runs on every route. A guard that grants one partition doesn't grant the list of all partitions, and an unauthorized caller can't find out how many partitions exist.

## Limits

- A device that's offline right now is invisible until it syncs.
- On a busy server the event ring holds minutes of history, per process.
- The delivery trace covers what the server sent. If a device has a row but doesn't show it, look at the app's local queries.
- Anyone with console access can read your users' data.

## Try it

The [sync lab](/demo/) runs two devices and a Syncular server in one browser tab. Click "Simulate conflict", open "Server console", and follow the conflict from People to the trace. Setting it up on your own server is covered in the [Admin console docs](/server-admin-console/).

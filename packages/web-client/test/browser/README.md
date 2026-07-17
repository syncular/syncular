# Browser leadership fixture

This fixture exercises RFC 0007 §3 in a real browser using native Web Locks,
BroadcastChannel, Worker, top-level tabs, and a same-origin preview iframe.

Run `bun packages/web-client/test/browser/serve-leadership.ts`, then cover:

1. two URLs with the same `suite`, `lock`, and no `partition` become one leader
   and one follower, with one `/events?suite=…` worker open;
2. keep a leader open and launch a second URL with the same lock but distinct
   `partition` values; it becomes `blocked`, reports
   `client.follower_timeout` immediately on its next call, and does not add a
   worker open; and
3. use `embed=preview-id`; the parent and isolated preview iframe both become
   leaders and `/events` reports two distinct worker opens.

The deterministic injected suite remains in `../multi-tab.test.ts`; this page
is the browser-level topology fixture and deliberately uses browser primitives.

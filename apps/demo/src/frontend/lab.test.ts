import { describe, expect, test } from 'bun:test';
import type { OutboxCommit } from '@syncular/client';
import type { SyncularServerEvent } from '@syncular/server';
import {
  advanceTour,
  applyServerEvent,
  currentStep,
  type DeviceId,
  EMPTY_LOG,
  LOG_CAPACITY,
  type LogState,
  outboxLines,
  planMove,
  resetTour,
  type Transit,
  type WriteIntent,
} from './lab';

const CLIENTS: Record<string, DeviceId> = {
  'c-laptop': 'laptop',
  'c-phone': 'phone',
};
const deviceOf = (clientId: string) => CLIENTS[clientId];
const base = { atMs: 1, partition: 'demo', actorId: 'demo-user' };

function applied(
  clientId: string,
  clientCommitId: string,
  commitSeq: number,
  replay = false,
): SyncularServerEvent {
  return {
    ...base,
    type: 'push.applied',
    clientId,
    clientCommitId,
    operations: 1,
    commitSeq,
    replay,
  };
}
function conflicted(
  clientId: string,
  clientCommitId: string,
): SyncularServerEvent {
  return {
    ...base,
    type: 'push.conflicted',
    clientId,
    clientCommitId,
    operations: 1,
    opIndex: 0,
    replay: false,
  };
}
function delta(clientId: string, commitSeq: number): SyncularServerEvent {
  return {
    ...base,
    type: 'realtime.delta',
    clientId,
    sessionId: 's',
    commitSeq,
    bytes: 10,
    changes: 1,
  };
}
function pulled(
  clientId: string,
  mode: 'bootstrap' | 'incremental',
  first?: number,
  last?: number,
): SyncularServerEvent {
  return {
    ...base,
    type: 'pull.served',
    clientId,
    acceptedThrough: 0,
    storageMaxCommitSeq: last ?? 0,
    subscriptions: [
      {
        id: 'todos:home',
        table: 'todos',
        status: 'active',
        mode,
        requestedScopes: { list_id: ['home'] },
        effectiveScopes: { list_id: ['home'] },
        ...(first !== undefined ? { firstCommitSeq: first } : {}),
        ...(last !== undefined ? { lastCommitSeq: last } : {}),
        fromCursor: 0,
        nextCursor: last ?? 0,
        commits:
          first === undefined || last === undefined ? 0 : last - first + 1,
        changes: 1,
        segments: [],
      },
    ],
  };
}

function fold(
  events: readonly SyncularServerEvent[],
  start: LogState = EMPTY_LOG,
) {
  let state = start;
  const transits: Transit[] = [];
  for (const event of events) {
    const result = applyServerEvent(state, event, deviceOf);
    state = result.state;
    transits.push(...result.transits);
  }
  return { state, transits };
}

describe('commit log', () => {
  test('a push and its realtime delta form one delivered entry', () => {
    const { state, transits } = fold([
      applied('c-laptop', 'k1', 2),
      delta('c-phone', 2),
    ]);
    expect(state.entries).toEqual([
      {
        clientCommitId: 'k1',
        origin: 'laptop',
        status: 'applied',
        commitSeq: 2,
        replay: false,
        operations: 1,
        deliveredTo: ['phone'],
        arrival: 1,
      },
    ]);
    expect(transits).toEqual([
      { device: 'laptop', direction: 'up', label: 'c2', tone: 'applied' },
      { device: 'phone', direction: 'down', label: 'c2', tone: 'delivery' },
    ]);
  });

  test('a delta that precedes its push.applied still marks the receiver', () => {
    const { state } = fold([delta('c-phone', 2), applied('c-laptop', 'k1', 2)]);
    expect(state.entries[0]?.deliveredTo).toEqual(['phone']);
  });

  test('the seed commit and unknown clients have no wire', () => {
    const { state, transits } = fold([
      applied('seed', 'seed-commit-1', 1),
      applied('other', 'k9', 2),
    ]);
    expect(state.entries.map((entry) => entry.origin)).toEqual([
      'external',
      'seed',
    ]);
    expect(transits).toEqual([]);
  });

  test('a conflict keeps no sequence and travels up in the conflict tone', () => {
    const { state, transits } = fold([conflicted('c-laptop', 'k2')]);
    expect(state.entries[0]).toMatchObject({
      status: 'conflict',
      origin: 'laptop',
    });
    expect(state.entries[0]?.commitSeq).toBeUndefined();
    expect(transits).toEqual([
      {
        device: 'laptop',
        direction: 'up',
        label: 'conflict',
        tone: 'conflict',
      },
    ]);
  });

  test('a catch-up pull delivers the covered range to the reconnecting device', () => {
    const { state, transits } = fold([
      applied('c-laptop', 'k1', 2),
      applied('c-laptop', 'k2', 3),
      applied('c-laptop', 'k3', 4),
      pulled('c-phone', 'incremental', 2, 3),
    ]);
    expect(
      state.entries.map((entry) => [entry.commitSeq, entry.deliveredTo]),
    ).toEqual([
      [4, []],
      [3, ['phone']],
      [2, ['phone']],
    ]);
    expect(transits.at(-1)).toEqual({
      device: 'phone',
      direction: 'down',
      label: 'c2–c3',
      tone: 'delivery',
    });
  });

  test('a device never counts as a receiver of its own commit', () => {
    const { state } = fold([
      applied('c-phone', 'k1', 2),
      pulled('c-phone', 'incremental', 2, 2),
    ]);
    expect(state.entries[0]?.deliveredTo).toEqual([]);
  });

  test('a bootstrap pull animates a snapshot and an empty pull animates nothing', () => {
    expect(fold([pulled('c-phone', 'bootstrap')]).transits).toEqual([
      {
        device: 'phone',
        direction: 'down',
        label: 'snapshot',
        tone: 'delivery',
      },
    ]);
    expect(fold([pulled('c-phone', 'incremental')]).transits).toEqual([]);
  });

  test('a replayed backlog leaves entries in place and marks cache replays', () => {
    const first = fold([
      applied('c-laptop', 'k1', 2),
      delta('c-phone', 2),
    ]).state;
    const again = fold(
      [applied('c-laptop', 'k1', 2, true), delta('c-phone', 2)],
      first,
    ).state;
    expect(again.entries).toHaveLength(1);
    expect(again.entries[0]).toMatchObject({
      replay: true,
      deliveredTo: ['phone'],
      arrival: 1,
    });
  });

  test('the log keeps the newest entries up to its capacity', () => {
    const events = Array.from({ length: LOG_CAPACITY + 5 }, (_, index) =>
      applied('c-laptop', `k${index}`, index + 1),
    );
    const { state } = fold(events);
    expect(state.entries).toHaveLength(LOG_CAPACITY);
    expect(state.entries[0]?.commitSeq).toBe(LOG_CAPACITY + 5);
    expect(state.arrivals).toBe(LOG_CAPACITY + 5);
  });
});

describe('guided tour', () => {
  const intents = new Map<string, WriteIntent>([
    [
      'move-1',
      { kind: 'move', title: 'Cache the pricing API', boardId: 'web' },
    ],
    ['move-2', { kind: 'move', title: 'Biometric sign-in', boardId: 'mobile' }],
    ['edit-1', { kind: 'edit', title: 'Dark mode', boardId: 'web' }],
    ['grant-1', { kind: 'grant', title: 'Ben', boardId: 'web' }],
  ]);
  const intentOf = (id: string) => intents.get(id);
  const phone = (online: boolean, pending = 0, sqlRuns = 0) => ({
    online,
    pending,
    sqlRuns,
  });

  test('the steps complete from real log entries and device state', () => {
    let log = EMPTY_LOG;
    let tour = resetTour(log);
    const step = (view: {
      phone: ReturnType<typeof phone>;
      openConflicts?: number;
    }) => {
      tour = advanceTour(tour, {
        log,
        intentOf,
        phone: view.phone,
        openConflicts: view.openConflicts ?? 0,
      });
    };
    expect(currentStep(tour)).toBe('move');

    log = fold([applied('c-phone', 'edit-1', 2)], log).state;
    step({ phone: phone(true) });
    expect(tour.done.move).toBe(false);
    log = fold([applied('c-laptop', 'move-1', 3)], log).state;
    step({ phone: phone(true) });
    expect(currentStep(tour)).toBe('offline');

    // Offline with queued phone writes, but the laptop has not moved a card since.
    step({ phone: phone(false, 2) });
    expect(tour.done.offline).toBe(false);
    log = fold([applied('c-laptop', 'move-2', 4)], log).state;
    step({ phone: phone(false, 2) });
    expect(currentStep(tour)).toBe('reconnect');

    step({ phone: phone(true, 2) });
    expect(tour.done.reconnect).toBe(false);
    log = fold([applied('c-phone', 'k-offline-1', 5)], log).state;
    step({ phone: phone(true) });
    expect(currentStep(tour)).toBe('conflict');

    log = fold([conflicted('c-laptop', 'k-stale')], log).state;
    step({ phone: phone(true), openConflicts: 1 });
    expect(tour.done.conflict).toBe(false);
    step({ phone: phone(true), openConflicts: 0 });
    expect(currentStep(tour)).toBe('scope');

    log = fold([applied('c-laptop', 'grant-1', 6)], log).state;
    step({ phone: phone(true, 0, 3) });
    expect(tour.done.scope).toBe(false);
    step({ phone: phone(true, 0, 4) });
    expect(currentStep(tour)).toBeUndefined();
  });

  test('a phone commit from before the offline step does not count as the replay', () => {
    let log = fold([applied('c-phone', 'k-before', 2)]).state;
    let tour = resetTour(EMPTY_LOG);
    tour = advanceTour(tour, {
      log,
      intentOf,
      phone: phone(false, 1),
      openConflicts: 0,
    });
    log = fold([applied('c-laptop', 'move-1', 3)], log).state;
    tour = advanceTour(tour, {
      log,
      intentOf,
      phone: phone(false, 1),
      openConflicts: 0,
    });
    expect(tour.done.offline).toBe(true);
    tour = advanceTour(tour, {
      log,
      intentOf,
      phone: phone(true),
      openConflicts: 0,
    });
    expect(tour.done.reconnect).toBe(false);
    log = fold([applied('c-phone', 'k-after', 4)], log).state;
    expect(
      advanceTour(tour, { log, intentOf, phone: phone(true), openConflicts: 0 })
        .done.reconnect,
    ).toBe(true);
  });

  test('reset ignores entries that arrived before it', () => {
    const log = fold([
      applied('c-laptop', 'move-1', 2),
      conflicted('c-laptop', 'k-stale'),
    ]).state;
    const tour = advanceTour(resetTour(log), {
      log,
      intentOf,
      phone: phone(true),
      openConflicts: 0,
    });
    expect(Object.values(tour.done).some(Boolean)).toBe(false);
  });
});

describe('outbox lines', () => {
  test('recorded intents name the write; other commits read their first operation', () => {
    const commits: OutboxCommit[] = [
      { seq: 1, clientCommitId: 'move-1', createdAtMs: 1, operations: [] },
      {
        seq: 2,
        clientCommitId: 'k-other',
        createdAtMs: 2,
        operations: [
          {
            table: 'cards',
            rowId: 'c1',
            op: 'upsert',
            values: { title: 'From a sibling tab', board_id: 'web' },
          },
        ],
      },
      {
        seq: 3,
        clientCommitId: 'k-del',
        createdAtMs: 3,
        operations: [{ table: 'cards', rowId: 'c2', op: 'delete' }],
      },
    ];
    expect(
      outboxLines(commits, (id) =>
        id === 'move-1'
          ? { kind: 'move', title: 'Biometric sign-in', boardId: 'mobile' }
          : undefined,
      ),
    ).toEqual([
      {
        clientCommitId: 'move-1',
        kind: 'move',
        title: 'Biometric sign-in',
        boardId: 'mobile',
      },
      {
        clientCommitId: 'k-other',
        kind: 'upsert',
        title: 'From a sibling tab',
        boardId: 'web',
      },
      { clientCommitId: 'k-del', kind: 'delete', title: 'c2' },
    ]);
  });
});

describe('card moves', () => {
  const column = (columnId: string, ...positions: number[]) =>
    positions.map((position, index) => ({
      id: `${columnId}-${index}`,
      columnId,
      position,
    }));
  const cards = [
    ...column('doing', 1000, 2000, 3000),
    ...column('review', 1000),
  ];

  test('a move takes the midpoint between its new neighbours', () => {
    expect(planMove(cards, 'review-0', 'doing', 1)).toEqual([
      { id: 'review-0', columnId: 'doing', position: 1500 },
    ]);
    expect(planMove(cards, 'doing-0', 'review', 0)).toEqual([
      { id: 'doing-0', columnId: 'review', position: 500 },
    ]);
    expect(planMove(cards, 'doing-0', 'done', 0)).toEqual([
      { id: 'doing-0', columnId: 'done', position: 1000 },
    ]);
    expect(planMove(cards, 'doing-0', 'doing', 9)).toEqual([
      { id: 'doing-0', columnId: 'doing', position: 4000 },
    ]);
  });

  test('a card already in place plans nothing', () => {
    expect(planMove(cards, 'doing-1', 'doing', 1)).toEqual([]);
  });

  test('a full gap renumbers the column in one plan', () => {
    const tight = [...column('doing', 1000, 1001), ...column('review', 5000)];
    expect(planMove(tight, 'review-0', 'doing', 1)).toEqual([
      { id: 'review-0', columnId: 'doing', position: 2000 },
      { id: 'doing-1', columnId: 'doing', position: 3000 },
    ]);
  });
});

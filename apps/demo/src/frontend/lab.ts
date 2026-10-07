/**
 * The sync lab's state model, kept free of DOM and client cores so it runs
 * under bun:test. Three pieces:
 * - the commit log: server events (`push.*`, `realtime.delta`,
 *   `pull.served`) folded into one entry per client commit, plus the
 *   packets ("transits") the stage animates for each event;
 * - the guided tour: five steps that complete from log entries, the
 *   phone's network/outbox state, open conflicts, and Local SQL runs;
 * - outbox lines: a device's pending commits rendered as queued writes.
 */
import type { OutboxCommit } from '@syncular/client';
import type { SyncularServerEvent } from '@syncular/server';

export type DeviceId = 'laptop' | 'phone';

/** What a device meant by a commit, recorded when `mutate` returns its id. */
export interface WriteIntent {
  readonly kind: 'add' | 'move' | 'edit' | 'keep-mine' | 'grant' | 'revoke';
  /** The card title, or the person a grant or revoke names. */
  readonly title: string;
  readonly boardId: string;
}

export interface LogEntry {
  readonly clientCommitId: string;
  /** `seed` is the server-side seed commit; `external` any other client. */
  readonly origin: DeviceId | 'seed' | 'external';
  readonly status: 'applied' | 'conflict' | 'rejected';
  readonly commitSeq?: number;
  /** The server answered from its idempotency cache (§2.3). */
  readonly replay: boolean;
  /** §10 code of a rejected commit. */
  readonly code?: string;
  readonly operations: number;
  /** Devices that received the commit through a delta or a pull. */
  readonly deliveredTo: readonly DeviceId[];
  /** Monotonic arrival order; survives the log's length cap. */
  readonly arrival: number;
}

export interface LogState {
  /** Newest first, capped at {@link LOG_CAPACITY}. */
  readonly entries: readonly LogEntry[];
  readonly arrivals: number;
  /**
   * Receivers by commitSeq. The hub fans a commit out before the pusher's
   * `push.applied` is emitted, so a delivery can precede its entry.
   */
  readonly deliveries: Readonly<Record<number, readonly DeviceId[]>>;
}

/** One packet on a wire between a device and the server. */
export interface Transit {
  readonly device: DeviceId;
  readonly direction: 'up' | 'down';
  readonly label: string;
  readonly tone: 'applied' | 'conflict' | 'rejected' | 'delivery';
}

export const LOG_CAPACITY = 60;
export const EMPTY_LOG: LogState = { entries: [], arrivals: 0, deliveries: {} };

function upsertEntry(
  state: LogState,
  clientCommitId: string,
  build: (previous: LogEntry | undefined, arrival: number) => LogEntry,
): LogState {
  const previous = state.entries.find(
    (entry) => entry.clientCommitId === clientCommitId,
  );
  if (previous !== undefined) {
    return {
      ...state,
      entries: state.entries.map((entry) =>
        entry === previous ? build(previous, previous.arrival) : entry,
      ),
    };
  }
  const arrival = state.arrivals + 1;
  const entries = [build(undefined, arrival), ...state.entries].slice(
    0,
    LOG_CAPACITY,
  );
  // Forget receivers of commits older than every retained entry.
  const floor = Math.min(
    ...entries.map((entry) => entry.commitSeq ?? Number.POSITIVE_INFINITY),
  );
  const deliveries = Object.fromEntries(
    Object.entries(state.deliveries).filter(([seq]) => Number(seq) >= floor),
  );
  return { entries, arrivals: arrival, deliveries };
}

function deliver(
  state: LogState,
  device: DeviceId,
  seqs: readonly number[],
): LogState {
  const deliveries = { ...state.deliveries };
  for (const seq of seqs) {
    const known = deliveries[seq] ?? [];
    if (!known.includes(device)) deliveries[seq] = [...known, device];
  }
  return {
    ...state,
    deliveries,
    entries: state.entries.map((entry) =>
      entry.commitSeq !== undefined && seqs.includes(entry.commitSeq)
        ? {
            ...entry,
            deliveredTo: receivers(deliveries, entry.commitSeq, entry.origin),
          }
        : entry,
    ),
  };
}

function receivers(
  deliveries: LogState['deliveries'],
  commitSeq: number | undefined,
  origin: LogEntry['origin'],
): readonly DeviceId[] {
  if (commitSeq === undefined) return [];
  return (deliveries[commitSeq] ?? []).filter((device) => device !== origin);
}

/**
 * Fold one server event into the log. Replayed events (an SSE reconnect
 * re-sends the ring backlog) leave the log unchanged apart from the
 * idempotency-cache flag, so the fold is safe to repeat.
 */
export function applyServerEvent(
  state: LogState,
  event: SyncularServerEvent,
  deviceOf: (clientId: string) => DeviceId | undefined,
): { readonly state: LogState; readonly transits: readonly Transit[] } {
  switch (event.type) {
    case 'push.applied':
    case 'push.conflicted':
    case 'push.rejected': {
      const device = deviceOf(event.clientId);
      const status =
        event.type === 'push.applied'
          ? 'applied'
          : event.type === 'push.conflicted'
            ? 'conflict'
            : 'rejected';
      const origin =
        device ?? (event.clientId === 'seed' ? 'seed' : 'external');
      const next = upsertEntry(
        state,
        event.clientCommitId,
        (previous, arrival) => {
          const commitSeq =
            event.type === 'push.applied'
              ? event.commitSeq
              : previous?.commitSeq;
          return {
            clientCommitId: event.clientCommitId,
            origin,
            status,
            ...(commitSeq !== undefined ? { commitSeq } : {}),
            replay: event.replay || (previous?.replay ?? false),
            ...(event.type === 'push.rejected' ? { code: event.code } : {}),
            operations: event.operations,
            deliveredTo: receivers(state.deliveries, commitSeq, origin),
            arrival,
          };
        },
      );
      const seq =
        event.type === 'push.applied' && event.commitSeq !== undefined
          ? `c${event.commitSeq}`
          : status;
      return {
        state: next,
        transits:
          device === undefined
            ? []
            : [{ device, direction: 'up', label: seq, tone: status }],
      };
    }
    case 'realtime.delta': {
      const device = deviceOf(event.clientId);
      if (device === undefined) return { state, transits: [] };
      return {
        state: deliver(state, device, [event.commitSeq]),
        transits: [
          {
            device,
            direction: 'down',
            label: `c${event.commitSeq}`,
            tone: 'delivery',
          },
        ],
      };
    }
    case 'pull.served': {
      const device = deviceOf(event.clientId);
      if (device === undefined) return { state, transits: [] };
      let next = state;
      const transits: Transit[] = [];
      for (const section of event.subscriptions) {
        if (section.mode === 'bootstrap') {
          transits.push({
            device,
            direction: 'down',
            label: 'snapshot',
            tone: 'delivery',
          });
          continue;
        }
        const first = section.firstCommitSeq;
        const last = section.lastCommitSeq;
        if (
          section.commits === 0 ||
          first === undefined ||
          last === undefined
        ) {
          continue;
        }
        next = deliver(
          next,
          device,
          Array.from({ length: last - first + 1 }, (_, index) => first + index),
        );
        transits.push({
          device,
          direction: 'down',
          label: first === last ? `c${first}` : `c${first}–c${last}`,
          tone: 'delivery',
        });
      }
      return { state: next, transits };
    }
    default:
      return { state, transits: [] };
  }
}

// -- guided tour --------------------------------------------------------------

export const TOUR_STEPS = [
  'move',
  'offline',
  'reconnect',
  'conflict',
  'scope',
] as const;
export type TourStepId = (typeof TOUR_STEPS)[number];

export interface TourState {
  readonly done: Readonly<Record<TourStepId, boolean>>;
  /** Entries at or below this arrival predate the last reset. */
  readonly since: number;
  /** Arrival count when the phone was last seen going offline. */
  readonly phoneOfflineAt?: number;
  /** Arrival count when the offline step completed. */
  readonly offlineAt?: number;
  /** A conflict reached the log; the step completes once none is open. */
  readonly conflictSeen: boolean;
  /** Phone SQL runs counted when a grant or revoke reached the log. */
  readonly scopeSqlBaseline?: number;
}

export interface TourView {
  readonly log: LogState;
  readonly intentOf: (clientCommitId: string) => WriteIntent | undefined;
  readonly phone: {
    readonly online: boolean;
    readonly pending: number;
    /** Monotonic count of Local SQL queries run on the phone. */
    readonly sqlRuns: number;
  };
  /** Conflict records open on either device. */
  readonly openConflicts: number;
}

export function resetTour(log: LogState): TourState {
  return {
    done: {
      move: false,
      offline: false,
      reconnect: false,
      conflict: false,
      scope: false,
    },
    since: log.arrivals,
    conflictSeen: false,
  };
}

/** Steps only ever complete; {@link resetTour} is the one way back. */
export function advanceTour(tour: TourState, view: TourView): TourState {
  const fresh = view.log.entries.filter((entry) => entry.arrival > tour.since);
  const appliedBy = (
    origin: DeviceId | undefined,
    kinds: readonly WriteIntent['kind'][],
    after = tour.since,
  ) =>
    fresh.some(
      (entry) =>
        entry.status === 'applied' &&
        entry.arrival > after &&
        (origin === undefined
          ? entry.origin === 'laptop' || entry.origin === 'phone'
          : entry.origin === origin) &&
        kinds.includes(view.intentOf(entry.clientCommitId)?.kind ?? 'edit'),
    );

  const move = tour.done.move || appliedBy(undefined, ['move']);

  const phoneOfflineAt = view.phone.online
    ? undefined
    : (tour.phoneOfflineAt ?? view.log.arrivals);
  const wentOffline =
    !tour.done.offline &&
    phoneOfflineAt !== undefined &&
    view.phone.pending > 0 &&
    appliedBy('laptop', ['move'], phoneOfflineAt);
  const offline = tour.done.offline || wentOffline;
  const offlineAt = wentOffline ? view.log.arrivals : tour.offlineAt;

  const reconnect =
    tour.done.reconnect ||
    (offline &&
      offlineAt !== undefined &&
      view.phone.online &&
      view.phone.pending === 0 &&
      appliedBy('phone', ['add', 'move', 'edit'], offlineAt));

  const conflictSeen =
    tour.conflictSeen || fresh.some((entry) => entry.status === 'conflict');
  const conflict =
    tour.done.conflict || (conflictSeen && view.openConflicts === 0);

  const scopeSqlBaseline =
    tour.scopeSqlBaseline ??
    (appliedBy('laptop', ['grant', 'revoke']) ? view.phone.sqlRuns : undefined);
  const scope =
    tour.done.scope ||
    (scopeSqlBaseline !== undefined && view.phone.sqlRuns > scopeSqlBaseline);

  return {
    done: { move, offline, reconnect, conflict, scope },
    since: tour.since,
    conflictSeen,
    ...(phoneOfflineAt !== undefined ? { phoneOfflineAt } : {}),
    ...(offlineAt !== undefined ? { offlineAt } : {}),
    ...(scopeSqlBaseline !== undefined ? { scopeSqlBaseline } : {}),
  };
}

/** The first step still open, or undefined once every step is done. */
export function currentStep(tour: TourState): TourStepId | undefined {
  return TOUR_STEPS.find((step) => !tour.done[step]);
}

// -- outbox -------------------------------------------------------------------

export interface OutboxLine {
  readonly clientCommitId: string;
  readonly kind: WriteIntent['kind'] | 'upsert' | 'delete';
  readonly title: string;
  readonly boardId?: string;
}

/**
 * One line per pending commit. The recorded intent names the write; a
 * commit without one (written by an earlier page load, or a sibling tab)
 * reads its first operation instead.
 */
export function outboxLines(
  commits: readonly OutboxCommit[],
  intentOf: (clientCommitId: string) => WriteIntent | undefined,
): OutboxLine[] {
  return commits.map((commit) => {
    const intent = intentOf(commit.clientCommitId);
    if (intent !== undefined) {
      return {
        clientCommitId: commit.clientCommitId,
        kind: intent.kind,
        title: intent.title,
        boardId: intent.boardId,
      };
    }
    const operation = commit.operations[0];
    const title = operation?.values?.title;
    const boardId = operation?.values?.board_id;
    return {
      clientCommitId: commit.clientCommitId,
      kind: operation?.op ?? 'upsert',
      title: typeof title === 'string' ? title : (operation?.rowId ?? ''),
      ...(typeof boardId === 'string' ? { boardId } : {}),
    };
  });
}

// -- card moves ---------------------------------------------------------------

export interface CardPlace {
  readonly id: string;
  readonly columnId: string;
  readonly position: number;
}

/**
 * The patches that put `cardId` at `toIndex` of `toColumn`. Positions are
 * gapped integers: a move normally writes one card at the midpoint of its
 * new neighbours, and renumbers the column (one commit, several patches)
 * only when no integer is left between them. An empty plan means the card
 * is already there.
 */
export function planMove(
  cards: readonly CardPlace[],
  cardId: string,
  toColumn: string,
  toIndex: number,
): CardPlace[] {
  const card = cards.find((candidate) => candidate.id === cardId);
  if (card === undefined) throw new Error(`planMove: unknown card ${cardId}`);
  const order = (a: CardPlace, b: CardPlace) =>
    a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const siblings = cards
    .filter((other) => other.columnId === toColumn && other.id !== cardId)
    .sort(order);
  const index = Math.max(0, Math.min(toIndex, siblings.length));
  if (
    card.columnId === toColumn &&
    siblings.filter((other) => order(other, card) < 0).length === index
  ) {
    return [];
  }
  const prev = siblings[index - 1]?.position ?? 0;
  const next = siblings[index]?.position ?? prev + 2000;
  if (next - prev >= 2) {
    return [
      {
        id: cardId,
        columnId: toColumn,
        position: Math.floor((prev + next) / 2),
      },
    ];
  }
  const ordered = [...siblings];
  ordered.splice(index, 0, card);
  return ordered
    .map((place, rank) => ({
      id: place.id,
      columnId: toColumn,
      position: (rank + 1) * 1000,
    }))
    .filter((place) => {
      const before = cards.find((candidate) => candidate.id === place.id);
      return (
        before?.columnId !== place.columnId ||
        before.position !== place.position
      );
    });
}

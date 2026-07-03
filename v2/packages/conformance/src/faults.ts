/**
 * Fault injection at the transport seam (test doctrine, REVISE B4).
 *
 * The harness owns the loopback between a ClientInstance and a
 * ServerInstance; scenarios arm faults on this controller and the next
 * matching exchange misbehaves — deterministically, with no timers. The
 * only randomness is the truncation offset, drawn from a seeded PRNG so
 * every run of a scenario byte-truncates at the same place.
 *
 * Fault vocabulary (§2.3, §1.4, §5.1):
 * - drop request     — the request never reaches the server;
 * - drop response    — the server processed it, the ack is lost;
 * - duplicate        — the request is delivered twice (replayed bytes);
 * - truncate         — the response is cut short (decode-error surfacing);
 * - segment faults   — the same, at the segment download hop.
 */

/** Deterministic PRNG (mulberry32) — seeded per scenario. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** The error a faulted transport rejects with (client-observable). */
export class TransportFault extends Error {
  override readonly name = 'TransportFault';
  /** Client drivers surface transport losses under this code. */
  readonly code = 'transport.lost';
}

export class TransportFaults {
  /** Fail the next N sync requests before they reach the server. */
  dropNextRequests = 0;
  /** Deliver the next N sync requests, then lose their responses. */
  dropNextResponses = 0;
  /** Deliver the next sync request twice; return the second response. */
  duplicateNextRequest = false;
  /** Truncate the next sync response at a seeded offset. */
  truncateNextResponse = false;
  /** Fail the next N segment downloads before they reach the server. */
  dropNextSegmentRequests = 0;
  /** Truncate the next segment download at a seeded offset. */
  truncateNextSegmentDownload = false;
  /** Fail the next N signed-URL fetches (the CDN hop, §5.4). */
  dropNextUrlFetches = 0;
  /** Corrupt the next signed-URL fetch's bytes (§5.1 tamper). */
  corruptNextUrlFetch = false;

  readonly #random: () => number;

  constructor(random: () => number) {
    this.#random = random;
  }

  /** Seeded cut point: at least 1 byte kept, at least 1 byte removed. */
  truncate(bytes: Uint8Array): Uint8Array {
    const cut = 1 + Math.floor(this.#random() * (bytes.length - 1));
    return bytes.slice(0, cut);
  }

  /** Flip one seeded byte — same length, different content address. */
  corrupt(bytes: Uint8Array): Uint8Array {
    const out = bytes.slice();
    const index = Math.floor(this.#random() * out.length);
    out[index] = (out[index] ?? 0) ^ 0xff;
    return out;
  }
}

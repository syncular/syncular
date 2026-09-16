/**
 * Per-frame byte production for streaming responses (SPEC.md §1.4).
 *
 * The reference codec encodes whole messages; the server streams frames as
 * they are produced. Rather than duplicating the codec's frame encoders
 * (and risking drift), each frame is encoded inside a minimal legal wrapper
 * message via the reference `encodeMessage`, and its length-prefixed bytes
 * are sliced back out by walking the frame headers. Wrapper stubs are a few
 * bytes; the reference codec remains the single source of wire bytes.
 */
import {
  encodeMessage,
  PROTOCOL_WIRE_VERSION,
  type PushResultFrame,
  type RespHeaderFrame,
  type ResponseFrame,
  type SubEndFrame,
  type SubStartFrame,
} from '@syncular/core';

const stubHeader = (): RespHeaderFrame => ({
  type: 'RESP_HEADER',
  logEpoch: 'frame-probe',
  resetRequired: false,
});
const STUB_SUB_START: SubStartFrame = {
  type: 'SUB_START',
  id: '',
  status: 'active',
  reasonCode: '',
  effectiveScopes: {},
  bootstrap: false,
};
const STUB_SUB_END: SubEndFrame = { type: 'SUB_END', nextCursor: 0 };

const probe = encodeMessage({
  wireVersion: PROTOCOL_WIRE_VERSION,
  msgKind: 'response',
  frames: [stubHeader()],
});

/** The 8-byte SSP2 response envelope header (§1.2). */
export function responseEnvelopeHeader(wireVersion: number): Uint8Array {
  const encoded = encodeMessage({
    wireVersion,
    msgKind: 'response',
    frames: [stubHeader()],
  });
  return encoded.slice(0, 8);
}

/** The terminating END frame (§1.2 rule 1). */
export const END_FRAME_BYTES: Uint8Array = probe.slice(probe.length - 5);

function wrapperFor(frame: ResponseFrame): {
  frames: ResponseFrame[];
  index: number;
} {
  switch (frame.type) {
    case 'RESP_HEADER':
      return { frames: [frame], index: 0 };
    case 'LEASE':
      // §7.3.2: LEASE rides immediately after RESP_HEADER.
      return { frames: [stubHeader(), frame], index: 1 };
    case 'PUSH_RESULT':
    case 'ERROR':
    case 'UNKNOWN':
      return { frames: [stubHeader(), frame], index: 1 };
    case 'PUSH_RESULT_DETAILS': {
      const result: PushResultFrame = {
        type: 'PUSH_RESULT',
        clientCommitId: frame.clientCommitId,
        status: 'rejected',
        results: frame.entries.map((entry) => ({
          opIndex: entry.opIndex,
          status: 'error',
          code: 'sync.constraint_violation',
          message: '',
          retryable: false,
        })),
      };
      return { frames: [stubHeader(), result, frame], index: 2 };
    }
    case 'SUB_START':
      return {
        frames: [stubHeader(), frame, STUB_SUB_END],
        index: 1,
      };
    case 'SUB_END':
      return {
        frames: [stubHeader(), STUB_SUB_START, frame],
        index: 2,
      };
    case 'COMMIT':
    case 'SEGMENT_REF':
    case 'SEGMENT_INLINE':
      return {
        frames: [stubHeader(), STUB_SUB_START, frame, STUB_SUB_END],
        index: 2,
      };
  }
}

/**
 * Encode one response frame (5-byte frame header + payload) using the
 * reference codec.
 */
export function encodeResponseFrame(
  frame: ResponseFrame,
  wireVersion = PROTOCOL_WIRE_VERSION,
): Uint8Array {
  const { frames, index } = wrapperFor(frame);
  const encoded = encodeMessage({
    wireVersion,
    msgKind: 'response',
    frames,
  });
  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  let position = 8;
  for (let i = 0; ; i++) {
    const length = view.getUint32(position + 1, true);
    const end = position + 5 + length;
    if (i === index) return encoded.slice(position, end);
    position = end;
  }
}

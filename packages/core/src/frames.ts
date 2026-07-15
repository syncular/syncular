/** Frame type registry for wire version 1 (SPEC.md §1.2). */
export const FrameType = {
  END: 0x00,
  REQ_HEADER: 0x01,
  PUSH_COMMIT: 0x02,
  PULL_HEADER: 0x03,
  SUBSCRIPTION: 0x04,
  RESP_HEADER: 0x10,
  PUSH_RESULT: 0x11,
  SUB_START: 0x12,
  COMMIT: 0x13,
  SEGMENT_REF: 0x14,
  SEGMENT_INLINE: 0x15,
  SUB_END: 0x16,
  LEASE: 0x19,
  PUSH_RESULT_DETAILS: 0x1b,
  ERROR: 0x1f,
} as const;

export type FrameTypeName = keyof typeof FrameType;

/** Known request frame types (excluding END). */
export const REQUEST_FRAME_TYPES: ReadonlySet<number> = new Set([
  FrameType.REQ_HEADER,
  FrameType.PUSH_COMMIT,
  FrameType.PULL_HEADER,
  FrameType.SUBSCRIPTION,
]);

/** Known response frame types (excluding END). */
export const RESPONSE_FRAME_TYPES: ReadonlySet<number> = new Set([
  FrameType.RESP_HEADER,
  FrameType.PUSH_RESULT,
  FrameType.SUB_START,
  FrameType.COMMIT,
  FrameType.SEGMENT_REF,
  FrameType.SEGMENT_INLINE,
  FrameType.SUB_END,
  FrameType.LEASE,
  FrameType.PUSH_RESULT_DETAILS,
  FrameType.ERROR,
]);

/** Every frame type with a defined layout in wire version 1. */
export const KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set([
  FrameType.END,
  ...REQUEST_FRAME_TYPES,
  ...RESPONSE_FRAME_TYPES,
]);

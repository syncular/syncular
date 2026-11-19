/** Frame type registry for wire version 4 (SPEC.md §1.2). */
export const FrameType = {
  END: 0x00,
  REQ_HEADER: 0x01,
  PUSH_COMMIT: 0x02,
  PULL_HEADER: 0x03,
  UNIT: 0x04,
  ROUND_FAILURE: 0x05,
  PROGRESS: 0x06,
  RESTRICT: 0x07,
  ADOPT_EPOCH: 0x08,
  RESP_HEADER: 0x10,
  PUSH_RESULT: 0x11,
  SUB_START: 0x12,
  COMMIT: 0x13,
  SEGMENT_REF: 0x14,
  SEGMENT_INLINE: 0x15,
  SUB_END: 0x16,
  LEASE: 0x19,
  PUSH_RESULT_DETAILS: 0x1b,
  LIVE_START: 0x1c,
  LIVE_END: 0x1d,
  UNIT_EXTENT: 0x1e,
  ERROR: 0x1f,
} as const;

export type FrameTypeName = keyof typeof FrameType;

const registered: readonly number[] = Object.values(FrameType);

/** Known request frame types: the registry assigns them 0x01 to 0x0f. */
export const REQUEST_FRAME_TYPES: ReadonlySet<number> = new Set(
  registered.filter((type) => type > 0 && type < 0x10),
);

/** Known response frame types: the registry assigns them 0x10 to 0x1f. */
export const RESPONSE_FRAME_TYPES: ReadonlySet<number> = new Set(
  registered.filter((type) => type >= 0x10),
);

/** Every frame type with a defined layout in wire version 4. */
export const KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set(registered);

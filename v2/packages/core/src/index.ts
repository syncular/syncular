/**
 * Protocol constants (B1 seeds these; SPEC.md §9 is normative).
 *
 * DRAFT: the wire version becomes meaningful when the first golden vectors
 * land in spec/vectors/. Until then this exists so the toolchain has real
 * code to check.
 */
export const PROTOCOL_WIRE_VERSION = 1;

/** Magic bytes opening every v2 sync pack envelope (SPEC.md §1). DRAFT. */
export const SYNC_PACK_MAGIC = 'SSP2';

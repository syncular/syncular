/** Protocol constants (SPEC.md §1.2, §9 are normative). */

/** Latest SSP2 envelope wire version emitted by current clients. */
export const PROTOCOL_WIRE_VERSION = 2;

/** Oldest SSP2 envelope wire version accepted during the epoch rollout. */
export const MINIMUM_PROTOCOL_WIRE_VERSION = 1;

/** Wire versions implemented by the reference codec, oldest first. */
export const SUPPORTED_PROTOCOL_WIRE_VERSIONS: readonly number[] =
  Object.freeze(
    Array.from(
      {
        length: PROTOCOL_WIRE_VERSION - MINIMUM_PROTOCOL_WIRE_VERSION + 1,
      },
      (_, index) => MINIMUM_PROTOCOL_WIRE_VERSION + index,
    ),
  );

/** Whether the reference codec implements this exact wire version. */
export function isSupportedProtocolWireVersion(wireVersion: number): boolean {
  return (
    Number.isInteger(wireVersion) &&
    wireVersion >= MINIMUM_PROTOCOL_WIRE_VERSION &&
    wireVersion <= PROTOCOL_WIRE_VERSION
  );
}

/** Magic bytes opening every SSP2 sync envelope (SPEC.md §1.2). */
export const SYNC_PACK_MAGIC = 'SSP2';

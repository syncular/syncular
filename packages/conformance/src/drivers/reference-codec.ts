/**
 * Reference CodecDriver: `@syncular/core` behind the codec seam for
 * the golden-vector stage (Appendix A). A second implementation (e.g. a
 * Rust codec behind a subprocess) implements the same three calls.
 */
import {
  DecodeError,
  decodeMessage,
  decodeRowsSegment,
  encodeMessage,
  encodeRowsSegment,
  parseRealtimeServerEvent,
  renderMessageValue,
  renderRowsSegmentValue,
} from '@syncular/core';
import type { CodecDriver, CodecRoundtrip } from '../driver';

function guard(fn: () => CodecRoundtrip): CodecRoundtrip {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DecodeError) {
      return { ok: false, errorCode: error.code };
    }
    throw error;
  }
}

export const referenceCodecDriver: CodecDriver = {
  name: 'ts-core',
  async messageRoundtrip(bytes: Uint8Array): Promise<CodecRoundtrip> {
    return guard(() => {
      const message = decodeMessage(bytes);
      return {
        ok: true,
        bytes: encodeMessage(message),
        renderedJson: JSON.stringify(renderMessageValue(message)),
      };
    });
  },
  async segmentRoundtrip(bytes: Uint8Array): Promise<CodecRoundtrip> {
    return guard(() => {
      const segment = decodeRowsSegment(bytes);
      return {
        ok: true,
        bytes: encodeRowsSegment(segment),
        renderedJson: JSON.stringify(renderRowsSegmentValue(segment)),
      };
    });
  },
  async realtimeKnown(text: string): Promise<boolean> {
    try {
      return parseRealtimeServerEvent(text).known;
    } catch {
      return false;
    }
  },
};

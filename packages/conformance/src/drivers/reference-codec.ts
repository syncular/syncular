/**
 * Reference CodecDriver: `@syncular/core` behind the codec seam for
 * the golden-vector stage (Appendix A). A second implementation (e.g. a
 * Rust codec behind a subprocess) implements the same three calls.
 */
import {
  DecodeError,
  decodeFenceRequest,
  decodeMessage,
  decodeRowsSegment,
  encodeFenceRequest,
  encodeMessage,
  encodeRowsSegment,
  parseRealtimeServerEvent,
  renderMessage,
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
      // §6.12: a server reads a fence request before the general codec.
      const fence = decodeFenceRequest(bytes);
      if (fence !== undefined) {
        return {
          ok: true,
          bytes: encodeFenceRequest(fence.header, fence.clientCommitIds),
          renderedJson: JSON.stringify(renderMessage(bytes)),
        };
      }
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

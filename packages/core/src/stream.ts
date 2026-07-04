/**
 * Incremental SSP2 message-stream scanner (SPEC.md §1.4, §8.7).
 *
 * The envelope grammar is self-delimiting — an 8-byte header, then
 * length-prefixed frames until `END` — so a byte stream split across
 * arbitrary chunk boundaries (WebSocket messages, §8.7) needs no
 * reassembly protocol beyond concatenation plus this scanner: feed
 * chunks, learn exactly where one complete envelope ends. Used by the
 * server session (request assembly, pipelining detection), the client
 * (response assembly), and the conformance harness (round attribution).
 *
 * The scanner validates only the 8-byte header (a stream whose header is
 * not a valid SSP2 envelope has no findable end, §8.7 connection-fatal
 * rule) and walks frame length prefixes; full decoding stays with
 * `decodeMessage`.
 */
import { utf8Encode } from './bytes';
import { PROTOCOL_WIRE_VERSION, SYNC_PACK_MAGIC } from './constants';
import { DecodeError } from './errors';

const MAGIC = utf8Encode(SYNC_PACK_MAGIC);
/** `END` frame type byte (§1.2). */
const END_FRAME_TYPE = 0x00;

export interface ScannedMessage {
  /** The complete envelope bytes (header through the END frame). */
  readonly message: Uint8Array;
  /** Byte count buffered PAST the END frame — a §8.7 stream MUST end
   * exactly at the END frame's last byte, so any excess is a protocol
   * violation (pipelining) for the caller to act on. */
  readonly excess: number;
}

export class MessageStreamScanner {
  #buffer = new Uint8Array(1024);
  #length = 0;
  /** Parse cursor: start of the next frame header; -1 while the 8-byte
   * envelope header is still incomplete. */
  #offset = -1;
  #complete = false;

  /** True once any bytes were fed. */
  get started(): boolean {
    return this.#length > 0;
  }

  /**
   * Feed one chunk. Returns the completed message once the END frame is
   * fully buffered, `undefined` while more bytes are needed. Throws
   * `DecodeError` on an invalid envelope header (connection-fatal per
   * §8.7) and plain `Error` on use after completion.
   */
  push(chunk: Uint8Array): ScannedMessage | undefined {
    if (this.#complete) {
      throw new Error('MessageStreamScanner: message already complete');
    }
    this.#append(chunk);
    if (this.#offset < 0) {
      if (this.#length < 8) return undefined;
      this.#checkHeader();
      this.#offset = 8;
    }
    for (;;) {
      if (this.#length - this.#offset < 5) return undefined;
      const frameType = this.#buffer[this.#offset] as number;
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + this.#offset + 1,
        4,
      );
      const frameLength = view.getUint32(0, true);
      const frameEnd = this.#offset + 5 + frameLength;
      if (this.#length < frameEnd) return undefined;
      this.#offset = frameEnd;
      if (frameType === END_FRAME_TYPE) {
        this.#complete = true;
        return {
          message: this.#buffer.subarray(0, frameEnd),
          excess: this.#length - frameEnd,
        };
      }
    }
  }

  #append(chunk: Uint8Array): void {
    const needed = this.#length + chunk.length;
    if (needed > this.#buffer.length) {
      let capacity = this.#buffer.length;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
    this.#buffer.set(chunk, this.#length);
    this.#length = needed;
  }

  #checkHeader(): void {
    const b = this.#buffer;
    if (
      b[0] !== MAGIC[0] ||
      b[1] !== MAGIC[1] ||
      b[2] !== MAGIC[2] ||
      b[3] !== MAGIC[3]
    ) {
      throw new DecodeError('sync.invalid_request', 'bad envelope magic');
    }
    const wireVersion = (b[4] as number) | ((b[5] as number) << 8);
    if (wireVersion !== PROTOCOL_WIRE_VERSION) {
      throw new DecodeError(
        'sync.invalid_request',
        `unsupported wireVersion ${wireVersion}`,
      );
    }
    if (b[6] !== 0x01 && b[6] !== 0x02) {
      throw new DecodeError(
        'sync.invalid_request',
        `unknown msgKind byte 0x${(b[6] as number).toString(16)}`,
      );
    }
    if (b[7] !== 0x00) {
      throw new DecodeError(
        'sync.invalid_request',
        `non-zero envelope flags 0x${(b[7] as number).toString(16)}`,
      );
    }
  }
}

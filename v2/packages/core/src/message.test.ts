import { describe, expect, it } from 'bun:test';
import {
  ByteWriter,
  DecodeError,
  decodeMessage,
  encodeMessage,
  FrameType,
  type RequestMessage,
  type ResponseMessage,
  utf8Encode,
} from './index';

function expectDecodeError(
  fn: () => unknown,
  code = 'sync.invalid_request',
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DecodeError);
  expect((thrown as DecodeError).code).toBe(code);
}

function envelope(
  msgKind: number,
  frames: Array<{ type: number; build: (p: ByteWriter) => void }>,
  options: { omitEnd?: boolean } = {},
): Uint8Array {
  const w = new ByteWriter();
  w.raw(utf8Encode('SSP2'));
  w.u16(1);
  w.u8(msgKind);
  w.u8(0);
  for (const frame of frames) {
    const p = new ByteWriter();
    frame.build(p);
    const payload = p.finish();
    w.u8(frame.type);
    w.u32(payload.length);
    w.raw(payload);
  }
  if (!options.omitEnd) {
    w.u8(FrameType.END);
    w.u32(0);
  }
  return w.finish();
}

const reqHeader = {
  type: FrameType.REQ_HEADER,
  build: (p: ByteWriter) => {
    p.str('client-a');
    p.i32(1);
  },
};

const respHeader = {
  type: FrameType.RESP_HEADER,
  build: (p: ByteWriter) => {
    p.u8(0);
    p.u8(0);
  },
};

const pullHeader = {
  type: FrameType.PULL_HEADER,
  build: (p: ByteWriter) => {
    p.i32(0);
    p.i32(0);
    p.i32(0);
    p.u8(3);
  },
};

const subEnd = {
  type: FrameType.SUB_END,
  build: (p: ByteWriter) => {
    p.i64(1);
    p.u8(0);
  },
};

describe('SSP2 envelope (SPEC.md §1.2)', () => {
  it('rejects an unknown msgKind byte', () => {
    expectDecodeError(() =>
      decodeMessage(envelope(3, [reqHeader, pullHeader])),
    );
  });

  it('rejects trailing bytes after END', () => {
    const bytes = envelope(1, [reqHeader, pullHeader]);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expectDecodeError(() => decodeMessage(padded));
  });

  it('rejects an END frame with a non-zero length', () => {
    const w = new ByteWriter();
    w.raw(utf8Encode('SSP2'));
    w.u16(1);
    w.u8(1);
    w.u8(0);
    w.u8(FrameType.END);
    w.u32(1);
    w.u8(0);
    expectDecodeError(() => decodeMessage(w.finish()));
  });

  it('rejects trailing bytes inside a known frame payload (§1.2 rule 3)', () => {
    const fatHeader = {
      type: FrameType.REQ_HEADER,
      build: (p: ByteWriter) => {
        p.str('client-a');
        p.i32(1);
        p.u8(0); // extra byte
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [fatHeader, pullHeader])),
    );
  });

  it('rejects an invalid option presence byte', () => {
    const badResp = {
      type: FrameType.RESP_HEADER,
      build: (p: ByteWriter) => {
        p.u8(2); // presence byte must be 0x00 or 0x01
        p.u8(0);
      },
    };
    expectDecodeError(() => decodeMessage(envelope(2, [badResp])));
  });

  it('rejects a response frame type inside a request message', () => {
    const subStartInRequest = {
      type: FrameType.SUB_START,
      build: (p: ByteWriter) => {
        p.str('s');
        p.u8(1);
        p.str('');
        p.u32(0);
        p.u8(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pullHeader, subStartInRequest])),
    );
  });

  it('skips unknown frame types and preserves them on re-encode', () => {
    const unknown = {
      type: 0x18, // reserved (CRDT state vectors)
      build: (p: ByteWriter) => {
        p.raw(utf8Encode('future'));
      },
    };
    const bytes = envelope(1, [reqHeader, unknown, pullHeader]);
    const message = decodeMessage(bytes);
    expect(message.frames.map((f) => f.type)).toEqual([
      'REQ_HEADER',
      'UNKNOWN',
      'PULL_HEADER',
    ]);
    expect(encodeMessage(message)).toEqual(bytes);
  });
});

describe('request grammar (SPEC.md §1.5)', () => {
  it('rejects a request with neither PUSH_COMMIT nor PULL_HEADER', () => {
    expectDecodeError(() => decodeMessage(envelope(1, [reqHeader])));
  });

  it('rejects SUBSCRIPTION without a preceding PULL_HEADER', () => {
    const subscription = {
      type: FrameType.SUBSCRIPTION,
      build: (p: ByteWriter) => {
        p.str('s');
        p.str('notes');
        p.u32(0);
        p.u8(0);
        p.i64(-1);
        p.u8(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, subscription])),
    );
  });

  it('rejects PUSH_COMMIT after PULL_HEADER', () => {
    const message: RequestMessage = {
      wireVersion: 1,
      msgKind: 'request',
      frames: [
        { type: 'REQ_HEADER', clientId: 'c', schemaVersion: 1 },
        {
          type: 'PULL_HEADER',
          limitCommits: 0,
          limitSnapshotRows: 0,
          maxSnapshotPages: 0,
          accept: 3,
        },
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'x',
          operations: [{ table: 't', rowId: 'r', op: 'delete' }],
        },
      ],
    };
    expectDecodeError(() => encodeMessage(message));
  });

  it('rejects a PUSH_COMMIT with zero operations as sync.empty_commit', () => {
    const emptyCommit = {
      type: FrameType.PUSH_COMMIT,
      build: (p: ByteWriter) => {
        p.str('c-1');
        p.u32(0);
      },
    };
    expectDecodeError(
      () => decodeMessage(envelope(1, [reqHeader, emptyCommit])),
      'sync.empty_commit',
    );
  });

  it('rejects an empty clientId', () => {
    const badHeader = {
      type: FrameType.REQ_HEADER,
      build: (p: ByteWriter) => {
        p.str('');
        p.i32(1);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [badHeader, pullHeader])),
    );
  });

  it('rejects accept bits 4-7', () => {
    const badPull = {
      type: FrameType.PULL_HEADER,
      build: (p: ByteWriter) => {
        p.i32(0);
        p.i32(0);
        p.i32(0);
        p.u8(0b0001_0011);
      },
    };
    expectDecodeError(() => decodeMessage(envelope(1, [reqHeader, badPull])));
  });

  it('rejects out-of-order map keys in requested scopes', () => {
    const subscription = {
      type: FrameType.SUBSCRIPTION,
      build: (p: ByteWriter) => {
        p.str('s');
        p.str('notes');
        p.u32(2);
        p.str('z');
        p.u32(1);
        p.str('v');
        p.str('a'); // out of order after 'z'
        p.u32(1);
        p.str('v');
        p.u8(0);
        p.i64(-1);
        p.u8(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pullHeader, subscription])),
    );
  });

  it('rejects a non-JSON params document', () => {
    const subscription = {
      type: FrameType.SUBSCRIPTION,
      build: (p: ByteWriter) => {
        p.str('s');
        p.str('notes');
        p.u32(0);
        p.u8(1);
        p.str('not json');
        p.i64(-1);
        p.u8(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pullHeader, subscription])),
    );
  });
});

describe('response grammar (SPEC.md §1.6)', () => {
  const subStart = {
    type: FrameType.SUB_START,
    build: (p: ByteWriter) => {
      p.str('s');
      p.u8(1);
      p.str('');
      p.u32(0);
      p.u8(0);
    },
  };

  const errorFrame = {
    type: FrameType.ERROR,
    build: (p: ByteWriter) => {
      p.str('sync.rate_limited');
      p.str('slow down');
      p.str('rate-limited');
      p.u8(1);
      p.str('retryLater');
      p.u8(0);
    },
  };

  it('rejects frames after an ERROR frame', () => {
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, errorFrame, subStart, subEnd])),
    );
  });

  it('accepts ERROR terminating an open subscription (§1.4 abort rule)', () => {
    const message = decodeMessage(
      envelope(2, [respHeader, subStart, errorFrame]),
    );
    expect(message.frames.map((f) => f.type)).toEqual([
      'RESP_HEADER',
      'SUB_START',
      'ERROR',
    ]);
  });

  it('rejects END with an open subscription and no ERROR', () => {
    expectDecodeError(() => decodeMessage(envelope(2, [respHeader, subStart])));
  });

  it('rejects COMMIT outside a subscription', () => {
    const commit = {
      type: FrameType.COMMIT,
      build: (p: ByteWriter) => {
        p.i64(1);
        p.i64(0);
        p.str('a');
        p.u32(0);
        p.u32(0);
      },
    };
    expectDecodeError(() => decodeMessage(envelope(2, [respHeader, commit])));
  });

  it('rejects a COMMIT frame after segment frames in one subscription', () => {
    const message: ResponseMessage = {
      wireVersion: 1,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER' },
        {
          type: 'SUB_START',
          id: 's',
          status: 'active',
          reasonCode: '',
          effectiveScopes: {},
          bootstrap: true,
        },
        {
          type: 'SEGMENT_REF',
          segmentId: 'sha256:0',
          mediaType: 'rows',
          table: 't',
          byteLength: 1,
          rowCount: 1,
          asOfCommitSeq: 1,
          scopeDigest: 'd',
        },
        {
          type: 'COMMIT',
          commitSeq: 2,
          createdAtMs: 0,
          actorId: 'a',
          tables: [],
          changes: [],
        },
        { type: 'SUB_END', nextCursor: 1 },
      ],
    };
    expectDecodeError(() => encodeMessage(message));
  });

  it('rejects a change tableIndex outside the frame-local dictionary', () => {
    const commit = {
      type: FrameType.COMMIT,
      build: (p: ByteWriter) => {
        p.i64(1);
        p.i64(0);
        p.str('a');
        p.u32(1);
        p.str('notes');
        p.u32(1);
        p.u16(5); // out of range
        p.str('r');
        p.u8(2);
        p.u8(0);
        p.u32(0);
        p.u8(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, subStart, commit, subEnd])),
    );
  });

  it('rejects a rejected PUSH_RESULT carrying a commitSeq', () => {
    const pushResult = {
      type: FrameType.PUSH_RESULT,
      build: (p: ByteWriter) => {
        p.str('c-1');
        p.u8(3); // rejected
        p.u8(1); // commitSeq present — violation
        p.i64(9);
        p.u32(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, pushResult])),
    );
  });

  it('rejects urlExpiresAtMs without url on SEGMENT_REF', () => {
    const segmentRef = {
      type: FrameType.SEGMENT_REF,
      build: (p: ByteWriter) => {
        p.str('sha256:0');
        p.u8(1);
        p.str('t');
        p.i64(1);
        p.i64(1);
        p.i64(1);
        p.str('d');
        p.u8(0); // rowCursor absent
        p.u8(0); // nextRowCursor absent
        p.u8(0); // url absent
        p.u8(1); // urlExpiresAtMs present — violation
        p.i64(123);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, subStart, segmentRef, subEnd])),
    );
  });

  it('rejects PUSH_RESULT after SUB_START', () => {
    const message: ResponseMessage = {
      wireVersion: 1,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER' },
        {
          type: 'SUB_START',
          id: 's',
          status: 'active',
          reasonCode: '',
          effectiveScopes: {},
          bootstrap: false,
        },
        { type: 'SUB_END', nextCursor: 1 },
        {
          type: 'PUSH_RESULT',
          clientCommitId: 'c',
          status: 'applied',
          commitSeq: 1,
          results: [{ opIndex: 0, status: 'applied' }],
        },
      ],
    };
    expectDecodeError(() => encodeMessage(message));
  });

  it('round-trips i64 cursor values at the safe-integer boundary', () => {
    const message: ResponseMessage = {
      wireVersion: 1,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER' },
        {
          type: 'SUB_START',
          id: 's',
          status: 'active',
          reasonCode: '',
          effectiveScopes: {},
          bootstrap: false,
        },
        { type: 'SUB_END', nextCursor: 9007199254740991 },
      ],
    };
    const decoded = decodeMessage(encodeMessage(message));
    expect(decoded).toEqual(message);
  });

  it('rejects i64 values outside the safe-integer contract', () => {
    const badSubEnd = {
      type: FrameType.SUB_END,
      build: (p: ByteWriter) => {
        const big = new Uint8Array(8);
        new DataView(big.buffer).setBigInt64(0, 1n << 60n, true);
        p.raw(big);
        p.u8(0);
      },
    };
    const subStart = {
      type: FrameType.SUB_START,
      build: (p: ByteWriter) => {
        p.str('s');
        p.u8(1);
        p.str('');
        p.u32(0);
        p.u8(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, subStart, badSubEnd])),
    );
  });
});

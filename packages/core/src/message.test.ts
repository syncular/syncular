import { describe, expect, it } from 'bun:test';
import {
  ByteWriter,
  DecodeError,
  decodeMessage,
  decodeRequest,
  decodeResponse,
  encodeMessage,
  FrameType,
  type PullHeaderFrame,
  type PushResultDetailsFrame,
  type PushResultFrame,
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
  w.u16(4);
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
    p.u8(0); // logEpoch absent
    p.u8(0); // outboxId absent
  },
};

const respHeader = {
  type: FrameType.RESP_HEADER,
  build: (p: ByteWriter) => {
    p.u8(0);
    p.u8(0);
    p.str('epoch-test');
    p.u8(0); // resetRequired false
  },
};

const pullHeader = {
  type: FrameType.PULL_HEADER,
  build: (p: ByteWriter) => {
    p.i32(0);
    p.i32(0);
    p.i32(0);
    p.u8(3);
    p.i64(-1);
    p.bytes(new Uint8Array(32)); // registrationDigest
    p.bytes(new Uint8Array(0)); // echoDigest
  },
};

const pull: PullHeaderFrame = {
  type: 'PULL_HEADER',
  limitCommits: 0,
  limitSnapshotRows: 0,
  maxSnapshotPages: 0,
  accept: 3,
  cursor: -1,
  registrationDigest: new Uint8Array(32),
  echoDigest: new Uint8Array(0),
};

const UNIT_ID = '47c583f8f997e2a55f46dc618c2f1969';

const subStart = {
  type: FrameType.SUB_START,
  build: (p: ByteWriter) => {
    p.str(UNIT_ID);
    p.u8(1); // active
    p.str('');
    p.u8(0); // bootstrap false
    p.u32(0); // no fenced record
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
  it('the kind-specific decoders reject the other message kind', () => {
    const request = envelope(1, [reqHeader, pullHeader]);
    expect(decodeRequest(request)).toEqual(decodeMessage(request));
    expectDecodeError(() => decodeResponse(request));
    const response = encodeMessage({
      wireVersion: 4,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER', logEpoch: 'e', resetRequired: false },
        { type: 'LIVE_START', status: 'active', reasonCode: '' },
        { type: 'LIVE_END', throughSeq: 0, echoDigest: new Uint8Array() },
      ],
    });
    expect(decodeResponse(response)).toEqual(decodeMessage(response));
    expectDecodeError(() => decodeRequest(response));
  });

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
    w.u16(4);
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
        p.u8(0); // logEpoch absent
        p.u8(0); // outboxId absent
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
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pullHeader, subStart])),
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

describe('PUSH_RESULT_DETAILS additive companion', () => {
  it('round-trips bounded structured rejection metadata', () => {
    const message: ResponseMessage = {
      wireVersion: 4,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
        {
          type: 'PUSH_RESULT',
          clientCommitId: 'commit-1',
          status: 'rejected',
          results: [
            {
              opIndex: 0,
              status: 'error',
              code: 'app.invalid_duration',
              message: 'diagnostic only',
              retryable: false,
            },
          ],
        },
        {
          type: 'PUSH_RESULT_DETAILS',
          clientCommitId: 'commit-1',
          entries: [
            {
              opIndex: 0,
              details: {
                fieldPaths: ['duration_minutes'],
                reason: 'outside_allowed_range',
                requiredAction: 'edit_fields',
                references: { surgery_id: 'surgery-1' },
              },
            },
          ],
        },
      ],
    };
    const encoded = encodeMessage(message);
    expect(decodeMessage(encoded)).toEqual(message);
  });

  it('rejects free-form and over-broad metadata', () => {
    const message: ResponseMessage = {
      wireVersion: 4,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
        {
          type: 'PUSH_RESULT',
          clientCommitId: 'commit-1',
          status: 'rejected',
          results: [
            {
              opIndex: 0,
              status: 'error',
              code: 'app.invalid',
              message: 'diagnostic only',
              retryable: false,
            },
          ],
        },
        {
          type: 'PUSH_RESULT_DETAILS',
          clientCommitId: 'commit-1',
          entries: [
            {
              opIndex: 0,
              details: {
                requiredAction: 'Show this arbitrary sentence',
              },
            },
          ],
        },
      ],
    };
    expect(() => encodeMessage(message)).toThrow('lowercase stable token');
  });

  it('rejects orphaned, duplicated, and mismatched companions', () => {
    const result: PushResultFrame = {
      type: 'PUSH_RESULT',
      clientCommitId: 'commit-1',
      status: 'rejected',
      results: [
        {
          opIndex: 0,
          status: 'error',
          code: 'app.invalid',
          message: 'diagnostic only',
          retryable: false,
        },
      ],
    };
    const details: PushResultDetailsFrame = {
      type: 'PUSH_RESULT_DETAILS',
      clientCommitId: 'commit-1',
      entries: [{ opIndex: 0, details: { reason: 'invalid_value' } }],
    };

    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
          details,
        ],
      }),
    ).toThrow('without a preceding PUSH_RESULT');
    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
          result,
          details,
          details,
        ],
      }),
    ).toThrow('duplicate PUSH_RESULT_DETAILS');
    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
          result,
          { ...details, clientCommitId: 'other-commit' },
        ],
      }),
    ).toThrow('does not match its rejected PUSH_RESULT');
    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
          result,
          {
            ...details,
            entries: [{ opIndex: 1, details: { reason: 'invalid_value' } }],
          },
        ],
      }),
    ).toThrow('does not match an error result');
    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
          result,
          {
            type: 'SUB_START',
            id: UNIT_ID,
            status: 'active',
            reasonCode: '',
            bootstrap: false,
            fenced: [],
          },
          {
            type: 'SUB_END',
            nextCursor: 0,
          },
          details,
        ],
      }),
    ).toThrow('PUSH_RESULT_DETAILS frame after a unit or live section');
    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
          result,
          {
            type: 'UNKNOWN',
            frameType: 0xfe,
            payload: new Uint8Array([1]),
          },
          details,
        ],
      }),
    ).toThrow('without a preceding PUSH_RESULT');
  });
});

describe('request grammar (SPEC.md §1.5)', () => {
  const unitFrame = {
    type: FrameType.UNIT,
    build: (p: ByteWriter) => {
      p.u32(1);
      p.str('campaign_id');
      p.str('c1');
    },
  };

  const progress = (id: string, cursor: number) => ({
    type: FrameType.PROGRESS,
    build: (p: ByteWriter) => {
      p.str(id);
      p.i64(cursor);
      p.u8(0); // bootstrapState absent
    },
  });

  const pullWith = (
    fields: Partial<PullHeaderFrame>,
  ): { type: number; build: (p: ByteWriter) => void } => ({
    type: FrameType.PULL_HEADER,
    build: (p: ByteWriter) => {
      const frame = { ...pull, ...fields };
      p.i32(0);
      p.i32(0);
      p.i32(0);
      p.u8(frame.accept);
      p.i64(frame.cursor);
      p.bytes(frame.registrationDigest);
      p.bytes(frame.echoDigest);
    },
  });

  const pushCommit = (clientSeq: number) => ({
    type: FrameType.PUSH_COMMIT,
    build: (p: ByteWriter) => {
      p.str('c-1');
      p.i64(clientSeq);
      p.u32(1);
      p.str('notes');
      p.str('n-1');
      p.u8(2); // delete
      p.u8(0); // baseVersion absent
      p.u8(0); // payload absent
    },
  });

  const header = (outboxId: string) => ({
    type: FrameType.REQ_HEADER,
    build: (p: ByteWriter) => {
      p.str('client-a');
      p.i32(1);
      p.u8(0); // logEpoch absent
      p.u8(1);
      p.str(outboxId);
    },
  });

  it('round-trips a traveling list, progress and outbox sequences', () => {
    const message: RequestMessage = {
      wireVersion: 4,
      msgKind: 'request',
      frames: [
        {
          type: 'REQ_HEADER',
          clientId: 'c',
          schemaVersion: 1,
          outboxId: 'o'.repeat(64),
        },
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'x',
          clientSeq: 9007199254740991,
          operations: [{ table: 't', rowId: 'r', op: 'delete' }],
        },
        { ...pull, cursor: 12, echoDigest: new Uint8Array(32).fill(7) },
        { type: 'UNIT', scopes: { campaign_id: 'c1', a: '' } },
        { type: 'UNIT', scopes: {} },
        {
          type: 'PROGRESS',
          id: UNIT_ID,
          cursor: 40,
          bootstrapState: '{"tableIndex":0}',
        },
        { type: 'PROGRESS', id: 'f'.repeat(32), cursor: -1 },
      ],
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('rejects a request with neither PUSH_COMMIT nor PULL_HEADER', () => {
    expectDecodeError(() => decodeMessage(envelope(1, [reqHeader])));
  });

  it('rejects UNIT and PROGRESS without a preceding PULL_HEADER', () => {
    expectDecodeError(() => decodeMessage(envelope(1, [reqHeader, unitFrame])));
    expectDecodeError(() =>
      decodeMessage(
        envelope(1, [reqHeader, pushCommit(0), progress(UNIT_ID, -1)]),
      ),
    );
  });

  it('rejects UNIT after a PROGRESS frame', () => {
    expectDecodeError(() =>
      decodeMessage(
        envelope(1, [reqHeader, pullHeader, progress(UNIT_ID, -1), unitFrame]),
      ),
    );
  });

  it('rejects PUSH_COMMIT after PULL_HEADER', () => {
    const message: RequestMessage = {
      wireVersion: 4,
      msgKind: 'request',
      frames: [
        { type: 'REQ_HEADER', clientId: 'c', schemaVersion: 1 },
        pull,
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'x',
          clientSeq: 0,
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
        p.i64(0);
        p.u32(0);
      },
    };
    expectDecodeError(
      () => decodeMessage(envelope(1, [reqHeader, emptyCommit])),
      'sync.empty_commit',
    );
  });

  it('rejects a negative clientSeq on decode and encode', () => {
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pushCommit(-1)])),
    );
    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'request',
        frames: [
          { type: 'REQ_HEADER', clientId: 'c', schemaVersion: 1 },
          {
            type: 'PUSH_COMMIT',
            clientCommitId: 'x',
            clientSeq: -1,
            operations: [{ table: 't', rowId: 'r', op: 'delete' }],
          },
        ],
      }),
    ).toThrow('PUSH_COMMIT.clientSeq must be >= 0');
  });

  it('rejects an empty or over-long outboxId', () => {
    // 64 characters but 65 UTF-8 bytes: the limit counts bytes.
    for (const outboxId of ['', 'o'.repeat(65), `${'o'.repeat(63)}é`]) {
      expectDecodeError(() =>
        decodeMessage(envelope(1, [header(outboxId), pullHeader])),
      );
    }
    const atLimit = `${'o'.repeat(62)}é`;
    expect(
      decodeMessage(envelope(1, [header(atLimit), pullHeader])).frames[0],
    ).toMatchObject({ outboxId: atLimit });
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
    expectDecodeError(() =>
      decodeMessage(
        envelope(1, [reqHeader, pullWith({ accept: 0b0001_0011 })]),
      ),
    );
  });

  it('rejects a replica cursor below -1', () => {
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pullWith({ cursor: -2 })])),
    );
    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'request',
        frames: [
          { type: 'REQ_HEADER', clientId: 'c', schemaVersion: 1 },
          { ...pull, cursor: -2 },
        ],
      }),
    ).toThrow('PULL_HEADER.cursor must be >= -1');
  });

  it('rejects digests of the wrong length', () => {
    for (const fields of [
      { registrationDigest: new Uint8Array(31) },
      { registrationDigest: new Uint8Array(0) },
      { echoDigest: new Uint8Array(16) },
    ]) {
      expectDecodeError(() =>
        decodeMessage(envelope(1, [reqHeader, pullWith(fields)])),
      );
      expect(() =>
        encodeMessage({
          wireVersion: 4,
          msgKind: 'request',
          frames: [
            { type: 'REQ_HEADER', clientId: 'c', schemaVersion: 1 },
            { ...pull, ...fields },
          ],
        }),
      ).toThrow('Digest must be');
    }
  });

  it('rejects a PROGRESS id that is not 32 lowercase hex characters', () => {
    for (const id of [UNIT_ID.toUpperCase(), UNIT_ID.slice(1), `${UNIT_ID}0`]) {
      expectDecodeError(() =>
        decodeMessage(envelope(1, [reqHeader, pullHeader, progress(id, -1)])),
      );
    }
  });

  it('rejects a PROGRESS cursor below -1', () => {
    expectDecodeError(() =>
      decodeMessage(
        envelope(1, [reqHeader, pullHeader, progress(UNIT_ID, -2)]),
      ),
    );
  });

  it('rejects out-of-order map keys in a UNIT scope map', () => {
    const unsorted = {
      type: FrameType.UNIT,
      build: (p: ByteWriter) => {
        p.u32(2);
        p.str('z');
        p.str('v');
        p.str('a'); // out of order after 'z'
        p.str('v');
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pullHeader, unsorted])),
    );
  });

  it('rejects a non-JSON PROGRESS.bootstrapState document', () => {
    const badProgress = {
      type: FrameType.PROGRESS,
      build: (p: ByteWriter) => {
        p.str(UNIT_ID);
        p.i64(-1);
        p.u8(1);
        p.str('not json');
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pullHeader, badProgress])),
    );
  });
});

describe('ROUND_FAILURE (SPEC.md §1.5)', () => {
  const roundFailure = (code: string) => ({
    type: FrameType.ROUND_FAILURE,
    build: (p: ByteWriter) => p.str(code),
  });

  const requestWith = (code: string): RequestMessage => ({
    wireVersion: 4,
    msgKind: 'request',
    frames: [
      { type: 'REQ_HEADER', clientId: 'c', schemaVersion: 1 },
      { type: 'ROUND_FAILURE', code },
      pull,
    ],
  });

  it('round-trips the code immediately after REQ_HEADER', () => {
    const message = requestWith('sync.transport_failed');
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('rejects a duplicate ROUND_FAILURE frame', () => {
    expectDecodeError(() =>
      decodeMessage(
        envelope(1, [
          reqHeader,
          roundFailure('sync.transport_failed'),
          roundFailure('sync.transport_failed'),
          pullHeader,
        ]),
      ),
    );
  });

  it('rejects ROUND_FAILURE after a PUSH_COMMIT', () => {
    const push = {
      type: FrameType.PUSH_COMMIT,
      build: (p: ByteWriter) => {
        p.str('c-1');
        p.i64(1); // clientSeq
        p.u32(1);
        p.str('notes');
        p.str('n-1');
        p.u8(2); // delete
        p.u8(0); // baseVersion absent
        p.u8(0); // payload absent
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, push, roundFailure('a.b')])),
    );
  });

  it('rejects ROUND_FAILURE after a PULL_HEADER', () => {
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, pullHeader, roundFailure('a.b')])),
    );
  });

  it('rejects a request that carries only ROUND_FAILURE', () => {
    expectDecodeError(() =>
      decodeMessage(envelope(1, [reqHeader, roundFailure('a.b')])),
    );
  });

  it('rejects codes outside the §1.5 grammar on decode and encode', () => {
    for (const code of [
      '',
      'transport_failed',
      'sync..failed',
      'Sync.Failed',
      'sync.failed-x',
      'sync.failed.',
      '.sync.failed',
      `sync.${'a'.repeat(60)}`, // 65 UTF-8 bytes
    ]) {
      expectDecodeError(() =>
        decodeMessage(envelope(1, [reqHeader, roundFailure(code), pullHeader])),
      );
      expect(() => encodeMessage(requestWith(code))).toThrow(
        'ROUND_FAILURE.code must be a lowercase dotted code of at most 64 bytes',
      );
    }
  });

  it('accepts a code of exactly 64 UTF-8 bytes', () => {
    const atLimit = `sync.${'a'.repeat(59)}`;
    expect(utf8Encode(atLimit).length).toBe(64);
    expect(decodeMessage(encodeMessage(requestWith(atLimit)))).toEqual(
      requestWith(atLimit),
    );
  });

  it('rejects ROUND_FAILURE inside a response message', () => {
    expectDecodeError(() =>
      decodeMessage(
        envelope(2, [respHeader, roundFailure('sync.transport_failed')]),
      ),
    );
  });
});

describe('response grammar (SPEC.md §1.6)', () => {
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

  const liveStart = (status = 1) => ({
    type: FrameType.LIVE_START,
    build: (p: ByteWriter) => {
      p.u8(status);
      p.str('');
    },
  });

  const liveEnd = (echoDigestLength = 32) => ({
    type: FrameType.LIVE_END,
    build: (p: ByteWriter) => {
      p.i64(5);
      p.bytes(new Uint8Array(echoDigestLength));
    },
  });

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
      p.u8(0); // urlExpiresAtMs absent
    },
  };

  const fencedSubStart = (tables: string[], status = 1) => ({
    type: FrameType.SUB_START,
    build: (p: ByteWriter) => {
      p.str(UNIT_ID);
      p.u8(1);
      p.str('');
      p.u8(0);
      p.u32(tables.length);
      for (const table of tables) {
        p.str(table);
        p.u8(status);
        p.u32(0);
      }
    },
  });

  it('round-trips unit sections with echoes and a live section', () => {
    const message: ResponseMessage = {
      wireVersion: 4,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
        {
          type: 'SUB_START',
          id: UNIT_ID,
          status: 'active',
          reasonCode: '',
          bootstrap: false,
          fenced: [
            { table: 'a', status: 'revoked', scopes: {} },
            { table: 'b', status: 'active', scopes: { team: ['t2', 't1'] } },
          ],
        },
        { type: 'SUB_END', nextCursor: 9007199254740991 },
        { type: 'LIVE_START', status: 'active', reasonCode: '' },
        {
          type: 'COMMIT',
          commitSeq: 2,
          createdAtMs: 0,
          actorId: 'a',
          tables: [],
          changes: [],
        },
        {
          type: 'LIVE_END',
          throughSeq: 2,
          echoDigest: new Uint8Array(32).fill(1),
        },
      ],
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('round-trips the reset and unregistered live statuses', () => {
    for (const status of ['reset', 'unregistered'] as const) {
      const message: ResponseMessage = {
        wireVersion: 4,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
          { type: 'LIVE_START', status, reasonCode: '' },
          { type: 'LIVE_END', throughSeq: -1, echoDigest: new Uint8Array(0) },
        ],
      };
      expect(decodeMessage(encodeMessage(message))).toEqual(message);
    }
  });

  it('rejects LIVE_START status bytes outside 1, 3 and 4', () => {
    for (const status of [0, 2, 5]) {
      expectDecodeError(() =>
        decodeMessage(envelope(2, [respHeader, liveStart(status), liveEnd()])),
      );
    }
  });

  it('rejects a LIVE_END echo digest of the wrong length', () => {
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, liveStart(), liveEnd(31)])),
    );
  });

  it('rejects frames after an ERROR frame', () => {
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, errorFrame, subStart, subEnd])),
    );
  });

  it('accepts ERROR terminating an open unit or live section (§1.4 abort rule)', () => {
    const types = (open: { type: number; build: (p: ByteWriter) => void }) =>
      decodeMessage(envelope(2, [respHeader, open, errorFrame])).frames.map(
        (f) => f.type,
      );
    expect(types(subStart)).toEqual(['RESP_HEADER', 'SUB_START', 'ERROR']);
    expect(types(liveStart())).toEqual(['RESP_HEADER', 'LIVE_START', 'ERROR']);
  });

  it('rejects END with an open unit or live section and no ERROR', () => {
    expectDecodeError(() => decodeMessage(envelope(2, [respHeader, subStart])));
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, liveStart()])),
    );
  });

  it('rejects COMMIT outside the live section', () => {
    expectDecodeError(() => decodeMessage(envelope(2, [respHeader, commit])));
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, subStart, commit, subEnd])),
    );
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, liveStart(), liveEnd(), commit])),
    );
  });

  it('rejects unit-section frames inside or after the live section', () => {
    for (const late of [subStart, segmentRef, subEnd]) {
      expectDecodeError(() =>
        decodeMessage(envelope(2, [respHeader, liveStart(), late, liveEnd()])),
      );
      expectDecodeError(() =>
        decodeMessage(envelope(2, [respHeader, liveStart(), liveEnd(), late])),
      );
    }
  });

  it('rejects a second live section and nested sections', () => {
    expectDecodeError(() =>
      decodeMessage(
        envelope(2, [
          respHeader,
          liveStart(),
          liveEnd(),
          liveStart(),
          liveEnd(),
        ]),
      ),
    );
    expectDecodeError(() =>
      decodeMessage(
        envelope(2, [respHeader, subStart, liveStart(), liveEnd(), subEnd]),
      ),
    );
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, liveEnd()])),
    );
  });

  it('rejects fenced records out of table order or repeated', () => {
    for (const tables of [
      ['b', 'a'],
      ['a', 'a'],
    ]) {
      expectDecodeError(() =>
        decodeMessage(
          envelope(2, [respHeader, fencedSubStart(tables), subEnd]),
        ),
      );
    }
    expect(() =>
      encodeMessage({
        wireVersion: 4,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-test', resetRequired: false },
          {
            type: 'SUB_START',
            id: UNIT_ID,
            status: 'active',
            reasonCode: '',
            bootstrap: false,
            fenced: [
              { table: 'b', status: 'active', scopes: {} },
              { table: 'a', status: 'active', scopes: {} },
            ],
          },
          { type: 'SUB_END', nextCursor: 1 },
        ],
      }),
    ).toThrow('SUB_START.fenced tables must be unique and in ascending order');
  });

  it('rejects a fenced record status outside active and revoked', () => {
    expectDecodeError(() =>
      decodeMessage(
        envelope(2, [respHeader, fencedSubStart(['a'], 3), subEnd]),
      ),
    );
  });

  it('rejects a SUB_START id that is not a unit id', () => {
    const badSubStart = {
      type: FrameType.SUB_START,
      build: (p: ByteWriter) => {
        p.str('sub-notes');
        p.u8(1);
        p.str('');
        p.u8(0);
        p.u32(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, badSubStart, subEnd])),
    );
  });

  it('rejects a change tableIndex outside the frame-local dictionary', () => {
    const badCommit = {
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
      decodeMessage(
        envelope(2, [respHeader, liveStart(), badCommit, liveEnd()]),
      ),
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
    const badSegmentRef = {
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
      decodeMessage(envelope(2, [respHeader, subStart, badSegmentRef, subEnd])),
    );
  });

  it('rejects PUSH_RESULT after a unit or live section', () => {
    const pushResult = {
      type: FrameType.PUSH_RESULT,
      build: (p: ByteWriter) => {
        p.str('c-1');
        p.u8(1); // applied
        p.u8(1);
        p.i64(9);
        p.u32(0);
      },
    };
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, subStart, subEnd, pushResult])),
    );
    expectDecodeError(() =>
      decodeMessage(
        envelope(2, [respHeader, liveStart(), liveEnd(), pushResult]),
      ),
    );
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
    expectDecodeError(() =>
      decodeMessage(envelope(2, [respHeader, subStart, badSubEnd])),
    );
  });
});

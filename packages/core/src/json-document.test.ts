/**
 * The JSON validity rule (SPEC.md Conventions). The Rust core runs the same
 * probe table (`ssp2::primitives` tests), so both cores accept exactly the
 * same documents.
 */
import { describe, expect, it } from 'bun:test';
import { DecodeError, parseJsonDocument } from './index';

const nested = (open: string, close: string, depth: number): string =>
  `${open.repeat(depth)}${close.repeat(depth)}`;

const PROBES: ReadonlyArray<readonly [string, string, boolean]> = [
  ['arrays nested 64 deep', nested('[', ']', 64), true],
  ['arrays nested 65 deep', nested('[', ']', 65), false],
  ['objects nested 64 deep', `${'{"a":'.repeat(63)}{}${'}'.repeat(63)}`, true],
  ['objects nested 65 deep', `${'{"a":'.repeat(64)}{}${'}'.repeat(64)}`, false],
  ['1e999', '1e999', false],
  ['-1e999 inside an array', '[-1e999]', false],
  ['1e-999 underflows to zero', '1e-999', true],
  ['negative zero', '-0', true],
  ['largest finite binary64', '1.7976931348623157e308', true],
  ['rounds to infinity', '1.7976931348623159e308', false],
  ['integer beyond 2^64', '123456789012345678901234567890', true],
  ['unpaired high surrogate', '"\\ud800"', false],
  ['unpaired low surrogate', '"\\udc00"', false],
  ['high surrogate before a letter', '"\\ud800x"', false],
  ['escaped surrogate pair', '"\\ud83d\\ude00"', true],
  ['unpaired surrogate key', '{"\\ud800":1}', false],
  ['U+0000 escape', '"\\u0000"', false],
  ['U+0000 key', '{"\\u0000":1}', false],
  ['U+0000 deep inside', '[{"a":["x\\u0000"]}]', false],
  ['U+0001 escape', '"\\u0001"', true],
  ['raw U+0000 in a string', '"a\u0000b"', false],
  ['duplicate keys', '{"a":1,"a":2}', true],
  ['shadowed 1e999', '{"a":1e999,"a":1}', false],
  ['shadowed unpaired surrogate', '{"a":"\\ud800","a":1}', false],
  ['shadowed U+0000 escape', '{"a":"\\u0000","a":1}', false],
  ['shadowed depth 64', `{"a":${nested('[', ']', 63)},"a":1}`, true],
  ['shadowed depth 65', `{"a":${nested('[', ']', 64)},"a":1}`, false],
  ['shadowed depth 128', `{"a":${nested('[', ']', 127)},"a":1}`, false],
  ['escaped backslash before u0000', '"\\\\u0000"', true],
  ['brackets inside strings', '["[[[[", "}}}}"]', true],
  ['insignificant whitespace', ' { "a" : [ 1 , 2 ] } ', true],
  ['top-level true', 'true', true],
  ['top-level null', 'null', true],
  ['top-level string', '"x"', true],
  ['top-level number', '7', true],
  ['not JSON', '{not json', false],
  ['trailing comma', '[1,]', false],
  ['leading zero', '01', false],
  ['NaN literal', 'NaN', false],
  ['byte order mark', '﻿1', false],
];

describe('JSON validity rule (SPEC.md Conventions)', () => {
  for (const [name, raw, valid] of PROBES) {
    it(`${valid ? 'accepts' : 'rejects'} ${name}`, () => {
      if (valid) {
        expect(() => parseJsonDocument(raw, 'probe')).not.toThrow();
        return;
      }
      let thrown: unknown;
      try {
        parseJsonDocument(raw, 'probe');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DecodeError);
      expect(thrown).toMatchObject({ code: 'sync.invalid_request' });
    });
  }

  it('returns the parsed value, last duplicate key winning', () => {
    expect(parseJsonDocument('{"a":1,"a":[true]}', 'probe')).toEqual({
      a: [true],
    });
  });
});

import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  canonicalScopeJson,
  canonicalUnitJson,
  echoDigest,
  registrationDigest,
  unitId,
} from './canonical-json';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const nodeSha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('unit id and registration digest (SPEC.md §4.1)', () => {
  it('reproduces the §4.1 worked examples', () => {
    const a = { campaign_id: 'c1' };
    const b = { ruleset_id: 'r1' };
    expect(canonicalUnitJson(a)).toBe('{"campaign_id":"c1"}');
    expect(unitId(a)).toBe('47c583f8f997e2a55f46dc618c2f1969');
    expect(unitId(b)).toBe('2aa6ecebeab5fd23a8d13f806b28e4c6');
    expect(hex(registrationDigest([a, b]))).toBe(
      '2d52a2d80eed610872ef7239611c9cf9d768a6bce24d222f2985b129d4c929bf',
    );
    expect(hex(registrationDigest([]))).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
  });

  it('derives one id per scope map, independent of key insertion order', () => {
    const forward = { a: '1', b: '2' };
    const backward = { b: '2', a: '1' };
    expect(canonicalUnitJson(backward)).toBe('{"a":"1","b":"2"}');
    // Integer-like keys sort as text, never in JavaScript object order.
    expect(canonicalUnitJson({ '9': 'a', '10': 'b' })).toBe(
      '{"10":"b","9":"a"}',
    );
    expect(unitId(backward)).toBe(unitId(forward));
    expect(unitId(forward)).toMatch(/^[0-9a-f]{32}$/);
    expect(unitId({ a: '1' })).not.toBe(unitId({ a: '2' }));
  });

  it('orders keys by UTF-16 code unit and keeps registration order', () => {
    const units = [{ '\u{1f600}': 'x', '！': 'y' }, { k: '7' }];
    expect(canonicalUnitJson(units[0] ?? {})).toBe(
      '{"\u{1f600}":"x","！":"y"}',
    );
    expect(hex(registrationDigest(units))).toBe(
      nodeSha256('[{"\u{1f600}":"x","！":"y"},{"k":"7"}]'),
    );
    expect(hex(registrationDigest(units))).not.toBe(
      hex(registrationDigest([...units].reverse())),
    );
  });
});

describe('echo digest (SPEC.md §4.4)', () => {
  it('hashes the canonical echo array with sorted unique scope lists', () => {
    const digest = echoDigest([
      {
        id: '47c583f8f997e2a55f46dc618c2f1969',
        status: 'active',
        fenced: [
          {
            table: 'notes',
            status: 'active',
            scopes: { team: ['t2', 't1', 't2'] },
          },
          { table: 'tasks', status: 'revoked', scopes: {} },
        ],
      },
      { id: '2aa6ecebeab5fd23a8d13f806b28e4c6', status: 'revoked', fenced: [] },
    ]);
    expect(hex(digest)).toBe(
      nodeSha256(
        '[{"fenced":[{"scopes":{"team":["t1","t2"]},"status":"active","table":"notes"},' +
          '{"scopes":{},"status":"revoked","table":"tasks"}],' +
          '"id":"47c583f8f997e2a55f46dc618c2f1969","status":"active"},' +
          '{"fenced":[],"id":"2aa6ecebeab5fd23a8d13f806b28e4c6","status":"revoked"}]',
      ),
    );
    expect(hex(echoDigest([]))).toBe(nodeSha256('[]'));
  });
});

describe('canonical scope JSON (SPEC.md §11.2)', () => {
  it('sorts keys and sorts and deduplicates value lists', () => {
    expect(canonicalScopeJson({ b: ['2', '1', '2'], a: [] })).toBe(
      '{"a":[],"b":["1","2"]}',
    );
  });
});

describe('SHA-256', () => {
  it('matches node:crypto across every padding boundary', () => {
    // `[{"k":"…"}]` wraps the text in 10 bytes, so the hashed input spans
    // the 55/56 and 63/64/65 padding edges of one and two blocks.
    for (const length of [10, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = 'x'.repeat(length - 10);
      expect(hex(registrationDigest([{ k: text }]))).toBe(
        nodeSha256(`[{"k":${JSON.stringify(text)}}]`),
      );
    }
  });
});

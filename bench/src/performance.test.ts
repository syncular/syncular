import { expect, test } from 'bun:test';
import { nativeByteResult, performanceOptions } from './performance';

test('local reads select fixed data sizes and reject transport or core substitutions', () => {
  expect(
    performanceOptions([
      '--workload',
      'read',
      '--core',
      'rust',
      '--lane',
      'socket',
      '--boundary',
      'ffi',
    ]).boundary,
  ).toBe('ffi');
  expect(
    performanceOptions(['--workload', 'read', '--lane', 'engine']).sizes,
  ).toEqual([1000, 10000, 100000]);
  expect(
    performanceOptions([
      '--workload',
      'read',
      '--core',
      'rust',
      '--lane',
      'socket',
      '--boundary',
      'command',
    ]).boundary,
  ).toBe('command');
  for (const extra of [
    ['--lane', 'socket'],
    ['--core', 'rust'],
    ['--backend', 'postgres'],
    ['--sizes', '100001'],
  ])
    expect(() =>
      performanceOptions(['--workload', 'read', '--lane', 'engine', ...extra]),
    ).toThrow();
});

test('performance selections reject invalid and unsupported measurements', () => {
  expect(() =>
    performanceOptions(['--workload', 'native-bytes', '--lane', 'engine']),
  ).toThrow();
  expect(() =>
    performanceOptions([
      '--workload',
      'native-bytes',
      '--lane',
      'native',
      '--sizes',
      'NaN',
    ]),
  ).toThrow();
  expect(() =>
    performanceOptions([
      '--workload',
      'native-bytes',
      '--lane',
      'native',
      '--trials',
      '0',
    ]),
  ).toThrow();
  expect(() =>
    performanceOptions([
      '--workload',
      'native-bytes',
      '--lane',
      'native',
      '--unknown',
    ]),
  ).toThrow();
});

test('native artifacts require exact workload, validation, and every measured sample', () => {
  const result = {
    byteLength: 2,
    iterations: 1,
    warmups: 3,
    serializedBytes: 17,
    validation: 'exact-byte-roundtrip',
    encodeNs: [1_000_000],
    serializeNs: [2],
    parseNs: [3],
    decodeNs: [4],
  };
  expect(nativeByteResult({ result }, 2, 1).phasesMs.encodeNs).toEqual([1]);
  expect(() => nativeByteResult({ error: 'failed' }, 2, 1)).toThrow();
  expect(() => nativeByteResult({ result }, 3, 1)).toThrow();
  expect(() =>
    nativeByteResult({ result: { ...result, validation: 'unchecked' } }, 2, 1),
  ).toThrow();
  expect(() =>
    nativeByteResult({ result: { ...result, decodeNs: [] } }, 2, 1),
  ).toThrow();
  expect(() =>
    nativeByteResult({ result: { ...result, encodeNs: [Number.NaN] } }, 2, 1),
  ).toThrow();
});

test('Swift selection requires its actual runtime and supported read boundary', () => {
  const args = [
    '--workload',
    'read',
    '--core',
    'rust',
    '--boundary',
    'ffi',
    '--lane',
    'socket',
    '--binding',
    'swift',
  ];
  if (process.platform === 'darwin')
    expect(performanceOptions(args).binding).toBe('swift');
  else expect(() => performanceOptions(args)).toThrow('macOS');
  for (const extra of [
    ['--binding', 'kotlin'],
    ['--core', 'ts'],
    ['--boundary', 'direct'],
    ['--workload', 'blobs'],
    ['--lane', 'engine'],
    ['--backend', 'postgres'],
  ])
    expect(() => performanceOptions([...args, ...extra])).toThrow();
});

test('Postgres I/O diagnostics require an explicit server profile', () => {
  const args = [
    '--workload',
    'replay',
    '--lane',
    'socket',
    '--backend',
    'postgres',
    '--pg-io',
  ];
  expect(performanceOptions(args).pgIo).toBe(true);
  expect(
    performanceOptions(['--workload', 'replay', '--lane', 'engine']).pgIo,
  ).toBe(false);
  expect(() => performanceOptions([...args, '--backend', 'sqlite'])).toThrow(
    'Postgres',
  );
  expect(() =>
    performanceOptions([
      '--workload',
      'native-bytes',
      '--lane',
      'native',
      '--backend',
      'postgres',
      '--pg-io',
    ]),
  ).toThrow('Postgres');
});

test('native SQL diagnostics are opt-in and reject unsupported workloads and boundaries', () => {
  const args = [
    '--workload',
    'reconnect',
    '--core',
    'rust',
    '--lane',
    'socket',
  ];
  expect(performanceOptions(args).nativeSql).toBe(false);
  expect(performanceOptions([...args, '--native-sql']).nativeSql).toBe(true);
  expect(
    performanceOptions([
      ...args,
      '--workload',
      'fanout',
      '--boundary',
      'command',
      '--native-sql',
    ]).nativeSql,
  ).toBe(true);
  for (const extra of [
    ['--core', 'ts'],
    ['--lane', 'engine'],
    ['--workload', 'blobs'],
    ['--workload', 'read'],
    ['--boundary', 'ffi'],
  ])
    expect(() =>
      performanceOptions([...args, '--native-sql', ...extra]),
    ).toThrow('Native SQL diagnostics');
});

test('native phase diagnostics accept measured socket boundaries only', () => {
  const base = ['--core', 'rust', '--lane', 'socket', '--storage', 'file'];
  for (const workload of [
    'replay',
    'restart',
    'commit-boundaries',
    'fanout',
    'reconnect',
    'blobs',
  ]) {
    expect(
      performanceOptions([...base, '--workload', workload]).nativePhases,
    ).toBe(false);
    expect(
      performanceOptions([...base, '--workload', workload, '--native-phases'])
        .nativePhases,
    ).toBe(true);
  }
  for (const extra of [
    ['--core', 'ts'],
    ['--lane', 'engine'],
    ['--boundary', 'ffi'],
    ['--workload', 'read'],
  ])
    expect(() =>
      performanceOptions([
        ...base,
        '--workload',
        'replay',
        '--native-phases',
        ...extra,
      ]),
    ).toThrow('Native phases');
  expect(
    performanceOptions([...base, '--workload', 'replay', '--native-sql'])
      .nativeSql,
  ).toBe(true);
});

test('TS sampling is explicit and restricted to isolated TS replay and observation', () => {
  for (const workload of [
    'replay',
    'restart',
    'commit-boundaries',
    'fanout',
    'reconnect',
  ]) {
    const args = [
      '--workload',
      workload,
      '--core',
      'ts',
      '--lane',
      'socket',
      '--storage',
      'file',
    ];
    expect(performanceOptions(args).tsProfile).toBe(false);
    expect(performanceOptions([...args, '--ts-profile']).tsProfile).toBe(true);
    expect(() =>
      performanceOptions([...args, '--ts-profile', '--core', 'rust']),
    ).toThrow('TS sampling');
    expect(() =>
      performanceOptions([...args, '--ts-profile', '--lane', 'engine']),
    ).toThrow('TS sampling');
  }
  for (const workload of ['read', 'blobs', 'purge'])
    expect(() =>
      performanceOptions([
        '--workload',
        workload,
        '--core',
        'ts',
        '--lane',
        'socket',
        '--ts-profile',
      ]),
    ).toThrow('TS sampling');
});

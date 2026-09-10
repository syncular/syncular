import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { median } from './fixture';
import { runReplayLane } from './replay-lane';
import { openPgIoObserver } from './pg-lane';
import { runObservationLane } from './observation-lane';
import { runProcessReplay } from './process-lane';
import { runProcessPurge } from './purge-lane';
import { runProcessObservation } from './process-observation';
import { runReadLane, runProcessReads } from './read-lane';
import { runBlobLane, runProcessBlobs, runBlobFile } from './blob-lane';

const root = resolve(import.meta.dir, '../..');

export function performanceOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      workload: { type: 'string' },
      lane: { type: 'string' },
      core: { type: 'string', default: 'ts' },
      boundary: { type: 'string', default: 'direct' },
      binding: { type: 'string' },
      trials: { type: 'string', default: '5' },
      iterations: { type: 'string', default: '10' },
      sizes: { type: 'string' },
      rows: { type: 'string', default: '2000' },
      storage: { type: 'string', default: 'memory' },
      backend: { type: 'string', default: 'sqlite' },
      pattern: { type: 'string', default: 'independent' },
      'reject-middle': { type: 'boolean', default: false },
      'pg-io': { type: 'boolean', default: false },
      'native-sql': { type: 'boolean', default: false },
      'native-phases': { type: 'boolean', default: false },
      'ts-profile': { type: 'boolean', default: false },
      'blob-profile': { type: 'string' },
      'blob-store': { type: 'string' },
      'blob-diagnostics': { type: 'string' },
      output: { type: 'string' },
      ci: { type: 'boolean', default: false },
    },
  });
  const blobProfile = values['blob-profile'] ?? 'lifecycle';
  const blobStore = values['blob-store'] ?? 'memory';
  const blobDiagnostics = values['blob-diagnostics'] ?? 'on';
  if (
    !['on', 'off'].includes(blobDiagnostics) ||
    (values['blob-diagnostics'] !== undefined &&
      (values.workload !== 'blobs' || blobProfile !== 'file'))
  )
    throw new Error('Blob diagnostics on/off requires the blob file profile');
  if (
    !['lifecycle', 'file'].includes(blobProfile) ||
    !['memory', 'minio'].includes(blobStore) ||
    (values.workload !== 'blobs' &&
      (values['blob-profile'] !== undefined ||
        values['blob-store'] !== undefined))
  )
    throw new Error(
      'Blob options require the blobs workload, lifecycle/file profile, and memory/minio store',
    );
  if (
    (blobStore === 'minio' && blobProfile !== 'file') ||
    (blobProfile === 'file' &&
      (values.lane !== 'socket' ||
        values.storage !== 'file' ||
        values.boundary !== 'direct' ||
        values['native-phases']))
  )
    throw new Error(
      'Blob file profile requires socket, file storage, direct boundary, and native phases disabled; MinIO requires file profile',
    );
  const maxSize =
    blobProfile === 'file' && blobStore === 'minio'
      ? 500_000_000
      : 16 * 1024 * 1024;
  if (
    !(
      (values.workload === 'native-bytes' && values.lane === 'native') ||
      (values.workload === 'read' &&
        (values.lane === 'engine' || values.lane === 'socket')) ||
      ([
        'replay',
        'purge',
        'restart',
        'commit-boundaries',
        'blobs',
        'fanout',
        'reconnect',
      ].includes(values.workload ?? '') &&
        (values.lane === 'engine' || values.lane === 'socket'))
    )
  ) {
    throw new Error(
      'Select native-bytes/native, read with engine/socket lane, or replay/purge/restart/commit-boundaries/blobs/fanout/reconnect with engine/socket lane',
    );
  }
  if (
    values['ts-profile'] &&
    (values.core !== 'ts' ||
      values.lane !== 'socket' ||
      ![
        'replay',
        'restart',
        'commit-boundaries',
        'fanout',
        'reconnect',
      ].includes(values.workload ?? ''))
  )
    throw new Error(
      'TS sampling requires a TS socket replay or observation workload',
    );
  if (values.binding !== undefined && values.binding !== 'swift')
    throw new Error('Select swift binding or omit binding');
  if (
    values.binding === 'swift' &&
    (values.core !== 'rust' ||
      values.boundary !== 'ffi' ||
      values.workload !== 'read' ||
      values.lane !== 'socket' ||
      platform() !== 'darwin')
  )
    throw new Error(
      'Swift binding requires Rust, ffi, read, socket, and macOS',
    );
  if (
    values['pg-io'] &&
    (values.backend !== 'postgres' || values.workload === 'native-bytes')
  )
    throw new Error(
      'Postgres I/O diagnostics require a Postgres server workload',
    );
  if (
    values['native-sql'] &&
    (values.core !== 'rust' ||
      values.lane !== 'socket' ||
      !['direct', 'command'].includes(values.boundary) ||
      ![
        'fanout',
        'reconnect',
        'replay',
        'restart',
        'commit-boundaries',
      ].includes(values.workload ?? ''))
  )
    throw new Error(
      'Native SQL diagnostics require Rust socket replay/restart/commit-boundaries/fanout/reconnect with direct or command boundary',
    );
  if (
    values['native-phases'] &&
    (values.core !== 'rust' ||
      values.lane !== 'socket' ||
      !['direct', 'command'].includes(values.boundary) ||
      ![
        'replay',
        'restart',
        'commit-boundaries',
        'fanout',
        'reconnect',
        'blobs',
      ].includes(values.workload ?? ''))
  )
    throw new Error(
      'Native phases require Rust socket replay/restart/commit-boundaries/fanout/reconnect/blobs with direct or command boundary',
    );
  const trials = Number(values.trials);
  const iterations = Number(values.iterations);
  const sizes = (
    values.sizes ??
    (values.workload === 'purge'
      ? '2000,10000,100000'
      : values.workload === 'commit-boundaries'
        ? '499,500'
        : values.workload === 'replay' || values.workload === 'restart'
          ? '100,500,1000,10000'
          : values.workload === 'read'
            ? '1000,10000,100000'
            : values.workload === 'native-bytes' || values.workload === 'blobs'
              ? '65536,2097152,16777216'
              : '1,5,25')
  )
    .split(',')
    .map(Number);
  const rows = Number(values.rows);
  if (
    !Number.isInteger(trials) ||
    trials < 1 ||
    trials > 100 ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 100 ||
    sizes.length === 0 ||
    sizes.some((size) => !Number.isInteger(size) || size < 1 || size > maxSize)
  ) {
    throw new Error(
      `Trials/iterations must be integers in 1..100; sizes in 1..${maxSize}`,
    );
  }
  if (
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 100_000 ||
    !['memory', 'file'].includes(values.storage) ||
    !['independent', 'repeated'].includes(values.pattern) ||
    (['replay', 'restart'].includes(values.workload ?? '') &&
      sizes.some((size) => size > 10_000))
  ) {
    throw new Error('Invalid replay fixture, storage, or pattern');
  }
  if (
    (values.workload === 'fanout' || values.workload === 'reconnect') &&
    sizes.some((size) => size > 25)
  )
    throw new Error('Reader count exceeds 25');
  if (values.backend !== 'sqlite' && values.backend !== 'postgres')
    throw new Error('Select sqlite or postgres backend');
  if (values.core !== 'ts' && values.core !== 'rust')
    throw new Error('Select ts or rust core');
  if (
    values.boundary !== 'direct' &&
    values.boundary !== 'command' &&
    values.boundary !== 'ffi'
  )
    throw new Error('Select direct, command, or ffi boundary');
  if (
    values.boundary === 'ffi' &&
    !['blobs', 'read'].includes(values.workload ?? '')
  )
    throw new Error(
      'FFI boundary currently requires the blob or read workload',
    );
  if (
    values.core === 'rust' &&
    values.workload !== 'native-bytes' &&
    values.lane !== 'socket' &&
    !(values.lane === 'engine' && values.workload === 'replay')
  )
    throw new Error(
      'Native full clients require the socket lane, except engine replay',
    );
  if (
    values.workload === 'restart' &&
    (values.lane !== 'socket' || values.storage !== 'file')
  )
    throw new Error('Restart requires the socket lane and file storage');
  if (
    values.workload === 'commit-boundaries' &&
    (values.lane !== 'socket' ||
      values.pattern !== 'independent' ||
      sizes.some((size) => size !== 499 && size !== 500))
  )
    throw new Error(
      'Commit boundaries require socket, independent pattern, and sizes 499 or 500',
    );
  if (
    values.workload === 'purge' &&
    (values.lane !== 'socket' ||
      values.pattern !== 'independent' ||
      values.storage !== 'file' ||
      values.boundary === 'ffi' ||
      sizes.some((size) => size > 100_000))
  )
    throw new Error(
      'Purge requires socket lane, file storage, direct or command boundary, and at most 100000 rows',
    );
  if (values['reject-middle'] && values.workload !== 'commit-boundaries')
    throw new Error('Reject-middle requires the commit-boundaries workload');
  if (values.workload === 'blobs' && sizes.some((size) => size < 2))
    throw new Error('Blob lifecycle requires at least two bytes');
  if (values.core === 'ts' && values.boundary !== 'direct')
    throw new Error('Command boundary requires Rust');
  if (
    values.workload === 'read' &&
    ((values.core === 'ts' && values.lane !== 'engine') ||
      values.backend !== 'sqlite' ||
      sizes.some((size) => size > 100_000))
  )
    throw new Error(
      'Read requires TS/engine or Rust/socket, SQLite, and at most 100000 rows',
    );
  return {
    core: values.workload === 'native-bytes' ? 'rust' : values.core,
    boundary: values.boundary as 'direct' | 'command' | 'ffi',
    binding: values.binding as 'swift' | undefined,
    backend: values.backend as 'sqlite' | 'postgres',
    workload: values.workload,
    lane: values.lane,
    trials,
    iterations,
    sizes,
    rows,
    storage: values.storage,
    pattern: values.pattern,
    rejectMiddle: values['reject-middle'],
    pgIo: values['pg-io'],
    nativeSql: values['native-sql'],
    nativePhases: values['native-phases'],
    tsProfile: values['ts-profile'],
    blobProfile: blobProfile as 'lifecycle' | 'file',
    blobStore: blobStore as 'memory' | 'minio',
    blobDiagnostics: blobDiagnostics === 'on',
    output: resolve(
      root,
      values.output ??
        join(
          'bench/results',
          `${new Date().toISOString().replaceAll(':', '-')}-${values.workload}.json`,
        ),
    ),
  };
}

export function nativeByteResult(
  value: unknown,
  size: number,
  iterations: number,
) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('result' in value) ||
    typeof value.result !== 'object' ||
    value.result === null
  ) {
    throw new Error('Native byte benchmark returned no result');
  }
  const result = value.result;
  if (
    !('byteLength' in result) ||
    result.byteLength !== size ||
    !('iterations' in result) ||
    result.iterations !== iterations ||
    !('warmups' in result) ||
    result.warmups !== 3 ||
    !('serializedBytes' in result) ||
    result.serializedBytes !== size * 2 + 13 ||
    !('validation' in result) ||
    result.validation !== 'exact-byte-roundtrip'
  ) {
    throw new Error(
      'Native byte benchmark returned mismatched workload or validation',
    );
  }
  const phases: Record<string, number[]> = {};
  for (const key of ['encodeNs', 'serializeNs', 'parseNs', 'decodeNs']) {
    const samples: unknown = Reflect.get(result, key);
    if (
      !Array.isArray(samples) ||
      samples.length !== iterations ||
      !samples.every(
        (sample: unknown) =>
          typeof sample === 'number' && Number.isFinite(sample) && sample >= 0,
      )
    ) {
      throw new Error(
        'Native byte benchmark returned invalid duration samples',
      );
    }
    phases[key] = samples.map((sample: number) => sample / 1_000_000);
  }
  return {
    byteLength: size,
    serializedBytes: result.serializedBytes,
    warmups: 3,
    phasesMs: phases,
    validation: 'exact-byte-roundtrip',
  };
}

export async function runPerformanceBench(args: string[]): Promise<void> {
  const options = performanceOptions(args);
  if (await Bun.file(options.output).exists())
    throw new Error(
      'Benchmark artifact already exists; select a new output path',
    );
  let binary = join(root, 'rust/target/release/syncular-bench');
  const engineLibrary =
    options.core === 'rust' && options.lane === 'engine'
      ? join(
          root,
          'rust/target/release',
          process.platform === 'darwin'
            ? 'libsyncular_bench.dylib'
            : process.platform === 'linux'
              ? 'libsyncular_bench.so'
              : 'syncular_bench.dll',
        )
      : undefined;
  let swiftBuild:
    | {
        compiler: string;
        commands: string[][];
        libraries: Record<string, string>;
      }
    | undefined;
  if (options.core === 'rust') {
    const build = Bun.spawn(
      [
        'cargo',
        'build',
        '--release',
        '--locked',
        '--manifest-path',
        join(root, 'rust/Cargo.toml'),
        '-p',
        options.binding === 'swift' ? 'syncular-ffi' : 'syncular-bench',
        ...(options.binding === 'swift'
          ? ['--features', 'native-transport']
          : []),
      ],
      { cwd: root, stdout: 'inherit', stderr: 'inherit' },
    );
    if ((await build.exited) !== 0)
      throw new Error('Native benchmark release build failed');
  }
  if (options.binding === 'swift') {
    const directory = join(root, 'bench/results/swift-build');
    await mkdir(directory, { recursive: true });
    binary = join(directory, 'swift-read');
    const sdk = join(root, 'bindings/swift/Sources');
    const ffiDirectory = join(root, 'rust/target/release/deps');
    const common = [
      'swiftc',
      '-O',
      '-swift-version',
      '5',
      '-I',
      join(sdk, 'CSyncularFFI/include'),
    ];
    const commands = [
      [
        ...common,
        '-emit-library',
        '-emit-module',
        '-module-name',
        'Syncular',
        '-emit-module-path',
        join(directory, 'Syncular.swiftmodule'),
        ...[
          'JSONValue.swift',
          'SyncularClient.swift',
          'Connectivity.swift',
        ].map((file) => join(sdk, 'Syncular', file)),
        '-L',
        ffiDirectory,
        '-lsyncular',
        '-Xlinker',
        '-rpath',
        '-Xlinker',
        ffiDirectory,
        '-o',
        join(directory, 'libSyncularSwiftBench.dylib'),
      ],
      [
        ...common,
        '-parse-as-library',
        '-I',
        directory,
        '-L',
        directory,
        '-lSyncularSwiftBench',
        '-Xlinker',
        '-rpath',
        '-Xlinker',
        directory,
        join(root, 'bench/src/swift-read.swift'),
        '-o',
        binary,
      ],
    ];
    if (
      (await Bun.file(
        join(sdk, 'CSyncularFFI/include/syncular_ffi.h'),
      ).text()) !== (await Bun.file(join(root, 'rust/ffi.h')).text())
    )
      throw new Error('Swift FFI header differs from the shipping header');
    const compiler = Bun.spawnSync(['swiftc', '--version']);
    if (compiler.exitCode !== 0)
      throw new Error('Swift compiler is unavailable');
    for (const command of commands) {
      const build = Bun.spawn(command, {
        cwd: root,
        stdout: 'inherit',
        stderr: 'inherit',
      });
      if ((await build.exited) !== 0)
        throw new Error('Swift read benchmark build failed');
    }
    const libraries: Record<string, string> = {};
    for (const path of [
      join(ffiDirectory, 'libsyncular.dylib'),
      join(directory, 'libSyncularSwiftBench.dylib'),
    ])
      libraries[path] = createHash('sha256')
        .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
        .digest('hex');
    swiftBuild = {
      compiler: compiler.stdout.toString().trim(),
      commands,
      libraries,
    };
  }
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
  const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root });
  const diff = Bun.spawnSync(
    [
      'git',
      'diff',
      'HEAD',
      '--',
      'bench',
      'packages',
      'rust',
      'bindings',
      'bun.lock',
      'package.json',
      'tsconfig.json',
    ],
    { cwd: root },
  );
  const paths = Bun.spawnSync(
    [
      'git',
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      'bench',
      'packages',
      'rust',
      'bindings',
      'bun.lock',
      'package.json',
      'tsconfig.json',
    ],
    { cwd: root },
  );
  if ([revision, status, diff, paths].some((result) => result.exitCode !== 0)) {
    throw new Error('Cannot record benchmark source provenance');
  }
  const files: Record<string, string> = {};
  for (const path of [
    ...new Set(paths.stdout.toString().trim().split('\n')),
  ].sort()) {
    if (!path) continue;
    const file = Bun.file(join(root, path));
    if (await file.exists())
      files[path] = createHash('sha256')
        .update(new Uint8Array(await file.arrayBuffer()))
        .digest('hex');
  }
  const untracked = Bun.spawnSync(
    [
      'git',
      'ls-files',
      '--others',
      '--exclude-standard',
      'bench',
      'packages',
      'rust',
      'bindings',
      'bun.lock',
      'package.json',
      'tsconfig.json',
    ],
    { cwd: root },
  );
  if (untracked.exitCode !== 0)
    throw new Error('Cannot record untracked benchmark source');
  const untrackedSources: Record<string, string> = {};
  for (const path of untracked.stdout.toString().trim().split('\n')) {
    if (path) untrackedSources[path] = await Bun.file(join(root, path)).text();
  }
  const attempts: Array<Record<string, unknown>> = [];
  const artifact = {
    schema: 'syncular-performance-v1',
    startedAt: new Date().toISOString(),
    options,
    source: {
      revision: revision.stdout.toString().trim(),
      status: status.stdout.toString(),
      diff: diff.stdout.toString(),
      untrackedSources,
      files,
      fingerprint: createHash('sha256')
        .update(JSON.stringify(files))
        .digest('hex'),
    },
    host: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      bun: Bun.version,
    },
    native:
      options.core === 'rust'
        ? {
            binarySha256: createHash('sha256')
              .update(new Uint8Array(await Bun.file(binary).arrayBuffer()))
              .digest('hex'),
            profile: 'release',
            ...(engineLibrary
              ? {
                  engineLibrarySha256: createHash('sha256')
                    .update(
                      new Uint8Array(
                        await Bun.file(engineLibrary).arrayBuffer(),
                      ),
                    )
                    .digest('hex'),
                }
              : {}),
            ...(swiftBuild ? { swift: swiftBuild } : {}),
            rustc: Bun.spawnSync(['rustc', '--version'])
              .stdout.toString()
              .trim(),
          }
        : null,
    boundaries:
      options.workload === 'native-bytes'
        ? 'Fresh native process per attempt. Each phase is measured inside Rust; process elapsed includes launch and IPC. Three warmups; validation excluded. Phase samples are operation durations, not independent trials.'
        : 'Fresh server and full clients per attempt. Each attempt declares its operation, validation, and resource measurement boundaries.',
    attempts,
  };
  await mkdir(dirname(options.output), { recursive: true });
  for (let trial = 0; trial < options.trials; trial++) {
    for (const size of options.sizes) {
      const started = performance.now();
      let pgIo: Awaited<ReturnType<typeof openPgIoObserver>> | undefined;
      try {
        if (options.pgIo) {
          const url = process.env.SYNCULAR_PG_URL;
          if (!url)
            throw new Error('Postgres I/O diagnostics require SYNCULAR_PG_URL');
          pgIo = await openPgIoObserver(url);
        }
        if (options.workload === 'purge') {
          if (options.boundary === 'ffi')
            throw new Error('Purge FFI boundary is not implemented');
          const result = await runProcessPurge({
            binary:
              options.core === 'rust'
                ? binary
                : [process.execPath, join(import.meta.dir, 'ts-process.ts')],
            core: options.core === 'rust' ? 'rust' : 'ts',
            rows: size,
            backend: options.backend,
            boundary: options.boundary,
          });
          attempts.push({ trial, size, status: 'completed', ...result });
          console.log(
            `purge trial ${trial + 1}, ${size} revoked rows: ${result.operationPurgeMs.toFixed(3)} ms`,
          );
        } else if (options.workload === 'blobs') {
          if (options.lane !== 'engine' && options.lane !== 'socket')
            throw new Error('Invalid blob lane');
          const result =
            options.blobProfile === 'file'
              ? await runBlobFile({
                  binary:
                    options.core === 'rust'
                      ? binary
                      : [
                          process.execPath,
                          join(import.meta.dir, 'ts-process.ts'),
                        ],
                  byteLength: size,
                  rows: options.rows,
                  backend: options.backend,
                  blobStore: options.blobStore,
                  blobDiagnostics: options.blobDiagnostics,
                })
              : options.core === 'rust'
                ? await runProcessBlobs({
                    binary,
                    nativePhases: options.nativePhases,
                    boundary: options.boundary,
                    rows: options.rows,
                    byteLength: size,
                    objects: size === 2 * 1024 * 1024 ? 2 : 1,
                    persistent: options.storage === 'file',
                    backend: options.backend,
                  })
                : await runBlobLane({
                    byteLength: size,
                    objects: size === 2 * 1024 * 1024 ? 2 : 1,
                    rows: options.rows,
                    persistent: options.storage === 'file',
                    lane: options.lane,
                    backend: options.backend,
                  });
          attempts.push({ trial, size, status: 'completed', ...result });
          console.log(
            `blob trial ${trial + 1}, ${result.validatedObjects} objects of ${size} bytes: lifecycle validated`,
          );
        } else if (options.workload === 'read') {
          const result =
            options.core === 'rust'
              ? await runProcessReads({
                  binary,
                  ...(swiftBuild
                    ? { swiftLibraries: swiftBuild.libraries }
                    : {}),
                  boundary: options.boundary,
                  rows: size,
                  iterations: options.iterations,
                  persistent: options.storage === 'file',
                })
              : await runReadLane({
                  rows: size,
                  iterations: options.iterations,
                  persistent: options.storage === 'file',
                });
          attempts.push({ trial, size, status: 'completed', ...result });
          console.log(
            `read trial ${trial + 1}, ${size} rows: all selected read surfaces validated`,
          );
        } else if (
          ['replay', 'restart', 'commit-boundaries'].includes(
            options.workload ?? '',
          ) &&
          (options.lane === 'socket' ||
            options.core === 'rust' ||
            options.workload !== 'replay')
        ) {
          if (options.boundary === 'ffi')
            throw new Error('FFI replay is not implemented');
          const result = await runProcessReplay({
            ...(engineLibrary ? { engineLibrary } : {}),
            binary:
              options.core === 'rust'
                ? binary
                : [process.execPath, join(import.meta.dir, 'ts-process.ts')],
            core: options.core as 'ts' | 'rust',
            nativeSql: options.nativeSql,
            nativePhases: options.nativePhases,
            tsProfile: options.tsProfile,
            restart: options.workload === 'restart',
            rows: options.rows,
            commits: options.workload === 'commit-boundaries' ? 3 : size,
            ...(options.workload === 'commit-boundaries'
              ? {
                  mixed: {
                    firstOperations: size as 499 | 500,
                    rejectMiddle: options.rejectMiddle,
                  },
                }
              : {}),
            repeated: options.pattern === 'repeated',
            persistent: options.storage === 'file',
            backend: options.backend,
            boundary: options.boundary,
          });
          attempts.push({ trial, size, status: 'completed', ...result });
          console.log(
            `${options.core} ${options.lane} replay trial ${trial + 1}, ${result.validatedCommits} commits, ${result.validatedOperations} operations: construction ${result.operationConstructionMs.toFixed(3)} ms, drain ${result.drainedMs.toFixed(3)} ms, reader ${result.readerVisibleMs.toFixed(3)} ms`,
          );
        } else if (options.workload === 'replay') {
          if (options.lane !== 'engine' && options.lane !== 'socket')
            throw new Error('Invalid replay lane');
          const result = await runReplayLane({
            lane: options.lane,
            backend: options.backend,
            commits: size,
            rows: options.rows,
            repeated: options.pattern === 'repeated',
            persistent: options.storage === 'file',
          });
          attempts.push({ trial, size, status: 'completed', ...result });
          console.log(
            `replay trial ${trial + 1}, ${size} commits: drain ${result.drainedMs.toFixed(3)} ms, reader ${result.readerVisibleMs.toFixed(3)} ms`,
          );
        } else if (
          options.workload === 'fanout' ||
          options.workload === 'reconnect'
        ) {
          if (options.lane !== 'engine' && options.lane !== 'socket')
            throw new Error('Invalid observation lane');
          if (options.boundary === 'ffi')
            throw new Error('FFI observation is not implemented');
          const result =
            options.lane === 'socket'
              ? await runProcessObservation({
                  binary:
                    options.core === 'rust'
                      ? binary
                      : [
                          process.execPath,
                          join(import.meta.dir, 'ts-process.ts'),
                        ],
                  core: options.core as 'ts' | 'rust',
                  nativeSql: options.nativeSql,
                  nativePhases: options.nativePhases,
                  tsProfile: options.tsProfile,
                  rows: options.rows,
                  readers: size,
                  persistent: options.storage === 'file',
                  reconnect: options.workload === 'reconnect',
                  backend: options.backend,
                  boundary: options.boundary,
                })
              : await runObservationLane({
                  readers: size,
                  rows: options.rows,
                  reconnect: options.workload === 'reconnect',
                  persistent: options.storage === 'file',
                  lane: options.lane,
                  backend: options.backend,
                });
          attempts.push({ trial, size, status: 'completed', ...result });
          console.log(
            `${options.workload} trial ${trial + 1}, ${size} readers: ${result.allReadersMs.toFixed(3)} ms`,
          );
        } else {
          const child = Bun.spawn([binary], {
            cwd: root,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 120_000,
          });
          child.stdin.write(
            `${JSON.stringify({ id: 1, method: 'benchBytes', params: { byteLength: size, iterations: options.iterations } })}\n`,
          );
          child.stdin.end();
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          const processElapsedMs = performance.now() - started;
          if (code !== 0)
            throw new Error(`Native benchmark exited ${code}: ${stderr}`);
          const result = nativeByteResult(
            JSON.parse(stdout),
            size,
            options.iterations,
          );
          attempts.push({
            trial,
            size,
            status: 'completed',
            processElapsedMs,
            ...result,
          });
          console.log(
            `native-bytes trial ${trial + 1}, ${size} bytes: encode p50 ${median(result.phasesMs.encodeNs ?? []).toFixed(3)} ms`,
          );
        }
      } catch (error) {
        attempts.push({
          trial,
          size,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (pgIo) {
        const attempt = attempts.at(-1)!;
        try {
          try {
            attempt.postgresIo = await pgIo.collect();
          } finally {
            await pgIo.close();
          }
        } catch (error) {
          attempt.status = 'failed';
          attempt.postgresIoError =
            error instanceof Error ? error.message : String(error);
        }
      }
      await Bun.write(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
    }
  }
  console.log(`Artifact: ${options.output}`);
  if (attempts.some((attempt) => attempt.status === 'failed'))
    throw new Error('Benchmark attempts failed; retained in artifact');
}

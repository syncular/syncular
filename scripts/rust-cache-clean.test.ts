import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 'rust-cache-clean.py');
const now = Date.now() / 1000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rust-cache-test-'));
  const target = join(root, 'target');
  const profile = join(target, 'debug');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, '.cargo-lock'), '');
  return { root, target, profile };
}

function artifact(profile: string, hash: string, ageDays: number) {
  const fingerprint = join(profile, '.fingerprint', `crate-${hash}`);
  const output = join(profile, 'deps', `libcrate-${hash}.rlib`);
  mkdirSync(fingerprint, { recursive: true });
  mkdirSync(join(profile, 'deps'), { recursive: true });
  writeFileSync(join(fingerprint, 'lib-crate'), 'fingerprint');
  writeFileSync(output, Buffer.alloc(8192));
  for (const path of [fingerprint, join(fingerprint, 'lib-crate'), output]) {
    utimesSync(path, now - ageDays * 86400, now - ageDays * 86400);
  }
  return { fingerprint, output };
}

function clean(
  target: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const settings: Record<string, string | undefined> = {
    ...process.env,
    RUST_CACHE_MAX_GIB: '8',
    RUST_CACHE_MAX_AGE_DAYS: '14',
    RUST_CACHE_MIN_AGE_HOURS: '24',
    ...env,
  };
  delete settings.CARGO_TARGET_DIR;
  return Bun.spawnSync(['python3', script, target, ...args], { env: settings });
}

test.skipIf(process.platform === 'win32')(
  'prunes expired fingerprints with outputs while retaining fresh and final files',
  () => {
    const f = fixture();
    try {
      const old = artifact(f.profile, '1111111111111111', 20);
      const fresh = artifact(f.profile, '2222222222222222', 0);
      writeFileSync(join(f.profile, 'app'), 'final executable');
      expect(clean(f.target).exitCode).toBe(0);
      expect(existsSync(old.fingerprint)).toBe(false);
      expect(existsSync(old.output)).toBe(false);
      expect(existsSync(fresh.output)).toBe(true);
      expect(existsSync(join(f.profile, 'app'))).toBe(true);
      expect(existsSync(join(f.profile, '.cargo-lock'))).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'size pressure removes eligible older output but preserves the last 24 hours',
  () => {
    const f = fixture();
    try {
      const older = artifact(f.profile, '1111111111111111', 3);
      const fresh = artifact(f.profile, '2222222222222222', 0);
      expect(
        clean(f.target, [], { RUST_CACHE_MAX_GIB: '0.000001' }).exitCode,
      ).toBe(0);
      expect(existsSync(older.output)).toBe(false);
      expect(existsSync(fresh.output)).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'dry run preserves files and cross-target profiles are included',
  () => {
    const f = fixture();
    try {
      const cross = join(f.target, 'aarch64-apple-ios-sim', 'debug');
      mkdirSync(cross, { recursive: true });
      writeFileSync(join(cross, '.cargo-lock'), '');
      const old = artifact(cross, '1111111111111111', 20);
      expect(clean(f.target, ['--dry-run']).exitCode).toBe(0);
      expect(existsSync(old.output)).toBe(true);
      expect(clean(f.target).exitCode).toBe(0);
      expect(existsSync(old.output)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'a Cargo profile lock held by another process prevents all deletion',
  async () => {
    const f = fixture();
    const old = artifact(f.profile, '1111111111111111', 20);
    const holder = Bun.spawn(
      [
        'python3',
        '-c',
        'import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()',
        join(f.profile, '.cargo-lock'),
      ],
      { stdout: 'pipe', stdin: 'pipe' },
    );
    try {
      const reader = holder.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      const result = clean(f.target);
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toContain(
        'busy, retained',
      );
      expect(existsSync(old.output)).toBe(true);
    } finally {
      holder.stdin.end();
      await holder.exited;
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'refuses symlink targets and invalid limits; missing caches need no action',
  () => {
    const f = fixture();
    try {
      symlinkSync(f.target, join(f.root, 'alias'));
      expect(clean(join(f.root, 'alias')).exitCode).not.toBe(0);
      expect(
        clean(f.target, [], { RUST_CACHE_MAX_GIB: '-1' }).exitCode,
      ).not.toBe(0);
      expect(clean(join(f.root, 'missing')).exitCode).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'prunes old incremental caches without following build-output symlinks',
  () => {
    const f = fixture();
    try {
      const incremental = join(f.profile, 'incremental', 'old-session');
      mkdirSync(incremental, { recursive: true });
      const cached = join(incremental, 'object.o');
      writeFileSync(cached, 'old object');
      for (const path of [incremental, cached])
        utimesSync(path, now - 20 * 86400, now - 20 * 86400);
      const external = join(f.root, 'source.rs');
      writeFileSync(external, 'keep source');
      const old = artifact(f.profile, '1111111111111111', 20);
      const link = join(f.profile, 'deps', 'libcrate-1111111111111111.link');
      symlinkSync(external, link);
      // The symlink itself is recent, so the complete group must be retained.
      expect(clean(f.target).exitCode).toBe(0);
      expect(existsSync(incremental)).toBe(false);
      expect(existsSync(old.output)).toBe(true);
      expect(existsSync(external)).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'removes orphan hashed intermediates and rejects non-finite limits',
  () => {
    const f = fixture();
    try {
      const deps = join(f.profile, 'deps');
      mkdirSync(deps);
      const orphan = join(deps, 'liborphan-1111111111111111.rlib');
      writeFileSync(orphan, 'orphan cache');
      utimesSync(orphan, now - 20 * 86400, now - 20 * 86400);
      expect(
        clean(f.target, [], { RUST_CACHE_MAX_GIB: 'nan' }).exitCode,
      ).not.toBe(0);
      expect(existsSync(orphan)).toBe(true);
      expect(clean(f.target).exitCode).toBe(0);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

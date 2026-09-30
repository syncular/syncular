// Cargo uses POSIX flock on macOS/Linux. Windows keeps its native caches.
if (process.platform === 'win32') {
  console.log('[rust-cache] automatic pruning supports macOS/Linux only');
  process.exit(0);
}
const child = Bun.spawn(
  ['python3', `${import.meta.dir}/rust-cache-clean.py`, ...Bun.argv.slice(2)],
  { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await child.exited);

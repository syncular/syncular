import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function urlToFsPath(url: URL): string {
  return fileURLToPath(url);
}

async function run(cmd: string[], opts: { cwd: string }) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}`);
  }
}

const repoRootUrl = new URL('../../../', import.meta.url);
const consoleDirUrl = new URL('../../../console/', import.meta.url);
const consoleDistUrl = new URL('../../../console/dist/', import.meta.url);
const outDirUrl = new URL('../console-dist/', import.meta.url);

const repoRoot = urlToFsPath(repoRootUrl);
const consoleDir = urlToFsPath(consoleDirUrl);
const consoleDist = urlToFsPath(consoleDistUrl);
const outDir = urlToFsPath(outDirUrl);

console.log(`[server-console] repoRoot=${repoRoot}`);
console.log(`[server-console] building console (portable) from ${consoleDir}`);

await run(['bun', 'run', 'build:portable'], { cwd: consoleDir });

console.log(
  `[server-console] copying console dist ${consoleDist} -> ${outDir}`
);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(consoleDist, outDir, { recursive: true });

console.log('[server-console] done');

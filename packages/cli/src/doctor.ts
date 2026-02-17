import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandResult, DoctorCheck } from './types';

function runDoctorChecks(cwd: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: 'bun',
    ok: typeof process.versions.bun === 'string',
    detail:
      typeof process.versions.bun === 'string'
        ? `Bun ${process.versions.bun}`
        : 'Bun runtime not detected',
  });

  checks.push({
    name: 'workspace',
    ok: existsSync(join(cwd, 'package.json')),
    detail: existsSync(join(cwd, 'package.json'))
      ? 'package.json found'
      : 'package.json not found in current directory',
  });

  let hasGitRepo = false;
  let currentDir = cwd;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(currentDir, '.git'))) {
      hasGitRepo = true;
      break;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  checks.push({
    name: 'git',
    ok: hasGitRepo,
    detail: hasGitRepo
      ? 'git repository detected'
      : 'git repository not detected near current directory',
  });

  return checks;
}

export function formatDoctorResult(cwd: string): CommandResult {
  const checks = runDoctorChecks(cwd);
  const ok = checks.every((check) => check.ok);
  const lines = checks.map((check) => {
    const status = check.ok ? 'OK' : 'FAIL';
    return `${status.padEnd(4)} ${check.name.padEnd(9)} ${check.detail}`;
  });

  return {
    title: 'Doctor',
    lines,
    ok,
  };
}

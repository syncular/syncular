import type { ChildProcess } from 'node:child_process';
import {
  type AsyncDisposableResource,
  createAsyncDisposableResource,
  type ResourceRunner,
  withAsyncDisposableFactory,
} from './disposable';

export interface WaitForJsonPortOptions {
  timeoutMs?: number;
  processName?: string;
}

export async function waitForJsonPortFromStdout(
  process: ChildProcess,
  options: WaitForJsonPortOptions = {}
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const processName = options.processName ?? 'Child process';

  return new Promise<number>((resolve, reject) => {
    const stdout = process.stdout;
    const stderr = process.stderr;

    if (!stdout || !stderr) {
      reject(new Error(`${processName} has no stdout/stderr pipes`));
      return;
    }

    let stdoutBuffer = '';
    let stderrBuffer = '';

    const cleanup = () => {
      clearTimeout(timeout);
      stdout.off('data', onStdoutData);
      stderr.off('data', onStderrData);
      process.off('exit', onExit);
    };

    const resolvePort = (port: number) => {
      cleanup();
      resolve(port);
    };

    const rejectWith = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onStdoutData = (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as { port?: number };
          if (parsed.port && parsed.port > 0) {
            resolvePort(parsed.port);
            return;
          }
        } catch {
          // keep reading until a valid JSON line is emitted
        }
      }
    };

    const onStderrData = (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      rejectWith(
        new Error(
          `${processName} exited before reporting port (code=${String(code)} signal=${String(signal)})\nstderr: ${stderrBuffer}`
        )
      );
    };

    const timeout = setTimeout(() => {
      rejectWith(
        new Error(
          `${processName} startup timed out after ${timeoutMs}ms\nstderr: ${stderrBuffer}`
        )
      );
    }, timeoutMs);

    stdout.on('data', onStdoutData);
    stderr.on('data', onStderrData);
    process.on('exit', onExit);
  });
}

export interface StopChildProcessOptions {
  gracePeriodMs?: number;
}

export async function stopChildProcess(
  process: ChildProcess,
  options: StopChildProcessOptions = {}
): Promise<void> {
  if (process.exitCode != null) {
    return;
  }

  const gracePeriodMs = options.gracePeriodMs ?? 5000;

  try {
    process.kill('SIGTERM');
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      process.off('exit', onExit);
      resolve();
    };

    const timeout = setTimeout(() => {
      try {
        process.kill('SIGKILL');
      } catch {
        // ignore
      }
      process.off('exit', onExit);
      resolve();
    }, gracePeriodMs);

    process.on('exit', onExit);
  });
}

export function createChildProcessResource(
  process: ChildProcess,
  options: StopChildProcessOptions = {}
): AsyncDisposableResource<ChildProcess> {
  return createAsyncDisposableResource(process, () =>
    stopChildProcess(process, options)
  );
}

export async function withChildProcess<TResult>(
  process: ChildProcess,
  run: ResourceRunner<ChildProcess, TResult>,
  options: StopChildProcessOptions = {}
): Promise<TResult> {
  return withAsyncDisposableFactory(
    async () => createChildProcessResource(process, options),
    run
  );
}

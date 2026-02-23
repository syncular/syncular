export interface CreateIdFactoryOptions {
  prefix?: string;
  separator?: string;
  startAt?: number;
  step?: number;
  padLength?: number;
}

export interface IdFactory {
  next: () => string;
  peek: () => string;
  current: () => number;
  reset: (startAt?: number) => void;
}

function normalizeCounter(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return Math.trunc(value);
}

function formatCounter(value: number, padLength: number): string {
  const text = String(value);
  return padLength > text.length ? text.padStart(padLength, '0') : text;
}

export function createIdFactory(
  options: CreateIdFactoryOptions = {}
): IdFactory {
  const prefix = options.prefix ?? '';
  const separator = options.separator ?? '-';
  const step = normalizeCounter(options.step ?? 1, 'step');
  const padLength = Math.max(
    0,
    normalizeCounter(options.padLength ?? 0, 'padLength')
  );

  if (step === 0) {
    throw new Error('step must not be 0');
  }

  let counter = normalizeCounter(options.startAt ?? 1, 'startAt');

  const format = (value: number): string => {
    const token = formatCounter(value, padLength);
    if (prefix.length === 0) {
      return token;
    }

    return `${prefix}${separator}${token}`;
  };

  return {
    next: () => {
      const value = format(counter);
      counter += step;
      return value;
    },
    peek: () => format(counter),
    current: () => counter,
    reset: (nextStartAt = options.startAt ?? 1) => {
      counter = normalizeCounter(nextStartAt, 'startAt');
    },
  };
}

export interface CreateCommitIdFactoryOptions
  extends Omit<CreateIdFactoryOptions, 'prefix'> {
  prefix?: string;
}

export function createCommitIdFactory(
  options: CreateCommitIdFactoryOptions = {}
): IdFactory {
  return createIdFactory({
    prefix: options.prefix ?? 'commit',
    separator: options.separator,
    startAt: options.startAt,
    step: options.step,
    padLength: options.padLength,
  });
}

export interface CreateFakeClockOptions {
  startMs?: number;
  tickMs?: number;
}

export interface FakeClock {
  now: () => number;
  iso: () => string;
  set: (nextMs: number) => number;
  advance: (deltaMs: number) => number;
  tick: (stepMs?: number) => number;
}

export function createFakeClock(
  options: CreateFakeClockOptions = {}
): FakeClock {
  const defaultTickMs = normalizeCounter(options.tickMs ?? 1, 'tickMs');
  let nowMs = normalizeCounter(options.startMs ?? Date.now(), 'startMs');

  return {
    now: () => nowMs,
    iso: () => new Date(nowMs).toISOString(),
    set: (nextMs: number) => {
      nowMs = normalizeCounter(nextMs, 'nextMs');
      return nowMs;
    },
    advance: (deltaMs: number) => {
      nowMs += normalizeCounter(deltaMs, 'deltaMs');
      return nowMs;
    },
    tick: (stepMs = defaultTickMs) => {
      nowMs += normalizeCounter(stepMs, 'stepMs');
      return nowMs;
    },
  };
}

// Type declarations for bun: and node: modules when running tsgo
// (tsgo doesn't fully support bun-types or node type resolution)

declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string);
    close(): void;
    exec(sql: string): void;
    query<T = unknown>(sql: string): Statement<T>;
    prepare<T = unknown>(sql: string): Statement<T>;
    transaction<T>(fn: () => T): () => T;
  }

  export class Statement<T = unknown> {
    run(...params: unknown[]): void;
    get(...params: unknown[]): T | null;
    all(...params: unknown[]): T[];
    values(...params: unknown[]): unknown[][];
    finalize(): void;
  }
}

declare module 'bun:test' {
  interface Matchers<T> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string | RegExp | Error): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toMatch(expected: string | RegExp): void;
    toBeInstanceOf(expected: unknown): void;
    resolves: Matchers<Awaited<T>>;
    rejects: Matchers<unknown>;
    not: Matchers<T>;
  }

  export function describe(name: string, fn: () => void): void;
  export function test(
    name: string,
    fn: () => void | Promise<void>,
    timeout?: number
  ): void;
  export function it(
    name: string,
    fn: () => void | Promise<void>,
    timeout?: number
  ): void;
  export function expect<T>(value: T): Matchers<T>;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function mock<T extends (...args: unknown[]) => unknown>(fn?: T): T;
  export function spyOn<T extends object, K extends keyof T>(
    object: T,
    method: K
  ): unknown;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
  export function createHash(algorithm: string): Hash;
  export interface Hash {
    update(data: string | Buffer): Hash;
    digest(encoding: 'hex' | 'base64'): string;
  }
}

declare module 'node:zlib' {
  export function gzipSync(data: Buffer | Uint8Array | string): Buffer;
  export function gunzipSync(data: Buffer | Uint8Array): Buffer;
}

declare class Buffer extends Uint8Array {
  static from(data: string | ArrayBuffer | Uint8Array, encoding?: string): Buffer;
  static concat(list: Uint8Array[]): Buffer;
  static alloc(size: number): Buffer;
  toString(encoding?: string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; heapTotal: number; rss: number };
};

declare const global: typeof globalThis;

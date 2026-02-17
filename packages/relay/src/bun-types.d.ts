// Type declarations for bun modules when running tsgo
declare module 'bun:sqlite' {
  export default class Database {
    constructor(path: string);
    close(): void;
    exec(sql: string): void;
    query<T = unknown>(sql: string): Statement<T>;
    prepare<T = unknown>(sql: string): Statement<T>;
    transaction<T>(fn: () => T): () => T;
  }

  export class Statement<T = unknown> {
    run(
      ...params: unknown[]
    ): { changes: number; lastInsertRowid: number | bigint | null };
    get(...params: unknown[]): T | null;
    all(...params: unknown[]): T[];
    values(...params: unknown[]): unknown[][];
    finalize(): void;
  }
}

declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function expect<T>(value: T): Matchers<T>;

  interface Matchers<T> {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string | RegExp | Error): void;
    not: Matchers<T>;
  }
}

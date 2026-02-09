// Type declarations for bun:sqlite when running tsgo (which doesn't fully support bun-types)
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

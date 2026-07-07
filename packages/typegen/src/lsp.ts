/**
 * `syncular lsp` — a minimal `.syql` language server (DESIGN-queries.md
 * §10, staged Q5). Zero dependencies: hand-rolled JSON-RPC over stdio with
 * Content-Length framing, and the SAME parser/checker the generator runs —
 * diagnostics are generate-time truth, not a re-implementation.
 *
 * Capabilities:
 * - diagnostics (on open/change): parse errors, lowering errors (B1,
 *   knob conflicts), and — when a `syncular.json` is found above the file —
 *   the full SQLite-checked analysis (types, unknown columns, naming
 *   collisions).
 * - hover: a query name shows its lowered, checked SQL (what actually
 *   runs); an `@fragment` ref shows the fragment body.
 * - definition: an `@fragment` ref jumps to its declaration (same file —
 *   fragments are file-scoped).
 *
 * The server core is a pure(ish) class (`SyqlLanguageServer.handle`)
 * so tests drive it without stdio; `runLspStdio` is the thin transport.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { TypegenError } from './errors';
import { buildIr, loadMigrations, makeQueryDb } from './generate';
import type { IrDocument } from './ir';
import { MANIFEST_FILENAME, parseManifest } from './manifest';
import type { QueryDb, QueryNamingOptions } from './query';
import { analyzeSyqlFile, parseSyqlFile } from './syql';

// ---------------------------------------------------------------------------
// JSON-RPC / LSP shapes (the subset we speak)
// ---------------------------------------------------------------------------

export interface RpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | undefined;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Position {
  line: number;
  character: number;
}

interface Range {
  start: Position;
  end: Position;
}

interface Diagnostic {
  range: Range;
  severity: number; // 1 = error
  source: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Text/position helpers
// ---------------------------------------------------------------------------

function offsetToPosition(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

function positionToOffset(text: string, position: Position): number {
  let line = 0;
  let i = 0;
  while (i < text.length && line < position.line) {
    if (text[i] === '\n') line += 1;
    i += 1;
  }
  return Math.min(text.length, i + position.character);
}

/** The `@word` / `word` under the cursor, with its range. */
function wordAt(
  text: string,
  offset: number,
): { word: string; start: number; end: number } | null {
  const isWord = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_@]/.test(ch);
  if (!isWord(text[offset]) && !isWord(text[offset - 1])) return null;
  let start = isWord(text[offset]) ? offset : offset - 1;
  while (start > 0 && isWord(text[start - 1])) start -= 1;
  let end = start;
  while (end < text.length && isWord(text[end])) end += 1;
  return { word: text.slice(start, end), start, end };
}

function uriToPath(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
}

// ---------------------------------------------------------------------------
// Project context (manifest discovery, cached per directory)
// ---------------------------------------------------------------------------

interface ProjectContext {
  readonly ir: IrDocument;
  readonly db: QueryDb;
  readonly naming: QueryNamingOptions;
  readonly manifestDir: string;
}

function findManifestDir(fromPath: string): string | null {
  let dir = dirname(fromPath);
  for (let i = 0; i < 20; i++) {
    if (existsSync(resolve(dir, MANIFEST_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export class SyqlLanguageServer {
  readonly #documents = new Map<string, string>();
  #contexts = new Map<string, ProjectContext | null>();

  /** Handle one incoming message; returns the outgoing messages. */
  handle(message: RpcMessage): RpcMessage[] {
    const { method, id } = message;
    if (method === 'initialize') {
      return [
        {
          jsonrpc: '2.0',
          id,
          result: {
            capabilities: {
              textDocumentSync: 1, // full
              hoverProvider: true,
              definitionProvider: true,
            },
            serverInfo: { name: 'syncular-syql-lsp', version: '0.0.1' },
          },
        },
      ];
    }
    if (method === 'textDocument/didOpen') {
      const params = message.params as {
        textDocument: { uri: string; text: string };
      };
      this.#documents.set(params.textDocument.uri, params.textDocument.text);
      return [this.#publishDiagnostics(params.textDocument.uri)];
    }
    if (method === 'textDocument/didChange') {
      const params = message.params as {
        textDocument: { uri: string };
        contentChanges: { text: string }[];
      };
      const last = params.contentChanges[params.contentChanges.length - 1];
      if (last !== undefined) {
        this.#documents.set(params.textDocument.uri, last.text);
      }
      return [this.#publishDiagnostics(params.textDocument.uri)];
    }
    if (method === 'textDocument/didClose') {
      const params = message.params as { textDocument: { uri: string } };
      this.#documents.delete(params.textDocument.uri);
      return [];
    }
    if (method === 'textDocument/hover') {
      return [{ jsonrpc: '2.0', id, result: this.#hover(message.params) }];
    }
    if (method === 'textDocument/definition') {
      return [{ jsonrpc: '2.0', id, result: this.#definition(message.params) }];
    }
    if (method === 'shutdown') {
      return [{ jsonrpc: '2.0', id, result: null }];
    }
    if (id !== undefined && method !== undefined) {
      return [
        {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `unhandled method ${method}` },
        },
      ];
    }
    return [];
  }

  /** Reset cached manifest contexts (e.g. after schema edits). */
  invalidateProjects(): void {
    this.#contexts = new Map();
  }

  #context(uri: string): ProjectContext | null {
    const path = uriToPath(uri);
    const manifestDir = findManifestDir(path);
    if (manifestDir === null) return null;
    const cached = this.#contexts.get(manifestDir);
    if (cached !== undefined) return cached;
    try {
      const manifest = parseManifest(
        JSON.parse(
          readFileSync(resolve(manifestDir, MANIFEST_FILENAME), 'utf8'),
        ),
      );
      const migrations = loadMigrations(
        resolve(manifestDir, manifest.migrations),
      );
      const ir = buildIr(manifest, migrations);
      const { db } = makeQueryDb(ir);
      const targets: QueryNamingOptions['targets'] = ['ts'];
      const context: ProjectContext = {
        ir,
        db,
        manifestDir,
        naming: {
          naming: manifest.naming,
          targets,
          backend: manifest.queryBackend,
        },
      };
      this.#contexts.set(manifestDir, context);
      return context;
    } catch {
      this.#contexts.set(manifestDir, null);
      return null;
    }
  }

  #publishDiagnostics(uri: string): RpcMessage {
    const text = this.#documents.get(uri) ?? '';
    const diagnostics = this.#diagnose(uri, text);
    return {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics },
    };
  }

  #diagnose(uri: string, text: string): Diagnostic[] {
    const path = uriToPath(uri);
    const context = this.#context(uri);
    try {
      if (context !== null) {
        // The full generate-time analysis: parse + lower + SQLite check.
        const rel = relative(context.manifestDir, path).split('\\').join('/');
        analyzeSyqlFile(rel, text, context.ir, context.db, context.naming);
      } else {
        // No manifest reachable: parser + lowering only.
        const parsed = parseSyqlFile(path, text);
        void parsed;
      }
      return [];
    } catch (error) {
      return [this.#errorToDiagnostic(error, text)];
    }
  }

  #errorToDiagnostic(error: unknown, text: string): Diagnostic {
    const message = error instanceof Error ? error.message : String(error);
    let range: Range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    };
    if (error instanceof TypegenError) {
      // Cursor errors carry `file:line`; lowering errors carry
      // `file (query name)` — anchor those at the declaration.
      const lineMatch = /:(\d+): /.exec(message);
      const queryMatch = /\(query ([A-Za-z][A-Za-z0-9]*)\)/.exec(message);
      if (lineMatch !== null) {
        const line = Number.parseInt(lineMatch[1] as string, 10) - 1;
        range = {
          start: { line, character: 0 },
          end: { line, character: 200 },
        };
      } else if (queryMatch !== null) {
        try {
          const parsed = parseSyqlFile('doc', text);
          const decl = parsed.queries.find((q) => q.name === queryMatch[1]);
          if (decl !== undefined) {
            const start = offsetToPosition(text, decl.offset);
            range = {
              start,
              end: { line: start.line, character: start.character + 200 },
            };
          }
        } catch {
          // fall through to line 0
        }
      }
    }
    return { range, severity: 1, source: 'syncular', message };
  }

  #hover(params: unknown): unknown {
    const p = params as {
      textDocument: { uri: string };
      position: Position;
    };
    const text = this.#documents.get(p.textDocument.uri);
    if (text === undefined) return null;
    const offset = positionToOffset(text, p.position);
    const found = wordAt(text, offset);
    if (found === null) return null;

    let parsed: ReturnType<typeof parseSyqlFile>;
    try {
      parsed = parseSyqlFile('doc', text);
    } catch {
      return null;
    }

    // `@fragment` ref → the fragment's body.
    if (found.word.startsWith('@')) {
      const fragment = parsed.fragments.find(
        (f) => f.name === found.word.slice(1),
      );
      if (fragment === undefined) return null;
      return {
        contents: {
          kind: 'markdown',
          value: `\`\`\`sql\n${fragment.body}\n\`\`\``,
        },
      };
    }

    // A query name → the lowered, checked SQL (needs the project schema).
    const query = parsed.queries.find((q) => q.name === found.word);
    if (query !== undefined) {
      const context = this.#context(p.textDocument.uri);
      if (context === null) return null;
      try {
        const analyzed = analyzeSyqlFile(
          'doc.syql',
          text,
          context.ir,
          context.db,
          context.naming,
        ).find((q) => q.name === found.word);
        if (analyzed === undefined) return null;
        const lines = [
          '```sql',
          analyzed.sql,
          '```',
          '',
          `tables: ${analyzed.tables.join(', ')}`,
          ...(analyzed.variants !== undefined
            ? [`variants: ${analyzed.variants.length} enumerated statements`]
            : []),
        ];
        return { contents: { kind: 'markdown', value: lines.join('\n') } };
      } catch {
        return null;
      }
    }
    return null;
  }

  #definition(params: unknown): unknown {
    const p = params as {
      textDocument: { uri: string };
      position: Position;
    };
    const text = this.#documents.get(p.textDocument.uri);
    if (text === undefined) return null;
    const offset = positionToOffset(text, p.position);
    const found = wordAt(text, offset);
    if (found === null || !found.word.startsWith('@')) return null;
    let parsed: ReturnType<typeof parseSyqlFile>;
    try {
      parsed = parseSyqlFile('doc', text);
    } catch {
      return null;
    }
    const fragment = parsed.fragments.find(
      (f) => f.name === found.word.slice(1),
    );
    if (fragment === undefined) return null;
    const start = offsetToPosition(text, fragment.offset);
    return {
      uri: p.textDocument.uri,
      range: {
        start,
        end: {
          line: start.line,
          character:
            start.character + 'fragment '.length + fragment.name.length,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// stdio transport (Content-Length framing)
// ---------------------------------------------------------------------------

/** Run the language server over stdio until `exit`. */
export async function runLspStdio(): Promise<void> {
  const server = new SyqlLanguageServer();
  let buffer = Buffer.alloc(0);
  const write = (message: RpcMessage): void => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    process.stdout.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
        body,
      ]),
    );
  };
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatch = /Content-Length: (\d+)/i.exec(header);
      if (lengthMatch === null) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(lengthMatch[1] as string, 10);
      if (buffer.length < headerEnd + 4 + length) break;
      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
      buffer = buffer.subarray(headerEnd + 4 + length);
      let message: RpcMessage;
      try {
        message = JSON.parse(body.toString('utf8')) as RpcMessage;
      } catch {
        continue;
      }
      if (message.method === 'exit') return;
      for (const outgoing of server.handle(message)) write(outgoing);
    }
  }
}

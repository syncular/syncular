/** Revision-1 SYQL language server backed by the compiler frontend (§21). */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TypegenError } from './errors';
import { formatSyql } from './fmt';
import { buildIr, loadMigrations, loadQueries, makeQueryDb } from './generate';
import type { IrDocument } from './ir';
import { MANIFEST_FILENAME, parseManifest } from './manifest';
import { lockedMigrationNames, readMigrationLock } from './migration-lock';
import type { QueryDb, QueryNamingOptions } from './query';
import { SyqlFrontendError, type SyqlSourceSpan } from './syql-lexer';
import type { SyqlLoweredQuery } from './syql-lowering';
import { lowerSyqlQuery } from './syql-lowering';
import { buildSyqlModuleGraph } from './syql-modules';
import {
  parseSyqlSyntaxFile,
  type SyqlQueryParameter,
  type SyqlSyntaxFile,
  type SyqlValueType,
} from './syql-parser';
import {
  analyzeSyqlSemantics,
  type SyqlSemanticProgram,
} from './syql-semantics';
import { validateSyqlProgram } from './syql-validator';

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
  severity: number;
  source: string;
  code?: string;
  message: string;
}

interface ProjectContext {
  readonly ir: IrDocument;
  readonly db: QueryDb;
  readonly naming: QueryNamingOptions;
  readonly manifestDir: string;
  readonly queriesRoot: string;
}

type ProjectLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'ready'; readonly context: ProjectContext }
  | { readonly kind: 'error'; readonly error: unknown };

interface CompilerView {
  readonly root: string;
  readonly file: string;
  readonly module: SyqlSyntaxFile;
  readonly semantic: SyqlSemanticProgram;
  readonly lowered: readonly SyqlLoweredQuery[];
}

function offsetToPosition(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

function positionToOffset(text: string, position: Position): number {
  let line = 0;
  let index = 0;
  while (index < text.length && line < position.line) {
    if (text[index] === '\n') line += 1;
    index += 1;
  }
  return Math.min(text.length, index + position.character);
}

function wordAt(
  text: string,
  offset: number,
): {
  readonly word: string;
  readonly start: number;
  readonly end: number;
} | null {
  const isWord = (character: string | undefined): boolean =>
    character !== undefined && /[A-Za-z0-9_@]/.test(character);
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

function findManifestDir(fromPath: string): string | null {
  let directory = dirname(fromPath);
  for (let count = 0; count < 20; count += 1) {
    if (existsSync(resolve(directory, MANIFEST_FILENAME))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

function isWithin(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function spanRange(text: string, span: SyqlSourceSpan): Range {
  const start = offsetToPosition(text, span.start.offset);
  const end = offsetToPosition(text, span.end.offset);
  return {
    start,
    end:
      end.line === start.line && end.character === start.character
        ? { line: end.line, character: end.character + 1 }
        : end,
  };
}

function typeText(type: SyqlValueType | undefined): string {
  return type === undefined
    ? 'inferred'
    : `${type.base === 'boolean' ? 'bool' : type.base}${type.nullable ? ' | null' : ''}`;
}

function parameterHover(parameter: SyqlQueryParameter): string {
  if (parameter.kind === 'range') {
    return `${parameter.optional ? 'optional' : 'required'} inclusive range \`${parameter.name}: range<${typeText(parameter.type)}>\``;
  }
  if (parameter.kind === 'group') {
    return `optional group \`${parameter.name}\`\n\n${parameter.members
      .map((member) => `- \`${member.name}: ${typeText(member.type)}\``)
      .join('\n')}`;
  }
  return `${parameter.optional ? 'optional' : parameter.default === false ? 'default-false' : 'required'} input \`${parameter.name}: ${typeText(parameter.type)}\``;
}

export class SyqlLanguageServer {
  readonly #documents = new Map<string, string>();
  #contexts = new Map<string, ProjectLookup>();

  handle(message: RpcMessage): RpcMessage[] {
    const { method, id } = message;
    if (method === 'initialize') {
      return [
        {
          jsonrpc: '2.0',
          id,
          result: {
            capabilities: {
              textDocumentSync: 1,
              hoverProvider: true,
              definitionProvider: true,
              referencesProvider: true,
              documentSymbolProvider: true,
              documentFormattingProvider: true,
            },
            serverInfo: { name: 'syncular-syql-lsp', version: '1.0.0' },
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
      const last = params.contentChanges.at(-1);
      if (last !== undefined)
        this.#documents.set(params.textDocument.uri, last.text);
      return [this.#publishDiagnostics(params.textDocument.uri)];
    }
    if (method === 'textDocument/didClose') {
      const params = message.params as { textDocument: { uri: string } };
      this.#documents.delete(params.textDocument.uri);
      return [];
    }
    if (method === 'workspace/didChangeWatchedFiles') {
      this.invalidateProjects();
      return [...this.#documents.keys()].map((uri) =>
        this.#publishDiagnostics(uri),
      );
    }
    if (method === 'textDocument/hover') {
      return [{ jsonrpc: '2.0', id, result: this.#hover(message.params) }];
    }
    if (method === 'textDocument/definition') {
      return [{ jsonrpc: '2.0', id, result: this.#definition(message.params) }];
    }
    if (method === 'textDocument/references') {
      return [{ jsonrpc: '2.0', id, result: this.#references(message.params) }];
    }
    if (method === 'textDocument/documentSymbol') {
      return [{ jsonrpc: '2.0', id, result: this.#symbols(message.params) }];
    }
    if (method === 'textDocument/formatting') {
      return [{ jsonrpc: '2.0', id, result: this.#formatting(message.params) }];
    }
    if (method === 'shutdown') return [{ jsonrpc: '2.0', id, result: null }];
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

  invalidateProjects(): void {
    this.#contexts = new Map();
  }

  #context(uri: string): ProjectLookup {
    const path = uriToPath(uri);
    const manifestDir = findManifestDir(path);
    if (manifestDir === null) return { kind: 'none' };
    const cached = this.#contexts.get(manifestDir);
    if (cached !== undefined) return cached;
    try {
      const manifest = parseManifest(
        JSON.parse(
          readFileSync(resolve(manifestDir, MANIFEST_FILENAME), 'utf8'),
        ),
      );
      // Tolerate locked history exactly like generation does; a project with
      // no readable lock builds strictly.
      let lockedNames: ReadonlySet<string> | undefined;
      try {
        lockedNames = lockedMigrationNames(readMigrationLock(manifestDir));
      } catch {
        lockedNames = undefined;
      }
      const ir = buildIr(
        manifest,
        loadMigrations(resolve(manifestDir, manifest.migrations)),
        lockedNames,
      );
      const { db } = makeQueryDb(ir);
      const targets: QueryNamingOptions['targets'][number][] = ['ts'];
      if (manifest.output.swift !== undefined) targets.push('swift');
      if (manifest.output.kotlin !== undefined) targets.push('kotlin');
      if (manifest.output.dart !== undefined) targets.push('dart');
      if (manifest.output.rust !== undefined) targets.push('rust');
      const lookup: ProjectLookup = {
        kind: 'ready',
        context: {
          ir,
          db,
          manifestDir,
          queriesRoot: resolve(manifestDir, manifest.queries),
          naming: {
            naming: manifest.naming,
            targets,
            backend: manifest.queryBackend,
          },
        },
      };
      this.#contexts.set(manifestDir, lookup);
      return lookup;
    } catch (error) {
      const lookup: ProjectLookup = { kind: 'error', error };
      this.#contexts.set(manifestDir, lookup);
      return lookup;
    }
  }

  #openText(file: string): string | undefined {
    for (const [uri, text] of this.#documents) {
      if (resolve(uriToPath(uri)) === resolve(file)) return text;
    }
    return undefined;
  }

  #compilerView(uri: string, text: string): CompilerView {
    const file = resolve(uriToPath(uri));
    const lookup = this.#context(uri);
    if (lookup.kind === 'error') throw lookup.error;
    const project = lookup.kind === 'ready' ? lookup.context : undefined;
    const root =
      project !== undefined && isWithin(project.queriesRoot, file)
        ? project.queriesRoot
        : dirname(file);
    const sourceByFile = new Map<string, string>();
    const entries: string[] = [];
    if (project !== undefined && root === project.queriesRoot) {
      for (const input of loadQueries(root)) {
        if (!input.file.endsWith('.syql')) continue;
        const absolute = resolve(root, input.file);
        sourceByFile.set(absolute, this.#openText(absolute) ?? input.sql);
        entries.push(input.file);
      }
    }
    sourceByFile.set(file, text);
    const currentEntry = relative(root, file).split(sep).join('/');
    if (!entries.includes(currentEntry)) entries.push(currentEntry);
    entries.sort();
    const graph = buildSyqlModuleGraph(root, entries, (candidate) => {
      const open = this.#openText(candidate);
      if (open !== undefined) return open;
      const loaded = sourceByFile.get(candidate);
      if (loaded !== undefined) return loaded;
      return existsSync(candidate)
        ? readFileSync(candidate, 'utf8')
        : undefined;
    });
    const semantic = analyzeSyqlSemantics(graph);
    const module = graph.moduleByPath.get(file);
    if (module === undefined)
      throw new TypegenError(file, 'current SYQL module missing');
    const lowered =
      project === undefined
        ? []
        : validateSyqlProgram(
            semantic,
            project.ir,
            project.db,
            project.naming,
          ).queries.map((query) =>
            lowerSyqlQuery(query, project.ir, project.db, project.naming),
          );
    return { root, file, module, semantic, lowered };
  }

  #publishDiagnostics(uri: string): RpcMessage {
    const text = this.#documents.get(uri) ?? '';
    return {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: this.#diagnose(uri, text) },
    };
  }

  #diagnose(uri: string, text: string): Diagnostic[] {
    try {
      this.#compilerView(uri, text);
      return [];
    } catch (error) {
      return [this.#errorToDiagnostic(error, text, resolve(uriToPath(uri)))];
    }
  }

  #errorToDiagnostic(error: unknown, text: string, file: string): Diagnostic {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof SyqlFrontendError &&
      resolve(error.sourceFile) === file
    ) {
      return {
        range: spanRange(text, error.span),
        severity: 1,
        source: 'syncular',
        code: error.code,
        message: error.detail,
      };
    }
    return {
      range: {
        start: { line: 0, character: 0 },
        end: {
          line: 0,
          character: Math.max(1, text.split('\n')[0]?.length ?? 1),
        },
      },
      severity: 1,
      source: 'syncular',
      ...(error instanceof SyqlFrontendError ? { code: error.code } : {}),
      message:
        this.#context(pathToFileURL(file).href).kind === 'error'
          ? `SYQL9001_PROJECT_CONTEXT: ${message}`
          : message,
    };
  }

  #request(params: unknown): {
    readonly uri: string;
    readonly text: string;
    readonly offset: number;
    readonly found: NonNullable<ReturnType<typeof wordAt>>;
    readonly view: CompilerView;
  } | null {
    const request = params as {
      textDocument: { uri: string };
      position: Position;
    };
    const text = this.#documents.get(request.textDocument.uri);
    if (text === undefined) return null;
    const offset = positionToOffset(text, request.position);
    const found = wordAt(text, offset);
    if (found === null) return null;
    try {
      return {
        uri: request.textDocument.uri,
        text,
        offset,
        found,
        view: this.#compilerView(request.textDocument.uri, text),
      };
    } catch {
      return null;
    }
  }

  #hover(params: unknown): unknown {
    const request = this.#request(params);
    if (request === null) return null;
    const { found, view, offset } = request;
    const predicate = view.semantic.predicateScopes
      .get(view.file)
      ?.get(found.word);
    if (predicate !== undefined) {
      return {
        contents: {
          kind: 'markdown',
          value: `predicate \`${predicate.declaration.name}\` from \`${relative(view.root, predicate.module.file)}\`\n\n\`\`\`sql\n${predicate.declaration.body.text.trim()}\n\`\`\``,
        },
      };
    }
    const query = view.module.queries.find(
      (candidate) =>
        offset >= candidate.span.start.offset &&
        offset <= candidate.span.end.offset,
    );
    if (query !== undefined) {
      const parameter = query.parameters.find(
        (candidate) => candidate.name === found.word,
      );
      if (parameter !== undefined) {
        return {
          contents: { kind: 'markdown', value: parameterHover(parameter) },
        };
      }
      if (query.sort?.control === found.word) {
        return {
          contents: {
            kind: 'markdown',
            value: `sort control \`${found.word}\`; default profile \`${query.sort.defaultProfile}\``,
          },
        };
      }
      const profile = query.sort?.profiles.find(
        (candidate) => candidate.name === found.word,
      );
      if (profile !== undefined) {
        return {
          contents: {
            kind: 'markdown',
            value: `sort profile \`${profile.name}\`\n\n\`\`\`sql\n${profile.order.text.trim()}\n\`\`\``,
          },
        };
      }
      if (query.limit?.control === found.word) {
        return {
          contents: {
            kind: 'markdown',
            value: `limit control \`${found.word}\`: default ${query.limit.defaultSize}, maximum ${query.limit.maxSize}`,
          },
        };
      }
    }
    if (query?.name === found.word) {
      const lowered = view.lowered.find(
        (candidate) => candidate.validated.logical.declaration === query,
      );
      if (lowered === undefined) return null;
      const defaultStatement = lowered.selected.statements.find(
        (statement) =>
          (statement.activationMask === undefined ||
            statement.activationMask === 0) &&
          (lowered.validated.sort === undefined ||
            statement.sortProfile === lowered.validated.sort.defaultProfile),
      );
      return {
        contents: {
          kind: 'markdown',
          value: [
            `backend: **${lowered.selected.backend}** (${lowered.selected.statements.length} checked statement${lowered.selected.statements.length === 1 ? '' : 's'})`,
            '',
            '```sql',
            defaultStatement?.sql ?? lowered.analysis.sql,
            '```',
            '',
            `tables: ${lowered.analysis.tables.join(', ')}`,
          ].join('\n'),
        },
      };
    }
    return null;
  }

  #definition(params: unknown): unknown {
    const request = this.#request(params);
    if (request === null) return null;
    const predicate = request.view.semantic.predicateScopes
      .get(request.view.file)
      ?.get(request.found.word);
    if (predicate === undefined) return null;
    const text =
      this.#openText(predicate.module.file) ?? predicate.module.source;
    return {
      uri: pathToFileURL(predicate.module.file).href,
      range: spanRange(text, predicate.declaration.nameSpan),
    };
  }

  #references(params: unknown): unknown {
    const request = this.#request(params);
    if (request === null) return [];
    const target = request.view.semantic.predicateScopes
      .get(request.view.file)
      ?.get(request.found.word);
    if (target === undefined) return [];
    const locations: unknown[] = [];
    for (const module of request.view.semantic.graph.modules) {
      const scope = request.view.semantic.predicateScopes.get(module.file);
      for (const token of module.tokens) {
        if (token.kind !== 'identifier') continue;
        const resolved = scope?.get(token.text);
        if (resolved?.id !== target.id) continue;
        locations.push({
          uri: pathToFileURL(module.file).href,
          range: spanRange(module.source, token.span),
        });
      }
    }
    return locations;
  }

  #symbols(params: unknown): unknown {
    const request = params as { textDocument: { uri: string } };
    const text = this.#documents.get(request.textDocument.uri);
    if (text === undefined) return [];
    try {
      const parsed = parseSyqlSyntaxFile(
        uriToPath(request.textDocument.uri),
        text,
      );
      return parsed.declarations.map((declaration) => ({
        name: declaration.name,
        kind: declaration.kind === 'query' ? 12 : 12,
        range: spanRange(text, declaration.span),
        selectionRange: spanRange(text, declaration.nameSpan),
      }));
    } catch {
      return [];
    }
  }

  #formatting(params: unknown): unknown {
    const request = params as { textDocument: { uri: string } };
    const text = this.#documents.get(request.textDocument.uri);
    if (text === undefined) return [];
    try {
      const formatted = formatSyql(uriToPath(request.textDocument.uri), text);
      if (formatted === text) return [];
      return [
        {
          range: {
            start: { line: 0, character: 0 },
            end: offsetToPosition(text, text.length),
          },
          newText: formatted,
        },
      ];
    } catch {
      return [];
    }
  }
}

/** Run the LSP over Content-Length-framed JSON-RPC stdio. */
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
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer
        .subarray(bodyStart, bodyStart + length)
        .toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      let incoming: RpcMessage;
      try {
        incoming = JSON.parse(body) as RpcMessage;
      } catch {
        write({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'parse error' },
        });
        continue;
      }
      for (const outgoing of server.handle(incoming)) write(outgoing);
      if (incoming.method === 'exit') return;
    }
  }
}

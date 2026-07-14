import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type RpcMessage, SyqlLanguageServer } from '../src';

const FIXTURE = join(import.meta.dir, 'fixtures', 'basic');
const PATH = join(FIXTURE, 'queries', 'lsp-probe.syql');
const URI = pathToFileURL(PATH).href;
const IMPORTED_URI = pathToFileURL(
  join(FIXTURE, 'queries', 'task-search.syql'),
).href;

const GOOD = `import { searchTitle } from "./task-search.syql";

query probeTasks(projectId, needle?: string, minPriority?) {

    select id, title, priority from tasks
    where tasks.project_id = :projectId
      and when(needle) { searchTitle(:needle) }
      and when(minPriority) { priority >= :minPriority }
  ;
}
`;

function open(server: SyqlLanguageServer, text: string): RpcMessage[] {
  return server.handle({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: URI, text } },
  });
}

function positionOf(
  source: string,
  needle: string,
): {
  line: number;
  character: number;
} {
  const offset = source.indexOf(needle);
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: (lines.at(-1)?.length ?? 0) + 2 };
}

describe('revision-1 SyqlLanguageServer', () => {
  test('advertises compiler-backed authoring capabilities', () => {
    const [response] = new SyqlLanguageServer().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const capabilities = (
      response?.result as { capabilities: Record<string, unknown> }
    ).capabilities;
    expect(capabilities).toMatchObject({
      textDocumentSync: 1,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
    });
  });

  test('runs the full import, schema, semantic, and SQLite pipeline', () => {
    const [notification] = open(new SyqlLanguageServer(), GOOD);
    expect(notification?.method).toBe('textDocument/publishDiagnostics');
    expect(
      (notification?.params as { diagnostics: unknown[] }).diagnostics,
    ).toEqual([]);
  });

  test('publishes stable codes and exact source spans', () => {
    const server = new SyqlLanguageServer();
    const badSql = GOOD.replace('title, priority', 'title, no_such_column');
    const [sqlNotification] = open(server, badSql);
    const sqlDiagnostic = (
      sqlNotification?.params as {
        diagnostics: Array<{
          code?: string;
          message: string;
          range: { start: { line: number } };
        }>;
      }
    ).diagnostics[0];
    expect(sqlDiagnostic?.code).toBe('SYQL6002_INVALID_SQL');
    expect(sqlDiagnostic?.message).toContain('no such column');
    expect(sqlDiagnostic?.range.start.line).toBeGreaterThan(1);

    const [parseNotification] = open(
      new SyqlLanguageServer(),
      'query broken(a) {  select id from tasks ;',
    );
    const parseDiagnostic = (
      parseNotification?.params as {
        diagnostics: Array<{ code?: string; range: { start: Position } }>;
      }
    ).diagnostics[0];
    expect(parseDiagnostic?.code).toBe('SYQL2001_EXPECTED_TOKEN');
    expect(parseDiagnostic?.range.start.character).toBeGreaterThan(0);
  });

  test('didChange and watched project files trigger fresh diagnostics', () => {
    const server = new SyqlLanguageServer();
    open(server, GOOD);
    const [changed] = server.handle({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: URI },
        contentChanges: [{ text: 'query broken( {' }],
      },
    });
    expect(
      (changed?.params as { diagnostics: unknown[] }).diagnostics,
    ).toHaveLength(1);
    const watched = server.handle({
      jsonrpc: '2.0',
      method: 'workspace/didChangeWatchedFiles',
      params: { changes: [] },
    });
    expect(watched).toHaveLength(1);
  });

  test('query/input/profile hover exposes logical and physical facts', () => {
    const server = new SyqlLanguageServer();
    open(server, GOOD);
    const hover = (needle: string): string | undefined => {
      const [response] = server.handle({
        jsonrpc: '2.0',
        id: needle,
        method: 'textDocument/hover',
        params: {
          textDocument: { uri: URI },
          position: positionOf(GOOD, needle),
        },
      });
      return (response?.result as { contents: { value: string } } | null)
        ?.contents.value;
    };
    expect(hover('probeTasks')).toContain('backend: **variants** (4 checked');
    expect(hover('probeTasks')).toContain('tables: tasks');
    expect(hover('minPriority')).toContain('optional input');
  });

  test('imported predicate hover, definition, and references resolve hygienically', () => {
    const server = new SyqlLanguageServer();
    open(server, GOOD);
    const position = positionOf(GOOD, 'searchTitle');
    const [hover] = server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/hover',
      params: { textDocument: { uri: URI }, position },
    });
    expect(
      (hover?.result as { contents: { value: string } }).contents.value,
    ).toContain("title like '%' || :needle || '%'");

    const [definition] = server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'textDocument/definition',
      params: { textDocument: { uri: URI }, position },
    });
    expect((definition?.result as { uri: string }).uri).toBe(IMPORTED_URI);

    const [references] = server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'textDocument/references',
      params: { textDocument: { uri: URI }, position, context: {} },
    });
    expect((references?.result as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  test('document symbols and formatting use the revision-1 AST', () => {
    const server = new SyqlLanguageServer();
    open(server, GOOD);
    const [symbols] = server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'textDocument/documentSymbol',
      params: { textDocument: { uri: URI } },
    });
    expect(symbols?.result).toMatchObject([{ name: 'probeTasks' }]);

    const messy = GOOD.replace('query probeTasks', 'query   probeTasks');
    open(server, messy);
    const [formatting] = server.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'textDocument/formatting',
      params: { textDocument: { uri: URI }, options: {} },
    });
    const edits = formatting?.result as Array<{ newText: string }>;
    expect(edits[0]?.newText).toContain('query probeTasks(');
  });

  test('unknown request methods answer method-not-found', () => {
    const [response] = new SyqlLanguageServer().handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'textDocument/completion',
      params: {},
    });
    expect(response?.error?.code).toBe(-32601);
  });
});

interface Position {
  line: number;
  character: number;
}

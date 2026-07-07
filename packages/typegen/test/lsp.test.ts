/**
 * The `.syql` language server (Q5): the server core is driven directly
 * (no stdio) — initialize, diagnostics from the REAL generate-time checks
 * (the basic fixture's manifest is discovered by walking up), hover shows
 * the lowered SQL, and @fragment definition resolves in-file.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type RpcMessage, SyqlLanguageServer } from '../src';

const FIXTURE = join(import.meta.dir, 'fixtures', 'basic');
const URI = `file://${join(FIXTURE, 'queries', 'lsp-probe.syql')}`;

const GOOD = `fragment inProject(projectId) {
  project_id = :projectId
}

query probeTasks(projectId, minPriority?) {
  select id, title, priority
  from tasks
  where @inProject(:projectId)
    and priority >= :minPriority
}
`;

function open(server: SyqlLanguageServer, text: string): RpcMessage[] {
  return server.handle({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: URI, text } },
  });
}

describe('SyqlLanguageServer', () => {
  test('initialize advertises sync + hover + definition', () => {
    const server = new SyqlLanguageServer();
    const [response] = server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const result = response?.result as {
      capabilities: Record<string, unknown>;
    };
    expect(result.capabilities.textDocumentSync).toBe(1);
    expect(result.capabilities.hoverProvider).toBe(true);
    expect(result.capabilities.definitionProvider).toBe(true);
  });

  test('a clean file publishes zero diagnostics (full schema check ran)', () => {
    const server = new SyqlLanguageServer();
    const [notification] = open(server, GOOD);
    expect(notification?.method).toBe('textDocument/publishDiagnostics');
    expect(
      (notification?.params as { diagnostics: unknown[] }).diagnostics,
    ).toEqual([]);
  });

  test('a schema error surfaces as a diagnostic anchored at the query', () => {
    const server = new SyqlLanguageServer();
    const [notification] = open(
      server,
      GOOD.replace('select id, title, priority', 'select id, no_such_column'),
    );
    const diagnostics = (
      notification?.params as {
        diagnostics: { message: string; range: { start: { line: number } } }[];
      }
    ).diagnostics;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('no such column');
    // Anchored at the `query probeTasks…` declaration line (0-indexed 4).
    expect(diagnostics[0]?.range.start.line).toBe(4);
  });

  test('a parse error carries its file:line position', () => {
    const server = new SyqlLanguageServer();
    const [notification] = open(
      server,
      'query broken(a?: string) {\n select 1\n}',
    );
    const diagnostics = (
      notification?.params as { diagnostics: { message: string }[] }
    ).diagnostics;
    expect(diagnostics[0]?.message).toContain('flag');
  });

  test('didChange re-diagnoses with the new text', () => {
    const server = new SyqlLanguageServer();
    open(server, GOOD);
    const [notification] = server.handle({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: URI },
        contentChanges: [{ text: 'query broken( {' }],
      },
    });
    expect(
      (notification?.params as { diagnostics: unknown[] }).diagnostics,
    ).toHaveLength(1);
  });

  test('hover on a query name shows the LOWERED sql + tables', () => {
    const server = new SyqlLanguageServer();
    open(server, GOOD);
    const line = GOOD.split('\n').findIndex((l) => l.startsWith('query '));
    const [response] = server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/hover',
      params: {
        textDocument: { uri: URI },
        position: { line, character: 'query pro'.length },
      },
    });
    const value = (response?.result as { contents: { value: string } } | null)
      ?.contents.value;
    expect(value).toContain(':minPriority is null or');
    expect(value).toContain('tables: tasks');
  });

  test('hover on an @fragment ref shows the fragment body', () => {
    const server = new SyqlLanguageServer();
    open(server, GOOD);
    const line = GOOD.split('\n').findIndex((l) => l.includes('@inProject'));
    const character =
      (GOOD.split('\n')[line] as string).indexOf('@inProject') + 2;
    const [response] = server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'textDocument/hover',
      params: { textDocument: { uri: URI }, position: { line, character } },
    });
    const value = (response?.result as { contents: { value: string } } | null)
      ?.contents.value;
    expect(value).toContain('project_id = :projectId');
  });

  test('definition on an @fragment ref jumps to the declaration', () => {
    const server = new SyqlLanguageServer();
    open(server, GOOD);
    const line = GOOD.split('\n').findIndex((l) => l.includes('@inProject'));
    const character =
      (GOOD.split('\n')[line] as string).indexOf('@inProject') + 2;
    const [response] = server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'textDocument/definition',
      params: { textDocument: { uri: URI }, position: { line, character } },
    });
    const location = response?.result as {
      uri: string;
      range: { start: { line: number } };
    } | null;
    expect(location?.uri).toBe(URI);
    expect(location?.range.start.line).toBe(0); // fragment declared on line 1
  });

  test('unknown request methods answer method-not-found', () => {
    const server = new SyqlLanguageServer();
    const [response] = server.handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'textDocument/completion',
      params: {},
    });
    expect(response?.error?.code).toBe(-32601);
  });
});

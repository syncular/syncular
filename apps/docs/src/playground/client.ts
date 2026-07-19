import { shikiToMonaco } from '@shikijs/monaco';
import * as monaco from 'monaco-editor-core';
import EditorWorker from 'monaco-editor-core/esm/vs/editor/common/services/editorWebWorkerMain.js?worker';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import syqlLanguageConfiguration from '../../../../editors/vscode-syql/language-configuration.json';
import { SYQL_HIGHLIGHTER_LANGUAGES } from '../syql-highlighting';
import { type SyqlCompletionKind, syqlCompletions } from './completions';
import {
  PLAYGROUND_EXAMPLES,
  PLAYGROUND_SCHEMAS,
  type PlaygroundExample,
  playgroundExample,
  schemaSummary,
} from './examples';
import type {
  PlaygroundDiagnostic,
  PlaygroundQuery,
  PlaygroundStatement,
  PlaygroundWorkerRequest,
  PlaygroundWorkerResponse,
} from './protocol';
import { SYNCULAR_MONACO_THEME } from './theme';

const MARKER_OWNER = 'syncular-syql-playground';
const COMPILE_DEBOUNCE_MS = 150;

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

interface MonacoEnvironmentShape {
  getWorker(_moduleId: string, _label: string): Worker;
}

const runtime = globalThis as typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironmentShape;
};
runtime.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

let editorSetup: Promise<Highlighter> | undefined;

function setupEditors(): Promise<Highlighter> {
  if (editorSetup !== undefined) return editorSetup;
  editorSetup = (async () => {
    if (!monaco.languages.getLanguages().some(({ id }) => id === 'syql')) {
      monaco.languages.register({ id: 'syql' });
    }
    if (!monaco.languages.getLanguages().some(({ id }) => id === 'sql')) {
      monaco.languages.register({ id: 'sql' });
    }
    monaco.languages.setLanguageConfiguration('syql', {
      comments: {
        lineComment: syqlLanguageConfiguration.comments.lineComment,
        blockComment: syqlLanguageConfiguration.comments.blockComment as [
          string,
          string,
        ],
      },
      brackets: syqlLanguageConfiguration.brackets as [string, string][],
      autoClosingPairs: syqlLanguageConfiguration.autoClosingPairs,
      surroundingPairs: (
        syqlLanguageConfiguration.surroundingPairs as [string, string][]
      ).map(([open, close]) => ({ open, close })),
    });
    const highlighter = (await createHighlighterCore({
      themes: [SYNCULAR_MONACO_THEME],
      langs: SYQL_HIGHLIGHTER_LANGUAGES,
      engine: createJavaScriptRegexEngine(),
    })) as Highlighter;
    shikiToMonaco(highlighter, monaco);
    return highlighter;
  })();
  return editorSetup;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null)
    throw new Error(`missing playground element ${selector}`);
  return element;
}

function replaceSelect(
  select: HTMLSelectElement,
  options: readonly { readonly value: string; readonly label: string }[],
  selected: string,
): void {
  select.replaceChildren(
    ...options.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === selected;
      return option;
    }),
  );
  select.disabled = options.length === 0;
}

function statementLabel(statement: PlaygroundStatement, index: number): string {
  const parts = [
    statement.sortProfile,
    statement.activationLabel === 'always'
      ? undefined
      : statement.activationLabel,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? `statement ${index + 1}` : parts.join(' · ');
}

function canonicalStatement(query: PlaygroundQuery): number {
  const found = query.statements.findIndex(
    (statement) =>
      (statement.activationMask === undefined ||
        statement.activationMask === 0) &&
      (query.defaultSortProfile === undefined ||
        statement.sortProfile === query.defaultSortProfile),
  );
  return found < 0 ? 0 : found;
}

function completionKind(
  kind: SyqlCompletionKind,
): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'column':
      return monaco.languages.CompletionItemKind.Field;
    case 'input':
      return monaco.languages.CompletionItemKind.Variable;
    case 'keyword':
      return monaco.languages.CompletionItemKind.Keyword;
    case 'qualifier':
      return monaco.languages.CompletionItemKind.Module;
    case 'snippet':
      return monaco.languages.CompletionItemKind.Snippet;
    case 'table':
      return monaco.languages.CompletionItemKind.Struct;
  }
}

function completionPriority(kind: SyqlCompletionKind): string {
  switch (kind) {
    case 'column':
      return '1';
    case 'input':
      return '2';
    case 'qualifier':
      return '3';
    case 'table':
      return '4';
    case 'snippet':
      return '5';
    case 'keyword':
      return '6';
  }
}

function planMetadata(
  query: PlaygroundQuery,
  statement: PlaygroundStatement,
): string {
  return JSON.stringify(
    {
      query: query.name,
      backend: query.backend,
      statement: {
        sortProfile: statement.sortProfile ?? null,
        activation: statement.activationLabel,
        activationMask: statement.activationMask ?? null,
      },
      inputs: query.inputs,
      binds: statement.binds,
      dependencies: query.dependencies,
      coverage: query.coverage,
      identity: query.identity ?? null,
    },
    null,
    2,
  );
}

class PlaygroundApp {
  readonly #root: HTMLElement;
  readonly #worker: Worker;
  readonly #sourceEditor: monaco.editor.IStandaloneCodeEditor;
  readonly #sqlEditor: monaco.editor.IStandaloneCodeEditor;
  readonly #models = new Map<string, monaco.editor.ITextModel>();
  readonly #sqlModel: monaco.editor.ITextModel;
  readonly #disposables: monaco.IDisposable[] = [];
  readonly #eventController = new AbortController();
  readonly #pendingFormats = new Map<
    number,
    { readonly exampleId: string; readonly version: number }
  >();
  readonly #exampleDescription: HTMLElement;
  readonly #querySelect: HTMLSelectElement;
  readonly #statementSelect: HTMLSelectElement;
  readonly #representationSelect: HTMLSelectElement;
  readonly #copyButton: HTMLButtonElement;
  readonly #backend: HTMLElement;
  readonly #statementCount: HTMLElement;
  readonly #status: HTMLElement;
  readonly #stale: HTMLElement;
  readonly #metadata: HTMLElement;
  readonly #diagnostics: HTMLOListElement;
  readonly #schemaSummary: HTMLElement;
  #activeExample: PlaygroundExample;
  #queries: readonly PlaygroundQuery[] = [];
  #queryIndex = 0;
  #statementIndex = 0;
  #requestId = 0;
  #latestCompileId = 0;
  #compileTimer: number | undefined;
  #lastSuccessfulSql = false;
  #disposed = false;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#activeExample = playgroundExample(
      new URL(location.href).searchParams.get('example'),
    );
    this.#exampleDescription = required(
      root,
      '#playground-example-description',
    );
    this.#querySelect = required(root, '#playground-query');
    this.#statementSelect = required(root, '#playground-statement');
    this.#representationSelect = required(root, '#playground-representation');
    this.#copyButton = required(root, '#playground-copy');
    this.#backend = required(root, '#playground-backend');
    this.#statementCount = required(root, '#playground-statement-count');
    this.#status = required(root, '#playground-status');
    this.#stale = required(root, '#playground-stale');
    this.#metadata = required(root, '#playground-metadata');
    this.#diagnostics = required(root, '#playground-diagnostics');
    this.#schemaSummary = required(root, '#playground-schema-summary');

    for (const example of PLAYGROUND_EXAMPLES) {
      this.#models.set(
        example.id,
        monaco.editor.createModel(
          example.source,
          'syql',
          monaco.Uri.parse(`inmemory://syncular/${example.id}.syql`),
        ),
      );
    }
    const sourceHost = required<HTMLElement>(root, '#playground-source');
    const sqlHost = required<HTMLElement>(root, '#playground-sql');
    sourceHost.replaceChildren();
    sqlHost.replaceChildren();
    this.#sourceEditor = monaco.editor.create(sourceHost, {
      model: this.#activeModel(),
      theme: 'syncular-dark',
      automaticLayout: true,
      accessibilitySupport: 'auto',
      ariaLabel: 'Editable SYQL source',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      padding: { top: 14, bottom: 14 },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'off',
      bracketPairColorization: { enabled: false },
      guides: { bracketPairs: true, indentation: false },
      fixedOverflowWidgets: true,
    });
    this.#sqlModel = monaco.editor.createModel(
      '-- waiting for the SYQL compiler…',
      'sql',
      monaco.Uri.parse('inmemory://syncular/generated.sql'),
    );
    this.#sqlEditor = monaco.editor.create(sqlHost, {
      model: this.#sqlModel,
      theme: 'syncular-dark',
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      accessibilitySupport: 'auto',
      ariaLabel: 'Generated SQL output',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      padding: { top: 14, bottom: 14 },
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      folding: false,
      lineNumbersMinChars: 3,
      renderLineHighlight: 'none',
      fixedOverflowWidgets: true,
    });

    this.#disposables.push(
      monaco.languages.registerCompletionItemProvider('syql', {
        triggerCharacters: ['.', ':'],
        provideCompletionItems: (model, position) => {
          if (model !== this.#activeModel()) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          const schema = PLAYGROUND_SCHEMAS[this.#activeExample.schemaId];
          const suggestions: monaco.languages.CompletionItem[] =
            syqlCompletions(
              model.getValue(),
              model.getOffsetAt(position),
              schema,
            ).map((completion) => ({
              label: completion.label,
              insertText: completion.insertText,
              kind: completionKind(completion.kind),
              detail: completion.detail,
              range,
              sortText: `${completionPriority(completion.kind)}-${completion.label}`,
              ...(completion.snippet === true
                ? {
                    insertTextRules:
                      monaco.languages.CompletionItemInsertTextRule
                        .InsertAsSnippet,
                  }
                : {}),
            }));
          return { suggestions };
        },
      }),
    );

    this.#worker = new Worker(
      new URL('./compiler.worker.ts', import.meta.url),
      {
        type: 'module',
        name: 'syncular-syql-compiler',
      },
    );
    this.#worker.addEventListener('message', this.#onWorkerMessage);
    this.#worker.addEventListener('error', this.#onWorkerError);
    this.#wireEvents();
    this.#selectExample(this.#activeExample, false);
  }

  #activeModel(): monaco.editor.ITextModel {
    const model = this.#models.get(this.#activeExample.id);
    if (model === undefined)
      throw new Error('active playground model is missing');
    return model;
  }

  #wireEvents(): void {
    const eventOptions = { signal: this.#eventController.signal };
    this.#disposables.push(
      this.#sourceEditor.onDidChangeModelContent(() => {
        monaco.editor.setModelMarkers(this.#activeModel(), MARKER_OWNER, []);
        this.#compile(false);
      }),
    );
    for (const button of this.#root.querySelectorAll<HTMLButtonElement>(
      '[data-example-id]',
    )) {
      button.addEventListener(
        'click',
        () => {
          this.#selectExample(
            playgroundExample(button.dataset.exampleId ?? null),
          );
        },
        eventOptions,
      );
    }
    required<HTMLButtonElement>(
      this.#root,
      '#playground-reset',
    ).addEventListener(
      'click',
      () => {
        this.#replaceSource(this.#activeExample.source);
        this.#sourceEditor.focus();
      },
      eventOptions,
    );
    required<HTMLButtonElement>(
      this.#root,
      '#playground-format',
    ).addEventListener('click', () => this.#format(), eventOptions);
    this.#querySelect.addEventListener(
      'change',
      () => {
        this.#queryIndex = Number(this.#querySelect.value);
        this.#statementIndex = canonicalStatement(this.#activeQuery());
        this.#renderStatementOptions();
        this.#renderSelectedStatement();
      },
      eventOptions,
    );
    this.#statementSelect.addEventListener(
      'change',
      () => {
        this.#statementIndex = Number(this.#statementSelect.value);
        this.#renderSelectedStatement();
      },
      eventOptions,
    );
    this.#representationSelect.addEventListener(
      'change',
      () => this.#renderSelectedStatement(),
      eventOptions,
    );
    this.#copyButton.addEventListener(
      'click',
      () => void this.#copySql(),
      eventOptions,
    );
  }

  #selectExample(example: PlaygroundExample, updateUrl = true): void {
    this.#activeExample = example;
    this.#sourceEditor.setModel(this.#activeModel());
    this.#exampleDescription.textContent = example.description;
    this.#schemaSummary.textContent = `schema: ${schemaSummary(example.schemaId)}`;
    for (const button of this.#root.querySelectorAll<HTMLButtonElement>(
      '[data-example-id]',
    )) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.exampleId === example.id),
      );
    }
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('example', example.id);
      history.replaceState(history.state, '', url);
    }
    monaco.editor.setModelMarkers(this.#activeModel(), MARKER_OWNER, []);
    this.#queries = [];
    this.#queryIndex = 0;
    this.#statementIndex = 0;
    replaceSelect(this.#querySelect, [], '');
    replaceSelect(this.#statementSelect, [], '');
    this.#sqlModel.setValue('-- compiling the selected example…');
    this.#backend.textContent = 'compiling';
    this.#statementCount.textContent = '—';
    this.#metadata.textContent =
      'Compile the source to inspect inputs, binds, dependencies, coverage, and identity.';
    this.#copyButton.disabled = true;
    this.#lastSuccessfulSql = false;
    this.#stale.hidden = true;
    this.#root.dataset.stale = 'false';
    this.#compile(true);
  }

  #replaceSource(source: string): void {
    const model = this.#activeModel();
    this.#sourceEditor.pushUndoStop();
    this.#sourceEditor.executeEdits('syncular-playground', [
      { range: model.getFullModelRange(), text: source },
    ]);
    this.#sourceEditor.pushUndoStop();
  }

  #compile(immediate: boolean): void {
    if (this.#compileTimer !== undefined)
      window.clearTimeout(this.#compileTimer);
    this.#setState('compiling', 'Compiling…');
    if (immediate) {
      this.#sendCompile();
      return;
    }
    this.#compileTimer = window.setTimeout(
      () => this.#sendCompile(),
      COMPILE_DEBOUNCE_MS,
    );
  }

  #sendCompile(): void {
    this.#compileTimer = undefined;
    const requestId = ++this.#requestId;
    this.#latestCompileId = requestId;
    this.#post({
      kind: 'compile',
      requestId,
      schemaId: this.#activeExample.schemaId,
      source: this.#activeModel().getValue(),
    });
  }

  #format(): void {
    const model = this.#activeModel();
    const requestId = ++this.#requestId;
    this.#pendingFormats.set(requestId, {
      exampleId: this.#activeExample.id,
      version: model.getVersionId(),
    });
    this.#post({
      kind: 'format',
      requestId,
      source: model.getValue(),
    });
  }

  #post(request: PlaygroundWorkerRequest): void {
    this.#worker.postMessage(request);
  }

  readonly #onWorkerMessage = (
    event: MessageEvent<PlaygroundWorkerResponse>,
  ): void => {
    if (this.#disposed) return;
    const response = event.data;
    if (response.kind === 'ready') return;
    if (response.kind === 'formatted') {
      const pending = this.#pendingFormats.get(response.requestId);
      this.#pendingFormats.delete(response.requestId);
      if (
        pending !== undefined &&
        pending.exampleId === this.#activeExample.id &&
        pending.version === this.#activeModel().getVersionId()
      ) {
        this.#replaceSource(response.source);
        this.#sourceEditor.focus();
      }
      return;
    }
    if (response.kind === 'diagnostics') {
      if (this.#pendingFormats.delete(response.requestId)) {
        this.#showDiagnostics(response.diagnostics);
        this.#setState(
          'error',
          `Format failed · ${response.diagnostics.length} ${response.diagnostics.length === 1 ? 'error' : 'errors'}`,
        );
        return;
      }
      if (
        response.requestId !== 0 &&
        response.requestId !== this.#latestCompileId
      ) {
        return;
      }
      this.#showDiagnostics(response.diagnostics);
      this.#setState(
        'error',
        `${response.diagnostics.length} ${response.diagnostics.length === 1 ? 'error' : 'errors'}`,
      );
      this.#stale.hidden = !this.#lastSuccessfulSql;
      this.#root.dataset.stale = String(this.#lastSuccessfulSql);
      return;
    }
    if (response.requestId !== this.#latestCompileId) return;
    this.#queries = response.queries;
    this.#queryIndex = 0;
    this.#renderQueryOptions();
    this.#statementIndex = canonicalStatement(this.#activeQuery());
    this.#renderStatementOptions();
    this.#renderSelectedStatement();
    this.#showDiagnostics([]);
    this.#lastSuccessfulSql = true;
    this.#stale.hidden = true;
    this.#root.dataset.stale = 'false';
    this.#setState(
      'success',
      `Compiled ${response.queries.length} ${response.queries.length === 1 ? 'query' : 'queries'} · ${Math.max(0.1, response.elapsedMs).toFixed(1)} ms`,
    );
  };

  readonly #onWorkerError = (event: ErrorEvent): void => {
    if (this.#disposed) return;
    this.#showDiagnostics([
      { code: 'PLAYGROUND_WORKER_ERROR', message: event.message },
    ]);
    this.#setState('error', 'Compiler worker failed');
    this.#stale.hidden = !this.#lastSuccessfulSql;
    this.#root.dataset.stale = String(this.#lastSuccessfulSql);
  };

  #activeQuery(): PlaygroundQuery {
    const query = this.#queries[this.#queryIndex];
    if (query === undefined)
      throw new Error('active compiled query is missing');
    return query;
  }

  #activeStatement(): PlaygroundStatement {
    const statement = this.#activeQuery().statements[this.#statementIndex];
    if (statement === undefined)
      throw new Error('active SQL statement is missing');
    return statement;
  }

  #renderQueryOptions(): void {
    replaceSelect(
      this.#querySelect,
      this.#queries.map((query, index) => ({
        value: String(index),
        label: query.name,
      })),
      String(this.#queryIndex),
    );
  }

  #renderStatementOptions(): void {
    const query = this.#activeQuery();
    replaceSelect(
      this.#statementSelect,
      query.statements.map((statement, index) => ({
        value: String(index),
        label: statementLabel(statement, index),
      })),
      String(this.#statementIndex),
    );
  }

  #renderSelectedStatement(): void {
    const query = this.#activeQuery();
    const statement = this.#activeStatement();
    const sql =
      this.#representationSelect.value === 'positional'
        ? statement.positionalSql
        : statement.sql;
    this.#sqlModel.setValue(sql);
    this.#backend.textContent = query.backend;
    this.#statementCount.textContent = `${query.statements.length} ${query.statements.length === 1 ? 'statement' : 'statements'}`;
    this.#metadata.textContent = planMetadata(query, statement);
    this.#copyButton.disabled = false;
  }

  #showDiagnostics(diagnostics: readonly PlaygroundDiagnostic[]): void {
    const model = this.#activeModel();
    const markers: monaco.editor.IMarkerData[] = diagnostics.map((item) => {
      const startLineNumber = Math.min(
        model.getLineCount(),
        Math.max(1, item.line ?? 1),
      );
      const startColumn = Math.min(
        model.getLineMaxColumn(startLineNumber),
        Math.max(1, item.column ?? 1),
      );
      const endLineNumber = Math.min(
        model.getLineCount(),
        Math.max(startLineNumber, item.endLine ?? startLineNumber),
      );
      const endColumn = Math.min(
        model.getLineMaxColumn(endLineNumber),
        Math.max(
          endLineNumber === startLineNumber ? startColumn + 1 : 1,
          item.endColumn ?? startColumn + 1,
        ),
      );
      return {
        severity: monaco.MarkerSeverity.Error,
        source: 'SYQL',
        code: item.code,
        message: item.message,
        startLineNumber,
        startColumn,
        endLineNumber,
        endColumn,
      };
    });
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
    if (diagnostics.length === 0) {
      const empty = document.createElement('li');
      empty.textContent = 'No diagnostics.';
      this.#diagnostics.replaceChildren(empty);
      return;
    }
    this.#diagnostics.replaceChildren(
      ...diagnostics.map((item) => {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        const code = document.createElement('span');
        code.className = 'diagnostic-code';
        code.textContent = item.code;
        button.append(code, ` — ${item.message}`);
        if (item.line !== undefined) {
          button.addEventListener(
            'click',
            () => {
              this.#sourceEditor.setPosition({
                lineNumber: item.line ?? 1,
                column: item.column ?? 1,
              });
              this.#sourceEditor.revealPositionInCenter({
                lineNumber: item.line ?? 1,
                column: item.column ?? 1,
              });
              this.#sourceEditor.focus();
            },
            { signal: this.#eventController.signal },
          );
        }
        row.append(button);
        return row;
      }),
    );
  }

  #setState(state: string, message: string): void {
    this.#root.dataset.state = state;
    this.#status.textContent = message;
  }

  async #copySql(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.#sqlModel.getValue());
      this.#setState('success', 'Visible SQL copied');
    } catch (error) {
      this.#setState(
        'error',
        `Could not copy SQL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#eventController.abort();
    if (this.#compileTimer !== undefined)
      window.clearTimeout(this.#compileTimer);
    this.#worker.removeEventListener('message', this.#onWorkerMessage);
    this.#worker.removeEventListener('error', this.#onWorkerError);
    this.#worker.terminate();
    for (const disposable of this.#disposables) disposable.dispose();
    this.#sourceEditor.dispose();
    this.#sqlEditor.dispose();
    for (const model of this.#models.values()) model.dispose();
    this.#sqlModel.dispose();
  }
}

let activeApp: PlaygroundApp | undefined;
let mountVersion = 0;

async function mountPlayground(): Promise<void> {
  const version = ++mountVersion;
  const root = document.querySelector<HTMLElement>('#syql-playground');
  if (root === null) return;
  activeApp?.dispose();
  activeApp = undefined;
  try {
    await setupEditors();
    if (version !== mountVersion || !root.isConnected) return;
    activeApp = new PlaygroundApp(root);
  } catch (error) {
    root.dataset.state = 'error';
    required(root, '#playground-status').textContent =
      `Could not start the playground: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function unmountPlayground(): void {
  mountVersion += 1;
  activeApp?.dispose();
  activeApp = undefined;
}

document.addEventListener('astro:page-load', () => void mountPlayground());
document.addEventListener('astro:before-swap', unmountPlayground);

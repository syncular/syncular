import { shikiToMonaco } from '@shikijs/monaco';
import * as monaco from 'monaco-editor-core';
import EditorWorker from 'monaco-editor-core/esm/vs/editor/common/services/editorWebWorkerMain.js?worker';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import syqlLanguageConfiguration from '../../../../editors/vscode-syql/language-configuration.json';
import { SYQL_HIGHLIGHTER_LANGUAGES } from '../syql-highlighting';
import { type SyqlCompletionKind, syqlCompletions } from './completions';
import {
  BOARD_SCHEMA,
  EXAMPLE_GROUPS,
  PLAYGROUND_EXAMPLES,
  type PlaygroundExample,
} from './examples';
import type {
  PlaygroundDiagnostic,
  PlaygroundQuery,
  PlaygroundSqlValue,
  PlaygroundStatement,
  PlaygroundWorkerRequest,
  PlaygroundWorkerResponse,
} from './protocol';
import {
  bindStatement,
  type PlaygroundParam,
  PlaygroundRunError,
} from './runtime';
import { pageScript } from '../page-lifecycle';
import { SYNCULAR_MONACO_THEME } from './theme';

const MARKER_OWNER = 'syncular-syql-playground';
const DEBOUNCE_MS = 150;
// A single watchdog guards every worker round-trip. The worker processes
// messages FIFO, so one hung request stalls all later work; if nothing
// settles within this window the worker is replaced with a fresh one.
const WORKER_TIMEOUT_MS = 10_000;
const MAX_RESULT_ROWS = 500;

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;
type OutputTab = 'sql' | 'run' | 'types' | 'reactivity' | 'problems' | 'json';
type Pane = 'editor' | 'schema' | 'output';

/** Form state of one public input in the Run tab. */
interface Field {
  present: boolean;
  isNull: boolean;
  text: string;
  members: Record<string, string>;
}

const runtime = globalThis as typeof globalThis & {
  MonacoEnvironment?: { getWorker(_moduleId: string, _label: string): Worker };
};
runtime.MonacoEnvironment = { getWorker: () => new EditorWorker() };

let editorSetup: Promise<Highlighter> | undefined;

function setupEditors(): Promise<Highlighter> {
  if (editorSetup !== undefined) return editorSetup;
  editorSetup = (async () => {
    for (const id of ['syql', 'sql']) {
      if (
        !monaco.languages.getLanguages().some((language) => language.id === id)
      ) {
        monaco.languages.register({ id });
      }
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

function required<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`missing playground element ${selector}`);
  }
  return element;
}

/** Build one element; strings become text nodes. */
function h(
  tag: string,
  attributes: Readonly<Record<string, string | undefined>> = {},
  ...children: readonly (Node | string | null | undefined)[]
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) element.append(child);
  }
  return element;
}

function table(
  head: readonly string[],
  rows: readonly (readonly (Node | string)[])[],
): HTMLElement {
  return h(
    'table',
    { class: 'pg-grid' },
    h('thead', {}, h('tr', {}, ...head.map((cell) => h('th', {}, cell)))),
    h(
      'tbody',
      {},
      ...rows.map((row) =>
        h('tr', {}, ...row.map((cell) => h('td', {}, cell))),
      ),
    ),
  );
}

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return h('section', { class: 'pg-section' }, h('h3', {}, title), ...children);
}

function code(text: string): HTMLElement {
  return h('code', {}, text);
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
      (statement.activationMask ?? 0) === 0 &&
      (query.defaultSortProfile === undefined ||
        statement.sortProfile === query.defaultSortProfile),
  );
  return found < 0 ? 0 : found;
}

const COMPLETION_KINDS: Record<
  SyqlCompletionKind,
  readonly [monaco.languages.CompletionItemKind, string]
> = {
  column: [monaco.languages.CompletionItemKind.Field, '1'],
  input: [monaco.languages.CompletionItemKind.Variable, '2'],
  qualifier: [monaco.languages.CompletionItemKind.Module, '3'],
  table: [monaco.languages.CompletionItemKind.Struct, '4'],
  snippet: [monaco.languages.CompletionItemKind.Snippet, '5'],
  keyword: [monaco.languages.CompletionItemKind.Keyword, '6'],
};

function fieldFromParam(param: PlaygroundParam): Field {
  if (param === undefined) {
    return { present: false, isNull: false, text: '', members: {} };
  }
  if (param === null) {
    return { present: true, isNull: true, text: '', members: {} };
  }
  if (typeof param === 'boolean') {
    return { present: param, isNull: false, text: String(param), members: {} };
  }
  if (typeof param === 'object') {
    return {
      present: true,
      isNull: false,
      text: '',
      members: Object.fromEntries(
        Object.entries(param).map(([name, value]) => [
          name,
          String(value ?? ''),
        ]),
      ),
    };
  }
  return { present: true, isNull: false, text: String(param), members: {} };
}

function parseValue(
  type: string,
  text: string,
  input: string,
): PlaygroundSqlValue | boolean {
  const invalid = () =>
    new PlaygroundRunError(
      'SYQL_RUNTIME_INVALID_INPUT',
      `value does not parse as ${type}`,
      input,
    );
  switch (type) {
    case 'integer': {
      const value = Number(text.trim());
      if (!/^-?\d+$/.test(text.trim()) || !Number.isSafeInteger(value)) {
        throw invalid();
      }
      return value;
    }
    case 'float': {
      const value = Number(text.trim());
      if (text.trim() === '' || !Number.isFinite(value)) throw invalid();
      return value;
    }
    case 'boolean':
      if (text !== 'true' && text !== 'false') throw invalid();
      return text === 'true';
    case 'bytes':
    case 'crdt':
      throw new PlaygroundRunError(
        'PLAYGROUND_INPUT_UNSUPPORTED',
        `the Run form cannot enter ${type} values`,
        input,
      );
    default:
      return text;
  }
}

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

class PlaygroundApp {
  readonly #root: HTMLElement;
  readonly #out: HTMLElement;
  #worker: Worker;
  readonly #sourceEditor: monaco.editor.IStandaloneCodeEditor;
  readonly #sqlEditor: monaco.editor.IStandaloneCodeEditor;
  readonly #models = new Map<string, monaco.editor.ITextModel>();
  readonly #sqlModel: monaco.editor.ITextModel;
  readonly #usage: monaco.editor.IEditorDecorationsCollection;
  readonly #disposables: monaco.IDisposable[] = [];
  readonly #events = new AbortController();
  readonly #pendingFormats = new Map<
    number,
    { readonly exampleId: string; readonly version: number }
  >();
  readonly #fields = new Map<string, Map<string, Field>>();
  readonly #inflight = new Set<number>();
  #example: PlaygroundExample;
  #queries: readonly PlaygroundQuery[] = [];
  #diagnostics: readonly PlaygroundDiagnostic[] = [];
  #queryIndex = 0;
  #statementIndex = 0;
  #tab: OutputTab = 'sql';
  #autoProblems = false;
  #requestId = 0;
  #latestCompileId = 0;
  #latestRunId = 0;
  #compileTimer: number | undefined;
  #runTimer: number | undefined;
  #hashTimer: number | undefined;
  #watchdog: number | undefined;
  #disposed = false;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#out = required(root, '.pg-out');
    const fromHash = this.#readHash();
    this.#example = fromHash.example;
    for (const example of PLAYGROUND_EXAMPLES) {
      this.#models.set(
        example.id,
        monaco.editor.createModel(
          example.id === fromHash.example.id && fromHash.source !== undefined
            ? fromHash.source
            : example.source,
          'syql',
          monaco.Uri.parse(`inmemory://syncular/${example.id}.syql`),
        ),
      );
    }
    const sourceHost = required<HTMLElement>(root, '[data-source-host]');
    const sqlHost = required<HTMLElement>(root, '[data-sql-host]');
    sourceHost.replaceChildren();
    const shared = {
      theme: 'syncular-dark',
      automaticLayout: true,
      accessibilitySupport: 'auto',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
    } as const satisfies monaco.editor.IStandaloneEditorConstructionOptions;
    this.#sourceEditor = monaco.editor.create(sourceHost, {
      ...shared,
      model: this.#model(),
      ariaLabel: 'Editable SYQL source',
      renderWhitespace: 'selection',
      // The word highlighter rejects a pending delay with `Canceled` when an
      // example switch swaps the model; the schema pane highlights usage.
      occurrencesHighlight: 'off',
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'off',
      bracketPairColorization: { enabled: false },
      guides: { bracketPairs: true, indentation: false },
    });
    this.#usage = this.#sourceEditor.createDecorationsCollection();
    this.#sqlModel = monaco.editor.createModel(
      '',
      'sql',
      monaco.Uri.parse('inmemory://syncular/generated.sql'),
    );
    this.#sqlEditor = monaco.editor.create(sqlHost, {
      ...shared,
      model: this.#sqlModel,
      readOnly: true,
      domReadOnly: true,
      ariaLabel: 'Generated SQL',
      wordWrap: 'on',
      folding: false,
      lineNumbersMinChars: 3,
      renderLineHighlight: 'none',
    });

    this.#disposables.push(
      monaco.languages.registerCompletionItemProvider('syql', {
        triggerCharacters: ['.', ':'],
        provideCompletionItems: (model, position) => {
          if (model !== this.#model()) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          return {
            suggestions: syqlCompletions(
              model.getValue(),
              model.getOffsetAt(position),
              BOARD_SCHEMA,
            ).map((completion) => ({
              label: completion.label,
              insertText: completion.insertText,
              kind: COMPLETION_KINDS[completion.kind][0],
              detail: completion.detail,
              range,
              sortText: `${COMPLETION_KINDS[completion.kind][1]}-${completion.label}`,
              ...(completion.snippet === true
                ? {
                    insertTextRules:
                      monaco.languages.CompletionItemInsertTextRule
                        .InsertAsSnippet,
                  }
                : {}),
            })),
          };
        },
      }),
    );
    this.#sourceEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => this.#runNow(),
    );
    this.#sourceEditor.addCommand(
      monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
      () => this.#format(),
    );
    this.#sourceEditor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.BracketLeft,
      () => this.#step(-1),
    );
    this.#sourceEditor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.BracketRight,
      () => this.#step(1),
    );

    for (const key of root.querySelectorAll<HTMLElement>('[data-key]')) {
      key.textContent =
        key.dataset.key === 'mod'
          ? isMac
            ? '⌘'
            : 'Ctrl'
          : key.dataset.key === 'shift'
            ? isMac
              ? '⇧'
              : 'Shift'
            : isMac
              ? '⌥'
              : 'Alt';
    }
    this.#renderSchema();
    this.#worker = this.#createWorker();
    this.#wireEvents();
    this.#selectExample(this.#example, false);
  }

  // -- state -----------------------------------------------------------------

  #model(): monaco.editor.ITextModel {
    const model = this.#models.get(this.#example.id);
    if (model === undefined)
      throw new Error('active playground model is missing');
    return model;
  }

  #query(): PlaygroundQuery | undefined {
    return this.#queries[this.#queryIndex];
  }

  #readHash(): { example: PlaygroundExample; source?: string } {
    const params = new URLSearchParams(location.hash.slice(1));
    const example =
      PLAYGROUND_EXAMPLES.find(({ id }) => id === params.get('example')) ??
      PLAYGROUND_EXAMPLES[0];
    if (example === undefined)
      throw new Error('the playground has no examples');
    const encoded = params.get('source');
    if (encoded === null) return { example };
    try {
      const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
      return {
        example,
        source: new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(binary, (char) => char.charCodeAt(0)),
        ),
      };
    } catch {
      this.#setStatus(
        'error',
        'The shared source in the link is not valid; showing the example',
      );
      return { example };
    }
  }

  /** Mirror the example and any edited source into the URL hash. */
  #writeHash(): void {
    const params = new URLSearchParams({ example: this.#example.id });
    const source = this.#model().getValue();
    if (source !== this.#example.source) {
      const bytes = new TextEncoder().encode(source);
      params.set(
        'source',
        btoa(String.fromCharCode(...bytes))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, ''),
      );
    }
    const url = new URL(location.href);
    url.search = '';
    url.hash = params.toString();
    history.replaceState(history.state, '', url);
  }

  #setStatus(state: string, message: string): void {
    this.#root.dataset.state = state;
    required(this.#root, '[data-status]').textContent = message;
  }

  // -- wiring ----------------------------------------------------------------

  #wireEvents(): void {
    const options = { signal: this.#events.signal };
    const root = this.#root;
    const gallery = required<HTMLDialogElement>(root, '[data-gallery]');
    this.#disposables.push(
      this.#sourceEditor.onDidChangeModelContent(() => {
        monaco.editor.setModelMarkers(this.#model(), MARKER_OWNER, []);
        this.#syncEdited();
        this.#compile(false);
      }),
    );
    root.addEventListener(
      'click',
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const action =
          target?.closest<HTMLElement>('[data-action]')?.dataset.action;
        if (action === 'format') this.#format();
        if (action === 'reset') this.#reset();
        if (action === 'share') void this.#share();
        if (action === 'copy') void this.#copySql();
        if (action === 'run') this.#run();
        if (action === 'toggle-schema') this.#toggleSchema();
        const step = target?.closest<HTMLElement>('[data-step]')?.dataset.step;
        if (step !== undefined) this.#step(Number(step));
        if (target?.closest('[data-open-gallery]')) {
          for (const button of gallery.querySelectorAll<HTMLElement>(
            '[data-example-id]',
          )) {
            button.setAttribute(
              'aria-current',
              String(button.dataset.exampleId === this.#example.id),
            );
          }
          gallery.showModal();
          gallery.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
        }
        const tab = target?.closest<HTMLElement>('[data-tab], [data-goto-tab]');
        const tabName = tab?.dataset.tab ?? tab?.dataset.gotoTab;
        if (tab !== null && tab !== undefined && tabName !== undefined) {
          this.#autoProblems = false;
          this.#setTab(tabName as OutputTab);
        }
        const pane =
          target?.closest<HTMLElement>('[data-pane-tab]')?.dataset.paneTab;
        if (pane !== undefined) this.#setPane(pane as Pane);
      },
      options,
    );
    gallery.addEventListener(
      'click',
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const id =
          target?.closest<HTMLElement>('[data-example-id]')?.dataset.exampleId;
        const example = PLAYGROUND_EXAMPLES.find(
          (candidate) => candidate.id === id,
        );
        if (example !== undefined) {
          gallery.close();
          this.#selectExample(example);
          this.#sourceEditor.focus();
        } else if (
          target === gallery ||
          target?.closest('[data-close-gallery]')
        ) {
          gallery.close();
        }
      },
      options,
    );
    const schema = required<HTMLElement>(root, '[data-schema-body]');
    schema.addEventListener(
      'click',
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest<HTMLElement>('[data-insert]');
        if (button?.dataset.insert === undefined) return;
        const text =
          event instanceof MouseEvent && event.shiftKey && button.dataset.table
            ? `${button.dataset.table}.${button.dataset.insert}`
            : button.dataset.insert;
        const selections = this.#sourceEditor.getSelections() ?? [];
        this.#sourceEditor.executeEdits(
          'syncular-schema',
          selections.map((range) => ({ range, text, forceMoveMarkers: true })),
        );
        this.#setPane('editor');
        this.#sourceEditor.focus();
      },
      options,
    );
    schema.addEventListener(
      'pointerover',
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const name =
          target?.closest<HTMLElement>('[data-insert]')?.dataset.insert;
        if (name === undefined) {
          this.#usage.clear();
          return;
        }
        this.#usage.set(
          this.#model()
            .findMatches(`\\b${name}\\b`, false, true, false, null, false)
            .map(({ range }) => ({
              range,
              options: {
                inlineClassName: 'pg-usage',
                overviewRuler: {
                  color: '#ffb000',
                  position: monaco.editor.OverviewRulerLane.Center,
                },
              },
            })),
        );
      },
      options,
    );
    schema.addEventListener('pointerleave', () => this.#usage.clear(), options);
    required<HTMLSelectElement>(root, '[data-query]').addEventListener(
      'change',
      (event) => {
        if (!(event.target instanceof HTMLSelectElement)) return;
        this.#queryIndex = Number(event.target.value);
        const query = this.#query();
        this.#statementIndex =
          query === undefined ? 0 : canonicalStatement(query);
        this.#renderOutput();
        if (this.#tab === 'run') this.#run();
      },
      options,
    );
    required<HTMLSelectElement>(root, '[data-statement]').addEventListener(
      'change',
      (event) => {
        if (!(event.target instanceof HTMLSelectElement)) return;
        this.#statementIndex = Number(event.target.value);
        this.#renderOutput();
      },
      options,
    );
    required<HTMLSelectElement>(root, '[data-representation]').addEventListener(
      'change',
      () => this.#renderOutput(),
      options,
    );
    const form = required<HTMLFormElement>(root, '[data-params]');
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        this.#run();
      },
      options,
    );
    form.addEventListener('input', (event) => this.#onField(event), options);
    form.addEventListener('change', (event) => this.#onField(event), options);
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.defaultPrevented || gallery.open) return;
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key === 'Enter') {
          event.preventDefault();
          this.#runNow();
        } else if (event.altKey && event.shiftKey && event.code === 'KeyF') {
          event.preventDefault();
          this.#format();
        } else if (
          event.altKey &&
          !mod &&
          (event.code === 'BracketLeft' || event.code === 'BracketRight')
        ) {
          event.preventDefault();
          this.#step(event.code === 'BracketLeft' ? -1 : 1);
        }
      },
      options,
    );
    window.addEventListener(
      'hashchange',
      () => {
        const next = this.#readHash();
        if (next.source !== undefined)
          this.#models.get(next.example.id)?.setValue(next.source);
        this.#selectExample(next.example, false);
      },
      options,
    );
    this.#wireSplit(
      required(root, '[data-split="panes"]'),
      required(root, '.pg-work'),
      '--pg-split',
      'x',
    );
    this.#wireSplit(
      required(root, '[data-split="schema"]'),
      required(root, '.pg-left'),
      '--pg-schema',
      'y',
    );
  }

  /** Drag, arrow-key, and double-click handling for one splitter. */
  #wireSplit(
    handle: HTMLElement,
    container: HTMLElement,
    property: string,
    axis: 'x' | 'y',
  ): void {
    const options = { signal: this.#events.signal };
    // The user's last drag position survives reloads and example switches.
    const key = `syncular.playground${property}`;
    let fraction = axis === 'x' ? 0.48 : 0.4;
    const apply = (next: number) => {
      fraction = Math.min(
        axis === 'x' ? 0.75 : 0.8,
        Math.max(axis === 'x' ? 0.25 : 0.12, next),
      );
      this.#root.style.setProperty(property, `${(fraction * 100).toFixed(2)}%`);
      handle.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
      localStorage.setItem(key, fraction.toFixed(4));
      if (axis === 'y') this.#toggleSchema(true);
    };
    const stored = Number(localStorage.getItem(key) ?? Number.NaN);
    if (Number.isFinite(stored)) apply(stored);
    const fromPointer = (event: PointerEvent) => {
      const box = container.getBoundingClientRect();
      apply(
        axis === 'x'
          ? (event.clientX - box.left) / box.width
          : (box.bottom - event.clientY) / box.height,
      );
    };
    handle.addEventListener(
      'pointerdown',
      (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        handle.dataset.dragging = '';
        this.#root.dataset.dragging = '';
      },
      options,
    );
    handle.addEventListener(
      'pointermove',
      (event) => {
        if (handle.hasPointerCapture(event.pointerId)) fromPointer(event);
      },
      options,
    );
    const stop = () => {
      delete handle.dataset.dragging;
      delete this.#root.dataset.dragging;
    };
    handle.addEventListener('pointerup', stop, options);
    handle.addEventListener('pointercancel', stop, options);
    handle.addEventListener(
      'keydown',
      (event) => {
        const grow = axis === 'x' ? 'ArrowRight' : 'ArrowUp';
        const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowDown';
        if (event.key === grow || event.key === shrink) {
          event.preventDefault();
          apply(fraction + (event.key === grow ? 0.04 : -0.04));
        } else if (axis === 'y' && event.key === 'Enter') {
          this.#toggleSchema();
        }
      },
      options,
    );
    if (axis === 'y') {
      handle.addEventListener('dblclick', () => this.#toggleSchema(), options);
    }
  }

  #toggleSchema(open = this.#root.dataset.schema === 'collapsed'): void {
    this.#root.dataset.schema = open ? 'open' : 'collapsed';
    required(this.#root, '[data-action="toggle-schema"]').setAttribute(
      'aria-expanded',
      String(open),
    );
  }

  #setPane(pane: Pane): void {
    this.#root.dataset.pane = pane;
    for (const tab of this.#root.querySelectorAll<HTMLElement>(
      '[data-pane-tab]',
    )) {
      tab.setAttribute('aria-selected', String(tab.dataset.paneTab === pane));
    }
    // An editor laid out while its pane was hidden measured zero width.
    this.#sourceEditor.layout();
    this.#sqlEditor.layout();
  }

  #setTab(tab: OutputTab): void {
    this.#tab = tab;
    this.#out.dataset.activeTab = tab;
    for (const button of this.#out.querySelectorAll<HTMLElement>(
      '[role="tab"]',
    )) {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    }
    for (const panel of this.#out.querySelectorAll<HTMLElement>(
      '[data-panel]',
    )) {
      panel.hidden = panel.dataset.panel !== tab;
    }
    this.#sqlEditor.layout();
    if (tab === 'run' && this.#query() !== undefined) this.#run();
  }

  #step(delta: number): void {
    const index = PLAYGROUND_EXAMPLES.indexOf(this.#example);
    const count = PLAYGROUND_EXAMPLES.length;
    const next = PLAYGROUND_EXAMPLES[(index + delta + count) % count];
    if (next !== undefined) this.#selectExample(next);
  }

  #selectExample(example: PlaygroundExample, updateHash = true): void {
    this.#example = example;
    this.#sourceEditor.setModel(this.#model());
    this.#sourceEditor.setScrollPosition({ scrollLeft: 0, scrollTop: 0 });
    const position = PLAYGROUND_EXAMPLES.indexOf(example) + 1;
    required(this.#root, '[data-example-title]').textContent = example.title;
    required(this.#root, '[data-example-group]').textContent =
      EXAMPLE_GROUPS.find((group) => group.id === example.group)?.title ?? '';
    required(this.#root, '[data-example-description]').textContent =
      example.description;
    required(this.#root, '[data-example-position]').textContent =
      `${position} / ${PLAYGROUND_EXAMPLES.length}`;
    if (updateHash) this.#writeHash();
    this.#queries = [];
    this.#diagnostics = [];
    this.#queryIndex = 0;
    this.#statementIndex = 0;
    required(this.#root, '[data-results]').replaceChildren();
    this.#syncEdited();
    if (this.#tab === 'problems' || this.#autoProblems) {
      this.#autoProblems = false;
      this.#setTab('sql');
    }
    this.#renderOutput();
    this.#compile(true);
  }

  #syncEdited(): void {
    const edited = this.#model().getValue() !== this.#example.source;
    required(this.#root, '[data-edited]').hidden = !edited;
    required<HTMLButtonElement>(this.#root, '[data-action="reset"]').disabled =
      !edited;
    const words = new Set(
      this.#model()
        .getValue()
        .match(/[A-Za-z_][A-Za-z0-9_]*/g),
    );
    for (const button of this.#root.querySelectorAll<HTMLElement>(
      '[data-insert]',
    )) {
      button.toggleAttribute(
        'data-used',
        words.has(button.dataset.insert ?? ''),
      );
    }
    if (this.#hashTimer !== undefined) window.clearTimeout(this.#hashTimer);
    this.#hashTimer = window.setTimeout(() => this.#writeHash(), DEBOUNCE_MS);
  }

  #reset(): void {
    const model = this.#model();
    this.#fields.delete(this.#example.id);
    this.#sourceEditor.pushUndoStop();
    this.#sourceEditor.executeEdits('syncular-reset', [
      { range: model.getFullModelRange(), text: this.#example.source },
    ]);
    this.#sourceEditor.pushUndoStop();
    this.#sourceEditor.focus();
  }

  async #share(): Promise<void> {
    if (this.#hashTimer !== undefined) window.clearTimeout(this.#hashTimer);
    this.#writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      this.#setStatus(
        'success',
        'Link copied: it opens this example with the current source',
      );
    } catch {
      this.#setStatus(
        'error',
        'The browser blocked clipboard access; copy the address bar instead',
      );
    }
  }

  async #copySql(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.#sqlModel.getValue());
      this.#setStatus('success', 'SQL copied');
    } catch {
      this.#setStatus('error', 'The browser blocked clipboard access');
    }
  }

  // -- worker ----------------------------------------------------------------

  #createWorker(): Worker {
    const worker = new Worker(
      new URL('./compiler.worker.ts', import.meta.url),
      {
        type: 'module',
        name: 'syncular-syql-compiler',
      },
    );
    worker.addEventListener('message', this.#onWorkerMessage);
    worker.addEventListener('error', this.#onWorkerError);
    return worker;
  }

  #releaseWorker(): void {
    this.#worker.removeEventListener('message', this.#onWorkerMessage);
    this.#worker.removeEventListener('error', this.#onWorkerError);
    this.#worker.terminate();
  }

  #post(request: PlaygroundWorkerRequest): void {
    this.#inflight.add(request.requestId);
    if (this.#watchdog !== undefined) window.clearTimeout(this.#watchdog);
    this.#watchdog = window.setTimeout(
      () => this.#onWorkerTimeout(),
      WORKER_TIMEOUT_MS,
    );
    this.#worker.postMessage(request);
  }

  #settle(requestId: number): void {
    if (!this.#inflight.delete(requestId) || this.#inflight.size > 0) return;
    window.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
  }

  #onWorkerTimeout(): void {
    this.#watchdog = undefined;
    if (this.#disposed) return;
    this.#releaseWorker();
    this.#pendingFormats.clear();
    this.#inflight.clear();
    this.#worker = this.#createWorker();
    this.#showDiagnostics([
      {
        code: 'PLAYGROUND_WORKER_TIMEOUT',
        message: `The compiler did not answer within ${WORKER_TIMEOUT_MS / 1000} seconds. A fresh worker is running; edit the source to retry.`,
      },
    ]);
  }

  #compile(immediate: boolean): void {
    if (this.#compileTimer !== undefined)
      window.clearTimeout(this.#compileTimer);
    this.#setStatus('compiling', 'Compiling');
    const send = () => {
      this.#compileTimer = undefined;
      const requestId = ++this.#requestId;
      this.#latestCompileId = requestId;
      this.#post({
        kind: 'compile',
        requestId,
        source: this.#model().getValue(),
      });
    };
    if (immediate) send();
    else this.#compileTimer = window.setTimeout(send, DEBOUNCE_MS);
  }

  #runNow(): void {
    this.#autoProblems = false;
    this.#setTab('run');
    this.#setPane('output');
    this.#compile(true);
  }

  #format(): void {
    const model = this.#model();
    const requestId = ++this.#requestId;
    this.#pendingFormats.set(requestId, {
      exampleId: this.#example.id,
      version: model.getVersionId(),
    });
    this.#post({ kind: 'format', requestId, source: model.getValue() });
  }

  readonly #onWorkerMessage = (
    event: MessageEvent<PlaygroundWorkerResponse>,
  ): void => {
    if (this.#disposed) return;
    const response = event.data;
    if (response.kind === 'ready') return;
    this.#settle(response.requestId);
    const format = this.#pendingFormats.get(response.requestId);
    this.#pendingFormats.delete(response.requestId);
    if (response.kind === 'formatted') {
      if (
        format?.exampleId === this.#example.id &&
        format.version === this.#model().getVersionId()
      ) {
        const model = this.#model();
        this.#sourceEditor.pushUndoStop();
        this.#sourceEditor.executeEdits('syncular-format', [
          { range: model.getFullModelRange(), text: response.source },
        ]);
        this.#sourceEditor.pushUndoStop();
      }
      return;
    }
    if (response.kind === 'rows') {
      if (response.requestId === this.#latestRunId) this.#renderRows(response);
      return;
    }
    if (response.kind === 'diagnostics') {
      if (response.requestId === this.#latestRunId) {
        const problem = response.diagnostics[0];
        this.#renderRunError(
          'SQLite could not execute this statement locally',
          problem?.message ?? 'unknown error',
        );
        return;
      }
      if (format !== undefined) {
        this.#showDiagnostics(response.diagnostics, 'Format failed');
        return;
      }
      if (response.requestId !== this.#latestCompileId) return;
      this.#showDiagnostics(response.diagnostics);
      return;
    }
    if (response.requestId !== this.#latestCompileId) return;
    const previous = this.#query()?.name;
    this.#queries = response.queries;
    const kept = this.#queries.findIndex((query) => query.name === previous);
    this.#queryIndex = kept < 0 ? 0 : kept;
    const query = this.#query();
    this.#statementIndex = query === undefined ? 0 : canonicalStatement(query);
    this.#diagnostics = [];
    if (this.#autoProblems) {
      this.#autoProblems = false;
      this.#setTab('sql');
    }
    this.#renderOutput();
    this.#setStatus(
      'success',
      `Compiled ${response.queries.length} ${response.queries.length === 1 ? 'query' : 'queries'} in ${Math.max(0.1, response.elapsedMs).toFixed(1)} ms`,
    );
    if (this.#tab === 'run') this.#run();
  };

  readonly #onWorkerError = (event: ErrorEvent): void => {
    if (this.#disposed) return;
    this.#inflight.clear();
    this.#showDiagnostics([
      { code: 'PLAYGROUND_WORKER_ERROR', message: event.message },
    ]);
  };

  #showDiagnostics(
    diagnostics: readonly PlaygroundDiagnostic[],
    prefix?: string,
  ): void {
    this.#diagnostics = diagnostics;
    const model = this.#model();
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      diagnostics.map((item) => {
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
          message:
            item.remedy === undefined
              ? item.message
              : `${item.message}\n${item.remedy}`,
          startLineNumber,
          startColumn,
          endLineNumber,
          endColumn,
        };
      }),
    );
    const first = diagnostics[0];
    if (this.#queries.length === 0 && this.#tab !== 'problems') {
      this.#autoProblems = true;
      this.#setTab('problems');
    }
    this.#renderOutput();
    const count = `${diagnostics.length} ${diagnostics.length === 1 ? 'problem' : 'problems'}`;
    this.#setStatus(
      'error',
      `${prefix === undefined ? '' : `${prefix}: `}${count}${first?.line === undefined ? '' : ` · line ${first.line}`}${this.#example.fails === first?.code ? ' · expected for this example' : ''}`,
    );
  }

  // -- rendering -------------------------------------------------------------

  #renderSchema(): void {
    required(this.#root, '[data-schema-body]').replaceChildren(
      ...BOARD_SCHEMA.tables.map((table) =>
        h(
          'div',
          { class: 'pg-table' },
          h(
            'div',
            { class: 'pg-table-head' },
            h(
              'button',
              {
                type: 'button',
                'data-insert': table.name,
                title: `Insert ${table.name}`,
              },
              table.name,
            ),
            h('span', {}, `${table.columns.length} columns`),
          ),
          h(
            'ul',
            {},
            ...table.columns.map((column) => {
              const reference = table.references.find(
                (candidate) => candidate.column === column.name,
              );
              const scoped = table.scopes.some(
                (scope) => scope.column === column.name,
              );
              return h(
                'li',
                {},
                h(
                  'button',
                  {
                    type: 'button',
                    'data-insert': column.name,
                    'data-table': table.name,
                    title: `Insert ${column.name}; shift-click inserts ${table.name}.${column.name}`,
                  },
                  column.name,
                ),
                column.name === table.primaryKey
                  ? h(
                      'span',
                      { class: 'pg-tag pk', title: 'primary key' },
                      'PK',
                    )
                  : null,
                scoped
                  ? h(
                      'span',
                      { class: 'pg-tag scope', title: 'scope column' },
                      'SCOPE',
                    )
                  : null,
                reference === undefined
                  ? null
                  : h(
                      'span',
                      {
                        class: 'pg-tag ref',
                        title: `references ${reference.parentTable}, on delete ${reference.onDelete.toLowerCase()}`,
                      },
                      `→ ${reference.parentTable}`,
                    ),
                h(
                  'span',
                  { class: 'pg-type' },
                  `${column.type}${column.nullable ? ' | null' : ''}`,
                ),
              );
            }),
          ),
          h(
            'div',
            {
              class: 'pg-table-foot',
              title: table.indexes
                .map((index) => `${index.name} (${index.columns.join(', ')})`)
                .join('\n'),
            },
            `scope ${table.scopes.map((scope) => scope.pattern).join(', ')} · ${table.indexes.length} ${table.indexes.length === 1 ? 'index' : 'indexes'}`,
          ),
        ),
      ),
    );
  }

  #renderOutput(): void {
    const query = this.#query();
    const failing = this.#diagnostics.length > 0;
    const expected =
      failing && this.#example.fails === this.#diagnostics[0]?.code;
    this.#out.dataset.out = query === undefined ? 'empty' : 'ready';
    required(this.#root, '[data-stale]').hidden = !(
      failing && query !== undefined
    );
    for (const badge of this.#root.querySelectorAll<HTMLElement>(
      '[data-problem-count]',
    )) {
      badge.hidden = !failing;
      badge.textContent = String(this.#diagnostics.length);
    }
    const emptyText = required(this.#root, '[data-empty-text]');
    emptyText.textContent = failing
      ? expected
        ? 'This example fails on purpose. The Problems tab shows the diagnostic.'
        : 'The source does not compile, so there is no plan. The Problems tab points to the line.'
      : 'Compiling the source.';
    this.#renderProblems(expected);

    const picker = required<HTMLElement>(this.#root, '[data-query-picker]');
    picker.hidden = this.#queries.length < 2;
    required<HTMLSelectElement>(this.#root, '[data-query]').replaceChildren(
      ...this.#queries.map((candidate, index) => {
        const option = h('option', { value: String(index) }, candidate.name);
        if (index === this.#queryIndex) option.setAttribute('selected', '');
        return option;
      }),
    );
    if (query === undefined) {
      this.#sqlModel.setValue('');
      required<HTMLButtonElement>(this.#root, '[data-action="copy"]').disabled =
        true;
      required(this.#root, '[data-params]').replaceChildren();
      return;
    }
    const statement =
      query.statements[this.#statementIndex] ?? query.statements[0];
    if (statement === undefined)
      throw new Error('compiled query has no statement');
    const statements = required<HTMLSelectElement>(
      this.#root,
      '[data-statement]',
    );
    statements.replaceChildren(
      ...query.statements.map((candidate, index) => {
        const option = h(
          'option',
          { value: String(index) },
          statementLabel(candidate, index),
        );
        if (index === this.#statementIndex) option.setAttribute('selected', '');
        return option;
      }),
    );
    statements.disabled = query.statements.length < 2;
    const positional =
      required<HTMLSelectElement>(this.#root, '[data-representation]').value ===
      'positional';
    this.#sqlModel.setValue(
      positional ? statement.positionalSql : statement.sql,
    );
    required(this.#root, '[data-backend]').textContent = query.backend;
    required(this.#root, '[data-statement-count]').textContent =
      `${query.statements.length} ${query.statements.length === 1 ? 'statement' : 'statements'}`;
    required<HTMLButtonElement>(this.#root, '[data-action="copy"]').disabled =
      false;
    this.#renderTypes(query, statement);
    this.#renderReactivity(query);
    this.#renderParams(query);
    required(this.#root, '[data-json]').textContent = JSON.stringify(
      {
        query: query.name,
        sync: query.sync,
        backend: query.backend,
        statement: {
          sortProfile: statement.sortProfile ?? null,
          activation: statement.activationLabel,
          activationMask: statement.activationMask ?? null,
        },
        inputs: query.inputs,
        columns: query.columns,
        binds: statement.binds,
        dependencies: query.dependencies,
        coverage: query.coverage,
        identity: query.identity ?? null,
      },
      null,
      2,
    );
  }

  #renderProblems(expected: boolean): void {
    const panel = required(this.#root, '[data-panel="problems"]');
    if (this.#diagnostics.length === 0) {
      panel.replaceChildren(
        section(
          'Problems',
          h(
            'p',
            {},
            h('span', { class: 'pg-ok' }, 'No problems. '),
            'The source compiles against the Release board schema.',
          ),
        ),
      );
      return;
    }
    const model = this.#model();
    panel.replaceChildren(
      ...(expected
        ? [
            h(
              'p',
              { class: 'pg-note' },
              `This example fails on purpose: ${this.#example.description}`,
            ),
          ]
        : []),
      ...this.#diagnostics.map((item) => {
        const line = item.line;
        let frame: HTMLElement | null = null;
        if (line !== undefined && line <= model.getLineCount()) {
          const text = model.getLineContent(line);
          const start = Math.max(0, (item.column ?? 1) - 1);
          const end =
            item.endLine === line && item.endColumn !== undefined
              ? Math.max(start + 1, item.endColumn - 1)
              : text.length;
          frame = h(
            'pre',
            {},
            `${String(line).padStart(3)} | ${text.slice(0, start)}`,
            h('mark', {}, text.slice(start, end) || ' '),
            text.slice(end),
          );
        }
        const goto =
          line === undefined
            ? null
            : h(
                'button',
                { type: 'button' },
                `Go to line ${line}:${item.column ?? 1}`,
              );
        goto?.addEventListener(
          'click',
          () => {
            const position = {
              lineNumber: line ?? 1,
              column: item.column ?? 1,
            };
            this.#setPane('editor');
            this.#sourceEditor.setPosition(position);
            this.#sourceEditor.revealPositionInCenter(position);
            this.#sourceEditor.focus();
          },
          { signal: this.#events.signal },
        );
        return h(
          'div',
          { class: `pg-problem${expected ? ' expected' : ''}` },
          h(
            'div',
            { class: 'pg-problem-head' },
            h('strong', {}, item.code),
            line === undefined
              ? null
              : h('span', {}, `line ${line}, column ${item.column ?? 1}`),
            goto,
          ),
          h('p', {}, item.message),
          item.remedy === undefined
            ? null
            : h('p', { class: 'remedy' }, `Fix: ${item.remedy}`),
          frame,
        );
      }),
    );
  }

  #renderTypes(query: PlaygroundQuery, statement: PlaygroundStatement): void {
    required(this.#root, '[data-panel="types"]').replaceChildren(
      section(
        'Inputs',
        query.inputs.length === 0
          ? h('p', {}, 'The query takes no inputs.')
          : table(
              ['input', 'kind', 'type', 'presence'],
              query.inputs.map((input) => {
                switch (input.kind) {
                  case 'value':
                    return [
                      code(input.name),
                      'value',
                      `${input.type}${input.nullable ? ' | null' : ''}`,
                      input.default === false
                        ? 'default false'
                        : input.required
                          ? 'required'
                          : 'optional',
                    ];
                  case 'group':
                    return [
                      code(input.name),
                      'record',
                      `{ ${input.members.map((m) => `${m.name}: ${m.type}${m.nullable ? ' | null' : ''}`).join(', ')} }`,
                      'optional, all members',
                    ];
                  case 'sort':
                    return [
                      code(input.name),
                      'sort',
                      input.profiles.map((p) => p.name).join(' | '),
                      `default ${input.defaultProfile}`,
                    ];
                  case 'limit':
                    return [
                      code(input.name),
                      'limit',
                      'integer',
                      `default ${input.defaultSize}, max ${input.maxSize}`,
                    ];
                }
              }),
            ),
      ),
      section(
        'Result columns',
        table(
          ['column', 'type', 'nullable'],
          query.columns.map((column) => [
            code(column.name),
            column.type,
            column.nullable ? 'yes' : 'no',
          ]),
        ),
      ),
      section(
        `Binds of ${statementLabel(statement, this.#statementIndex)}`,
        statement.binds.length === 0
          ? h('p', {}, 'The statement has no binds.')
          : table(
              ['#', 'bind', 'kind', 'reads'],
              statement.binds.map((bind, index) => [
                String(index + 1),
                code(`:${bind.name}`),
                bind.kind,
                bind.kind === 'condition-active'
                  ? `when(${bind.controls.join(', ')})`
                  : bind.kind === 'group-member'
                    ? `${bind.input}.${bind.member}`
                    : bind.input,
              ]),
            ),
      ),
    );
  }

  #renderReactivity(query: PlaygroundQuery): void {
    required(this.#root, '[data-panel="reactivity"]').replaceChildren(
      section(
        'Dependencies',
        h(
          'p',
          {},
          'A write to one of these tables re-runs the query. A scope key narrows invalidation to rows of that scope; table-wide entries re-run on any write to the table.',
        ),
        table(
          ['table', 'invalidation'],
          query.dependencies.map((dependency) => [
            code(dependency.table),
            dependency.scopes.length === 0
              ? h('span', { class: 'pg-warn' }, 'table-wide')
              : dependency.scopes
                  .map(
                    (scope) =>
                      `${scope.pattern} for :${scope.params.join(', :')}`,
                  )
                  .join('; '),
          ]),
        ),
      ),
      section(
        'Coverage',
        query.sync
          ? h(
              'p',
              {},
              'This sync query claims coverage: the client reports it complete only when every entry below has synchronized.',
            )
          : h(
              'p',
              {},
              'An ordinary query reads local data and claims no coverage. Declare it as ',
              code('sync query'),
              ' to request and prove synchronization.',
            ),
        ...(query.coverage.length === 0
          ? []
          : [
              table(
                ['table', 'scope', 'units', 'fixed scopes'],
                query.coverage.map((entry) => [
                  code(entry.table),
                  entry.variable,
                  entry.units.map((unit) => `:${unit}`).join(', '),
                  entry.fixedScopes.length === 0
                    ? '—'
                    : entry.fixedScopes
                        .map(
                          (scope) =>
                            `${scope.variable} = :${scope.params.join(', :')}`,
                        )
                        .join('; '),
                ]),
              ),
            ]),
      ),
      section(
        'Row identity',
        query.identity === undefined
          ? h(
              'p',
              {},
              'No identity is proven, so consumers reconcile result rows without a key.',
            )
          : h(
              'p',
              {},
              'Rows are keyed by ',
              code(query.identity.join(', ')),
              '.',
            ),
      ),
    );
  }

  #exampleFields(): Map<string, Field> {
    let fields = this.#fields.get(this.#example.id);
    if (fields === undefined) {
      fields = new Map(
        Object.entries(this.#example.params ?? {}).map(([name, value]) => [
          name,
          fieldFromParam(value),
        ]),
      );
      this.#fields.set(this.#example.id, fields);
    }
    return fields;
  }

  #renderParams(query: PlaygroundQuery): void {
    const fields = this.#exampleFields();
    const form = required(this.#root, '[data-params]');
    const field = (name: string): Field => {
      let state = fields.get(name);
      if (state === undefined) {
        state = fieldFromParam(undefined);
        fields.set(name, state);
      }
      return state;
    };
    const textInput = (
      name: string,
      type: string,
      value: string,
      member?: string,
    ) =>
      h('input', {
        type: type === 'integer' || type === 'float' ? 'number' : 'text',
        step: type === 'float' ? 'any' : undefined,
        value,
        'data-input': name,
        'data-member': member,
        'aria-label': member === undefined ? name : `${name}.${member}`,
        spellcheck: 'false',
        autocomplete: 'off',
      });
    form.replaceChildren(
      ...query.inputs.map((input) => {
        const state = field(input.name);
        const label = (detail: string) =>
          h('span', {}, input.name, h('small', {}, detail));
        switch (input.kind) {
          case 'value': {
            if (input.default === false) {
              const box = h('input', {
                type: 'checkbox',
                'data-input': input.name,
                'data-flag': '',
              });
              if (state.present) box.setAttribute('checked', '');
              return h(
                'div',
                { class: 'pg-field' },
                label('bool flag, default false'),
                h('label', {}, box, 'true'),
              );
            }
            if (input.required) {
              return h(
                'label',
                { class: 'pg-field' },
                label(input.type),
                textInput(input.name, input.type, state.text),
              );
            }
            const mode = h(
              'select',
              {
                'data-input': input.name,
                'data-mode': '',
                'aria-label': `${input.name} presence`,
              },
              ...['absent', 'value', ...(input.nullable ? ['null'] : [])].map(
                (option) => {
                  const element = h('option', { value: option }, option);
                  const current = !state.present
                    ? 'absent'
                    : state.isNull
                      ? 'null'
                      : 'value';
                  if (option === current) element.setAttribute('selected', '');
                  return element;
                },
              ),
            );
            const value = textInput(input.name, input.type, state.text);
            if (!state.present || state.isNull)
              value.setAttribute('disabled', '');
            return h(
              'div',
              { class: 'pg-field' },
              label(
                `${input.type}${input.nullable ? ' | null' : ''}, optional`,
              ),
              h('div', { class: 'pg-field-row' }, mode, value),
            );
          }
          case 'group': {
            const box = h('input', {
              type: 'checkbox',
              'data-input': input.name,
              'data-flag': '',
            });
            if (state.present) box.setAttribute('checked', '');
            return h(
              'div',
              { class: 'pg-field' },
              label('record, optional'),
              h('label', {}, box, 'present'),
              h(
                'div',
                { class: 'pg-field-row' },
                ...input.members.map((member) => {
                  const element = textInput(
                    input.name,
                    member.type,
                    state.members[member.name] ?? '',
                    member.name,
                  );
                  element.setAttribute('placeholder', member.name);
                  if (!state.present) element.setAttribute('disabled', '');
                  return element;
                }),
              ),
            );
          }
          case 'sort':
            return h(
              'label',
              { class: 'pg-field' },
              label('sort profile'),
              h(
                'select',
                { 'data-input': input.name },
                ...input.profiles.map((profile) => {
                  const option = h(
                    'option',
                    { value: profile.name },
                    profile.name,
                  );
                  if (
                    profile.name ===
                    (state.present ? state.text : input.defaultProfile)
                  )
                    option.setAttribute('selected', '');
                  return option;
                }),
              ),
            );
          case 'limit': {
            const element = textInput(
              input.name,
              'integer',
              state.present ? state.text : '',
            );
            element.setAttribute('placeholder', `default ${input.defaultSize}`);
            element.setAttribute('min', '1');
            element.setAttribute('max', String(input.maxSize));
            return h(
              'label',
              { class: 'pg-field' },
              label(`limit 1 to ${input.maxSize}`),
              element,
            );
          }
        }
      }),
    );
  }

  #onField(event: Event): void {
    const target = event.target;
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement
      )
    )
      return;
    const name = target.dataset.input;
    if (name === undefined) return;
    const state = this.#exampleFields().get(name);
    if (state === undefined) return;
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      state.present = target.checked;
      state.text = String(target.checked);
    } else if (target.dataset.mode !== undefined) {
      state.present = target.value !== 'absent';
      state.isNull = target.value === 'null';
    } else if (target.dataset.member !== undefined) {
      state.members[target.dataset.member] = target.value;
    } else {
      state.text = target.value;
      state.present = target.value !== '';
    }
    if (event.type === 'change') {
      const query = this.#query();
      if (query !== undefined) this.#renderParams(query);
    }
    if (this.#runTimer !== undefined) window.clearTimeout(this.#runTimer);
    this.#runTimer = window.setTimeout(() => this.#run(), DEBOUNCE_MS);
  }

  #run(): void {
    this.#runTimer = undefined;
    const query = this.#query();
    if (query === undefined) return;
    const fields = this.#exampleFields();
    try {
      const params = Object.fromEntries(
        query.inputs.map((input): [string, PlaygroundParam] => {
          const state = fields.get(input.name) ?? fieldFromParam(undefined);
          switch (input.kind) {
            case 'value':
              if (input.default === false) return [input.name, state.present];
              if (!state.present) return [input.name, undefined];
              if (state.isNull) return [input.name, null];
              return [
                input.name,
                parseValue(input.type, state.text, input.name),
              ];
            case 'group':
              if (!state.present) return [input.name, undefined];
              return [
                input.name,
                Object.fromEntries(
                  input.members.map((member) => {
                    const value = parseValue(
                      member.type,
                      state.members[member.name] ?? '',
                      input.name,
                    );
                    return [
                      member.name,
                      typeof value === 'boolean' ? Number(value) : value,
                    ];
                  }),
                ),
              ];
            case 'sort':
              return [input.name, state.present ? state.text : undefined];
            case 'limit':
              return [
                input.name,
                state.present
                  ? parseValue('integer', state.text, input.name)
                  : undefined,
              ];
          }
        }),
      );
      const { statement, values } = bindStatement(query, params);
      const requestId = ++this.#requestId;
      this.#latestRunId = requestId;
      required(this.#root, '[data-run-meta]').textContent =
        `Running ${statementLabel(statement, query.statements.indexOf(statement))}`;
      this.#post({
        kind: 'run',
        requestId,
        sql: statement.positionalSql,
        values,
      });
    } catch (error) {
      if (!(error instanceof PlaygroundRunError)) throw error;
      this.#latestRunId = 0;
      this.#renderRunError(error.code, `${error.input}: ${error.message}`);
    }
  }

  #renderRunError(title: string, message: string): void {
    required(this.#root, '[data-run-meta]').textContent = 'No rows';
    required(this.#root, '[data-results]').replaceChildren(
      h(
        'div',
        { class: 'pg-run-error' },
        h('strong', {}, title),
        h('br'),
        message,
      ),
    );
  }

  #renderRows(
    result: Extract<PlaygroundWorkerResponse, { kind: 'rows' }>,
  ): void {
    const query = this.#query();
    const types = new Map(
      query?.columns.map((column) => [column.name, column.type]),
    );
    const shown = result.rows.slice(0, MAX_RESULT_ROWS);
    required(this.#root, '[data-run-meta]').textContent =
      `${result.rows.length} ${result.rows.length === 1 ? 'row' : 'rows'} in ${Math.max(0.01, result.elapsedMs).toFixed(2)} ms${result.rows.length > shown.length ? `, first ${shown.length} shown` : ''}`;
    const results = required(this.#root, '[data-results]');
    if (result.rows.length === 0) {
      results.replaceChildren(
        h(
          'div',
          { class: 'pg-run-error' },
          'The statement returned no rows for these inputs.',
        ),
      );
      return;
    }
    results.replaceChildren(
      h(
        'table',
        { class: 'pg-grid' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...result.columns.map((column) =>
              h('th', { title: types.get(column) }, column),
            ),
          ),
        ),
        h(
          'tbody',
          {},
          ...shown.map((row) =>
            h(
              'tr',
              {},
              ...row.map((value) =>
                value === null
                  ? h('td', { class: 'null' }, 'null')
                  : h(
                      'td',
                      {
                        class: typeof value === 'number' ? 'num' : undefined,
                        title: String(value),
                      },
                      String(value),
                    ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#events.abort();
    for (const timer of [
      this.#compileTimer,
      this.#runTimer,
      this.#hashTimer,
      this.#watchdog,
    ]) {
      if (timer !== undefined) window.clearTimeout(timer);
    }
    this.#releaseWorker();
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
    required(root, '[data-status]').textContent =
      `The playground could not start: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function unmountPlayground(): void {
  mountVersion += 1;
  activeApp?.dispose();
  activeApp = undefined;
}

pageScript(() => {
  void mountPlayground();
  return unmountPlayground;
});

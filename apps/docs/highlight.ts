/**
 * Build-time syntax highlighter — zero dependencies, same stance as the rest
 * of the generator. A small sequential scanner with a per-language config:
 * comments, strings, numbers, then identifiers classified as keyword / type
 * (Capitalized) / function call (identifier before `(`). Anything it does not
 * recognize passes through as plain ink. Highlighting happens here, at build
 * time — the published site still ships zero highlighter JavaScript.
 *
 * Token classes (styled in style.css): tok-c comment · tok-k keyword ·
 * tok-s string · tok-n number · tok-t type · tok-f function · tok-key
 * object/JSON key.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface LangConfig {
  readonly lineComment?: string;
  readonly blockComment?: readonly [string, string];
  /** String delimiters, longest first (e.g. `"""` before `"`). */
  readonly strings: readonly string[];
  readonly keywords: ReadonlySet<string>;
  readonly caseInsensitiveKeywords?: boolean;
}

const KW = (words: string): ReadonlySet<string> => new Set(words.split(' '));

const TS_KEYWORDS = KW(
  'abstract any as async await boolean break case catch class const continue ' +
    'debugger declare default delete do else enum export extends false finally ' +
    'for from function get if implements import in instanceof interface keyof ' +
    'let namespace never new null number object of override private protected ' +
    'public readonly return satisfies set static string super switch this throw ' +
    'true try type typeof undefined unknown var void while yield',
);

const TS_CONFIG: LangConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: ['`', "'", '"'],
  keywords: TS_KEYWORDS,
};

const SH_CONFIG: LangConfig = {
  lineComment: '#',
  strings: ["'", '"'],
  keywords: KW(
    'case cd do done echo elif else esac exit export fi for function if in local ' +
      'return set then while',
  ),
};

const JSON_CONFIG: LangConfig = {
  strings: ['"'],
  keywords: KW('true false null'),
};

const C_CONFIG: LangConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  strings: ['"', "'"],
  keywords: KW(
    'break case char const continue default do double else enum extern float ' +
      'for goto if int long return short signed sizeof static struct switch ' +
      'typedef union unsigned void volatile while',
  ),
};

const LANGS: Record<string, LangConfig> = {
  ts: TS_CONFIG,
  tsx: TS_CONFIG,
  js: TS_CONFIG,
  jsx: TS_CONFIG,
  swift: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['"""', '"'],
    keywords: KW(
      'actor as associatedtype async await break case catch class continue ' +
        'convenience default defer deinit do dynamic else enum extension ' +
        'fallthrough false fileprivate final for func guard if import in indirect ' +
        'infix init inout internal is lazy let mutating nil none nonmutating open ' +
        'operator optional override postfix precedencegroup prefix private ' +
        'protocol public repeat required rethrows return self Self some static ' +
        'struct subscript super switch throw throws true try typealias unowned ' +
        'var weak where while',
    ),
  },
  kotlin: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['"""', '"', "'"],
    keywords: KW(
      'abstract actual annotation as break by catch class companion const ' +
        'constructor continue crossinline data do dynamic else enum expect ' +
        'external false final finally for fun get if import in infix init inline ' +
        'inner interface internal is it lateinit noinline null object open ' +
        'operator out override package private protected public reified return ' +
        'sealed set super suspend tailrec this throw true try typealias val var ' +
        'vararg when where while',
    ),
  },
  dart: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ["'''", '"""', "'", '"'],
    keywords: KW(
      'abstract as assert async await base break case catch class const continue ' +
        'covariant default deferred do dynamic else enum export extends extension ' +
        'external factory false final finally for get hide if implements import in ' +
        'interface is late library mixin new null on operator part required rethrow ' +
        'return sealed set show static super switch sync this throw true try ' +
        'typedef var void when while with yield',
    ),
  },
  rust: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
    strings: ['"'],
    keywords: KW(
      'as async await break const continue crate dyn else enum extern false fn ' +
        'for if impl in let loop match mod move mut pub ref return self Self ' +
        'static struct super trait true type union unsafe use where while',
    ),
  },
  sql: {
    lineComment: '--',
    blockComment: ['/*', '*/'],
    strings: ["'"],
    caseInsensitiveKeywords: true,
    keywords: KW(
      'add all alter and as asc autoincrement begin between by cascade case check ' +
        'column commit constraint create cross default delete desc distinct drop ' +
        'else end exists foreign from group having if in index inner insert integer ' +
        'into is join key left like limit not null on or order outer primary real ' +
        'references rename replace right rollback select set table text then union ' +
        'unique update values view when where',
    ),
  },
  sh: SH_CONFIG,
  bash: SH_CONFIG,
  zsh: SH_CONFIG,
  shell: SH_CONFIG,
  json: JSON_CONFIG,
  jsonc: { ...JSON_CONFIG, lineComment: '//' },
  toml: {
    lineComment: '#',
    strings: ['"""', "'''", '"', "'"],
    keywords: KW('true false'),
  },
  yaml: {
    lineComment: '#',
    strings: ["'", '"'],
    keywords: KW('true false null'),
  },
  c: C_CONFIG,
  h: C_CONFIG,
  glsl: C_CONFIG,
};

const span = (cls: string, text: string): string =>
  `<span class="${cls}">${escapeHtml(text)}</span>`;

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;

/** Highlight `code` for `lang`; falls back to escaped plain text. */
export function highlight(code: string, lang: string): string {
  const cfg = LANGS[lang];
  if (!cfg) return escapeHtml(code);

  const out: string[] = [];
  let plain = ''; // pending unstyled run
  const flush = () => {
    if (plain) {
      out.push(escapeHtml(plain));
      plain = '';
    }
  };

  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);

    // Comments.
    if (cfg.lineComment && rest.startsWith(cfg.lineComment)) {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      flush();
      out.push(span('tok-c', code.slice(i, stop)));
      i = stop;
      continue;
    }
    if (cfg.blockComment && rest.startsWith(cfg.blockComment[0])) {
      const close = code.indexOf(cfg.blockComment[1], i + 2);
      const stop =
        close === -1 ? code.length : close + cfg.blockComment[1].length;
      flush();
      out.push(span('tok-c', code.slice(i, stop)));
      i = stop;
      continue;
    }

    // Strings (longest delimiter first; simple backslash escapes).
    const delim = cfg.strings.find((d) => rest.startsWith(d));
    if (delim) {
      let j = i + delim.length;
      while (j < code.length) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code.startsWith(delim, j)) {
          j += delim.length;
          break;
        }
        // Single-char strings never span lines (keeps shell `it's` damage local).
        if (delim.length === 1 && code[j] === '\n') break;
        j++;
      }
      flush();
      const text = code.slice(i, j);
      // JSON/object keys read differently from value strings.
      const isKey =
        /^\s*:/.test(code.slice(j)) && (lang === 'json' || lang === 'jsonc');
      out.push(span(isKey ? 'tok-key' : 'tok-s', text));
      i = j;
      continue;
    }

    // Numbers (int, float, hex, underscores).
    const ch = code[i] ?? '';
    if (/[0-9]/.test(ch) && !(i > 0 && IDENT.test(code[i - 1] ?? ''))) {
      const m = rest.match(
        /^0[xX][0-9a-fA-F_]+|^[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?/,
      );
      if (m) {
        flush();
        out.push(span('tok-n', m[0]));
        i += m[0].length;
        continue;
      }
    }

    // Identifiers → keyword / type / function call / plain.
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < code.length && IDENT.test(code[j] ?? '')) j++;
      const word = code.slice(i, j);
      const kwWord = cfg.caseInsensitiveKeywords ? word.toLowerCase() : word;
      flush();
      if (cfg.keywords.has(kwWord)) {
        out.push(span('tok-k', word));
      } else if (/^[A-Z]/.test(word) && lang !== 'sql' && lang !== 'sh') {
        out.push(span('tok-t', word));
      } else if (code[j] === '(') {
        out.push(span('tok-f', word));
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    plain += ch;
    i++;
  }
  flush();
  return out.join('');
}

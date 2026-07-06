/**
 * A tiny markdown → HTML renderer. Scope is exactly the subset the docs
 * pages use — no dependency, no client-side JS (REVISE.md boring-ness).
 * Supported: ATX headings, paragraphs, unordered/ordered lists, GitHub
 * tables, fenced code (```), blockquotes, horizontal rules, and inline
 * `code`, **bold**, and [links](url). Code blocks are syntax-highlighted at
 * build time (highlight.ts) — the site still ships no client-side JS for it.
 */
import { highlight } from './highlight';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Inline: code spans are lifted into placeholders first (so their contents
 * are never further parsed), then bold/emphasis/links run on the remainder —
 * which lets a link label or bold span contain a code span — and finally the
 * rendered code substitutes back in.
 */
function inline(text: string): string {
  const codes: string[] = [];
  let html = text.replace(/`([^`]+)`/g, (_all, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  html = escapeHtml(html);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_all, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );
  return html.replace(
    /\uE000(\d+)\uE000/g,
    (_all, i: string) => codes[Number(i)] ?? '',
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function renderTable(rows: string[]): string {
  const cells = (line: string): string[] =>
    line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
  const header = cells(rows[0] ?? '');
  const bodyRows = rows.slice(2); // rows[1] is the --- separator
  const thead = `<thead><tr>${header
    .map((cell) => `<th>${inline(cell)}</th>`)
    .join('')}</tr></thead>`;
  const tbody = bodyRows
    .map(
      (row) =>
        `<tr>${cells(row)
          .map((cell) => `<td>${inline(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="table-scroll"><table>${thead}<tbody>${tbody}</tbody></table></div>`;
}

export function render(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const isTableSep = (line: string): boolean =>
    /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code — highlighted at build time (see highlight.ts).
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        code.push(lines[i] ?? '');
        i++;
      }
      i++; // closing fence
      out.push(`<pre><code>${highlight(code.join('\n'), lang)}</code></pre>`);
      continue;
    }

    // Headings.
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2]?.trim() ?? '';
      const id = slugify(text);
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^---+$/.test(line.trim())) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Blockquote (possibly multi-line).
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        quote.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }

    // Table: a `|` line followed by a separator line.
    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      isTableSep(lines[i + 1] ?? '')
    ) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(lines[i] ?? '');
        i++;
      }
      out.push(renderTable(rows));
      continue;
    }

    // Lists (unordered or ordered). A wrapped continuation line — non-blank,
    // not a new marker, not structural — folds into the current item.
    const marker = /^(\s*)([-*]|\d+\.)\s+/;
    if (marker.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        if (marker.test(current)) {
          items.push(current.replace(marker, ''));
          i++;
          continue;
        }
        const structural =
          current.trim() === '' ||
          current.startsWith('```') ||
          current.startsWith('#') ||
          current.startsWith('>') ||
          current.trim().startsWith('|');
        if (structural || items.length === 0) break;
        items[items.length - 1] += ` ${current.trim()}`;
        i++;
      }
      const body = items.map((item) => `<li>${inline(item)}</li>`).join('');
      out.push(ordered ? `<ol>${body}</ol>` : `<ul>${body}</ul>`);
      continue;
    }

    // Blank line.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-structural lines.
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        current.trim() === '' ||
        current.startsWith('```') ||
        current.startsWith('#') ||
        current.startsWith('>') ||
        /^\s*[-*]\s+/.test(current) ||
        /^\s*\d+\.\s+/.test(current) ||
        current.trim().startsWith('|')
      ) {
        break;
      }
      para.push(current);
      i++;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

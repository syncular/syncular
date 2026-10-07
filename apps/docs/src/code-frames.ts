// The controls on the code frames that markdown components render: tab
// switching and the copy button. Imported by the docs and blog scripts;
// the module evaluates once per full load, so the document-level click
// handler registers once and keeps working across <ClientRouter> swaps.

/** Select `tab` in one tab block; `missing` names an SDK without a sample. */
export const showTab = (
  tabs: Element,
  tab: string,
  missing?: string | null,
) => {
  let label = '';
  for (const button of tabs.querySelectorAll<HTMLElement>('[role=tab]')) {
    const on = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(on));
    if (on) label = button.textContent ?? '';
  }
  let file = '';
  for (const panel of tabs.querySelectorAll<HTMLElement>('.tab-panel')) {
    panel.hidden = panel.dataset.tab !== tab;
    if (!panel.hidden) file = panel.dataset.file ?? '';
  }
  const fileEl = tabs.querySelector('.code-file');
  if (fileEl) fileEl.textContent = file;
  const note = tabs.querySelector<HTMLElement>('.code-note');
  if (note) {
    note.hidden = !missing;
    note.textContent = missing
      ? `No ${missing} sample for this block · showing ${label}`
      : '';
  }
};

document.addEventListener('click', (event) => {
  const target = event.target as Element | null;
  const tab = target?.closest<HTMLElement>('.code.tabs [role=tab]');
  const tabs = tab?.closest('.code.tabs');
  if (tab?.dataset.tab && tabs) {
    // A tab click switches this block only; the SDK menu sets the default.
    showTab(tabs, tab.dataset.tab);
    return;
  }
  const copy = target?.closest<HTMLElement>('.code-copy');
  if (copy) {
    const frame = copy.closest('.code');
    const pre =
      frame?.querySelector('.tab-panel:not([hidden]) pre') ??
      frame?.querySelector('pre');
    void navigator.clipboard.writeText(pre?.textContent ?? '').then(() => {
      copy.dataset.copied = '';
      setTimeout(() => delete copy.dataset.copied, 1300);
    });
  }
});

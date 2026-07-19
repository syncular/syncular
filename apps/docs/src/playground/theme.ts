import type { ThemeRegistrationRaw } from 'shiki/core';

export const SYNCULAR_MONACO_THEME = {
  name: 'syncular-dark',
  type: 'dark',
  colors: {
    'editor.background': '#0a0908',
    'editor.foreground': '#f4efe4',
    'editorCursor.foreground': '#ffb000',
    'editor.selectionBackground': '#604500',
    'editor.inactiveSelectionBackground': '#3a2b08',
    'editor.lineHighlightBackground': '#11100e',
    'editorLineNumber.foreground': '#756f64',
    'editorLineNumber.activeForeground': '#9a948a',
    'editorGutter.background': '#0a0908',
    'editorError.foreground': '#ff6b5f',
    'editorWidget.background': '#0a0908',
    'editorWidget.border': '#625d55',
    'input.background': '#000000',
    'input.foreground': '#f4efe4',
    'input.border': '#625d55',
    focusBorder: '#ffb000',
    'scrollbarSlider.background': '#756f644d',
    'scrollbarSlider.hoverBackground': '#9a948a66',
    'scrollbarSlider.activeBackground': '#ffb00066',
  },
  settings: [
    { settings: { foreground: '#f4efe4', background: '#0a0908' } },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: '#756f64', fontStyle: 'italic' },
    },
    {
      scope: [
        'keyword',
        'storage.modifier',
        'keyword.control.conditional.syql',
        'keyword.other.member.syql',
      ],
      settings: { foreground: '#ffb000' },
    },
    {
      scope: ['string', 'constant.other.symbol'],
      settings: { foreground: '#a9bf6e' },
    },
    {
      scope: ['constant.numeric', 'constant.language'],
      settings: { foreground: '#6fb3c0' },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'storage.type',
        'entity.name.type',
      ],
      settings: { foreground: '#e3d3a2' },
    },
    {
      scope: ['variable.parameter', 'variable.parameter.bind.syql'],
      settings: { foreground: '#f4efe4' },
    },
    {
      scope: ['punctuation', 'meta.brace', 'meta.delimiter'],
      settings: { foreground: '#9a948a' },
    },
  ],
} as const satisfies ThemeRegistrationRaw;

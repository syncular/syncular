import sqlGrammar from '@shikijs/langs/sql';
import type { LanguageRegistration } from 'shiki/core';
import syqlGrammar from '../../../editors/vscode-syql/syntaxes/syql.tmLanguage.json';

export const SYQL_LANGUAGE_REGISTRATION = {
  ...(syqlGrammar as LanguageRegistration),
  name: 'syql',
  embeddedLangs: ['sql'],
} satisfies LanguageRegistration;

export const SYQL_HIGHLIGHTER_LANGUAGES = [
  ...sqlGrammar,
  SYQL_LANGUAGE_REGISTRATION,
] satisfies LanguageRegistration[];

import { expect, test } from 'bun:test';
import sqlGrammar from '@shikijs/langs/sql';
import { createHighlighter, type LanguageRegistration } from 'shiki';

const source = `query listTodos(first?, second?: { start, end }) {

    select id from todos
    where when(first) {
      id = :first
    }
      and when(second) {
        id between :start and :end
      }


  order by sortBy default newest {
    newest: id desc ;
  }
  limit pageSize default 50 max 200;
}`;

test('keeps highlighting after a nested SYQL block closes', async () => {
  const grammar = (await Bun.file(
    new URL(
      '../../../editors/vscode-syql/syntaxes/syql.tmLanguage.json',
      import.meta.url,
    ),
  ).json()) as LanguageRegistration;
  const highlighter = await createHighlighter({
    themes: ['github-dark'],
    langs: [
      ...sqlGrammar,
      {
        ...grammar,
        name: 'syql',
        embeddedLangs: ['sql'],
      },
    ],
  });

  try {
    const result = highlighter.codeToTokens(source, {
      lang: 'syql' as never,
      theme: 'github-dark',
      includeExplanation: true,
    });
    const sourceLines = source.split('\n');

    const scopesFor = (lineText: string, tokenText: string) => {
      const lineIndex = sourceLines.findIndex((line) =>
        line.includes(lineText),
      );
      expect(lineIndex).toBeGreaterThanOrEqual(0);
      const token = result.tokens[lineIndex]?.find((candidate) =>
        candidate.content.includes(tokenText),
      );
      expect(token).toBeDefined();
      return token?.explanation?.flatMap((entry) =>
        entry.scopes.map((scope) => scope.scopeName),
      );
    };

    expect(scopesFor('when(second)', 'when')).toContain(
      'keyword.control.conditional.syql',
    );
    expect(scopesFor('order by sortBy default', 'default')).toContain(
      'keyword.other.member.syql',
    );
    expect(scopesFor('limit pageSize default 50 max', 'max')).toContain(
      'keyword.other.member.syql',
    );
  } finally {
    highlighter.dispose();
  }
});

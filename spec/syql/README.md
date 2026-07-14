# SYQL conformance fixtures

This directory is normative for SYQL revision 1 together with
[`docs/SYQL.md`](../../docs/SYQL.md). `manifest.json` is the only fixture entry
point. Every listed family declares its JSON Schema and is executed by the
typegen conformance tests.

Fixture data has three deliberately separate representations:

- lexical vectors pin every token's kind, exact spelling, UTF-16 offset, line,
  and Unicode-scalar column, including trivia and EOF;
- valid syntax vectors pin the span-free semantic AST produced by
  `toSyqlSemanticAst`;
- invalid vectors pin a stable diagnostic code and primary start position.

Trivia and source spans remain present in the lossless runtime AST. They are
excluded from semantic AST equality so formatting-only changes do not alter
language meaning. Atomic SQL token spellings remain in semantic AST vectors,
so changing a string, quoted identifier, blob, operator, or bind is observable.

Adding or changing language behavior requires updating the relevant schema,
fixtures, specification, parser tests, formatter fixtures, and emitters in the
same change. Increment `fixtureSchemaRevision` when a fixture JSON shape
changes; increment the language `revision` when accepted source meaning changes.

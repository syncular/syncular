import type { SyqlLexErrorCode } from './syql-lexer';
import type { SyqlLoweringErrorCode } from './syql-lowering';
import type { SyqlModuleErrorCode } from './syql-modules';
import type { SyqlParseErrorCode } from './syql-parser';
import type { SyqlSemanticErrorCode } from './syql-semantics';
import type { SyqlTemplateParseErrorCode } from './syql-template-parser';
import type { SyqlValidationErrorCode } from './syql-validator';

export type SyqlRuntimeErrorCode =
  | 'SYQL_RUNTIME_MISSING_REQUIRED_INPUT'
  | 'SYQL_RUNTIME_UNKNOWN_INPUT'
  | 'SYQL_RUNTIME_INVALID_INPUT'
  | 'SYQL_RUNTIME_INVALID_GROUP'
  | 'SYQL_RUNTIME_INVALID_SORT'
  | 'SYQL_RUNTIME_INVALID_LIMIT';

export type SyqlDiagnosticCode =
  | SyqlLexErrorCode
  | SyqlParseErrorCode
  | SyqlTemplateParseErrorCode
  | SyqlModuleErrorCode
  | SyqlSemanticErrorCode
  | SyqlValidationErrorCode
  | SyqlLoweringErrorCode
  | 'SYQL9001_PROJECT_CONTEXT'
  | SyqlRuntimeErrorCode;

/** Stable compiler and generated-runtime diagnostic remedies keyed by code. */
export const SYQL_DIAGNOSTIC_REMEDIES = {
  SYQL1001_UNTERMINATED_STRING:
    'Close the string literal with a matching single quote.',
  SYQL1002_UNTERMINATED_IDENTIFIER:
    'Close the quoted identifier with its matching delimiter.',
  SYQL1003_UNTERMINATED_COMMENT: 'Close the block comment with */.',
  SYQL1004_UNTERMINATED_IMPORT_PATH:
    'Close the import path with a matching double quote.',
  SYQL2001_EXPECTED_TOKEN:
    'Insert the token named by the diagnostic at the reported source position.',
  SYQL2002_INVALID_NAME:
    'Rename the declaration or parameter to a valid lower-camel identifier.',
  SYQL2003_RESERVED_NAME:
    'Rename the declaration or parameter so it does not use a reserved SYQL name.',
  SYQL2004_DUPLICATE_NAME:
    'Give each declaration, parameter, group member, and profile a unique name in its scope.',
  SYQL2005_INVALID_IMPORT:
    'Use a relative .syql import with explicit imported predicate names.',
  SYQL2006_EMPTY_TEMPLATE:
    'Add a SQL expression or statement inside the braces.',
  SYQL2007_FORBIDDEN_SEMICOLON:
    'Remove the semicolon from the embedded SQL template.',
  SYQL2008_INVALID_MEMBER:
    'Use a member supported by the surrounding SYQL declaration.',
  SYQL2009_INVALID_INTEGER:
    'Use a decimal integer within the range named by the diagnostic.',
  SYQL2010_INVALID_PAGE_RANGE:
    'Choose default and maximum page sizes that satisfy the declared range.',
  SYQL2011_INVALID_PARAMETER:
    'Rewrite the parameter using a supported value, optional, range, group, sort, or limit form.',
  SYQL2012_INVALID_QUERY_BODY:
    'Rewrite the query body using the clause order and forms defined by the SYQL grammar.',
  SYQL3001_EXPECTED_EMBEDDED_TOKEN:
    'Insert the required token in the embedded SQL construct.',
  SYQL3002_INVALID_BIND:
    'Bind a declared input with the :name form in a supported SQL position.',
  SYQL3003_INVALID_PREDICATE_CALL:
    'Call the predicate with declared bind arguments and matching parentheses.',
  SYQL3004_INVALID_WHEN:
    'Use when with declared controls and a nonempty conditional SQL body.',
  SYQL3005_INVALID_REACTIVE_DIRECTIVE:
    'Rewrite the reactive directive using a supported revision-1 form.',
  SYQL3006_FORBIDDEN_TEMPLATE_NODE:
    'Remove the conditional or predicate construct from this SQL context.',
  SYQL3007_UNEXPECTED_BRACE:
    'Remove the unmatched brace or close the surrounding embedded construct.',
  SYQL3008_FORBIDDEN_PARAMETER_FORM:
    'Use a value bind in this context instead of a range, group, sort, or limit control.',
  SYQL4001_IMPORT_OUTSIDE_ROOT:
    'Move the imported file under the configured query root and use a relative path.',
  SYQL4002_MODULE_NOT_FOUND:
    'Create the imported .syql file or correct the relative import path.',
  SYQL4003_IMPORT_CYCLE:
    'Remove one import edge so predicate modules form an acyclic graph.',
  SYQL4004_UNKNOWN_PREDICATE:
    'Export and import the predicate under the referenced name.',
  SYQL4005_DUPLICATE_IMPORT_TARGET:
    'Import each local predicate name once in the module.',
  SYQL4006_DUPLICATE_QUERY:
    'Give every query in the project a unique public name.',
  SYQL5001_UNKNOWN_PREDICATE:
    'Define the predicate locally or import it under the referenced name.',
  SYQL5002_PREDICATE_CYCLE:
    'Remove the recursive predicate call so expansion terminates.',
  SYQL5003_PREDICATE_ARITY:
    'Pass exactly the number of bind arguments declared by the predicate.',
  SYQL5004_CLOSED_PREDICATE:
    'Declare each external bind as a predicate parameter and pass it at the call site.',
  SYQL5005_UNUSED_PREDICATE_PARAMETER:
    'Use the predicate parameter in its body or remove it from the signature.',
  SYQL5006_UNDECLARED_BIND:
    'Declare the bind as a query input or predicate parameter.',
  SYQL5007_UNUSED_INPUT:
    'Use the query input in SQL or remove it from the public signature.',
  SYQL5008_INVALID_CONTROL:
    'Use an optional input, group, sort, or limit name as the control.',
  SYQL5009_MISSING_DOMINANCE:
    'Guard every optional bind with a when condition that proves its presence.',
  SYQL5010_UNUSED_CONTROL:
    'Use the control in the query body or remove it from the signature.',
  SYQL5011_TYPE_CONFLICT:
    'Make every declaration and SQL use of the bind agree on one SYQL type.',
  SYQL6001_INVALID_PLACEMENT:
    'Move the SYQL construct to the SQL clause named by the diagnostic.',
  SYQL6002_INVALID_SQL:
    'Correct the reported SQLite syntax, table, column, function, or bind error.',
  SYQL6003_NONDETERMINISTIC_SQL:
    'Replace nondeterministic SQL with values supplied through query inputs or stored columns.',
  SYQL6004_TYPE_CONFLICT:
    'Align the declared input type with the schema column and SQL expression types.',
  SYQL6005_INVALID_SYNC_QUERY:
    'Select stable row identity and preserve the scope coverage required for reactive sync.',
  SYQL6006_INVALID_SORT:
    'Use declared sort profiles with deterministic ORDER BY terms and a stable tie-breaker.',
  SYQL6007_INVALID_LIMIT:
    'Use the declared limit control and keep its default and maximum within the supported range.',
  SYQL6008_INVALID_IDENTITY:
    'Declare identity columns that are selected, non-null, and sufficient to identify each result row.',
  SYQL7001_ENUMERATION_LIMIT:
    'Use the auto or neutralize backend, reduce control combinations, or raise the explicit compiler limit.',
  SYQL7002_INTERNAL_LOWERING:
    'Report the query and diagnostic to the Syncular maintainers.',
  SYQL9001_PROJECT_CONTEXT:
    'Open the file under a project with a valid syncular.json, migrations, schema output, and query root.',
  SYQL_RUNTIME_MISSING_REQUIRED_INPUT:
    'Pass the required generated-query input.',
  SYQL_RUNTIME_UNKNOWN_INPUT:
    'Remove the unknown key from the generated-query input object.',
  SYQL_RUNTIME_INVALID_INPUT:
    'Pass a value that matches the generated input type and nullability.',
  SYQL_RUNTIME_INVALID_GROUP:
    'Pass either the complete generated group shape or omit the optional group.',
  SYQL_RUNTIME_INVALID_SORT:
    'Pass one of the sort profile names exported for the generated query.',
  SYQL_RUNTIME_INVALID_LIMIT:
    'Pass an integer within the generated query limit range.',
} as const satisfies Readonly<Record<SyqlDiagnosticCode, string>>;

/** Generate a deterministic JSON-ready code-to-remedy catalog. */
export function generateSyqlDiagnosticCatalog(): Readonly<
  Array<{ readonly code: SyqlDiagnosticCode; readonly remedy: string }>
> {
  return (Object.keys(SYQL_DIAGNOSTIC_REMEDIES) as SyqlDiagnosticCode[])
    .sort()
    .map((code) => ({ code, remedy: SYQL_DIAGNOSTIC_REMEDIES[code] }));
}

/** Resolve a diagnostic remedy without requiring a narrowed code type. */
export function syqlDiagnosticRemedy(code: string): string | undefined {
  const remedies: Readonly<Record<string, string>> = SYQL_DIAGNOSTIC_REMEDIES;
  return remedies[code];
}

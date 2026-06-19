const BENIGN_CONSOLE_SCHEMA_ERROR_SUBSTRINGS = [
  'driver has already been destroyed',
];

export function isBenignConsoleSchemaError(error: unknown): boolean {
  const visited = new Set<Error>();
  let current: unknown = error;

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const message = current.message.toLowerCase();
    if (
      BENIGN_CONSOLE_SCHEMA_ERROR_SUBSTRINGS.some((substring) =>
        message.includes(substring)
      )
    ) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

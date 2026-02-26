import type { ConsoleMessage, Page } from '@playwright/test';

export interface BrowserErrorCollector {
  clear(): void;
  assertNone(context: string): void;
  detach(): void;
}

function formatConsoleLocation(message: ConsoleMessage): string {
  const location = message.location();
  if (!location.url) return '';
  const line = location.lineNumber ?? 0;
  const column = location.columnNumber ?? 0;
  return ` (${location.url}:${line}:${column})`;
}

export function collectBrowserErrors(page: Page): BrowserErrorCollector {
  const errors: string[] = [];

  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== 'error') return;
    errors.push(
      `[console.error] ${message.text()}${formatConsoleLocation(message)}`
    );
  };

  const onPageError = (error: Error): void => {
    errors.push(`[pageerror] ${error.message}`);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  return {
    clear(): void {
      errors.length = 0;
    },
    assertNone(context: string): void {
      if (errors.length === 0) return;
      throw new Error(
        `${context} produced browser errors:\n${errors
          .map((entry, index) => `${index + 1}. ${entry}`)
          .join('\n')}`
      );
    },
    detach(): void {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

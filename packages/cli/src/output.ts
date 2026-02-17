import type { CommandResult } from './types';

export function printResult(result: CommandResult): void {
  const status = result.ok ? 'OK' : 'FAIL';
  console.log(`${status} ${result.title}`);
  for (const line of result.lines) {
    console.log(`  ${line}`);
  }
}

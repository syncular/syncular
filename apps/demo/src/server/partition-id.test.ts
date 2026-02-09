import { describe, expect, test } from 'bun:test';
import {
  normalizePartitionId,
  resolvePartitionIdFromRequest,
} from './partition-id';

describe('partition-id helpers', () => {
  test('normalizes partition identifiers', () => {
    expect(normalizePartitionId('  demo@one  ')).toBe('demo-one');
    expect(normalizePartitionId('')).toBe('default');
    expect(normalizePartitionId(null)).toBe('default');
  });

  test('resolves from x-demo-id header first', () => {
    const request = new Request(
      'https://demo.syncular.dev/api/sync?demoId=query-value',
      {
        headers: { 'x-demo-id': 'header-value' },
      }
    );

    expect(resolvePartitionIdFromRequest(request)).toBe('header-value');
  });

  test('resolves from demoId query parameter', () => {
    const request = new Request(
      'https://demo.syncular.dev/api/sync?demoId=query-value'
    );

    expect(resolvePartitionIdFromRequest(request)).toBe('query-value');
  });

  test('falls back to default when partition is missing', () => {
    const request = new Request('https://demo.syncular.dev/api/sync');

    expect(resolvePartitionIdFromRequest(request)).toBe('default');
  });
});

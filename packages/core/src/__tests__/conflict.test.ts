/**
 * Unit tests for conflict detection utilities.
 *
 * Tests the field-level merge logic for sync push operations.
 * These are pure function tests that don't require database setup.
 */
import { describe, expect, test } from 'bun:test';
import { performFieldLevelMerge } from '../conflict';

describe('performFieldLevelMerge', () => {
  describe('no base row (new insert)', () => {
    test('client payload wins entirely when base row is null', () => {
      const result = performFieldLevelMerge(
        null, // no base row
        { id: 'team-1', name: 'Server Name', type: 'praxis' }, // server row
        { name: 'Client Name', type: 'op' } // client payload
      );

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload).toEqual({
          name: 'Client Name',
          type: 'op',
        });
      }
    });
  });

  describe('only client changed', () => {
    test('uses client value when only client changed a field', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const clientPayload = { name: 'Client Updated', type: 'praxis' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.name).toBe('Client Updated');
        expect(result.mergedPayload.type).toBe('praxis');
      }
    });

    test('handles multiple fields changed by client only', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const clientPayload = { name: 'New Name', type: 'op' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.name).toBe('New Name');
        expect(result.mergedPayload.type).toBe('op');
      }
    });
  });

  describe('only server changed', () => {
    test('keeps server value when only server changed a field', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = {
        id: 'team-1',
        name: 'Server Updated',
        type: 'praxis',
      };
      const clientPayload = { name: 'Original', type: 'praxis' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        // Server's value is kept since client didn't change it
        expect(result.mergedPayload.name).toBe('Server Updated');
        expect(result.mergedPayload.type).toBe('praxis');
      }
    });
  });

  describe('both changed to same value', () => {
    test('no conflict when both changed field to same value', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = { id: 'team-1', name: 'Same Value', type: 'praxis' };
      const clientPayload = { name: 'Same Value', type: 'praxis' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.name).toBe('Same Value');
      }
    });
  });

  describe('both changed to different values (true conflict)', () => {
    test('returns conflict when both changed same field to different values', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = { id: 'team-1', name: 'Server Value', type: 'praxis' };
      const clientPayload = { name: 'Client Value', type: 'praxis' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
      if (!result.canMerge) {
        expect(result.conflictingFields).toContain('name');
      }
    });

    test('reports multiple conflicting fields', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = {
        id: 'team-1',
        name: 'Server Name',
        type: 'server-type',
      };
      const clientPayload = { name: 'Client Name', type: 'client-type' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
      if (!result.canMerge) {
        expect(result.conflictingFields).toContain('name');
        expect(result.conflictingFields).toContain('type');
        expect(result.conflictingFields.length).toBe(2);
      }
    });
  });

  describe('mixed changes', () => {
    test('handles client changed one field, server changed another', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = { id: 'team-1', name: 'Original', type: 'server-type' };
      const clientPayload = { name: 'Client Name', type: 'praxis' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        // Client's name change is applied
        expect(result.mergedPayload.name).toBe('Client Name');
        // Server's type change is kept
        expect(result.mergedPayload.type).toBe('server-type');
      }
    });

    test('handles conflict in one field but not another', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = { id: 'team-1', name: 'Server Name', type: 'praxis' };
      const clientPayload = { name: 'Client Name', type: 'op' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
      if (!result.canMerge) {
        // Only name conflicts (both changed from Original to different values)
        expect(result.conflictingFields).toContain('name');
        // Type was only changed by client, so no conflict
        expect(result.conflictingFields).not.toContain('type');
      }
    });
  });

  describe('neither changed', () => {
    test('returns server values when neither changed', () => {
      const baseRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const serverRow = { id: 'team-1', name: 'Original', type: 'praxis' };
      const clientPayload = { name: 'Original', type: 'praxis' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.name).toBe('Original');
        expect(result.mergedPayload.type).toBe('praxis');
      }
    });
  });
});

describe('deepEqual (tested through performFieldLevelMerge)', () => {
  describe('primitive equality', () => {
    test('detects change in string values', () => {
      const baseRow = { name: 'a' };
      const serverRow = { name: 'b' };
      const clientPayload = { name: 'c' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
    });

    test('detects change in number values', () => {
      const baseRow = { count: 1 };
      const serverRow = { count: 2 };
      const clientPayload = { count: 3 };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
    });

    test('handles null values', () => {
      const baseRow = { value: null };
      const serverRow = { value: null };
      const clientPayload = { value: 'not null' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.value).toBe('not null');
      }
    });

    test('detects null to value change', () => {
      const baseRow = { value: null };
      const serverRow = { value: 'server' };
      const clientPayload = { value: 'client' };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
    });
  });

  describe('array equality', () => {
    test('detects equal arrays', () => {
      const baseRow = { tags: ['a', 'b'] };
      const serverRow = { tags: ['a', 'b'] };
      const clientPayload = { tags: ['a', 'b', 'c'] };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.tags).toEqual(['a', 'b', 'c']);
      }
    });

    test('detects array length difference', () => {
      const baseRow = { tags: ['a'] };
      const serverRow = { tags: ['a', 'b'] };
      const clientPayload = { tags: ['a', 'c'] };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
    });

    test('detects array element difference', () => {
      const baseRow = { tags: ['a', 'b'] };
      const serverRow = { tags: ['a', 'x'] };
      const clientPayload = { tags: ['a', 'y'] };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
    });
  });

  describe('object equality', () => {
    test('detects equal objects', () => {
      const baseRow = { meta: { key: 'value' } };
      const serverRow = { meta: { key: 'value' } };
      const clientPayload = { meta: { key: 'new-value' } };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.meta).toEqual({ key: 'new-value' });
      }
    });

    test('detects object key count difference', () => {
      const baseRow = { meta: { a: 1 } };
      const serverRow = { meta: { a: 1, b: 2 } };
      const clientPayload = { meta: { a: 1, c: 3 } };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
    });

    test('detects object value difference', () => {
      const baseRow = { meta: { key: 'original' } };
      const serverRow = { meta: { key: 'server' } };
      const clientPayload = { meta: { key: 'client' } };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(false);
    });
  });

  describe('nested structures', () => {
    test('handles deeply nested objects', () => {
      const baseRow = { data: { nested: { deep: 'original' } } };
      const serverRow = { data: { nested: { deep: 'original' } } };
      const clientPayload = { data: { nested: { deep: 'updated' } } };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.data).toEqual({
          nested: { deep: 'updated' },
        });
      }
    });

    test('handles arrays within objects', () => {
      const baseRow = { config: { items: [1, 2, 3] } };
      const serverRow = { config: { items: [1, 2, 3] } };
      const clientPayload = { config: { items: [1, 2, 3, 4] } };

      const result = performFieldLevelMerge(baseRow, serverRow, clientPayload);

      expect(result.canMerge).toBe(true);
      if (result.canMerge) {
        expect(result.mergedPayload.config).toEqual({ items: [1, 2, 3, 4] });
      }
    });
  });
});

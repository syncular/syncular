import { describe, expect, it } from 'bun:test';
import { assertAuditChangeRedacted, assertAuditJsonExcludes } from './audit';

describe('audit testkit helpers', () => {
  it('accepts canonical redacted audit changes', () => {
    expect(() =>
      assertAuditChangeRedacted({
        changeKind: 'app_row',
        fields: ['id', 'title'],
        redaction: {
          payload: 'omitted',
          reason: 'audit_redacted_by_default',
        },
      })
    ).not.toThrow();
  });

  it('rejects raw payload fields', () => {
    expect(() =>
      assertAuditChangeRedacted({
        rowJson: { title: 'secret' },
        redaction: {
          payload: 'omitted',
          reason: 'audit_redacted_by_default',
        },
      })
    ).toThrow(/rowJson/);
  });

  it('detects forbidden payload strings anywhere in an audit response', () => {
    expect(() =>
      assertAuditJsonExcludes({ history: [{ fields: ['title'] }] }, [
        'secret-title',
      ])
    ).not.toThrow();

    expect(() =>
      assertAuditJsonExcludes({ error: 'not_found', detail: 'secret-title' }, [
        'secret-title',
      ])
    ).toThrow(/secret-title/);
  });
});

import { describe, expect, it } from 'bun:test';
import {
  findDiagnosticMarker,
  hasDiagnosticMarker,
  requireDiagnosticMarker,
  SYNCULAR_DX_MARKER_CODES,
} from './diagnostic-markers';

describe('diagnostic marker helpers', () => {
  const events = [
    { code: 'realtime.hello', details: { clientId: 'client-a' } },
    {
      code: 'blob.forbidden',
      details: { accessReason: 'missing_reference' },
    },
  ];

  it('finds stable Syncular marker codes with optional detail predicates', () => {
    expect(
      hasDiagnosticMarker(
        events,
        SYNCULAR_DX_MARKER_CODES.blobAccessDenied,
        (event) => event.details?.accessReason === 'missing_reference'
      )
    ).toBe(true);

    expect(
      findDiagnosticMarker(events, SYNCULAR_DX_MARKER_CODES.realtimeHello)
    ).toMatchObject({
      code: 'realtime.hello',
      details: { clientId: 'client-a' },
    });
  });

  it('throws an actionable failure when a marker is missing', () => {
    expect(() =>
      requireDiagnosticMarker(events, SYNCULAR_DX_MARKER_CODES.scopeRevoked)
    ).toThrow('Expected Syncular diagnostic marker "sync.scope_revoked"');
  });
});

export function parseBearerToken(
  authHeader: string | null | undefined
): string | null {
  const value = authHeader?.trim();
  if (!value?.startsWith('Bearer ')) {
    return null;
  }
  const token = value.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function parseWebSocketAuthToken(data: string): string | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const payload = parsed as Record<string, unknown>;
    if (payload.type !== 'auth' || typeof payload.token !== 'string') {
      return null;
    }
    const token = payload.token.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function closeUnauthenticatedSocket(ws: {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}): void {
  try {
    ws.send(JSON.stringify({ type: 'error', message: 'UNAUTHENTICATED' }));
  } catch {
    // ignore send errors
  }
  ws.close(4001, 'Unauthenticated');
}

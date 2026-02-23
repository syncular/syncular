const DEMO_ID_STORAGE_KEY = 'sync-demo:demo-id-v1';
const DEFAULT_DEMO_ID = 'default';

function createDemoId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeDemoId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._:-]/g, '-');
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 120);
}

function getDemoId(): string {
  if (typeof window === 'undefined') return DEFAULT_DEMO_ID;

  const fromQuery = normalizeDemoId(
    new URLSearchParams(window.location.search).get('demoId')
  );
  if (fromQuery) {
    try {
      window.localStorage.setItem(DEMO_ID_STORAGE_KEY, fromQuery);
    } catch {
      // Ignore storage failures and continue with the in-memory value.
    }
    return fromQuery;
  }

  try {
    const stored = normalizeDemoId(
      window.localStorage.getItem(DEMO_ID_STORAGE_KEY)
    );
    if (stored) return stored;

    const created = createDemoId();
    window.localStorage.setItem(DEMO_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return createDemoId();
  }
}

export function getDemoAuthHeaders(
  actorId: string,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    ...(extra ?? {}),
    'x-user-id': actorId,
    'x-demo-id': getDemoId(),
  };
}

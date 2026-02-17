const DEFAULT_PARTITION_ID = 'default';
const PARTITION_ID_MAX_LENGTH = 120;
const PARTITION_ID_SANITIZE_PATTERN = /[^a-zA-Z0-9._:-]/g;

export function normalizePartitionId(value: string | null | undefined): string {
  if (!value) return DEFAULT_PARTITION_ID;
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_PARTITION_ID;
  const cleaned = trimmed.replace(PARTITION_ID_SANITIZE_PATTERN, '-');
  if (cleaned.length === 0) return DEFAULT_PARTITION_ID;
  return cleaned.slice(0, PARTITION_ID_MAX_LENGTH);
}

export function resolvePartitionIdFromRequest(request: Request): string {
  const url = new URL(request.url);
  return normalizePartitionId(
    request.headers.get('x-demo-id') ??
      url.searchParams.get('demoId') ??
      url.searchParams.get('demo_id')
  );
}

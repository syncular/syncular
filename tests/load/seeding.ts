export const SEED_USER_PREFIXES = [
  'user',
  'reader',
  'writer',
  'small',
  'medium',
  'large',
  'ws',
] as const;

interface SeedIdentity {
  userId: string;
  rowCount: number;
}

export function buildSeedPlan(
  totalRows: number,
  userCount: number,
  prefixes: readonly string[] = SEED_USER_PREFIXES
): SeedIdentity[] {
  const safeTotalRows = Math.max(0, Math.floor(totalRows));
  const safeUserCount = Math.max(0, Math.floor(userCount));
  if (safeTotalRows === 0 || safeUserCount === 0 || prefixes.length === 0) {
    return [];
  }

  const identities: string[] = [];
  for (let userIndex = 0; userIndex < safeUserCount; userIndex++) {
    for (const prefix of prefixes) {
      identities.push(`${prefix}-${userIndex}`);
    }
  }

  const rowsPerIdentity = Math.floor(safeTotalRows / identities.length);
  const rowRemainder = safeTotalRows % identities.length;

  return identities
    .map((userId, identityIndex) => ({
      userId,
      rowCount: rowsPerIdentity + (identityIndex < rowRemainder ? 1 : 0),
    }))
    .filter((identity) => identity.rowCount > 0);
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeSeed(seed: string): number {
  const parsed = Number(seed);
  if (Number.isFinite(parsed)) {
    return Math.floor(parsed) >>> 0 || 1;
  }
  return hashSeed(seed) || 1;
}

export function createSeededRandom(seed?: string): () => number {
  if (!seed) return Math.random;

  let state = normalizeSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

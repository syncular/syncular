/**
 * @syncular/server-hono - Rate limiting middleware for sync endpoints
 *
 * Provides per-user rate limiting to prevent DoS attacks and excessive
 * server load from misbehaving clients.
 */

import { logSyncEvent } from '@syncular/core';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /**
   * Maximum requests per window (default: 60)
   */
  maxRequests: number;

  /**
   * Time window in milliseconds (default: 60000 = 1 minute)
   */
  windowMs: number;

  /**
   * Function to extract the rate limit key from a request.
   * Typically returns userId, deviceId, or IP address.
   * Return null to skip rate limiting for this request.
   */
  keyGenerator: (c: Context) => string | null | Promise<string | null>;

  /**
   * Whether to include rate limit headers in responses (default: true)
   */
  includeHeaders?: boolean;

  /**
   * Custom handler for rate-limited requests (optional)
   * If not provided, returns a 429 JSON response
   */
  onRateLimited?: (
    c: Context,
    retryAfterMs: number
  ) => Response | Promise<Response>;

  /**
   * Whether to skip rate limiting in test environments (default: false)
   */
  skipInTest?: boolean;
}

/**
 * Default rate limit configuration
 */
const DEFAULT_RATE_LIMIT_CONFIG: Omit<RateLimitConfig, 'keyGenerator'> = {
  maxRequests: 60,
  windowMs: 60_000,
  includeHeaders: true,
  skipInTest: false,
};

/**
 * Rate limit entry for tracking request counts
 */
interface RateLimitEntry {
  /** Request count in current window */
  count: number;
  /** Window start timestamp */
  windowStart: number;
}

/**
 * In-memory rate limiter store
 *
 * Note: This is suitable for single-instance deployments.
 * For distributed deployments, use Redis or similar.
 */
class RateLimitStore {
  private entries = new Map<string, RateLimitEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private windowMs: number) {
    // Clean up expired entries periodically
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      Math.max(windowMs, 60_000)
    );
  }

  /**
   * Check and increment the rate limit counter for a key.
   *
   * @param key - Rate limit key (e.g., userId)
   * @param maxRequests - Maximum requests allowed
   * @returns Rate limit check result
   */
  check(
    key: string,
    maxRequests: number
  ): {
    allowed: boolean;
    current: number;
    remaining: number;
    resetAt: number;
  } {
    const now = Date.now();
    let entry = this.entries.get(key);

    // Check if window has expired
    if (!entry || now - entry.windowStart >= this.windowMs) {
      entry = { count: 0, windowStart: now };
      this.entries.set(key, entry);
    }

    const resetAt = entry.windowStart + this.windowMs;
    const allowed = entry.count < maxRequests;

    if (allowed) {
      entry.count++;
    }

    return {
      allowed,
      current: entry.count,
      remaining: Math.max(0, maxRequests - entry.count),
      resetAt,
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Stop the cleanup interval
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clear all entries (for testing)
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get current entry count (for monitoring)
   */
  get size(): number {
    return this.entries.size;
  }
}

// Track created stores so tests can reset state deterministically.
const activeStores = new Set<RateLimitStore>();

/**
 * Reset the global store (for testing)
 */
export function resetRateLimitStore(): void {
  for (const store of activeStores) {
    store.stop();
  }
  activeStores.clear();
}

/**
 * Create a rate limiting middleware for Hono.
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from '@syncular/server-hono';
 *
 * const rateLimiter = createRateLimiter({
 *   maxRequests: 60,
 *   windowMs: 60_000,
 *   keyGenerator: async (c) => {
 *     const auth = await authenticate(c);
 *     return auth?.userId ?? null;
 *   },
 * });
 *
 * app.use('/sync/*', rateLimiter);
 * ```
 */
export function createRateLimiter(
  config: Partial<RateLimitConfig> & Pick<RateLimitConfig, 'keyGenerator'>
): MiddlewareHandler {
  const {
    maxRequests = DEFAULT_RATE_LIMIT_CONFIG.maxRequests,
    windowMs = DEFAULT_RATE_LIMIT_CONFIG.windowMs,
    keyGenerator,
    includeHeaders = DEFAULT_RATE_LIMIT_CONFIG.includeHeaders,
    onRateLimited,
    skipInTest = DEFAULT_RATE_LIMIT_CONFIG.skipInTest,
  } = config;

  const store = new RateLimitStore(windowMs);
  activeStores.add(store);

  return async (c, next) => {
    // Skip in test environment if configured
    if (skipInTest && process.env.NODE_ENV === 'test') {
      return next();
    }

    // Get the rate limit key
    const key = await keyGenerator(c);
    if (key === null) {
      // Skip rate limiting for this request
      return next();
    }

    const result = store.check(key, maxRequests);

    // Add rate limit headers if configured
    if (includeHeaders) {
      c.header('X-RateLimit-Limit', String(maxRequests));
      c.header('X-RateLimit-Remaining', String(result.remaining));
      c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    }

    if (!result.allowed) {
      const retryAfterMs = result.resetAt - Date.now();
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      // Log rate limit event
      logSyncEvent({
        event: 'sync.rate_limit',
        key,
        current: result.current,
        maxRequests,
        retryAfterMs,
      });

      // Add Retry-After header
      c.header('Retry-After', String(retryAfterSec));

      // Use custom handler or default response
      if (onRateLimited) {
        return onRateLimited(c, retryAfterMs);
      }

      return c.json(
        {
          error: 'RATE_LIMITED',
          message: 'Too many requests. Please try again later.',
          retryAfterMs,
          retryAfterSec,
        },
        429
      );
    }

    return next();
  };
}

/**
 * Create a rate limiter that uses userId from auth context.
 *
 * This is a convenience function for the common case of rate limiting
 * by authenticated user.
 *
 * @example
 * ```typescript
 * const syncRoutes = createSyncRoutes({
 *   db,
 *   handlers: [tasksHandler],
 *   authenticate,
 *   sync: {
 *     rateLimit: {
 *       pull: { maxRequests: 120, windowMs: 60_000 },
 *       push: { maxRequests: 60, windowMs: 60_000 },
 *     },
 *   },
 * });
 * ```
 */
export interface SyncRateLimitConfig {
  /**
   * Rate limit config for pull requests.
   * Set to false to disable rate limiting for pulls.
   */
  pull?: Omit<RateLimitConfig, 'keyGenerator'> | false;

  /**
   * Rate limit config for push requests.
   * Set to false to disable rate limiting for pushes.
   */
  push?: Omit<RateLimitConfig, 'keyGenerator'> | false;
}

/**
 * Default sync rate limit configuration
 */
export const DEFAULT_SYNC_RATE_LIMITS: SyncRateLimitConfig = {
  pull: {
    maxRequests: 120, // 2 requests per second average
    windowMs: 60_000,
    includeHeaders: true,
  },
  push: {
    maxRequests: 60, // 1 request per second average
    windowMs: 60_000,
    includeHeaders: true,
  },
};

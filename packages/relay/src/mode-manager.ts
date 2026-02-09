/**
 * @syncular/relay - Mode Manager
 *
 * State machine for tracking relay online/offline status.
 */

/**
 * Relay operating modes.
 */
export type RelayMode = 'online' | 'offline' | 'reconnecting';

/**
 * Mode manager options.
 */
export interface ModeManagerOptions {
  healthCheckIntervalMs?: number;
  reconnectBackoffMs?: number;
  maxReconnectBackoffMs?: number;
  onModeChange?: (mode: RelayMode) => void;
}

/**
 * Mode manager for tracking relay online/offline state.
 *
 * Uses health checks to detect connectivity to the main server
 * and manages reconnection with exponential backoff.
 */
export class ModeManager {
  private mode: RelayMode = 'offline';
  private healthCheckIntervalMs: number;
  private reconnectBackoffMs: number;
  private maxReconnectBackoffMs: number;
  private currentBackoffMs: number;
  private onModeChange?: (mode: RelayMode) => void;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckFn: (() => Promise<boolean>) | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: assigned and incremented in healthCheck
  private consecutiveFailures = 0;

  constructor(options: ModeManagerOptions = {}) {
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 30000;
    this.reconnectBackoffMs = options.reconnectBackoffMs ?? 1000;
    this.maxReconnectBackoffMs = options.maxReconnectBackoffMs ?? 60000;
    this.currentBackoffMs = this.reconnectBackoffMs;
    this.onModeChange = options.onModeChange;
  }

  /**
   * Get the current mode.
   */
  getMode(): RelayMode {
    return this.mode;
  }

  /**
   * Start the mode manager with a health check function.
   */
  start(healthCheckFn: () => Promise<boolean>): void {
    if (this.running) return;
    this.running = true;
    this.healthCheckFn = healthCheckFn;

    // Start with immediate health check
    this.scheduleHealthCheck(0);
  }

  /**
   * Stop the mode manager.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Manually report a successful operation (resets backoff).
   */
  reportSuccess(): void {
    if (this.mode !== 'online') {
      this.setMode('online');
    }
    this.consecutiveFailures = 0;
    this.currentBackoffMs = this.reconnectBackoffMs;
  }

  /**
   * Manually report a failed operation.
   */
  reportFailure(): void {
    this.consecutiveFailures++;

    if (this.mode !== 'reconnecting') {
      this.setMode('reconnecting');
    }

    // Increase backoff for next attempt
    this.currentBackoffMs = Math.min(
      this.currentBackoffMs * 2,
      this.maxReconnectBackoffMs
    );
  }

  private setMode(newMode: RelayMode): void {
    if (this.mode === newMode) return;
    this.mode = newMode;
    this.onModeChange?.(newMode);
  }

  private scheduleHealthCheck(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) return;

    this.timer = setTimeout(async () => {
      this.timer = null;

      if (!this.healthCheckFn) {
        this.scheduleHealthCheck(this.healthCheckIntervalMs);
        return;
      }

      try {
        const healthy = await this.healthCheckFn();

        if (healthy) {
          this.reportSuccess();
          this.scheduleHealthCheck(this.healthCheckIntervalMs);
        } else {
          this.reportFailure();
          this.scheduleHealthCheck(this.currentBackoffMs);
        }
      } catch {
        this.reportFailure();
        this.scheduleHealthCheck(this.currentBackoffMs);
      }
    }, delayMs);
  }
}

/**
 * @syncular/client - Fingerprint Collector
 *
 * Accumulates fingerprint data from multiple queries.
 */

/**
 * Fingerprint collector accumulates fingerprint data from multiple queries
 */
export class FingerprintCollector {
  private fingerprints: string[] = [];

  add(fingerprint: string): void {
    this.fingerprints.push(fingerprint);
  }

  /**
   * Get combined fingerprint from all collected fingerprints
   */
  getCombined(): string {
    if (this.fingerprints.length === 0) return '';
    if (this.fingerprints.length === 1) return this.fingerprints[0] ?? '';
    return this.fingerprints.join('|');
  }

  clear(): void {
    this.fingerprints = [];
  }
}

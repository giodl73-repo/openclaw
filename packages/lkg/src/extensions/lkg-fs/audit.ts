/**
 * Audit record shape + sink interface for the FS-backed LKG impl.
 *
 * Mirrors the existing config-LKG audit envelope so byte-for-byte
 * conformance with shipped behavior is provable. Callers can plug in
 * their own sink (default: in-memory ring buffer for tests).
 *
 * @module @openclaw/lkg-fs/audit
 */

import type { LKGActor, LKGObservation } from '../../plugin-sdk/lkg/types.js';

/**
 * One audit record. Emitted on every observation outcome (valid /
 * promoted / recovered / skipped / failed) so audit replay can
 * reconstruct the LKG store's history of decisions.
 */
export interface LKGAuditRecord {
  readonly event: 'lkg.observe';
  readonly path: string;
  /**
   * Workspace-relative `oc://` URI for the tracked file. Synthesized
   * from `LKGTracker.ocPath` at observe time. Absent when the
   * tracker didn't declare an ocPath. Lets SIEM / observability
   * pipelines correlate LKG events with oc-lint / oc-doctor
   * diagnostics that already use the same vocabulary.
   */
  readonly ocPath?: string;
  readonly outcome: LKGObservation['outcome'];
  readonly fingerprintHash?: string;
  readonly clobberedPath?: string;
  readonly clobberedFileHash?: string;
  readonly replacedFingerprintHash?: string | null;
  readonly reason?: string;
  readonly actor?: LKGActor | null;
  readonly correlationEventId?: string | null;
  readonly observedAt: string;
}

/**
 * Audit sink — receives records as they're emitted. Hosts plug in
 * their own (file-backed, network-pushed, SIEM-streamed). Default
 * impl below is a ring buffer for tests.
 */
export interface LKGAuditSink {
  append(record: LKGAuditRecord): Promise<void>;
}

/**
 * In-memory ring-buffer sink. Useful for tests + dev. Production
 * deployments swap in a persistent sink.
 */
export class InMemoryAuditSink implements LKGAuditSink {
  private records: LKGAuditRecord[] = [];
  constructor(private readonly capacity = 1000) {}

  async append(record: LKGAuditRecord): Promise<void> {
    this.records.push(record);
    while (this.records.length > this.capacity) {
      this.records.shift();
    }
  }

  list(): readonly LKGAuditRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records = [];
  }
}

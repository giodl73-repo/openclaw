/**
 * Recovery-notice queue. After a recovery event, the LKG store
 * enqueues a notice so the next agent turn can surface "your bytes
 * were just clobbered; here's what happened" to the user.
 *
 * Mirrors the existing config-LKG recovery-notice shape.
 *
 * @module @openclaw/lkg-fs/recovery-notice
 */

import type { LKGActor, LKGFingerprint } from '../../plugin-sdk/lkg/types.js';

export interface LKGRecoveryNotice {
  readonly path: string;
  readonly clobberedPath: string;
  readonly restoredFromHash: string;
  readonly replacedFingerprint: LKGFingerprint | null;
  readonly reason: string;
  readonly actor?: LKGActor | null;
  readonly correlationEventId?: string | null;
  readonly observedAt: string;
}

/**
 * Recovery-notice sink — receives notices as they're emitted. The
 * gateway typically picks them up at the next turn boundary and
 * surfaces them to the agent + user.
 */
export interface LKGRecoveryNoticeSink {
  enqueue(notice: LKGRecoveryNotice): Promise<void>;
}

/** In-memory queue for tests + dev. */
export class InMemoryRecoveryNoticeSink implements LKGRecoveryNoticeSink {
  private queue: LKGRecoveryNotice[] = [];

  async enqueue(notice: LKGRecoveryNotice): Promise<void> {
    this.queue.push(notice);
  }

  drain(): readonly LKGRecoveryNotice[] {
    const drained = [...this.queue];
    this.queue = [];
    return drained;
  }

  size(): number {
    return this.queue.length;
  }
}

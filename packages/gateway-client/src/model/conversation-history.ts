import { CHAT_INPUT_RECEIPT_MAX_RUN_IDS } from "@openclaw/gateway-protocol/schema";
import {
  readSessionMessageSequence,
  reduceSessionProjection,
  type SessionProjectionState,
} from "../browser.js";
import type {
  ControlModelConversationHistory,
  ControlModelConversationHistoryMethod,
  ControlModelConversationHistoryQuery,
  ControlModelConversationHost,
  ControlModelConversationMetadata,
  ControlModelConversationStatus,
} from "./conversation-types.js";
import {
  hash,
  localError,
  normalizeGatewayError,
  record,
  readStartupMetadata,
  safeInteger,
  stableStringify,
  text,
} from "./conversation-utils.js";
import type { ControlModelRequestOptions } from "./model.js";

type ConversationHistoryControllerOptions = {
  host: ControlModelConversationHost;
  sessionKey: string;
  partialReasons: Set<string>;
  isDisposed(): boolean;
  captureEpoch(command: string): number;
  assertEpoch(epoch: number, command: string): void;
  getProjection(): SessionProjectionState;
  setProjection(projection: SessionProjectionState): void;
  restoreInFlightRun(value: unknown): void;
  boundProjectionEntries(): void;
  setMessagesTruncated(truncated: boolean): void;
  setStatus(status: ControlModelConversationStatus): void;
  publish(): void;
};

export class ConversationHistoryController {
  readonly #options: ConversationHistoryControllerOptions;
  #status: ControlModelConversationHistory["status"] = "idle";
  #error: ControlModelConversationHistory["error"] = null;
  #messages: unknown[] = [];
  #nextOffset: number | null = null;
  #hasMore = false;
  #totalMessages: number | null = null;
  #completeSnapshot = false;
  #window: "newest" | "older" = "newest";
  #truncatedBefore = false;
  #truncatedAfter = false;
  #revision = 0;
  #loop: Promise<void> | null = null;
  #requested = false;
  #offsetRequested = 0;
  #methodRequested: ControlModelConversationHistoryMethod = "chat.history";
  #metadata: ControlModelConversationMetadata | null = null;
  #requestOptions: ControlModelRequestOptions | undefined;
  #queryRequested: ControlModelConversationHistoryQuery | undefined;
  #generation = 0;

  constructor(options: ConversationHistoryControllerOptions) {
    this.#options = options;
  }

  get hasActiveOperation(): boolean {
    return this.#loop !== null;
  }

  get status(): ControlModelConversationHistory["status"] {
    return this.#status;
  }

  get window(): "newest" | "older" {
    return this.#window;
  }

  get metadata(): ControlModelConversationMetadata | null {
    return this.#metadata;
  }

  snapshot(): ControlModelConversationHistory {
    return {
      status: this.#status,
      hasMore: this.#hasMore,
      nextOffset: this.#nextOffset,
      totalMessages: this.#totalMessages,
      completeSnapshot: this.#completeSnapshot,
      window: this.#window,
      truncatedBefore: this.#truncatedBefore,
      truncatedAfter: this.#truncatedAfter,
      revision: this.#revision,
      error: this.#error,
    };
  }

  setActivationError(error: unknown): void {
    const normalized = normalizeGatewayError(error, "sessions.messages.subscribe");
    this.#error = {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
    };
  }

  markProjectionTruncated(): void {
    this.#completeSnapshot = false;
    if (this.#window === "older") {
      this.#truncatedAfter = true;
    } else {
      this.#truncatedBefore = true;
    }
  }

  refresh(
    options?: ControlModelRequestOptions,
    method: ControlModelConversationHistoryMethod = "chat.history",
    query?: ControlModelConversationHistoryQuery,
  ): Promise<void> {
    this.#requested = true;
    this.#offsetRequested = 0;
    this.#methodRequested = method;
    if (options !== undefined || this.#requestOptions === undefined) {
      this.#requestOptions = options;
    }
    if (query?.inputRunIds?.length) {
      this.#queryRequested = {
        inputRunIds: [
          ...new Set([...(this.#queryRequested?.inputRunIds ?? []), ...query.inputRunIds]),
        ],
      };
    }
    if (!this.#loop) {
      const loop = this.#drain().finally(() => {
        if (this.#loop === loop) {
          this.#loop = null;
          this.#queryRequested = undefined;
        }
      });
      this.#loop = loop;
    }
    return this.#loop;
  }

  async loadMore(options?: ControlModelRequestOptions): Promise<void> {
    while (this.#loop) {
      const activeLoop = this.#loop;
      const activeOffset = this.#offsetRequested;
      await activeLoop;
      if (activeOffset > 0) {
        return;
      }
      if (!this.#hasMore || this.#nextOffset === null) {
        return;
      }
    }
    if (!this.#hasMore || this.#nextOffset === null) {
      throw localError(
        "conflict",
        "chat.history",
        "No older history is available",
        "NO_MORE_HISTORY",
      );
    }
    if (this.#loop) {
      throw localError(
        "conflict",
        "chat.history",
        "A history operation is already in progress",
        "HISTORY_BUSY",
      );
    }
    this.#requested = true;
    this.#offsetRequested = this.#nextOffset;
    this.#requestOptions = options;
    this.#methodRequested = "chat.history";
    const loop = this.#drain().finally(() => {
      if (this.#loop === loop) {
        this.#loop = null;
        this.#queryRequested = undefined;
      }
    });
    this.#loop = loop;
    await loop;
  }

  requestRefresh(): boolean {
    this.#methodRequested = "chat.history";
    if (this.#requested || this.#loop) {
      this.#requested = true;
      this.#offsetRequested = 0;
      return false;
    }
    this.#requested = true;
    this.#offsetRequested = 0;
    return true;
  }

  invalidatePending(): void {
    this.#generation += 1;
  }

  async #drain(): Promise<void> {
    let firstError: unknown;
    let hasError = false;
    while (this.#requested && !this.#options.isDisposed()) {
      this.#requested = false;
      const options = this.#requestOptions;
      const query = this.#queryRequested;
      const method = this.#methodRequested;
      this.#requestOptions = undefined;
      try {
        await this.#refreshOnce(this.#offsetRequested, options, method, query);
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
      }
    }
    if (hasError) {
      throw firstError instanceof Error
        ? firstError
        : new Error("Conversation history refresh failed", { cause: firstError });
    }
  }

  async #refreshOnce(
    offset: number,
    options?: ControlModelRequestOptions,
    method: ControlModelConversationHistoryMethod = "chat.history",
    query?: ControlModelConversationHistoryQuery,
  ): Promise<void> {
    if (this.#options.isDisposed()) {
      return;
    }
    const epoch = this.#options.captureEpoch(method);
    const generation = this.#generation;
    this.#status = "loading";
    this.#error = null;
    this.#options.setStatus("loading");
    this.#options.publish();
    try {
      const inputRunIds = query?.inputRunIds ?? [];
      const queryBatches =
        inputRunIds.length > 0
          ? Array.from(
              { length: Math.ceil(inputRunIds.length / CHAT_INPUT_RECEIPT_MAX_RUN_IDS) },
              (_, index) =>
                inputRunIds.slice(
                  index * CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
                  (index + 1) * CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
                ),
            )
          : [undefined];
      let response: Record<string, unknown> = {};
      const inputReceipts: unknown[] = [];
      let receivedInputReceipts = false;
      for (const inputRunIdsBatch of queryBatches) {
        response = await this.#options.host.gateway.request<Record<string, unknown>>(
          method,
          {
            sessionKey: this.#options.sessionKey,
            ...(this.#options.host.agentId ? { agentId: this.#options.host.agentId } : {}),
            limit: this.#options.host.bounds.maxMessages,
            ...(offset > 0 ? { offset } : {}),
            ...(inputRunIdsBatch ? { inputRunIds: [...inputRunIdsBatch] } : {}),
          },
          options,
        );
        this.#options.assertEpoch(epoch, method);
        if (generation !== this.#generation) {
          return;
        }
        if (Array.isArray(response.inputReceipts)) {
          receivedInputReceipts = true;
          inputReceipts.push(...response.inputReceipts);
        }
      }
      if (receivedInputReceipts) {
        response = { ...response, inputReceipts };
      }
      const page = Array.isArray(response?.messages) ? response.messages : [];
      this.#applyStartupMetadata(record(response) ?? {}, method);
      const mergedHistory = mergeHistory(offset > 0 ? [...page, ...this.#messages] : page);
      const maxMessages = this.#options.host.bounds.maxMessages;
      const locallyTruncated = mergedHistory.length > maxMessages;
      this.#window = offset > 0 ? "older" : "newest";
      this.#messages = locallyTruncated
        ? this.#window === "older"
          ? mergedHistory.slice(0, maxMessages)
          : mergedHistory.slice(-maxMessages)
        : mergedHistory;
      this.#options.setProjection(
        reduceSessionProjection(this.#options.getProjection(), {
          type: "snapshotLoaded",
          messages: this.#messages,
          scope: { sessionKey: this.#options.sessionKey },
        }),
      );
      this.#options.restoreInFlightRun(response?.inFlightRun);
      const projectionOverflow = this.#options.getProjection().entries.length > maxMessages;
      this.#options.boundProjectionEntries();
      const nextOffset = safeInteger(response?.nextOffset);
      this.#hasMore = response?.hasMore === true && nextOffset !== null && nextOffset > offset;
      this.#nextOffset = this.#hasMore ? nextOffset : null;
      const total = safeInteger(response?.totalMessages);
      if (total !== null && total >= 0) {
        this.#totalMessages = total;
      }
      this.#truncatedBefore = this.#hasMore || (this.#window === "newest" && projectionOverflow);
      this.#truncatedAfter = this.#window === "older" && (locallyTruncated || projectionOverflow);
      const sourceComplete = response?.completeSnapshot === true || !this.#hasMore;
      this.#completeSnapshot = sourceComplete && !this.#truncatedBefore && !this.#truncatedAfter;
      this.#revision += 1;
      this.#status = "ready";
      this.#error = null;
      this.#options.partialReasons.delete("reconnect-awaiting-authoritative-history");
      this.#options.partialReasons.delete("session-reset-awaiting-history");
      this.#options.partialReasons.delete("disconnected");
      if (this.#truncatedBefore || this.#truncatedAfter) {
        this.#options.setMessagesTruncated(true);
        this.#options.partialReasons.add("messages-truncated");
      } else {
        this.#options.setMessagesTruncated(false);
        this.#options.partialReasons.delete("messages-truncated");
      }
      this.#options.setStatus(this.#options.partialReasons.size > 0 ? "partial" : "ready");
      this.#options.publish();
    } catch (error) {
      this.#options.assertEpoch(epoch, method);
      const normalized = normalizeGatewayError(error, method);
      this.#status = "error";
      this.#error = {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      };
      this.#options.setStatus("error");
      this.#options.publish();
      throw normalized;
    }
  }

  /**
   * Startup responses replace the retained envelope; ordinary history merges over it so a
   * canonical refresh can advance fields such as the active leaf without dropping the rest.
   */
  #applyStartupMetadata(
    response: Record<string, unknown>,
    method: ControlModelConversationHistoryMethod,
  ): void {
    const maxBytes = this.#options.host.bounds.maxMetadataBytes;
    const read = readStartupMetadata(response, maxBytes);
    if (method === "chat.startup") {
      this.#metadata = read.metadata;
      this.#setMetadataReason("startup-metadata-truncated", read.truncated);
      this.#setMetadataReason("startup-metadata-malformed", read.malformed);
      return;
    }
    const retained = { ...this.#metadata };
    // These fields describe the exact authoritative history response. Retaining
    // an omitted value would resurrect a completed run or stale input custody.
    delete retained.inFlightRun;
    delete retained.pendingInputs;
    delete retained.inputReceipts;
    const merged = read.metadata
      ? readStartupMetadata({ ...retained, ...read.metadata }, maxBytes)
      : read;
    if (merged.metadata) {
      this.#metadata = merged.metadata;
    }
    if (merged.truncated) {
      this.#options.partialReasons.add("startup-metadata-truncated");
    }
    if (merged.malformed) {
      this.#options.partialReasons.add("startup-metadata-malformed");
    }
  }

  #setMetadataReason(reason: string, present: boolean): void {
    if (present) {
      this.#options.partialReasons.add(reason);
    } else {
      this.#options.partialReasons.delete(reason);
    }
  }
}

function mergeHistory(messages: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const message of messages) {
    const value = record(message);
    const metadata = record(value?.["__openclaw"]);
    const role = text(value?.role) ?? "unknown";
    const id = text(metadata?.id) ?? text(value?.id);
    const sequence = readSessionMessageSequence(message);
    const idempotencyKey = text(metadata?.idempotencyKey);
    const key = id
      ? `id:${role}:${id}`
      : sequence !== null
        ? `seq:${role}:${sequence}`
        : idempotencyKey
          ? `idempotency:${role}:${idempotencyKey}`
          : `content:${hash(stableStringify(message))}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(message);
  }
  const sequences = merged.map((message) => readSessionMessageSequence(message));
  return sequences.every((sequence) => sequence !== null)
    ? merged
        .map((message, index) => ({ message, sequence: sequences[index] ?? 0 }))
        .toSorted((left, right) => left.sequence - right.sequence)
        .map(({ message }) => message)
    : merged;
}

import {
  assertReverseProviderDispatchFrameV1,
  measureReverseProviderDispatchChunkBytesV1,
  type ReverseProviderDispatchCertainty,
  type ReverseProviderDispatchFrameV1,
  type ReverseProviderDispatchOperationOpenV1,
  type ReverseProviderDispatchTraceResult,
} from "./reverse-provider-dispatch.js";

function encodedFrameBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("frame is not JSON serializable");
  }
  return Buffer.byteLength(encoded, "utf8");
}

function failure(
  code: Extract<ReverseProviderDispatchTraceResult, { ok: false }>["code"],
  frameIndex: number,
  certainty: ReverseProviderDispatchCertainty,
  message: string,
): ReverseProviderDispatchTraceResult {
  return { ok: false, code, frameIndex, certainty, message };
}

type ReverseProviderDispatchTerminalV1 = Extract<
  ReverseProviderDispatchFrameV1,
  { type: "terminal" }
>;

export type ReverseProviderDispatchStepResultV1 =
  | { ok: true; ignored: boolean; terminal: ReverseProviderDispatchTerminalV1 | undefined }
  | {
      ok: false;
      code: "protocol-violation";
      certainty: ReverseProviderDispatchCertainty;
      message: string;
    };

/** Constant-memory protocol validation for one admitted operation. */
export class ReverseProviderDispatchStateMachineV1 {
  readonly #open: ReverseProviderDispatchOperationOpenV1;
  #requestCredit = 0;
  #responseCredit = 0;
  #requestBytes = 0;
  #responseBytes = 0;
  #requestSequence = 0;
  #responseSequence = 0;
  #requestClosed = false;
  #responseOpened = false;
  #responseBodyAllowed = false;
  #responseClosed = false;
  #dispatchStarted = false;
  #cancelled = false;
  #terminal: ReverseProviderDispatchTerminalV1 | undefined;
  #certainty: ReverseProviderDispatchCertainty = "not-started";

  constructor(open: ReverseProviderDispatchOperationOpenV1) {
    this.#open = open;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  get certainty(): ReverseProviderDispatchCertainty {
    return this.#certainty;
  }

  get terminal(): ReverseProviderDispatchTerminalV1 | undefined {
    return this.#terminal;
  }

  #reject(message: string): ReverseProviderDispatchStepResultV1 {
    return { ok: false, code: "protocol-violation", certainty: this.#certainty, message };
  }

  observe(value: unknown): ReverseProviderDispatchStepResultV1 {
    if (this.#terminal) {
      return { ok: true, ignored: true, terminal: this.#terminal };
    }

    let frame: ReverseProviderDispatchFrameV1;
    try {
      frame = assertReverseProviderDispatchFrameV1(value);
    } catch (error) {
      return this.#reject(error instanceof Error ? error.message : String(error));
    }
    if (
      frame.operationId !== this.#open.operationId ||
      frame.incarnationId !== this.#open.incarnationId ||
      frame.ownerGeneration !== this.#open.ownerGeneration ||
      frame.hostBundleGeneration !== this.#open.hostBundleGeneration
    ) {
      return { ok: true, ignored: true, terminal: undefined };
    }
    if (encodedFrameBytes(frame) > this.#open.maxFrameBytes) {
      return this.#reject("frame exceeds maxFrameBytes");
    }
    if (frame.type === "operation-open") {
      return this.#reject("operation is already open");
    }
    if (
      this.#cancelled &&
      frame.type !== "cancel" &&
      frame.type !== "terminal" &&
      frame.type !== "dispatch-started" &&
      frame.type !== "response-open"
    ) {
      return { ok: true, ignored: true, terminal: undefined };
    }
    if (frame.type === "credit") {
      if (frame.stream === "request") {
        const requestCredit = this.#requestCredit + frame.bytes;
        const authorizedRequestBytes = this.#requestBytes + requestCredit;
        if (
          !Number.isSafeInteger(authorizedRequestBytes) ||
          authorizedRequestBytes > this.#open.requestByteLimit
        ) {
          return this.#reject("request credit exceeds byte limit");
        }
        this.#requestCredit = requestCredit;
      } else {
        const responseCredit = this.#responseCredit + frame.bytes;
        const authorizedResponseBytes = this.#responseBytes + responseCredit;
        if (
          !Number.isSafeInteger(authorizedResponseBytes) ||
          authorizedResponseBytes > this.#open.responseByteLimit
        ) {
          return this.#reject("response credit exceeds byte limit");
        }
        this.#responseCredit = responseCredit;
      }
      return { ok: true, ignored: false, terminal: undefined };
    }
    if (frame.type === "chunk") {
      const bytes = measureReverseProviderDispatchChunkBytesV1(frame.payloadBase64);
      if (bytes === 0 || bytes > this.#open.maxChunkBytes) {
        return this.#reject("chunk size is invalid");
      }
      if (frame.stream === "request") {
        const method = this.#open.request.method.toUpperCase();
        if (
          this.#requestClosed ||
          method === "GET" ||
          method === "HEAD" ||
          frame.sequence !== this.#requestSequence ||
          bytes > this.#requestCredit
        ) {
          return this.#reject("request chunk violates stream state or credit");
        }
        const requestBytes = this.#requestBytes + bytes;
        if (requestBytes > this.#open.requestByteLimit) {
          return this.#reject("request byte limit exceeded");
        }
        this.#requestSequence += 1;
        this.#requestCredit -= bytes;
        this.#requestBytes = requestBytes;
      } else {
        if (
          !this.#responseOpened ||
          !this.#responseBodyAllowed ||
          this.#responseClosed ||
          frame.sequence !== this.#responseSequence ||
          bytes > this.#responseCredit
        ) {
          return this.#reject("response chunk violates stream state or credit");
        }
        const responseBytes = this.#responseBytes + bytes;
        if (responseBytes > this.#open.responseByteLimit) {
          return this.#reject("response byte limit exceeded");
        }
        this.#responseSequence += 1;
        this.#responseCredit -= bytes;
        this.#responseBytes = responseBytes;
        this.#certainty = "response-started";
      }
      return { ok: true, ignored: false, terminal: undefined };
    }
    if (frame.type === "half-close") {
      if (frame.stream === "request") {
        if (this.#requestClosed) {
          return this.#reject("request stream already closed");
        }
        this.#requestClosed = true;
      } else {
        if (!this.#responseOpened || this.#responseClosed) {
          return this.#reject("response stream is not open");
        }
        this.#responseClosed = true;
      }
      return { ok: true, ignored: false, terminal: undefined };
    }
    if (frame.type === "dispatch-started") {
      if (this.#dispatchStarted) {
        return this.#reject("dispatch already started");
      }
      this.#dispatchStarted = true;
      this.#certainty = "started-unconfirmed";
      return { ok: true, ignored: false, terminal: undefined };
    }
    if (frame.type === "response-open") {
      if (!this.#dispatchStarted || this.#responseOpened) {
        return this.#reject("response cannot open in current state");
      }
      this.#responseOpened = true;
      this.#responseBodyAllowed =
        this.#open.request.method.toUpperCase() !== "HEAD" &&
        frame.status !== 204 &&
        frame.status !== 205 &&
        frame.status !== 304;
      this.#certainty = "response-started";
      return { ok: true, ignored: false, terminal: undefined };
    }
    if (frame.type === "cancel") {
      if (this.#cancelled) {
        return this.#reject("operation already cancelled");
      }
      this.#cancelled = true;
      return { ok: true, ignored: false, terminal: undefined };
    }
    if (
      frame.outcome === "completed" &&
      (!this.#requestClosed || !this.#responseOpened || !this.#responseClosed)
    ) {
      return this.#reject("completed outcome requires both streams to be half-closed");
    }
    if (frame.outcome === "failed" && frame.certainty === "completed") {
      return this.#reject("failed outcome cannot be completed");
    }
    if (frame.outcome === "failed" && frame.certainty !== this.#certainty) {
      return this.#reject("failed outcome certainty does not match observed dispatch state");
    }
    this.#terminal = frame;
    this.#certainty = frame.certainty;
    return { ok: true, ignored: false, terminal: frame };
  }
}

export function evaluateReverseProviderDispatchTraceV1(params: {
  frames: readonly unknown[];
  disconnected?: boolean;
  expectedSession?: {
    bindingId: string;
    incarnationId: string;
    ownerGeneration: string;
    hostBundleGeneration: string;
  };
}): ReverseProviderDispatchTraceResult {
  let state: ReverseProviderDispatchStateMachineV1 | undefined;
  let ignoredFrames = 0;

  for (const [frameIndex, value] of params.frames.entries()) {
    if (!state) {
      let frame: ReverseProviderDispatchFrameV1;
      try {
        frame = assertReverseProviderDispatchFrameV1(value);
      } catch (error) {
        return failure(
          "protocol-violation",
          frameIndex,
          "not-started",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (frame.type !== "operation-open") {
        return failure(
          "protocol-violation",
          frameIndex,
          "not-started",
          "first frame must open operation",
        );
      }
      if (
        params.expectedSession &&
        (frame.bindingId !== params.expectedSession.bindingId ||
          frame.incarnationId !== params.expectedSession.incarnationId ||
          frame.ownerGeneration !== params.expectedSession.ownerGeneration ||
          frame.hostBundleGeneration !== params.expectedSession.hostBundleGeneration)
      ) {
        return failure(
          "stale-generation",
          frameIndex,
          "not-started",
          "operation-open does not match the admitted session",
        );
      }
      state = new ReverseProviderDispatchStateMachineV1(frame);
      continue;
    }
    const result = state.observe(value);
    if (!result.ok) {
      return failure(result.code, frameIndex, result.certainty, result.message);
    }
    if (result.ignored) {
      ignoredFrames += 1;
    }
  }

  if (state?.terminal) {
    return {
      ok: true,
      terminal: {
        outcome: state.terminal.outcome,
        certainty: state.terminal.certainty,
        ...(state.terminal.failureCode ? { failureCode: state.terminal.failureCode } : {}),
      },
      cancelled: state.cancelled,
      ignoredFrames,
    };
  }
  if (params.disconnected && state) {
    return {
      ok: true,
      terminal: {
        outcome: "failed",
        certainty: state.certainty,
        failureCode: "connection-lost",
      },
      cancelled: state.cancelled,
      ignoredFrames,
    };
  }
  return failure(
    "incomplete-trace",
    params.frames.length,
    state?.certainty ?? "not-started",
    "trace ended without terminal outcome or disconnect",
  );
}

import {
  assertReverseProviderDispatchFrameV1,
  measureReverseProviderDispatchChunkBytesV1,
  type ReverseProviderDispatchCertainty,
  type ReverseProviderDispatchFrameV1,
  type ReverseProviderDispatchOperationOpenV1,
  type ReverseProviderDispatchTraceResult,
} from "./reverse-provider-dispatch.js";

type ExpectedSession = {
  incarnationId: string;
  ownerGeneration: string;
  hostBundleGeneration: string;
};

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
): Extract<ReverseProviderDispatchTraceResult, { ok: false }> {
  return { ok: false, code, frameIndex, certainty, message };
}

export class ReverseProviderDispatchTraceEvaluatorV1 {
  private open: ReverseProviderDispatchOperationOpenV1 | undefined;
  private requestCredit = 0;
  private responseCredit = 0;
  private requestBytes = 0;
  private responseBytes = 0;
  private requestSequence = 0;
  private responseSequence = 0;
  private requestClosed = false;
  private responseOpened = false;
  private responseClosed = false;
  private dispatchStarted = false;
  private cancelled = false;
  private ignoredFrames = 0;
  private terminal: Extract<ReverseProviderDispatchFrameV1, { type: "terminal" }> | undefined;
  private certainty: ReverseProviderDispatchCertainty = "not-started";
  private frameCount = 0;
  private failed: Extract<ReverseProviderDispatchTraceResult, { ok: false }> | undefined;

  constructor(private readonly expectedSession?: ExpectedSession) {}

  append(value: unknown): ReverseProviderDispatchTraceResult {
    if (this.failed) {
      return this.failed;
    }
    const frameIndex = this.frameCount;
    this.frameCount += 1;
    if (this.terminal) {
      this.ignoredFrames += 1;
      return this.terminalResult();
    }
    let frame: ReverseProviderDispatchFrameV1;
    try {
      frame = assertReverseProviderDispatchFrameV1(value);
    } catch (error) {
      return this.fail(
        "protocol-violation",
        frameIndex,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!this.open) {
      if (frame.type !== "operation-open") {
        return this.fail("protocol-violation", frameIndex, "first frame must open operation");
      }
      if (
        this.expectedSession &&
        (frame.incarnationId !== this.expectedSession.incarnationId ||
          frame.ownerGeneration !== this.expectedSession.ownerGeneration ||
          frame.hostBundleGeneration !== this.expectedSession.hostBundleGeneration)
      ) {
        return this.fail(
          "stale-generation",
          frameIndex,
          "operation-open does not match the admitted session",
        );
      }
      this.open = frame;
      return this.incompleteResult();
    }
    if (
      frame.operationId !== this.open.operationId ||
      frame.incarnationId !== this.open.incarnationId ||
      frame.ownerGeneration !== this.open.ownerGeneration ||
      frame.hostBundleGeneration !== this.open.hostBundleGeneration
    ) {
      this.ignoredFrames += 1;
      return this.incompleteResult();
    }
    if (encodedFrameBytes(frame) > this.open.maxFrameBytes) {
      return this.fail("protocol-violation", frameIndex, "frame exceeds maxFrameBytes");
    }
    if (frame.type === "operation-open") {
      return this.fail("protocol-violation", frameIndex, "operation is already open");
    }
    if (this.cancelled && frame.type !== "terminal") {
      this.ignoredFrames += 1;
      return this.incompleteResult();
    }
    if (frame.type === "credit") {
      if (frame.stream === "request") {
        this.requestCredit += frame.bytes;
        if (
          !Number.isSafeInteger(this.requestCredit) ||
          this.requestCredit > this.open.requestByteLimit
        ) {
          return this.fail("protocol-violation", frameIndex, "request credit exceeds byte limit");
        }
      } else {
        this.responseCredit += frame.bytes;
        if (
          !Number.isSafeInteger(this.responseCredit) ||
          this.responseCredit > this.open.responseByteLimit
        ) {
          return this.fail("protocol-violation", frameIndex, "response credit exceeds byte limit");
        }
      }
      return this.incompleteResult();
    }
    if (frame.type === "chunk") {
      const bytes = measureReverseProviderDispatchChunkBytesV1(frame.payloadBase64);
      if (bytes === 0 || bytes > this.open.maxChunkBytes) {
        return this.fail("protocol-violation", frameIndex, "chunk size is invalid");
      }
      if (frame.stream === "request") {
        if (
          this.requestClosed ||
          frame.sequence !== this.requestSequence ||
          bytes > this.requestCredit
        ) {
          return this.fail(
            "protocol-violation",
            frameIndex,
            "request chunk violates stream state or credit",
          );
        }
        this.requestSequence += 1;
        this.requestCredit -= bytes;
        this.requestBytes += bytes;
        if (this.requestBytes > this.open.requestByteLimit) {
          return this.fail("protocol-violation", frameIndex, "request byte limit exceeded");
        }
      } else {
        if (
          !this.responseOpened ||
          this.responseClosed ||
          frame.sequence !== this.responseSequence ||
          bytes > this.responseCredit
        ) {
          return this.fail(
            "protocol-violation",
            frameIndex,
            "response chunk violates stream state or credit",
          );
        }
        this.responseSequence += 1;
        this.responseCredit -= bytes;
        this.responseBytes += bytes;
        this.certainty = "response-started";
        if (this.responseBytes > this.open.responseByteLimit) {
          return this.fail("protocol-violation", frameIndex, "response byte limit exceeded");
        }
      }
      return this.incompleteResult();
    }
    if (frame.type === "half-close") {
      if (frame.stream === "request") {
        if (this.requestClosed) {
          return this.fail("protocol-violation", frameIndex, "request stream already closed");
        }
        this.requestClosed = true;
      } else {
        if (!this.responseOpened || this.responseClosed) {
          return this.fail("protocol-violation", frameIndex, "response stream is not open");
        }
        this.responseClosed = true;
      }
      return this.incompleteResult();
    }
    if (frame.type === "dispatch-started") {
      if (this.dispatchStarted) {
        return this.fail("protocol-violation", frameIndex, "dispatch already started");
      }
      this.dispatchStarted = true;
      this.certainty = "started-unconfirmed";
      return this.incompleteResult();
    }
    if (frame.type === "response-open") {
      if (!this.dispatchStarted || this.responseOpened) {
        return this.fail("protocol-violation", frameIndex, "response cannot open in current state");
      }
      this.responseOpened = true;
      this.certainty = "response-started";
      return this.incompleteResult();
    }
    if (frame.type === "cancel") {
      if (this.cancelled) {
        return this.fail("protocol-violation", frameIndex, "operation already cancelled");
      }
      this.cancelled = true;
      return this.incompleteResult();
    }
    this.terminal = frame;
    if (
      frame.outcome === "completed" &&
      (!this.requestClosed || !this.responseOpened || !this.responseClosed)
    ) {
      return this.fail(
        "protocol-violation",
        frameIndex,
        "completed outcome requires both streams to be half-closed",
      );
    }
    if (frame.outcome === "failed" && frame.certainty === "completed") {
      return this.fail("protocol-violation", frameIndex, "failed outcome cannot be completed");
    }
    if (frame.outcome === "failed" && frame.certainty !== this.certainty) {
      return this.fail(
        "protocol-violation",
        frameIndex,
        "failed outcome certainty does not match observed dispatch state",
      );
    }
    this.certainty = frame.certainty;
    return this.terminalResult();
  }

  finalize(params: { disconnected?: boolean } = {}): ReverseProviderDispatchTraceResult {
    if (this.failed) {
      return this.failed;
    }
    if (this.terminal) {
      return this.terminalResult();
    }
    if (params.disconnected && this.open) {
      return {
        ok: true,
        terminal: {
          outcome: "failed",
          certainty: this.certainty,
          failureCode: "connection-lost",
        },
        cancelled: this.cancelled,
        ignoredFrames: this.ignoredFrames,
      };
    }
    return this.incompleteResult();
  }

  private fail(
    code: Extract<ReverseProviderDispatchTraceResult, { ok: false }>["code"],
    frameIndex: number,
    message: string,
  ): Extract<ReverseProviderDispatchTraceResult, { ok: false }> {
    this.failed = failure(code, frameIndex, this.certainty, message);
    return this.failed;
  }

  private incompleteResult(): Extract<ReverseProviderDispatchTraceResult, { ok: false }> {
    return failure(
      "incomplete-trace",
      this.frameCount,
      this.certainty,
      "trace ended without terminal outcome or disconnect",
    );
  }

  private terminalResult(): Extract<ReverseProviderDispatchTraceResult, { ok: true }> {
    const terminal = this.terminal;
    if (!terminal) {
      throw new Error("terminal result requested before terminal frame");
    }
    return {
      ok: true,
      terminal: {
        outcome: terminal.outcome,
        certainty: terminal.certainty,
        ...(terminal.failureCode ? { failureCode: terminal.failureCode } : {}),
      },
      cancelled: this.cancelled,
      ignoredFrames: this.ignoredFrames,
    };
  }
}

export function createReverseProviderDispatchTraceEvaluatorV1(
  params: {
    expectedSession?: ExpectedSession;
  } = {},
): ReverseProviderDispatchTraceEvaluatorV1 {
  return new ReverseProviderDispatchTraceEvaluatorV1(params.expectedSession);
}

export function evaluateReverseProviderDispatchTraceV1(params: {
  frames: readonly unknown[];
  disconnected?: boolean;
  expectedSession?: ExpectedSession;
}): ReverseProviderDispatchTraceResult {
  const evaluator = createReverseProviderDispatchTraceEvaluatorV1({
    expectedSession: params.expectedSession,
  });
  for (const frame of params.frames) {
    const result = evaluator.append(frame);
    if (!result.ok && result.code !== "incomplete-trace") {
      return result;
    }
  }
  return evaluator.finalize({ disconnected: params.disconnected });
}

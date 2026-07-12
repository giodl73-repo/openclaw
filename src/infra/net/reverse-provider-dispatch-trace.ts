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

export function evaluateReverseProviderDispatchTraceV1(params: {
  frames: readonly unknown[];
  disconnected?: boolean;
  expectedSession?: {
    incarnationId: string;
    ownerGeneration: string;
    hostBundleGeneration: string;
  };
}): ReverseProviderDispatchTraceResult {
  let open: ReverseProviderDispatchOperationOpenV1 | undefined;
  let requestCredit = 0;
  let responseCredit = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  let requestSequence = 0;
  let responseSequence = 0;
  let requestClosed = false;
  let responseOpened = false;
  let responseClosed = false;
  let dispatchStarted = false;
  let cancelled = false;
  let ignoredFrames = 0;
  let terminal: Extract<ReverseProviderDispatchFrameV1, { type: "terminal" }> | undefined;
  let certainty: ReverseProviderDispatchCertainty = "not-started";

  for (const [frameIndex, value] of params.frames.entries()) {
    if (terminal) {
      ignoredFrames += 1;
      continue;
    }
    let frame: ReverseProviderDispatchFrameV1;
    try {
      frame = assertReverseProviderDispatchFrameV1(value);
    } catch (error) {
      return failure(
        "protocol-violation",
        frameIndex,
        certainty,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!open) {
      if (frame.type !== "operation-open") {
        return failure(
          "protocol-violation",
          frameIndex,
          certainty,
          "first frame must open operation",
        );
      }
      if (
        params.expectedSession &&
        (frame.incarnationId !== params.expectedSession.incarnationId ||
          frame.ownerGeneration !== params.expectedSession.ownerGeneration ||
          frame.hostBundleGeneration !== params.expectedSession.hostBundleGeneration)
      ) {
        return failure(
          "stale-generation",
          frameIndex,
          certainty,
          "operation-open does not match the admitted session",
        );
      }
      open = frame;
      continue;
    }
    if (
      frame.operationId !== open.operationId ||
      frame.incarnationId !== open.incarnationId ||
      frame.ownerGeneration !== open.ownerGeneration ||
      frame.hostBundleGeneration !== open.hostBundleGeneration
    ) {
      ignoredFrames += 1;
      continue;
    }
    if (encodedFrameBytes(frame) > open.maxFrameBytes) {
      return failure("protocol-violation", frameIndex, certainty, "frame exceeds maxFrameBytes");
    }
    if (frame.type === "operation-open") {
      return failure("protocol-violation", frameIndex, certainty, "operation is already open");
    }
    if (cancelled && frame.type !== "terminal") {
      ignoredFrames += 1;
      continue;
    }
    if (frame.type === "credit") {
      if (frame.stream === "request") {
        requestCredit += frame.bytes;
        if (!Number.isSafeInteger(requestCredit) || requestCredit > open.requestByteLimit) {
          return failure(
            "protocol-violation",
            frameIndex,
            certainty,
            "request credit exceeds byte limit",
          );
        }
      } else {
        responseCredit += frame.bytes;
        if (!Number.isSafeInteger(responseCredit) || responseCredit > open.responseByteLimit) {
          return failure(
            "protocol-violation",
            frameIndex,
            certainty,
            "response credit exceeds byte limit",
          );
        }
      }
      continue;
    }
    if (frame.type === "chunk") {
      const bytes = measureReverseProviderDispatchChunkBytesV1(frame.payloadBase64);
      if (bytes === 0 || bytes > open.maxChunkBytes) {
        return failure("protocol-violation", frameIndex, certainty, "chunk size is invalid");
      }
      if (frame.stream === "request") {
        if (requestClosed || frame.sequence !== requestSequence || bytes > requestCredit) {
          return failure(
            "protocol-violation",
            frameIndex,
            certainty,
            "request chunk violates stream state or credit",
          );
        }
        requestSequence += 1;
        requestCredit -= bytes;
        requestBytes += bytes;
        if (requestBytes > open.requestByteLimit) {
          return failure(
            "protocol-violation",
            frameIndex,
            certainty,
            "request byte limit exceeded",
          );
        }
      } else {
        if (
          !responseOpened ||
          responseClosed ||
          frame.sequence !== responseSequence ||
          bytes > responseCredit
        ) {
          return failure(
            "protocol-violation",
            frameIndex,
            certainty,
            "response chunk violates stream state or credit",
          );
        }
        responseSequence += 1;
        responseCredit -= bytes;
        responseBytes += bytes;
        certainty = "response-started";
        if (responseBytes > open.responseByteLimit) {
          return failure(
            "protocol-violation",
            frameIndex,
            certainty,
            "response byte limit exceeded",
          );
        }
      }
      continue;
    }
    if (frame.type === "half-close") {
      if (frame.stream === "request") {
        if (requestClosed) {
          return failure(
            "protocol-violation",
            frameIndex,
            certainty,
            "request stream already closed",
          );
        }
        requestClosed = true;
      } else {
        if (!responseOpened || responseClosed) {
          return failure(
            "protocol-violation",
            frameIndex,
            certainty,
            "response stream is not open",
          );
        }
        responseClosed = true;
      }
      continue;
    }
    if (frame.type === "dispatch-started") {
      if (dispatchStarted) {
        return failure("protocol-violation", frameIndex, certainty, "dispatch already started");
      }
      dispatchStarted = true;
      certainty = "started-unconfirmed";
      continue;
    }
    if (frame.type === "response-open") {
      if (!dispatchStarted || responseOpened) {
        return failure(
          "protocol-violation",
          frameIndex,
          certainty,
          "response cannot open in current state",
        );
      }
      responseOpened = true;
      certainty = "response-started";
      continue;
    }
    if (frame.type === "cancel") {
      if (cancelled) {
        return failure("protocol-violation", frameIndex, certainty, "operation already cancelled");
      }
      cancelled = true;
      continue;
    }
    terminal = frame;
    if (frame.outcome === "completed" && (!requestClosed || !responseOpened || !responseClosed)) {
      return failure(
        "protocol-violation",
        frameIndex,
        certainty,
        "completed outcome requires both streams to be half-closed",
      );
    }
    if (frame.outcome === "failed" && frame.certainty === "completed") {
      return failure(
        "protocol-violation",
        frameIndex,
        certainty,
        "failed outcome cannot be completed",
      );
    }
    if (frame.outcome === "failed" && frame.certainty !== certainty) {
      return failure(
        "protocol-violation",
        frameIndex,
        certainty,
        "failed outcome certainty does not match observed dispatch state",
      );
    }
    certainty = frame.certainty;
  }

  if (terminal) {
    return {
      ok: true,
      terminal: {
        outcome: terminal.outcome,
        certainty: terminal.certainty,
        ...(terminal.failureCode ? { failureCode: terminal.failureCode } : {}),
      },
      cancelled,
      ignoredFrames,
    };
  }
  if (params.disconnected && open) {
    return {
      ok: true,
      terminal: {
        outcome: "failed",
        certainty,
        failureCode: "connection-lost",
      },
      cancelled,
      ignoredFrames,
    };
  }
  return failure(
    "incomplete-trace",
    params.frames.length,
    certainty,
    "trace ended without terminal outcome or disconnect",
  );
}

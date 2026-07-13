import { randomUUID } from "node:crypto";
import type {
  OneHopFetchDispatcher,
  OneHopFetchRequest,
} from "../infra/net/one-hop-fetch-dispatcher.js";
import {
  REVERSE_PROVIDER_DISPATCH_VERSION,
  type ReverseProviderDispatchCertainty,
  type ReverseProviderDispatchFailureCode,
  type ReverseProviderDispatchFrameV1,
} from "../infra/net/reverse-provider-dispatch.js";
import type { HostProviderOperation, HostProviderRegistry } from "./host-provider-registry.js";

const DEFAULT_REQUEST_BYTE_LIMIT = 10 * 1024 * 1024;
const DEFAULT_RESPONSE_BYTE_LIMIT = 48 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_DEADLINE_MS = 30_000;

export class HostProviderDispatchError extends Error {
  readonly failureCode: ReverseProviderDispatchFailureCode;
  readonly certainty: ReverseProviderDispatchCertainty;

  constructor(
    failureCode: ReverseProviderDispatchFailureCode,
    certainty: ReverseProviderDispatchCertainty,
    message: string,
  ) {
    super(message);
    this.name = "HostProviderDispatchError";
    this.failureCode = failureCode;
    this.certainty = certainty;
  }
}

export type HostProviderOneHopDispatcherOptionsV1 = {
  registry: HostProviderRegistry;
  bindingId: string;
  routeProfile: string;
  deadlineMs?: number;
  requestByteLimit?: number;
  responseByteLimit?: number;
  maxFrameBytes?: number;
  maxChunkBytes?: number;
  createAuditCorrelation?: () => string;
};

type HostProviderOperationFrameInput = ReverseProviderDispatchFrameV1 extends infer TFrame
  ? TFrame extends ReverseProviderDispatchFrameV1
    ? Omit<
        TFrame,
        "version" | "incarnationId" | "operationId" | "ownerGeneration" | "hostBundleGeneration"
      >
    : never
  : never;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function operationFrame(
  operation: HostProviderOperation,
  frame: HostProviderOperationFrameInput,
): ReverseProviderDispatchFrameV1 {
  return {
    ...frame,
    version: REVERSE_PROVIDER_DISPATCH_VERSION,
    incarnationId: operation.open.incarnationId,
    operationId: operation.open.operationId,
    ownerGeneration: operation.open.ownerGeneration,
    hostBundleGeneration: operation.open.hostBundleGeneration,
  } as ReverseProviderDispatchFrameV1;
}

function dispatchFailure(
  failureCode: ReverseProviderDispatchFailureCode,
  certainty: ReverseProviderDispatchCertainty,
): HostProviderDispatchError {
  return new HostProviderDispatchError(
    failureCode,
    certainty,
    `Host provider dispatch failed before a complete response (${failureCode}, ${certainty})`,
  );
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries());
}

function createRequestBodySender(params: {
  operation: HostProviderOperation;
  request: Request;
  requestByteLimit: number;
  maxChunkBytes: number;
}): (credit: number) => Promise<void> {
  const reader = params.request.body?.getReader();
  let sequence = 0;
  let totalBytes = 0;
  let pending = new Uint8Array();
  let pendingOffset = 0;
  let closed = false;

  return async (credit: number) => {
    if (closed) {
      return;
    }
    if (!reader) {
      closed = true;
      if (
        !params.operation.send(
          operationFrame(params.operation, {
            type: "half-close",
            stream: "request",
          }),
        )
      ) {
        throw dispatchFailure("overloaded", "not-started");
      }
      return;
    }
    let remainingCredit = credit;
    while (remainingCredit > 0) {
      if (pendingOffset >= pending.byteLength) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        pending = chunk.value;
        pendingOffset = 0;
      }
      const payloadBytes = Math.min(
        remainingCredit,
        params.maxChunkBytes,
        pending.byteLength - pendingOffset,
      );
      const payload = pending.subarray(pendingOffset, pendingOffset + payloadBytes);
      totalBytes += payload.byteLength;
      if (totalBytes > params.requestByteLimit) {
        throw dispatchFailure("protocol-violation", "not-started");
      }
      if (
        !params.operation.send(
          operationFrame(params.operation, {
            type: "chunk",
            stream: "request",
            sequence,
            payloadBase64: Buffer.from(payload).toString("base64"),
          }),
        )
      ) {
        throw dispatchFailure("overloaded", "not-started");
      }
      pendingOffset += payload.byteLength;
      remainingCredit -= payload.byteLength;
      sequence += 1;
    }
    if (pendingOffset < pending.byteLength) {
      return;
    }
    const next = await reader.read();
    if (!next.done) {
      pending = next.value;
      pendingOffset = 0;
      return;
    }
    closed = true;
    if (
      !params.operation.send(
        operationFrame(params.operation, {
          type: "half-close",
          stream: "request",
        }),
      )
    ) {
      throw dispatchFailure("overloaded", "not-started");
    }
  };
}

function runOperation(params: {
  operation: HostProviderOperation;
  request: Request;
  requestByteLimit: number;
  responseByteLimit: number;
  maxChunkBytes: number;
  resolveResponse: (response: Response) => void;
  rejectResponse: (error: unknown) => void;
}): void {
  void (async () => {
    const reader = params.operation.frames.getReader();
    const sendRequestBody = createRequestBodySender(params);
    let responseBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    let responseOpened = false;
    let responseClosed = false;
    let responseSequence = 0;
    let responseBytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          const terminal = await params.operation.result;
          if (!terminal.ok) {
            throw dispatchFailure("protocol-violation", terminal.certainty);
          }
          if (terminal.terminal.outcome === "failed") {
            throw dispatchFailure(
              terminal.terminal.failureCode ?? "protocol-violation",
              terminal.terminal.certainty,
            );
          }
          if (!responseOpened || !responseClosed) {
            throw dispatchFailure("protocol-violation", terminal.terminal.certainty);
          }
          responseBody?.close();
          return;
        }
        const frame = next.value;
        if (frame.type === "credit" && frame.stream === "request") {
          await sendRequestBody(frame.bytes);
          continue;
        }
        if (frame.type === "response-open") {
          if (responseOpened) {
            throw dispatchFailure("protocol-violation", "response-started");
          }
          responseOpened = true;
          params.resolveResponse(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  responseBody = controller;
                },
                cancel(reason) {
                  params.operation.send(
                    operationFrame(params.operation, {
                      type: "cancel",
                      reason: typeof reason === "string" && reason ? reason : "response cancelled",
                    }),
                  );
                },
              }),
              {
                status: frame.status,
                statusText: frame.statusText,
                headers: frame.headers,
              },
            ),
          );
          continue;
        }
        if (frame.type === "chunk" && frame.stream === "response") {
          if (!responseOpened || responseClosed || frame.sequence !== responseSequence) {
            throw dispatchFailure("protocol-violation", "response-started");
          }
          const payload = Buffer.from(frame.payloadBase64, "base64");
          responseBytes += payload.byteLength;
          if (responseBytes > params.responseByteLimit) {
            throw dispatchFailure("response-limit-exceeded", "response-started");
          }
          responseSequence += 1;
          if (!responseBody) {
            throw dispatchFailure("protocol-violation", "response-started");
          }
          responseBody.enqueue(payload);
          continue;
        }
        if (frame.type === "half-close" && frame.stream === "response") {
          if (!responseOpened || responseClosed) {
            throw dispatchFailure("protocol-violation", "response-started");
          }
          responseClosed = true;
        }
      }
    } catch (error) {
      if (responseOpened && responseBody) {
        responseBody.error(error);
      } else {
        params.rejectResponse(error);
      }
      params.operation.send(
        operationFrame(params.operation, {
          type: "cancel",
          reason: "OpenClaw stopped the hosted dispatch",
        }),
      );
    } finally {
      reader.releaseLock();
    }
  })();
}

export function createHostProviderOneHopFetchDispatcherV1(
  options: HostProviderOneHopDispatcherOptionsV1,
): OneHopFetchDispatcher {
  const bindingId = options.bindingId.trim();
  const routeProfile = options.routeProfile.trim();
  if (!bindingId || !routeProfile) {
    throw new Error("Host provider dispatcher binding and route profile are required");
  }
  const deadlineMs = positiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS, "deadlineMs");
  const requestByteLimit = positiveInteger(
    options.requestByteLimit,
    DEFAULT_REQUEST_BYTE_LIMIT,
    "requestByteLimit",
  );
  const responseByteLimit = positiveInteger(
    options.responseByteLimit,
    DEFAULT_RESPONSE_BYTE_LIMIT,
    "responseByteLimit",
  );
  const maxFrameBytes = positiveInteger(
    options.maxFrameBytes,
    DEFAULT_MAX_FRAME_BYTES,
    "maxFrameBytes",
  );
  const maxChunkBytes = positiveInteger(
    options.maxChunkBytes,
    DEFAULT_MAX_CHUNK_BYTES,
    "maxChunkBytes",
  );
  if (maxChunkBytes > requestByteLimit || maxChunkBytes > responseByteLimit) {
    throw new Error("maxChunkBytes must not exceed request or response byte limits");
  }

  return {
    dispatch: async (request: OneHopFetchRequest) => {
      const prepared = new Request(request.url, request.init);
      const operation = options.registry.openOperation({
        operationId: randomUUID(),
        bindingId,
        deadlineMs,
        requestByteLimit,
        responseByteLimit,
        maxFrameBytes,
        maxChunkBytes,
        request: {
          method: prepared.method,
          url: prepared.url,
          headers: requestHeaders(prepared),
          ...(request.credentialSlotRefs?.length
            ? { credentialSlotRefs: [...request.credentialSlotRefs] }
            : {}),
          routeProfile,
          networkGuard: request.networkGuard,
          auditCorrelation: options.createAuditCorrelation?.() ?? randomUUID(),
        },
      });
      if (
        !operation.send(
          operationFrame(operation, {
            type: "credit",
            stream: "response",
            bytes: responseByteLimit,
          }),
        )
      ) {
        throw dispatchFailure("overloaded", "not-started");
      }

      const response = new Promise<Response>((resolveResponse, rejectResponse) => {
        runOperation({
          operation,
          request: prepared,
          requestByteLimit,
          responseByteLimit,
          maxChunkBytes,
          resolveResponse,
          rejectResponse,
        });
      });
      const abort = () => {
        operation.send(
          operationFrame(operation, {
            type: "cancel",
            reason: "request aborted",
          }),
        );
      };
      request.init.signal?.addEventListener("abort", abort, { once: true });
      void operation.result.finally(() => {
        request.init.signal?.removeEventListener("abort", abort);
      });
      try {
        return await response;
      } catch (error) {
        request.init.signal?.removeEventListener("abort", abort);
        throw error;
      }
    },
  };
}

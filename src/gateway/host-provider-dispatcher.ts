import { randomUUID } from "node:crypto";
import { createAbortError } from "../infra/abort-signal.js";
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
}): {
  send: (credit: number) => void;
  cancel: (reason?: unknown) => Promise<void>;
  failure: Promise<never>;
} {
  const reader = params.request.body?.getReader();
  let sequence = 0;
  let totalBytes = 0;
  let pending = new Uint8Array();
  let pendingOffset = 0;
  let availableCredit = 0;
  let closed = false;
  let released = false;
  let pumping = false;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });

  const release = () => {
    if (!reader || released) {
      return;
    }
    released = true;
    reader.releaseLock();
  };
  const cancel = async (reason?: unknown) => {
    if (!reader || released) {
      return;
    }
    closed = true;
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  };
  const pump = () => {
    if (closed || pumping) {
      return;
    }
    pumping = true;
    void (async () => {
      try {
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
        while (!closed) {
          if (pendingOffset >= pending.byteLength) {
            const chunk = await reader.read();
            if (closed) {
              return;
            }
            if (chunk.done) {
              closed = true;
              release();
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
            pending = chunk.value;
            pendingOffset = 0;
            if (totalBytes >= params.requestByteLimit) {
              throw dispatchFailure("protocol-violation", "not-started");
            }
          }
          if (pendingOffset < pending.byteLength && totalBytes >= params.requestByteLimit) {
            throw dispatchFailure("protocol-violation", "not-started");
          }
          if (availableCredit <= 0) {
            return;
          }
          const payloadBytes = Math.min(
            availableCredit,
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
          availableCredit -= payload.byteLength;
          sequence += 1;
        }
      } catch (error) {
        rejectFailure(error);
      } finally {
        pumping = false;
      }
    })();
  };
  const send = (credit: number) => {
    if (closed) {
      return;
    }
    availableCredit += credit;
    if (!Number.isSafeInteger(availableCredit)) {
      rejectFailure(dispatchFailure("protocol-violation", "not-started"));
      return;
    }
    pump();
  };
  return { send, cancel, failure };
}

function runOperation(params: {
  operation: HostProviderOperation;
  request: Request;
  requestByteLimit: number;
  responseByteLimit: number;
  maxChunkBytes: number;
  signal?: AbortSignal;
  resolveResponse: (response: Response) => void;
  rejectResponse: (error: unknown) => void;
}): void {
  void (async () => {
    const reader = params.operation.frames.getReader();
    const requestBody = createRequestBodySender(params);
    let responseBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    let responseOpened = false;
    let responseClosed = false;
    let responseSequence = 0;
    let responseBytes = 0;
    let responseCreditOutstanding = 0;
    let responseCreditRequested = false;
    let aborted = false;
    const sendResponseCredit = () => {
      if (responseClosed || responseCreditOutstanding > 0 || !responseCreditRequested) {
        return;
      }
      if (
        !params.operation.send(
          operationFrame(params.operation, {
            type: "credit",
            stream: "response",
            bytes: params.maxChunkBytes,
          }),
        )
      ) {
        throw dispatchFailure("overloaded", responseOpened ? "response-started" : "not-started");
      }
      responseCreditOutstanding = params.maxChunkBytes;
      responseCreditRequested = false;
    };
    const abort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      const error = createAbortError("Host provider dispatch aborted", {
        cause: params.signal?.reason,
      });
      if (responseOpened && responseBody) {
        responseBody.error(error);
      } else {
        params.rejectResponse(error);
      }
      void requestBody.cancel(error);
      params.operation.send(
        operationFrame(params.operation, {
          type: "cancel",
          reason: "request aborted",
        }),
      );
    };
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      responseCreditRequested = true;
      sendResponseCredit();
      for (;;) {
        const next = await Promise.race([reader.read(), requestBody.failure]);
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
          requestBody.send(frame.bytes);
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
                pull() {
                  responseCreditRequested = true;
                  sendResponseCredit();
                },
                async cancel(reason) {
                  await requestBody.cancel(reason);
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
          if (payload.byteLength > responseCreditOutstanding) {
            throw dispatchFailure("protocol-violation", "response-started");
          }
          responseCreditOutstanding -= payload.byteLength;
          responseSequence += 1;
          if (!responseBody) {
            throw dispatchFailure("protocol-violation", "response-started");
          }
          responseBody.enqueue(payload);
          sendResponseCredit();
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
      if (!aborted) {
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
      }
    } finally {
      params.signal?.removeEventListener("abort", abort);
      await requestBody.cancel("host provider operation ended");
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
      if (request.init.signal?.aborted) {
        throw createAbortError("Host provider dispatch aborted", {
          cause: request.init.signal.reason,
        });
      }
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

      const response = new Promise<Response>((resolveResponse, rejectResponse) => {
        runOperation({
          operation,
          request: prepared,
          requestByteLimit,
          responseByteLimit,
          maxChunkBytes,
          signal: request.init.signal ?? undefined,
          resolveResponse,
          rejectResponse,
        });
      });
      return await response;
    },
  };
}

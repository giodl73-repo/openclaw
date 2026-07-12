import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { WebSocket } from "ws";
import { resolveCurrentHostProviderDeclarationV1 } from "../hosting/host-provider-credentials.js";
import { evaluateReverseProviderDispatchTraceV1 } from "../infra/net/reverse-provider-dispatch-trace.js";
import {
  REVERSE_PROVIDER_DISPATCH_VERSION,
  assertReverseProviderDispatchFrameV1,
  type ReverseProviderDispatchFrameV1,
  type ReverseProviderDispatchOperationOpenV1,
  type ReverseProviderDispatchTraceResult,
} from "../infra/net/reverse-provider-dispatch.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const MAX_ACTIVE_OPERATIONS = 64;
const MAX_QUEUED_FRAMES = 256;
const MAX_QUEUED_BYTES = 1024 * 1024;
const MAX_OPERATION_FRAMES = 4096;
const MAX_OPERATION_TRACE_BYTES = 48 * 1024 * 1024;
const MAX_TOTAL_TRACE_BYTES = 128 * 1024 * 1024;
const SLOW_CONSUMER_CLOSE_CODE = 1008;
const SESSION_REPLACED_CLOSE_CODE = 4001;

type PendingOperation = {
  frames: ReverseProviderDispatchFrameV1[];
  resolve: (result: ReverseProviderDispatchTraceResult) => void;
  result: Promise<ReverseProviderDispatchTraceResult>;
  timer: ReturnType<typeof setTimeout>;
  traceBytes: number;
};

type QueuedFrame = {
  operationId: string;
  bindingId: string;
  connId: string;
  frame: ReverseProviderDispatchFrameV1;
  bytes: number;
};

export type HostProviderSession = {
  bindingId: string;
  connId: string;
  incarnationId: string;
  ownerGeneration: string;
  hostBundleGeneration: string;
  client: GatewayWsClient;
};

export type HostProviderOperation = {
  open: ReverseProviderDispatchOperationOpenV1;
  result: Promise<ReverseProviderDispatchTraceResult>;
  send: (frame: ReverseProviderDispatchFrameV1) => boolean;
};

export type HostProviderOperationOpenInput = Omit<
  ReverseProviderDispatchOperationOpenV1,
  "version" | "type" | "incarnationId" | "ownerGeneration" | "hostBundleGeneration"
>;

function encodedFrame(frame: ReverseProviderDispatchFrameV1, seq: number): string {
  return JSON.stringify({
    type: "event",
    event: "host.provider.frame",
    payload: frame,
    seq,
  });
}

function frameBytes(frame: ReverseProviderDispatchFrameV1): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

function isOutboundFrame(frame: ReverseProviderDispatchFrameV1): boolean {
  return (
    frame.type === "operation-open" ||
    frame.type === "cancel" ||
    (frame.type === "credit" && frame.stream === "response") ||
    (frame.type === "chunk" && frame.stream === "request") ||
    (frame.type === "half-close" && frame.stream === "request")
  );
}

function isInboundFrame(frame: ReverseProviderDispatchFrameV1): boolean {
  return (
    frame.type === "cancel" ||
    frame.type === "dispatch-started" ||
    frame.type === "response-open" ||
    frame.type === "terminal" ||
    (frame.type === "credit" && frame.stream === "request") ||
    (frame.type === "chunk" && frame.stream === "response") ||
    (frame.type === "half-close" && frame.stream === "response")
  );
}

function disconnectedResult(
  operation: PendingOperation,
): Extract<ReverseProviderDispatchTraceResult, { ok: true }> {
  const result = evaluateReverseProviderDispatchTraceV1({
    frames: operation.frames,
    disconnected: true,
  });
  if (result.ok) {
    return result;
  }
  return {
    ok: true,
    terminal: {
      outcome: "failed",
      certainty: result.certainty,
      failureCode: "connection-lost",
    },
    cancelled: false,
    ignoredFrames: 0,
  };
}

function currentOperationState(operation: PendingOperation): {
  certainty: Extract<ReverseProviderDispatchTraceResult, { ok: true }>["terminal"]["certainty"];
  cancelled: boolean;
  ignoredFrames: number;
} {
  const result = disconnectedResult(operation);
  return {
    certainty: result.terminal.certainty,
    cancelled: result.cancelled,
    ignoredFrames: result.ignoredFrames,
  };
}

export class HostProviderRegistry {
  private sessionsByBinding = new Map<string, HostProviderSession>();
  private bindingByConn = new Map<string, string>();
  private operations = new Map<string, PendingOperation>();
  private queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private totalTraceBytes = 0;
  private sendScheduled = false;
  private eventSequence = 0;

  constructor(
    private readonly isCurrentSession: (session: HostProviderSession) => boolean = (session) => {
      const current = resolveCurrentHostProviderDeclarationV1(session.bindingId);
      return (
        current?.ownerGeneration === session.ownerGeneration &&
        current.hostBundleGeneration === session.hostBundleGeneration
      );
    },
  ) {}

  register(client: GatewayWsClient): HostProviderSession {
    const admission = client.internal?.hostProvider;
    if (!admission) {
      throw new Error("trusted host provider admission is required");
    }
    const bindingId = admission.declaration.bindingId;
    const previous = this.sessionsByBinding.get(bindingId);
    if (previous) {
      this.disconnectSession(previous, "host provider session superseded");
      try {
        previous.client.socket.close(SESSION_REPLACED_CLOSE_CODE, "host provider superseded");
      } catch {
        // The old session is already detached; socket teardown is best effort.
      }
    }
    const session: HostProviderSession = {
      bindingId,
      connId: client.connId,
      incarnationId: randomUUID(),
      ownerGeneration: admission.declaration.ownerGeneration,
      hostBundleGeneration: admission.declaration.hostBundleGeneration,
      client,
    };
    if (!this.isCurrentSession(session)) {
      throw new Error("host provider authority changed before session registration");
    }
    this.sessionsByBinding.set(bindingId, session);
    this.bindingByConn.set(client.connId, bindingId);
    return session;
  }

  unregister(connId: string): boolean {
    const bindingId = this.bindingByConn.get(connId);
    if (!bindingId) {
      return false;
    }
    const session = this.sessionsByBinding.get(bindingId);
    if (!session || session.connId !== connId) {
      this.bindingByConn.delete(connId);
      return false;
    }
    this.disconnectSession(session, "host provider disconnected");
    return true;
  }

  openOperation(input: HostProviderOperationOpenInput): HostProviderOperation {
    const session = this.sessionsByBinding.get(input.bindingId);
    if (!session) {
      throw new Error(`host provider is not connected for ${input.bindingId}`);
    }
    if (!this.revalidateSession(session)) {
      throw new Error(`host provider authority is stale for ${input.bindingId}`);
    }
    if (this.operations.size >= MAX_ACTIVE_OPERATIONS) {
      throw new Error("host provider operation capacity exceeded");
    }
    if (this.operations.has(input.operationId)) {
      throw new Error(`host provider operation already exists: ${input.operationId}`);
    }
    const open = assertReverseProviderDispatchFrameV1({
      ...input,
      version: REVERSE_PROVIDER_DISPATCH_VERSION,
      type: "operation-open",
      incarnationId: session.incarnationId,
      ownerGeneration: session.ownerGeneration,
      hostBundleGeneration: session.hostBundleGeneration,
    });
    if (open.type !== "operation-open") {
      throw new Error("host provider operation-open frame is invalid");
    }
    const openBytes = frameBytes(open);
    if (
      openBytes > MAX_OPERATION_TRACE_BYTES ||
      this.totalTraceBytes + openBytes > MAX_TOTAL_TRACE_BYTES
    ) {
      throw new Error("host provider operation memory capacity exceeded");
    }
    let resolveResult!: (result: ReverseProviderDispatchTraceResult) => void;
    const result = new Promise<ReverseProviderDispatchTraceResult>((resolve) => {
      resolveResult = resolve;
    });
    const timer = setTimeout(
      () => {
        const pending = this.operations.get(open.operationId);
        if (!pending) {
          return;
        }
        const current = currentOperationState(pending);
        this.settle(open.operationId, {
          ok: true,
          terminal: {
            outcome: "failed",
            certainty: current.certainty,
            failureCode: "timeout",
          },
          cancelled: current.cancelled,
          ignoredFrames: current.ignoredFrames,
        });
      },
      resolveTimerTimeoutMs(open.deadlineMs, 1),
    );
    timer.unref?.();
    const operation: PendingOperation = {
      frames: [open],
      resolve: resolveResult,
      result,
      timer,
      traceBytes: openBytes,
    };
    this.totalTraceBytes += operation.traceBytes;
    this.operations.set(open.operationId, operation);
    if (!this.enqueue(session, open)) {
      this.settle(open.operationId, {
        ok: true,
        terminal: {
          outcome: "failed",
          certainty: "not-started",
          failureCode: "overloaded",
        },
        cancelled: false,
        ignoredFrames: 0,
      });
    }
    return {
      open,
      result,
      send: (frame) => this.sendOperationFrame(frame),
    };
  }

  receiveFrame(connId: string, value: unknown): ReverseProviderDispatchTraceResult {
    const session = this.sessionForConn(connId);
    if (!this.revalidateSession(session)) {
      throw new Error("host provider session authority is stale");
    }
    const frame = assertReverseProviderDispatchFrameV1(value);
    if (!isInboundFrame(frame)) {
      throw new Error("host provider frame direction is invalid");
    }
    const operation = this.operations.get(frame.operationId);
    if (!operation) {
      throw new Error(`host provider operation is not active: ${frame.operationId}`);
    }
    this.assertSessionFrame(session, frame);
    return this.appendAndEvaluate(frame.operationId, frame);
  }

  revokeAll(reason = "host provider access revoked"): void {
    for (const session of this.sessionsByBinding.values()) {
      this.disconnectSession(session, reason);
      try {
        session.client.socket.close(SESSION_REPLACED_CLOSE_CODE, reason);
      } catch {
        // Session state is already revoked.
      }
    }
  }

  revalidateSessions(): void {
    for (const session of this.sessionsByBinding.values()) {
      this.revalidateSession(session);
    }
  }

  shutdown(): void {
    this.revokeAll("gateway shutdown");
  }

  private sendOperationFrame(frame: ReverseProviderDispatchFrameV1): boolean {
    const operation = this.operations.get(frame.operationId);
    if (!operation) {
      return false;
    }
    const open = operation.frames[0];
    if (!open || open.type !== "operation-open") {
      return false;
    }
    const session = this.sessionsByBinding.get(open.bindingId);
    if (!session) {
      this.settle(frame.operationId, disconnectedResult(operation));
      return false;
    }
    if (!this.revalidateSession(session)) {
      return false;
    }
    const parsed = assertReverseProviderDispatchFrameV1(frame);
    if (!isOutboundFrame(parsed)) {
      throw new Error("host provider frame direction is invalid");
    }
    this.assertSessionFrame(session, parsed);
    const result = this.appendAndEvaluate(frame.operationId, parsed);
    if (result?.ok || (result && result.code !== "incomplete-trace")) {
      return result.ok;
    }
    if (!this.enqueue(session, parsed)) {
      this.settle(frame.operationId, {
        ok: true,
        terminal: {
          outcome: "failed",
          certainty: result.certainty,
          failureCode: "overloaded",
        },
        cancelled: false,
        ignoredFrames: 0,
      });
      return false;
    }
    return true;
  }

  private appendAndEvaluate(
    operationId: string,
    frame: ReverseProviderDispatchFrameV1,
  ): ReverseProviderDispatchTraceResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`host provider operation is not active: ${operationId}`);
    }
    if (operation.frames.length >= MAX_OPERATION_FRAMES) {
      const current = currentOperationState(operation);
      const result: ReverseProviderDispatchTraceResult = {
        ok: false,
        code: "protocol-violation",
        frameIndex: operation.frames.length,
        certainty: current.certainty,
        message: "operation frame capacity exceeded",
      };
      this.settle(operationId, result);
      return result;
    }
    const nextFrameBytes = frameBytes(frame);
    if (
      operation.traceBytes + nextFrameBytes > MAX_OPERATION_TRACE_BYTES ||
      this.totalTraceBytes + nextFrameBytes > MAX_TOTAL_TRACE_BYTES
    ) {
      const current = currentOperationState(operation);
      const result: ReverseProviderDispatchTraceResult = {
        ok: true,
        terminal: {
          outcome: "failed",
          certainty: current.certainty,
          failureCode: "overloaded",
        },
        cancelled: current.cancelled,
        ignoredFrames: current.ignoredFrames,
      };
      this.settle(operationId, result);
      return result;
    }
    operation.frames.push(frame);
    operation.traceBytes += nextFrameBytes;
    this.totalTraceBytes += nextFrameBytes;
    const result = evaluateReverseProviderDispatchTraceV1({ frames: operation.frames });
    if (result.ok || result.code !== "incomplete-trace") {
      this.settle(operationId, result);
    }
    return result;
  }

  private enqueue(session: HostProviderSession, frame: ReverseProviderDispatchFrameV1): boolean {
    const encoded = encodedFrame(frame, Number.MAX_SAFE_INTEGER);
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (
      this.queue.length >= MAX_QUEUED_FRAMES ||
      bytes > MAX_QUEUED_BYTES ||
      this.queuedBytes + bytes > MAX_QUEUED_BYTES
    ) {
      return false;
    }
    this.queue.push({
      operationId: frame.operationId,
      bindingId: session.bindingId,
      connId: session.connId,
      frame,
      bytes,
    });
    this.queuedBytes += bytes;
    this.scheduleSend();
    return true;
  }

  private scheduleSend(): void {
    if (this.sendScheduled) {
      return;
    }
    this.sendScheduled = true;
    setImmediate(() => {
      this.sendScheduled = false;
      const queued = this.queue.shift();
      if (!queued) {
        return;
      }
      this.queuedBytes -= queued.bytes;
      const current = this.sessionsByBinding.get(queued.bindingId);
      if (!current || current.connId !== queued.connId) {
        const operation = this.operations.get(queued.operationId);
        if (operation) {
          this.settle(queued.operationId, disconnectedResult(operation));
        }
      } else if (
        current.client.socket.readyState !== WebSocket.OPEN ||
        current.client.socket.bufferedAmount > MAX_BUFFERED_BYTES
      ) {
        this.disconnectSession(current, "host provider slow consumer");
        try {
          current.client.socket.close(SLOW_CONSUMER_CLOSE_CODE, "slow consumer");
        } catch {
          // Disconnect already settled pending operations.
        }
      } else {
        this.eventSequence += 1;
        try {
          current.client.socket.send(encodedFrame(queued.frame, this.eventSequence));
        } catch {
          this.disconnectSession(current, "host provider send failed");
        }
      }
      if (this.queue.length > 0) {
        this.scheduleSend();
      }
    });
  }

  private sessionForConn(connId: string): HostProviderSession {
    const bindingId = this.bindingByConn.get(connId);
    const session = bindingId ? this.sessionsByBinding.get(bindingId) : undefined;
    if (!session || session.connId !== connId) {
      throw new Error("host provider session is not current");
    }
    return session;
  }

  private assertSessionFrame(
    session: HostProviderSession,
    frame: ReverseProviderDispatchFrameV1,
  ): void {
    if (
      frame.incarnationId !== session.incarnationId ||
      frame.ownerGeneration !== session.ownerGeneration ||
      frame.hostBundleGeneration !== session.hostBundleGeneration
    ) {
      throw new Error("host provider frame does not match the admitted session");
    }
  }

  private revalidateSession(session: HostProviderSession): boolean {
    if (this.isCurrentSession(session)) {
      return true;
    }
    this.disconnectSession(session, "host provider authority changed");
    try {
      session.client.socket.close(SESSION_REPLACED_CLOSE_CODE, "host provider authority changed");
    } catch {
      // Session state and pending operations are already revoked.
    }
    return false;
  }

  private settle(operationId: string, result: ReverseProviderDispatchTraceResult): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return;
    }

    this.operations.delete(operationId);
    clearTimeout(operation.timer);
    this.totalTraceBytes -= operation.traceBytes;
    this.queue = this.queue.filter((entry) => entry.operationId !== operationId);
    this.queuedBytes = this.queue.reduce((total, entry) => total + entry.bytes, 0);
    operation.resolve(result);
  }

  private disconnectSession(session: HostProviderSession, _reason: string): void {
    this.sessionsByBinding.delete(session.bindingId);
    this.bindingByConn.delete(session.connId);
    const queuedOperationIds = new Set(
      this.queue
        .filter((entry) => {
          const open = this.operations.get(entry.operationId)?.frames[0];
          return open?.type === "operation-open" && open.bindingId === session.bindingId;
        })
        .map((entry) => entry.operationId),
    );
    this.queue = this.queue.filter((entry) => !queuedOperationIds.has(entry.operationId));
    this.queuedBytes = this.queue.reduce((total, entry) => total + entry.bytes, 0);
    for (const [operationId, operation] of this.operations) {
      const open = operation.frames[0];
      if (open?.type === "operation-open" && open.bindingId === session.bindingId) {
        this.settle(operationId, disconnectedResult(operation));
      }
    }
  }
}

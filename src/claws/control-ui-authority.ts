import { MessageChannel, type MessagePort } from "node:worker_threads";

/** The host answers each effect separately; the worker never inherits host credentials. */
export function createClawControlUiAuthority(assertCurrent: () => void) {
  const { port1, port2 } = new MessageChannel();
  let closed = false;
  port1.on("message", (buffer: unknown) => {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== 4) {
      return;
    }
    const decision = new Int32Array(buffer);
    let granted = false;
    try {
      if (!closed) {
        assertCurrent();
        granted = true;
      }
    } catch {
      // A refusal is deliberately independent of any private authorization details.
    }
    Atomics.compareExchange(decision, 0, 0, granted ? 1 : 2);
    Atomics.notify(decision, 0);
  });
  return {
    port: port2,
    close() {
      closed = true;
      port1.close();
      port2.close();
    },
  };
}

export function clawControlUiCommitGuard(port: MessagePort): () => void {
  return () => {
    const decision = new Int32Array(new SharedArrayBuffer(4));
    port.postMessage(decision.buffer);
    // Only the worker waits. A dead host must not strand a write-capable worker.
    Atomics.wait(decision, 0, 0, 30_000);
    if (Atomics.compareExchange(decision, 0, 0, 2) !== 1) {
      throw new Error("Claw mutation authority is no longer active.");
    }
  };
}

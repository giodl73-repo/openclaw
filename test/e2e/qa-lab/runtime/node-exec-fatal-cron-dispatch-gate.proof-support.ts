import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "../../../../packages/gateway-client/src/websocket.js";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type Invoke = { id: string; nodeId: string; command: string };
type InvokeResult = {
  id: string;
  nodeId: string;
  ok: boolean;
  error?: { code?: string; message?: string };
};

/** Delay only dispatch; all requests and replies retain their original wire bytes. */
export async function startNodeDispatchGate(params: {
  gatewayUrl: string;
  signal: AbortSignal;
  beforeRun: (invoke: Invoke) => Promise<void>;
}) {
  const owned = await reserveTestPortListener({
    offsets: [0],
    signal: params.signal,
    createListener: () => createServer((_request, response) => response.writeHead(404).end()),
  });
  const server = new WebSocketServer({ server: owned.listener });
  const sockets = new Set<WebSocket>();
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const invokes: Invoke[] = [];
  const results: InvokeResult[] = [];
  let stopped = false;
  server.on("connection", (node) => {
    const gateway = new WebSocket(params.gatewayUrl);
    sockets.add(node);
    sockets.add(gateway);
    const fail = (error: unknown) => {
      if (!stopped) {
        errors.push(error);
      }
      node.terminate();
      gateway.terminate();
    };
    const opened = new Promise<void>((resolve, reject) => {
      gateway.once("open", resolve);
      gateway.once("error", reject);
      gateway.once("close", () => reject(new Error("Dispatch gate upstream closed")));
    });
    void opened.catch(fail);
    const track = (operation: Promise<void>) => {
      const settled = operation.catch(fail).finally(() => pending.delete(settled));
      pending.add(settled);
    };
    node.on("message", (bytes, binary) =>
      track(
        (async () => {
          const frame = JSON.parse(bytes.toString()) as { method?: string; params?: InvokeResult };
          if (frame.method === "node.invoke.result" && frame.params) {
            results.push(frame.params);
          }
          await opened;
          gateway.send(bytes, { binary });
        })(),
      ),
    );
    gateway.on("message", (bytes, binary) =>
      track(
        (async () => {
          const frame = JSON.parse(bytes.toString()) as { event?: string; payload?: Invoke };
          if (frame.event === "node.invoke.request" && frame.payload) {
            invokes.push(frame.payload);
            if (frame.payload.command === "system.run") {
              await params.beforeRun(frame.payload);
            }
          }
          node.send(bytes, { binary });
        })(),
      ),
    );
    node.on("error", fail);
    gateway.on("error", fail);
    node.on("close", () => {
      sockets.delete(node);
      gateway.terminate();
    });
    gateway.on("close", () => {
      sockets.delete(gateway);
      node.terminate();
    });
  });
  return {
    port: owned.claim.port,
    invokes,
    results,
    errors,
    stop: () =>
      runQaGatewayFixture(
        async () => {
          stopped = true;
          for (const socket of sockets) {
            socket.terminate();
          }
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          await Promise.all(pending);
        },
        () => owned.releaseListener(),
        () => owned.claim.release(),
      ),
  };
}

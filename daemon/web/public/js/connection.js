// WebSocket lifecycle, request correlation and reconnect backoff. The socket
// and clock are injectable.
import { makeStateDecoder } from "./state-wire.js";
/**
 * @typedef {object} Socket
 * @property {number} readyState
 * @property {WebSocket["send"]} send
 * @property {WebSocket["close"]} close
 * @property {WebSocket["addEventListener"]} addEventListener
 * @typedef {{new(url: string, protocols?: string | string[]): Socket, OPEN: number}} SocketFactory
 * @param {object} options
 * @param {ReturnType<typeof import("./model.js").createModel>} options.model
 * @param {string} options.url
 * @param {SocketFactory} [options.WebSocketClass]
 * @param {(callback: () => void, delay: number) => number} [options.schedule]
 * @param {(timer: number) => void} [options.cancel]
 * @param {(frame: object) => void} [options.onFrame]
 * @param {(status: string) => void} [options.onStatus]
 * @param {() => void} [options.onReady]
 * @param {() => string} [options.offlineMessage]
 * @param {() => string} [options.errorMessage]
 */
export function createConnection(
  {
    model,
    url,
    WebSocketClass = globalThis.WebSocket,
    schedule = globalThis.setTimeout,
    cancel = globalThis.clearTimeout,
    onFrame = () => {},
    onStatus = () => {},
    onReady = () => {},
    offlineMessage = () => "Disconnected",
    errorMessage = () => "Request failed",
  },
) {
  function command(cmd, args = {}) {
    return new Promise((resolve, reject) => {
      if (
        !model.connected || model.socket?.readyState !== WebSocketClass.OPEN
      ) {
        reject(Object.assign(new Error(offlineMessage()), { unsent: true }));
        return;
      }
      const id = ++model.requestNumber;
      // onReady reloads the active chat's first page after a reconnect.
      const reloadOnResync = cmd === "history" && !("before" in args) &&
        String(args.chat || "") === model.active;
      model.requests.set(id, { resolve, reject, reloadOnResync });
      try {
        model.socket.send(JSON.stringify({ id, cmd, ...args }));
      } catch {
        model.requests.delete(id);
        reject(Object.assign(new Error(offlineMessage()), { unsent: true }));
      }
    });
  }
  function rejectPending(resync = false) {
    for (const request of model.requests.values()) {
      request.reject(
        Object.assign(new Error(offlineMessage()), {
          ambiguous: true,
          ...(resync && request.reloadOnResync ? { resync: true } : {}),
        }),
      );
    }
    model.requests.clear();
  }
  function connect(quiet = false) {
    if (!model.signedIn) return;
    cancel(model.retryTimer);
    if (!quiet) onStatus(model.everConnected ? "reconnecting" : "connecting");
    const socket = new WebSocketClass(url, "enil-state-delta-v1");
    const decodeState = makeStateDecoder();
    let gotFrame = false, resyncing = quiet;
    model.socket = socket;
    const reconnect = model.everConnected;
    socket.addEventListener("message", (event) => {
      if (model.socket !== socket) return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      const decoded = decodeState(frame);
      if (decoded.resync) {
        // One immediate, quiet reconnect recovers the missing snapshot. If
        // that connection also desynchronizes, use ordinary backoff.
        if (resyncing) {
          socket.close();
          return;
        }
        // Keep the visible status while the new socket connects. Commands
        // still check its readyState; a failed reconnect goes offline normally.
        model.socket = null;
        rejectPending(true);
        socket.close();
        connect(true);
        return;
      }
      if (!decoded.frame) return;
      frame = decoded.frame;
      const firstFrame = !gotFrame;
      gotFrame = true;
      if (frame.web === "state") resyncing = false;
      if (firstFrame) {
        model.connected = true;
        model.everConnected = true;
        model.retryDelay = 1000;
        onStatus("connected");
      }
      if (typeof frame.id === "number" && model.requests.has(frame.id)) {
        const request = model.requests.get(frame.id);
        model.requests.delete(frame.id);
        if (frame.ok) request.resolve(frame.data);
        else {request.reject(
            Object.assign(new Error(String(frame.error || errorMessage())), {
              refused: true,
            }),
          );}
      } else onFrame(frame);
      if (firstFrame && reconnect) onReady();
    });
    socket.addEventListener("close", () => {
      if (model.socket !== socket) return;
      model.connected = false;
      rejectPending();
      onStatus("reconnecting");
      if (model.signedIn) {
        model.retryTimer = schedule(connect, model.retryDelay);
        model.retryDelay = Math.min(model.retryDelay * 2, 15000);
      }
    });
  }
  function stop() {
    model.signedIn = false;
    cancel(model.retryTimer);
    model.socket?.close();
  }
  function start() {
    model.signedIn = true;
    connect();
  }
  return { command, start, stop };
}

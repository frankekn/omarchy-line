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
  // A page left open across a server downgrade can retry without the newer
  // subprotocol when the handshake never yields a frame.
  let tryLegacy = false;
  function command(cmd, args = {}) {
    return new Promise((resolve, reject) => {
      if (
        !model.connected || model.socket?.readyState !== WebSocketClass.OPEN
      ) {
        reject(Object.assign(new Error(offlineMessage()), { unsent: true }));
        return;
      }
      const id = ++model.requestNumber;
      model.requests.set(id, { resolve, reject });
      try {
        model.socket.send(JSON.stringify({ id, cmd, ...args }));
      } catch {
        model.requests.delete(id);
        reject(Object.assign(new Error(offlineMessage()), { unsent: true }));
      }
    });
  }
  function connect() {
    if (!model.signedIn) return;
    cancel(model.retryTimer);
    onStatus(model.everConnected ? "reconnecting" : "connecting");
    const negotiated = !tryLegacy;
    const socket = negotiated
      ? new WebSocketClass(url, "enil-state-delta-v1")
      : new WebSocketClass(url);
    const decodeState = makeStateDecoder();
    let gotFrame = false;
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
        socket.close();
        return;
      }
      if (!decoded.frame) return;
      frame = decoded.frame;
      gotFrame = true;
      const firstFrame = !model.connected;
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
      tryLegacy = !gotFrame && negotiated;
      model.connected = false;
      for (const request of model.requests.values()) {
        request.reject(
          Object.assign(new Error(offlineMessage()), { ambiguous: true }),
        );
      }
      model.requests.clear();
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

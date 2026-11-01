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
 * @param {(signal: AbortSignal) => Promise<boolean>} [options.onRejected]
 * @param {() => void} [options.onExpired]
 * @param {() => string} [options.offlineMessage]
 * @param {() => string} [options.errorMessage]
 * @param {EventTarget} [options.network] fires `online`: the window
 * @param {EventTarget & {visibilityState?: string}} [options.visibility]
 *   fires `visibilitychange`: the document
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
    onRejected,
    onExpired = () => {},
    offlineMessage = () => "Disconnected",
    errorMessage = () => "Request failed",
    network = globalThis.window,
    visibility = globalThis.document,
  },
) {
  // The network coming back or the tab becoming visible skips the backoff
  // wait once per outage. Later attempts in the same outage use the backoff,
  // so repeated events cannot cause a reconnect storm.
  let wokeEarly = false;
  function wake() {
    if (!model.signedIn || model.connected || wokeEarly) return;
    if (visibility && visibility.visibilityState === "hidden") return;
    // Only a pending retry is skipped: a socket that is still connecting is
    // left alone, so two events in a row open one socket.
    if (model.socket && model.socket.readyState < 2) return;
    if (model.retryTimer == null) return;
    wokeEarly = true;
    connect();
  }
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
    model.retryTimer = null;
    if (!quiet) onStatus(model.everConnected ? "reconnecting" : "connecting");
    const socket = new WebSocketClass(url, "enil-state-delta-v1");
    const decodeState = makeStateDecoder();
    let gotFrame = false, resyncing = quiet;
    model.socket = socket;
    const reconnect = model.everConnected;
    let beforeFirstFrame = true;
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
        cancelSessionCheck();
        model.connected = true;
        model.everConnected = true;
        model.retryDelay = 1000;
        wokeEarly = false;
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
      beforeFirstFrame = false;
    });
    socket.addEventListener("close", () => {
      if (model.socket !== socket) return;
      model.connected = false;
      rejectPending();
      onStatus("reconnecting");
      if (model.signedIn) {
        if (beforeFirstFrame) checkRejectedSession();
        model.retryTimer = schedule(connect, model.retryDelay);
        model.retryDelay = Math.min(model.retryDelay * 2, 15000);
      }
    });
  }
  function listen(on) {
    if (on) {
      network?.addEventListener("online", wake);
      visibility?.addEventListener("visibilitychange", wake);
    } else {
      network?.removeEventListener("online", wake);
      visibility?.removeEventListener("visibilitychange", wake);
    }
  }
  function stop() {
    model.signedIn = false;
    listen(false);
    cancelSessionCheck();
    cancel(model.retryTimer);
    model.retryTimer = null;
    model.socket?.close();
  }
  function start() {
    cancelSessionCheck();
    model.signedIn = true;
    wokeEarly = false;
    listen(true);
    connect();
  }
  let sessionCheck;
  function cancelSessionCheck() {
    if (!sessionCheck) return;
    clearTimeout(sessionCheck.timer);
    sessionCheck.controller.abort();
    sessionCheck = null;
  }
  function checkRejectedSession() {
    if (!onRejected || sessionCheck) return;
    const controller = new AbortController();
    const check = { controller, timer: 0 };
    sessionCheck = check;
    check.timer = setTimeout(() => {
      if (sessionCheck === check) sessionCheck = null;
      controller.abort();
    }, 10000);
    Promise.resolve().then(() => onRejected(controller.signal)).then(
      (expired) => {
        if (sessionCheck !== check) return;
        sessionCheck = null;
        if (expired && model.signedIn && !model.connected) {
          stop();
          onExpired();
        }
      },
    ).catch(() => {}).finally(() => {
      clearTimeout(check.timer);
      if (sessionCheck === check) sessionCheck = null;
    });
  }
  return { command, start, stop };
}

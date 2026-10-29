/**
 * The page's live channel: one browser WebSocket bridged to its own
 * connection on the daemon's unix socket, so the page gets exactly what a
 * panel gets (the same replies, the same push frames, the same ordering), plus
 * the two files a panel would watch: state.json whenever it changes, and
 * events.json once per connection to catch up.
 *
 * Frames to the browser: daemon lines verbatim, and
 *   {"web":"state","state":<state.json>}   on connect and on every change
 *   {"web":"events","events":<events.json>} on connect, when the file exists
 * Close code 4001 means the daemon is not there; the page reconnects.
 *
 * What the bridge refuses: the clipboard commands (they read the daemon
 * host's clipboard, not the browser's) and a sendFile whose path is not an
 * upload this server stored.
 *
 * Dependency direction: imports ./files.ts for the upload check.
 */
import { TextLineStream } from "@std/streams/text-line-stream";
import type { Uploads } from "./files.ts";

const STATE_POLL_MS = 500;
/** A browser this far behind is dropped; it reconnects and catches up. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
export const CLOSE_DAEMON_OFFLINE = 4001;
const CLOSE_TOO_SLOW = 4002;
const REFUSED_CMDS = new Set([
  "probeClipboardImage",
  "sendClipboardImage",
  "discardClipboardImage",
]);

type Send = (frame: string) => void;

/**
 * state.json for every open page, read once per change rather than once per
 * page. The file is atomically replaced, so its mtime moves on every write.
 */
export class StateFeed {
  readonly #path: string;
  readonly #subscribers = new Set<Send>();
  #text = "";
  #mtime = -1;
  #polling = false;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(path: string) {
    this.#path = path;
    this.#timer = setInterval(() => {
      if (this.#polling || this.#subscribers.size === 0) return;
      this.#polling = true;
      this.#poll().finally(() => this.#polling = false);
    }, STATE_POLL_MS);
  }

  /** Subscribe, and get the current state at once. */
  async add(send: Send): Promise<void> {
    this.#subscribers.add(send);
    if (this.#text) send(stateFrame(this.#text));
    else await this.#poll();
  }

  delete(send: Send): void {
    this.#subscribers.delete(send);
  }

  close(): void {
    clearInterval(this.#timer);
    this.#subscribers.clear();
  }

  async #poll(): Promise<void> {
    const info = await Deno.stat(this.#path).catch(() => null);
    const mtime = info?.mtime?.getTime() ?? -1;
    if (mtime === this.#mtime) return;
    const text = await Deno.readTextFile(this.#path).catch(() => "");
    if (!isJson(text)) return; // gone or mid-write: the next poll sees it
    this.#mtime = mtime;
    this.#text = text;
    const frame = stateFrame(text);
    for (const send of this.#subscribers) send(frame);
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function stateFrame(text: string): string {
  return `{"web":"state","state":${text}}`;
}

export interface BridgeDeps {
  sockPath: string;
  eventsPath: string;
  feed: StateFeed;
  uploads: Uploads;
  connections: Set<() => void>;
}

/** Upgrade `req` and bridge it; the caller has already checked who it is. */
export function bridge(req: Request, deps: BridgeDeps): Response {
  const { socket: ws, response } = Deno.upgradeWebSocket(req, {
    idleTimeout: 60,
  });
  const encoder = new TextEncoder();
  let conn: Deno.UnixConn | null = null;
  let closed = false;
  const close = () => shut(1001, "server stopped");
  /** request id → uploaded file to remove once the daemon has answered. */
  const sentUploads = new Map<unknown, string>();

  const send: Send = (frame) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      shut(CLOSE_TOO_SLOW, "too slow");
      return;
    }
    ws.send(frame);
  };
  const shut = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    deps.connections.delete(close);
    deps.feed.delete(send);
    try {
      conn?.close();
    } catch { /* already closed */ }
    conn = null;
    // An upload whose send may still be reading it stays; the sweep takes it.
    if (ws.readyState < WebSocket.CLOSING) {
      try {
        ws.close(code, reason);
      } catch { /* closed under us */ }
    }
  };
  const refuse = (id: unknown, error: string) =>
    send(JSON.stringify({ id, ok: false, error }));

  // Commands wait for the daemon connection, then go one at a time in arrival
  // order: a sendFile resolving its path must not let a later command pass it.
  let ready!: () => void;
  let inbound = new Promise<void>((resolve) => ready = resolve);

  const toDaemon = async (line: string) => {
    const c = conn;
    if (!c) return;
    const bytes = encoder.encode(line + "\n");
    let off = 0;
    while (off < bytes.length) off += await c.write(bytes.subarray(off));
  };

  const relay = async (data: unknown): Promise<void> => {
    if (closed || typeof data !== "string") return;
    let req: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      req = parsed;
    } catch {
      return;
    }
    const cmd = req.cmd;
    if (typeof cmd !== "string") return refuse(req.id, "bad request");
    if (REFUSED_CMDS.has(cmd)) {
      return refuse(req.id, "網頁版不能使用這台主機的剪貼簿");
    }
    if (cmd === "sendFile") {
      const real = await deps.uploads.owned(req.path);
      if (!real) return refuse(req.id, "只能傳送從網頁上傳的檔案");
      req.path = real;
      sentUploads.set(req.id, real);
    }
    await toDaemon(JSON.stringify(req));
  };

  const fromDaemon = async (c: Deno.UnixConn) => {
    const lines = c.readable.pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) {
      if (sentUploads.size) await releaseUpload(line);
      send(line);
    }
  };

  const releaseUpload = async (line: string) => {
    let reply: { id?: unknown; ok?: unknown } | null = null;
    try {
      reply = JSON.parse(line);
    } catch { /* not a reply */ }
    if (!reply || !("ok" in reply)) return;
    const path = sentUploads.get(reply.id);
    if (path === undefined) return;
    sentUploads.delete(reply.id);
    await deps.uploads.discard(path);
  };

  ws.onopen = async () => {
    try {
      const connected = await Deno.connect({
        transport: "unix",
        path: deps.sockPath,
      });
      if (closed) {
        connected.close();
        return;
      }
      conn = connected;
    } catch {
      shut(CLOSE_DAEMON_OFFLINE, "daemon offline");
      return;
    }
    await deps.feed.add(send);
    const events = await Deno.readTextFile(deps.eventsPath).catch(() => "");
    if (isJson(events)) send(`{"web":"events","events":${events}}`);
    ready();
    try {
      await fromDaemon(conn);
    } catch { /* closed under us */ }
    shut(CLOSE_DAEMON_OFFLINE, "daemon offline");
  };
  ws.onmessage = (ev) => {
    inbound = inbound.then(() => relay(ev.data)).catch(() =>
      shut(CLOSE_DAEMON_OFFLINE, "daemon offline")
    );
  };
  ws.onclose = () => shut(1000, "");
  ws.onerror = () => shut(1011, "");
  deps.connections.add(close);
  return response;
}

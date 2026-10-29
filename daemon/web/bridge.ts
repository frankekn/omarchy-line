/**
 * The page's live channel: one browser WebSocket bridged to its own
 * connection on the daemon's unix socket, so the page gets exactly what a
 * panel gets (the same replies, the same push frames, the same ordering), plus
 * the two files a panel would watch: state.json whenever it changes, and
 * events.json once per connection to catch up.
 *
 * Frames to the browser: daemon lines verbatim, and
 *   {"web":"state",...,"state":<state.json>} on connect and full updates
 *   {"web":"state-delta",...}                 for smaller large-state updates
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
const MIN_DELTA_STATE_BYTES = 20 * 1024;
const STATE_DELTA_PROTOCOL = "enil-state-delta-v1";
/** A browser this far behind is dropped; it reconnects and catches up. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_INBOUND_QUEUE = 128;
const MAX_INBOUND_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_COMMANDS = 256;
export const CLOSE_DAEMON_OFFLINE = 4001;
const CLOSE_TOO_SLOW = 4002;
const CLOSE_BAD_FRAME = 4003;
const CLOSE_INBOUND_OVERLOAD = 4004;
const REFUSED_CMDS = new Set([
  "probeClipboardImage",
  "sendClipboardImage",
  "discardClipboardImage",
]);

type Send = (frame: string) => void;
type Subscriber = { delta: boolean; initialized: boolean };
type StateObject = Record<string, unknown>;
type ChatRow = StateObject & { mid: string };

function object(value: unknown): StateObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as StateObject
    : null;
}

function chatRows(state: StateObject | null): ChatRow[] | null {
  if (!Array.isArray(state?.chats)) return null;
  const seen = new Set<string>(), rows: ChatRow[] = [];
  for (const value of state.chats) {
    const row = object(value), mid = row?.mid;
    if (typeof mid !== "string" || !mid || seen.has(mid)) return null;
    seen.add(mid);
    rows.push(row as ChatRow);
  }
  return rows;
}

/** Produce a patch only when unchanged rows retain their relative order. */
function stateDelta(
  previous: unknown,
  next: unknown,
  generation: string,
  base: number,
  version: number,
): string | null {
  const before = object(previous), after = object(next);
  const oldRows = chatRows(before), newRows = chatRows(after);
  const oldAccount = object(before?.me)?.mid, account = object(after?.me)?.mid;
  if (
    !before || !after || !oldRows || !newRows ||
    typeof before.bootId !== "string" || !before.bootId ||
    before.bootId !== after.bootId || typeof account !== "string" || !account ||
    oldAccount !== account
  ) return null;
  const old = new Map(oldRows.map((row) => [row.mid, row]));
  const nextIds = new Set(newRows.map((row) => row.mid));
  const remove = oldRows.filter((row) => !nextIds.has(row.mid))
    .map((row) => row.mid);
  const put: { index: number; chat: ChatRow }[] = [];
  const changed = new Set<string>();
  for (const [index, chat] of newRows.entries()) {
    const prior = old.get(chat.mid);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(chat)) {
      changed.add(chat.mid);
      put.push({ index, chat });
    }
  }
  const kept = oldRows.filter((row) =>
    nextIds.has(row.mid) && !changed.has(row.mid)
  );
  const ordered = newRows.filter((row) => !changed.has(row.mid));
  if (kept.some((row, i) => row.mid !== ordered[i]?.mid)) return null;
  const state = { ...after };
  delete state.chats;
  return JSON.stringify({
    web: "state-delta",
    generation,
    base,
    version,
    state,
    remove,
    put,
  });
}

/**
 * state.json for every open page, read once per change rather than once per
 * page. Atomic replacement also changes the file identity, even when two
 * writes have the same millisecond mtime.
 */
export class StateFeed {
  readonly #path: string;
  readonly #subscribers = new Map<Send, Subscriber>();
  readonly #generation = crypto.randomUUID();
  readonly #encoder = new TextEncoder();
  #text = "";
  #state: unknown = null;
  #version = 0;
  #fileKey = "";
  #polling: Promise<void> | null = null;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(path: string) {
    this.#path = path;
    this.#timer = setInterval(() => {
      if (this.#subscribers.size === 0) return;
      void this.#poll();
    }, STATE_POLL_MS);
  }

  /** Check the file before seeding a new subscriber with a full snapshot. */
  async add(send: Send, delta = false): Promise<void> {
    this.#subscribers.set(send, { delta, initialized: false });
    await this.#poll();
  }

  delete(send: Send): void {
    this.#subscribers.delete(send);
  }

  close(): void {
    clearInterval(this.#timer);
    this.#subscribers.clear();
  }

  #poll(): Promise<void> {
    if (this.#polling) return this.#polling;
    this.#polling = this.#read().finally(() => this.#polling = null);
    return this.#polling;
  }

  #fullFrame(): string {
    return `{"web":"state","generation":${JSON.stringify(this.#generation)},` +
      `"version":${this.#version},"state":${this.#text}}`;
  }

  #legacyFrame(): string {
    return `{"web":"state","state":${this.#text}}`;
  }

  #sendInitial(): void {
    for (const [send, subscriber] of this.#subscribers) {
      if (subscriber.initialized) continue;
      subscriber.initialized = true;
      send(subscriber.delta ? this.#fullFrame() : this.#legacyFrame());
    }
  }

  async #read(): Promise<void> {
    const info = await Deno.stat(this.#path).catch(() => null);
    if (!info) {
      this.#fileKey = "";
      return;
    }
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtime?.getTime()}`;
    if (key === this.#fileKey && this.#text) {
      this.#sendInitial();
      return;
    }
    const text = await Deno.readTextFile(this.#path).catch(() => "");
    let state: unknown;
    try {
      state = JSON.parse(text);
    } catch {
      return; // gone or mid-write: the next poll sees it
    }
    this.#fileKey = key;
    if (text === this.#text) {
      this.#sendInitial();
      return;
    }
    const previous = this.#state, base = this.#version;
    this.#text = text;
    this.#state = state;
    this.#version++;
    const full = this.#fullFrame();
    const fullBytes = this.#encoder.encode(full).length;
    const delta =
      [...this.#subscribers.values()].some((subscriber) =>
          subscriber.delta && subscriber.initialized
        ) &&
        fullBytes >= MIN_DELTA_STATE_BYTES
        ? stateDelta(previous, state, this.#generation, base, this.#version)
        : null;
    const frame = delta && this.#encoder.encode(delta).length < fullBytes
      ? delta
      : full;
    const legacy = this.#legacyFrame();
    for (const [send, subscriber] of this.#subscribers) {
      const next = subscriber.delta
        ? subscriber.initialized ? frame : full
        : legacy;
      subscriber.initialized = true;
      send(next);
    }
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

export interface BridgeDeps {
  sockPath: string;
  eventsPath: string;
  feed: StateFeed;
  uploads: Uploads;
  connections: Set<() => void>;
}

/** Upgrade `req` and bridge it; the caller has already checked who it is. */
export function bridge(req: Request, deps: BridgeDeps): Response {
  const delta = (req.headers.get("sec-websocket-protocol") ?? "").split(",")
    .some((protocol) => protocol.trim() === STATE_DELTA_PROTOCOL);
  const { socket: ws, response } = Deno.upgradeWebSocket(req, {
    idleTimeout: 60,
    ...(delta ? { protocol: STATE_DELTA_PROTOCOL } : {}),
  });
  const encoder = new TextEncoder();
  let conn: Deno.UnixConn | null = null;
  let closed = false;
  const close = () => shut(1001, "server stopped");
  /** request id → uploaded file to remove once the daemon has answered. */
  const sentUploads = new Map<unknown, string>();
  const pendingIds = new Set<unknown>();

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
    ready();
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
  let queued = 0;
  let queuedBytes = 0;

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
    if (
      !(typeof req.id === "string" && req.id.length <= 128) &&
      !(typeof req.id === "number" && Number.isSafeInteger(req.id))
    ) return refuse(req.id, "bad request id");
    if (pendingIds.has(req.id) || pendingIds.size >= MAX_PENDING_COMMANDS) {
      shut(CLOSE_INBOUND_OVERLOAD, "duplicate or too many requests");
      return;
    }
    if (REFUSED_CMDS.has(cmd)) {
      return refuse(req.id, "網頁版不能使用這台主機的剪貼簿");
    }
    if (cmd === "sendFile") {
      const real = await deps.uploads.owned(req.path);
      if (!real) return refuse(req.id, "只能傳送從網頁上傳的檔案");
      req.path = real;
      sentUploads.set(req.id, real);
    }
    pendingIds.add(req.id);
    await toDaemon(JSON.stringify(req));
  };

  const fromDaemon = async (c: Deno.UnixConn) => {
    const lines = c.readable.pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) {
      await releaseUpload(line);
      send(line);
    }
  };

  const releaseUpload = async (line: string) => {
    let reply: { id?: unknown; ok?: unknown } | null = null;
    try {
      reply = JSON.parse(line);
    } catch { /* not a reply */ }
    if (!reply || !("ok" in reply)) return;
    pendingIds.delete(reply.id);
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
    await deps.feed.add(send, delta);
    const events = await Deno.readTextFile(deps.eventsPath).catch(() => "");
    if (isJson(events)) send(`{"web":"events","events":${events}}`);
    ready();
    try {
      await fromDaemon(conn);
    } catch { /* closed under us */ }
    shut(CLOSE_DAEMON_OFFLINE, "daemon offline");
  };
  ws.onmessage = (ev) => {
    if (closed || typeof ev.data !== "string") return;
    const bytes = ev.data.length > MAX_FRAME_BYTES
      ? MAX_FRAME_BYTES + 1
      : encoder.encode(ev.data).length;
    if (bytes > MAX_FRAME_BYTES) {
      shut(CLOSE_BAD_FRAME, "frame too large");
      return;
    }
    if (
      queued >= MAX_INBOUND_QUEUE || queuedBytes + bytes > MAX_INBOUND_BYTES
    ) {
      shut(CLOSE_INBOUND_OVERLOAD, "too many requests");
      return;
    }
    queued++;
    queuedBytes += bytes;
    inbound = inbound.then(() => relay(ev.data)).catch(() =>
      shut(CLOSE_DAEMON_OFFLINE, "daemon offline")
    ).finally(() => {
      queued--;
      queuedBytes -= bytes;
    });
  };
  ws.onclose = () => shut(1000, "");
  ws.onerror = () => shut(1011, "");
  deps.connections.add(close);
  return response;
}

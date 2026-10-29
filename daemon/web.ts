/**
 * The web page: LINE from any browser on the tailnet, served by the daemon
 * itself so one process still holds the one session.
 *
 * Off unless ENIL_WEB_ADDR names an address (host:port). Bind it to the
 * machine's Tailscale IP, never 0.0.0.0: the address is the only network
 * boundary, and the web key below is the only credential.
 *
 * Signing in is magpie's model. ENIL_WEB_KEY (16+ of A-Z a-z 0-9 - . _ ~) is
 * the key; without one a fresh key is minted each start and printed with the
 * sign-in link. The key buys an HttpOnly, SameSite=Strict cookie good for 400
 * days, derived from the key, so changing the key signs every browser out.
 *
 * Each browser WebSocket is bridged to its own connection on the daemon's unix
 * socket, so the page gets exactly what a panel gets: the same replies, the
 * same push frames, the same request ordering. On top of that the bridge sends
 * state.json whenever it changes and events.json once per connection, the two
 * files a panel would watch.
 *
 * What the bridge refuses: the clipboard commands (they read the daemon
 * host's clipboard, not the browser's) and a sendFile whose path is not one
 * this server stored from an upload. /api/file serves only the media cache
 * and the login QR, resolved through symlinks, never storage.json.
 *
 * Runs inside the daemon (daemon.ts calls startWeb) or alone against a
 * running daemon or stub.py: `deno run -A web.ts`.
 */
import { TextLineStream } from "@std/streams/text-line-stream";

const KEY_RE = /^[A-Za-z0-9._~-]{16,}$/;
const COOKIE = "enil_web";
const COOKIE_MAX_AGE_S = 400 * 24 * 3600;
const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const UPLOAD_MAX_AGE_MS = 24 * 3600 * 1000;
const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
const SIGNIN_MAX_FAILURES = 10;
const STATE_POLL_MS = 500;
const BIND_RETRY_MS = 10_000;
/** Commands that act on the daemon host's clipboard, meaningless from a browser. */
const REFUSED_CMDS = new Set([
  "probeClipboardImage",
  "sendClipboardImage",
  "discardClipboardImage",
]);
const STATIC_FILES = new Set(["index.html", "app.js", "app.css"]);
const CSP = "default-src 'self'; img-src 'self' https: data: blob:; " +
  "media-src 'self' blob:; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
  "form-action 'self'";

export interface WebOptions {
  addr: string;
  key: string | undefined;
  stateDir: string;
  /** Where the page's files are; tests point it elsewhere. */
  webDir?: URL;
  log?: (line: string) => void;
}

export interface WebHandler {
  handle(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response>;
  /** The key in force, generated when the option was missing or invalid. */
  key: string;
  close(): void;
}

/** "100.1.2.3:3440" or "[fd7a::1]:3440" into Deno.serve's hostname/port. */
export function parseAddr(
  addr: string,
): { hostname: string; port: number } | null {
  const m = /^\[([0-9A-Fa-f:.]+)\]:(\d+)$/.exec(addr) ??
    /^([^:\[\]]+):(\d+)$/.exec(addr);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: m[1], port };
}

function mintKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-")
    .replace(/\//g, "_").replace(/=+$/, "");
}

async function cookieToken(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`enil-web-cookie:${key}`),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * A browser always sends Origin on a WebSocket handshake and on a POST fetch.
 * When it does, it must be this page's own; otherwise any site the user visits
 * could open the socket with the user's cookie. A client that sends no Origin
 * is not a browser and has no cookie to borrow.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function securityHeaders(extra: HeadersInit = {}): Headers {
  const h = new Headers(extra);
  h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return h;
}

function status(code: number, body = ""): Response {
  return new Response(body || null, {
    status: code,
    headers: securityHeaders(
      body ? { "Content-Type": "text/plain; charset=utf-8" } : {},
    ),
  });
}

function json(value: unknown, code = 200): Response {
  return new Response(JSON.stringify(value), {
    status: code,
    headers: securityHeaders({
      "Content-Type": "application/json; charset=utf-8",
    }),
  });
}

/** Inside `dir` after symlinks resolve; `dir` itself must already be real. */
function inside(realDir: string, realPath: string): boolean {
  return realPath.startsWith(realDir + "/");
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

/** Type by content, so a cached download named .jpg cannot render as HTML. */
export function sniffInline(head: Uint8Array): string | null {
  const b = head;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  ) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    return "video/mp4";
  }
  return null;
}

/** One path component a user picked, safe to create under the upload dir. */
export function uploadName(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // deno-lint-ignore no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const name = clean === "." || clean === ".." ? "" : clean;
  return (name || "file").slice(0, 200);
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${
    encodeURIComponent(name)
  }`;
}

export async function createWeb(opts: WebOptions): Promise<WebHandler> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const key = opts.key && KEY_RE.test(opts.key) ? opts.key : mintKey();
  const token = await cookieToken(key);
  const webDir = opts.webDir ?? new URL("./web/", import.meta.url);
  const stateDir = opts.stateDir;
  const sockPath = `${stateDir}/sock`;
  const statePath = `${stateDir}/state.json`;
  const eventsPath = `${stateDir}/events.json`;
  const mediaDir = `${stateDir}/media`;
  const uploadDir = `${mediaDir}/web-uploads`;
  const failures: number[] = [];
  const sockets = new Set<(frame: string) => void>();
  let stateText = "";
  let stateMtime = -1;
  let closed = false;

  await Deno.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const realUploadDir = await Deno.realPath(uploadDir);

  async function sweepUploads(): Promise<void> {
    try {
      for await (const entry of Deno.readDir(realUploadDir)) {
        const path = `${realUploadDir}/${entry.name}`;
        const info = await Deno.lstat(path).catch(() => null);
        const age = Date.now() - (info?.mtime?.getTime() ?? 0);
        if (age > UPLOAD_MAX_AGE_MS) {
          await Deno.remove(path, { recursive: true }).catch(() => {});
        }
      }
    } catch { /* the dir went away; nothing to sweep */ }
  }
  await sweepUploads();
  const sweepTimer = setInterval(() => void sweepUploads(), 3600_000);

  // state.json is atomically replaced; its mtime moves on every write.
  async function pollState(): Promise<void> {
    const info = await Deno.stat(statePath).catch(() => null);
    const mtime = info?.mtime?.getTime() ?? -1;
    if (mtime === stateMtime) return;
    const text = await Deno.readTextFile(statePath).catch(() => "");
    try {
      JSON.parse(text);
    } catch {
      return; // mid-write or gone: the next poll sees the finished file
    }
    stateMtime = mtime;
    stateText = text;
    const frame = `{"web":"state","state":${text}}`;
    for (const send of sockets) send(frame);
  }
  let polling = false;
  const pollTimer = setInterval(() => {
    if (polling || sockets.size === 0) return;
    polling = true;
    pollState().finally(() => polling = false);
  }, STATE_POLL_MS);

  function signedIn(req: Request): boolean {
    const got = cookieValue(req, COOKIE);
    return got !== null && sameText(got, token);
  }

  function signinBlocked(): boolean {
    const since = Date.now() - SIGNIN_WINDOW_MS;
    while (failures.length && failures[0] < since) failures.shift();
    return failures.length >= SIGNIN_MAX_FAILURES;
  }

  function keyMatches(given: unknown): boolean {
    return typeof given === "string" && sameText(given, key);
  }

  function signinCookie(): string {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`;
  }

  async function serveStatic(name: string): Promise<Response> {
    if (!STATIC_FILES.has(name)) return status(404);
    let body: string;
    try {
      body = await Deno.readTextFile(new URL(name, webDir));
    } catch {
      return status(404);
    }
    const type = name.endsWith(".html")
      ? "text/html; charset=utf-8"
      : name.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/css; charset=utf-8";
    return new Response(body, {
      headers: securityHeaders({ "Content-Type": type }),
    });
  }

  async function serveFile(url: URL): Promise<Response> {
    const asked = url.searchParams.get("path");
    if (!asked || !asked.startsWith("/")) return status(404);
    const real = await realOrNull(asked);
    const realState = await realOrNull(stateDir);
    const realMedia = await realOrNull(mediaDir);
    if (!real || !realState || !realMedia) return status(404);
    const slash = real.lastIndexOf("/");
    const isQr = real.slice(0, slash) === realState &&
      /^qr-[0-9]+\.png$/.test(real.slice(slash + 1));
    if (!isQr && !inside(realMedia, real)) return status(404);
    let file: Deno.FsFile;
    try {
      file = await Deno.open(real, { read: true });
    } catch {
      return status(404);
    }
    const info = await file.stat();
    if (!info.isFile) {
      file.close();
      return status(404);
    }
    const head = new Uint8Array(12);
    const n = await file.read(head) ?? 0;
    await file.seek(0, Deno.SeekMode.Start);
    const inline = n >= 12 ? sniffInline(head) : null;
    const download = url.searchParams.get("download") === "1" || !inline;
    const headers = securityHeaders({
      "Content-Type": inline ?? "application/octet-stream",
      "Content-Length": String(info.size),
      "Cache-Control": "private, max-age=86400",
    });
    // A file served from this origin must never run as this origin's page.
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    if (download) {
      headers.set(
        "Content-Disposition",
        contentDisposition(real.slice(slash + 1)),
      );
    }
    return new Response(file.readable, { headers });
  }

  async function serveUpload(req: Request, url: URL): Promise<Response> {
    if (!req.body) return status(400, "empty upload");
    const dir = `${realUploadDir}/${crypto.randomUUID()}`;
    await Deno.mkdir(dir, { mode: 0o700 });
    const path = `${dir}/${uploadName(url.searchParams.get("name"))}`;
    const file = await Deno.open(path, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    let size = 0;
    try {
      for await (const chunk of req.body) {
        size += chunk.length;
        if (size > UPLOAD_MAX_BYTES) throw new RangeError("too large");
        let off = 0;
        while (off < chunk.length) off += await file.write(chunk.subarray(off));
      }
    } catch (e) {
      file.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      return e instanceof RangeError
        ? status(413, "檔案太大（超過 1 GB）")
        : status(400, "上傳中斷");
    }
    file.close();
    if (size === 0) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      return status(400, "empty upload");
    }
    return json({ path });
  }

  function bridge(req: Request): Response {
    const { socket: ws, response } = Deno.upgradeWebSocket(req, {
      idleTimeout: 60,
    });
    let conn: Deno.UnixConn | null = null;
    let writing: Promise<unknown> = Promise.resolve();
    /** request id → upload dir to remove once the daemon has answered. */
    const uploads = new Map<unknown, string>();
    const encoder = new TextEncoder();
    const send = (frame: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    };
    const shut = (code: number, reason: string) => {
      sockets.delete(send);
      try {
        conn?.close();
      } catch { /* already closed */ }
      conn = null;
      // An upload whose send may still be reading it stays; the sweep takes
      // it a day later.
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
    };
    const toDaemon = (line: string) => {
      const c = conn;
      if (!c) return;
      const bytes = encoder.encode(line + "\n");
      writing = writing.then(async () => {
        let off = 0;
        while (off < bytes.length) off += await c.write(bytes.subarray(off));
      }).catch(() => shut(4001, "daemon offline"));
    };
    const refuse = (id: unknown, error: string) =>
      send(JSON.stringify({ id, ok: false, error }));

    ws.onopen = async () => {
      try {
        conn = await Deno.connect({ transport: "unix", path: sockPath });
      } catch {
        shut(4001, "daemon offline");
        return;
      }
      sockets.add(send);
      if (stateText) send(`{"web":"state","state":${stateText}}`);
      else await pollState();
      const events = await Deno.readTextFile(eventsPath).catch(() => "");
      try {
        JSON.parse(events);
        send(`{"web":"events","events":${events}}`);
      } catch { /* none yet */ }
      const c = conn;
      if (!c) return;
      try {
        const lines = c.readable.pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream());
        for await (const line of lines) {
          if (uploads.size) {
            try {
              const reply = JSON.parse(line);
              const dir = uploads.get(reply?.id);
              if (dir !== undefined && "ok" in reply) {
                uploads.delete(reply.id);
                await Deno.remove(dir, { recursive: true }).catch(() => {});
              }
            } catch { /* not ours to judge */ }
          }
          send(line);
        }
      } catch { /* closed under us */ }
      shut(4001, "daemon offline");
    };
    // One at a time, in arrival order: a sendFile resolving its path must not
    // let a later command reach the daemon first.
    let inbound: Promise<void> = Promise.resolve();
    ws.onmessage = (ev) => {
      inbound = inbound.then(() => relay(ev.data)).catch(() => {});
    };
    const relay = async (data: unknown): Promise<void> => {
      if (typeof data !== "string") return;
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
        const path = typeof req.path === "string" ? req.path : "";
        const real = await realOrNull(path);
        if (!real || !inside(realUploadDir, real)) {
          return refuse(req.id, "只能傳送從網頁上傳的檔案");
        }
        req.path = real;
        uploads.set(req.id, real.slice(0, real.lastIndexOf("/")));
      }
      toDaemon(JSON.stringify(req));
    };
    ws.onclose = () => shut(1000, "");
    ws.onerror = () => shut(1011, "");
    return response;
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req)) {
      return status(403);
    }
    if (path === "/" && req.method === "GET") {
      const given = url.searchParams.get("key");
      if (given !== null) {
        if (signinBlocked()) return status(429);
        if (!keyMatches(given)) {
          failures.push(Date.now());
          return status(401, "wrong key");
        }
        return new Response(null, {
          status: 303,
          headers: securityHeaders({
            Location: "/",
            "Set-Cookie": signinCookie(),
          }),
        });
      }
      return serveStatic("index.html");
    }
    if (req.method === "GET" && /^\/[a-z]+\.(js|css)$/.test(path)) {
      return serveStatic(path.slice(1));
    }
    if (path === "/api/session") {
      return status(signedIn(req) ? 204 : 401);
    }
    if (path === "/api/signin" && req.method === "POST") {
      if (signinBlocked()) return status(429);
      const body = await req.json().catch(() => null);
      if (!keyMatches(body?.key)) {
        failures.push(Date.now());
        return status(401);
      }
      return new Response(null, {
        status: 204,
        headers: securityHeaders({ "Set-Cookie": signinCookie() }),
      });
    }
    if (!signedIn(req)) return status(401);
    if (path === "/api/signout" && req.method === "POST") {
      return new Response(null, {
        status: 204,
        headers: securityHeaders({
          "Set-Cookie":
            `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        }),
      });
    }
    if (path === "/api/ws") {
      if (!originAllowed(req)) return status(403);
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return status(400);
      }
      return bridge(req);
    }
    if (path === "/api/file" && req.method === "GET") return serveFile(url);
    if (path === "/api/upload" && req.method === "POST") {
      return serveUpload(req, url);
    }
    return status(404);
  }

  return {
    handle,
    key,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(sweepTimer);
      clearInterval(pollTimer);
      log("[web] stopped");
    },
  };
}

/**
 * Serve the page on `addr`, retrying the bind until it succeeds: at login the
 * Tailscale address may not exist yet, and the daemon must not die for it.
 */
export async function startWeb(opts: WebOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const where = parseAddr(opts.addr);
  if (!where) {
    console.error(`[web] ENIL_WEB_ADDR is not host:port: ${opts.addr}`);
    return;
  }
  const web = await createWeb(opts);
  if (!opts.key || !KEY_RE.test(opts.key)) {
    log(
      "[web] no usable ENIL_WEB_KEY (16+ of A-Z a-z 0-9 - . _ ~); " +
        "this run's key is in the sign-in link",
    );
  }
  const host = where.hostname.includes(":")
    ? `[${where.hostname}]`
    : where.hostname;
  for (;;) {
    try {
      Deno.serve({
        hostname: where.hostname,
        port: where.port,
        onListen: () =>
          log(`[web] sign in: http://${host}:${where.port}/?key=${web.key}`),
        onError: (e) => {
          console.error(`[web] ${e instanceof Error ? e.message : String(e)}`);
          return status(500);
        },
      }, (req) => web.handle(req));
      return;
    } catch (e) {
      console.error(
        `[web] cannot listen on ${opts.addr} (${
          e instanceof Error ? e.message : String(e)
        }); retrying in ${BIND_RETRY_MS / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, BIND_RETRY_MS));
    }
  }
}

if (import.meta.main) {
  const home = Deno.env.get("HOME") ?? "";
  const stateDir = `${
    Deno.env.get("XDG_STATE_HOME") ?? `${home}/.local/state`
  }/enil`;
  await startWeb({
    addr: Deno.env.get("ENIL_WEB_ADDR") ?? "127.0.0.1:3440",
    key: Deno.env.get("ENIL_WEB_KEY"),
    stateDir,
  });
}

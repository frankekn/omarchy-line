/**
 * The web page: LINE from any browser on the tailnet, served by the daemon
 * itself so one process still holds the one session. docs/web.md is the user
 * guide.
 *
 * Off unless ENIL_WEB_ADDR names an address (host:port). Bind it to the
 * machine's Tailscale IP, never 0.0.0.0: the address is the only network
 * boundary, and the web key (auth.ts) is the only credential.
 *
 * Routes:
 *   GET  /                 the page (public/index.html); /?key=… signs in
 *   GET  /app.css, /js/<name>.js
 *   GET  /api/session      {"signedIn": bool}
 *   POST /api/signin       {"key": "…"} → 204 + cookie, 401, 429
 *   POST /api/signout      204, cookie cleared
 *   GET  /api/ws           the live channel (bridge.ts)
 *   GET  /api/file         media cache and login QR (files.ts)
 *   POST /api/upload       a file for sendFile (files.ts)
 * Everything under /api except session and signin needs the cookie, and any
 * POST or WebSocket from another origin is refused. A request whose Host is
 * not ENIL_WEB_ADDR is refused before routing, so a rebound DNS name cannot
 * reach the page. Sign-ins marked as cross-site are refused before counting;
 * link and form attempts have separate caps when browsers omit that marking.
 *
 * Runs inside the daemon (daemon.ts calls startWeb) or alone against a
 * running daemon or stub.py: `deno run -A web/server.ts`.
 *
 * Dependency direction: imports ./auth.ts, ./bridge.ts, ./files.ts and
 * ./http.ts; nothing from the daemon, so it runs alone.
 */
import { originAllowed, usableKey, WebAuth } from "./auth.ts";
import { bridge, StateFeed } from "./bridge.ts";
import { serveFile, Uploads } from "./files.ts";
import { json, securityHeaders, status } from "./http.ts";

const BIND_RETRY_MS = 10_000;
const MAX_BRIDGES = 32;
const MAX_SIGNIN_BODY = 8192;
const MAX_SIGNIN_PENDING = 16;
const SIGNIN_BODY_TIMEOUT_MS = 10_000;
const ASSET_RE = /^\/(?:app\.css|js\/[a-z][a-z0-9-]*\.js)$/;

export interface WebOptions {
  addr: string;
  key: string | undefined;
  stateDir: string;
  /** Where the page's files are; tests point it elsewhere. */
  publicDir?: URL;
  log?: (line: string) => void;
  /** Override the body deadline in tests. */
  signinTimeoutMs?: number;
}

export interface WebHandler {
  handle(req: Request): Promise<Response>;
  /** The key in force, minted when the option was missing or unusable. */
  key: string;
  close(): void;
}

/** "100.64.0.1:3440" or "[fd7a::1]:3440" into Deno.serve's hostname/port. */
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

/**
 * A Host value as a browser would send it for the same address, or null.
 * The URL parser settles case, the default port and numeric IPv4 forms; an
 * IPv4-mapped IPv6 literal is the same IPv4 listener, so it folds to IPv4.
 */
export function canonicalHost(host: string): string | null {
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return null;
  }
  if (
    url.username || url.password || url.pathname !== "/" || url.search ||
    url.hash
  ) return null;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(
    url.hostname,
  );
  if (!mapped) return url.host;
  const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  const ipv4 = [high >> 8, high & 255, low >> 8, low & 255].join(".");
  return url.port ? `${ipv4}:${url.port}` : ipv4;
}

/**
 * A browser marks a request another site started. Such a sign-in is not the
 * user's, and must not spend the wrong-key cap that locks the user out.
 */
function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

interface Asset {
  body: Uint8Array<ArrayBuffer>;
  etag: string;
  type: string;
}

/** Snapshot public assets once. Compiled assets do not have reliable mtimes. */
async function loadAssets(publicDir: URL): Promise<Map<string, Asset>> {
  const paths = ["/index.html", "/app.css"];
  try {
    for await (const entry of Deno.readDir(new URL("js/", publicDir))) {
      const path = `/js/${entry.name}`;
      if (entry.isFile && ASSET_RE.test(path)) paths.push(path);
    }
  } catch { /* A missing directory leaves the JS routes unavailable. */ }
  const assets = new Map<string, Asset>();
  await Promise.all(paths.map(async (path) => {
    try {
      const body = await Deno.readFile(new URL(path.slice(1), publicDir));
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
      const etag = `"${
        Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")
      }"`;
      const type = path.endsWith(".html")
        ? "text/html; charset=utf-8"
        : path.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/css; charset=utf-8";
      assets.set(path, { body, etag, type });
    } catch { /* An unreadable asset keeps its existing 404 behavior. */ }
  }));
  return assets;
}

function serveAsset(
  assets: Map<string, Asset>,
  path: string,
  req: Request,
  code = 200,
): Response {
  const asset = assets.get(path);
  if (!asset) return status(404);
  const headers = securityHeaders({
    "Content-Type": asset.type,
    "Cache-Control": code === 200 ? "no-cache" : "no-store",
    ETag: asset.etag,
  });
  if (path === "/index.html") {
    headers.set("Link", "</api/session>; rel=preload; as=fetch; crossorigin");
  }
  const matches = req.headers.get("if-none-match")?.split(",").some((value) => {
    const tag = value.trim();
    return tag === "*" || tag.replace(/^W\//, "") === asset.etag;
  });
  if (code === 200 && matches) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Length", String(asset.body.byteLength));
  return new Response(asset.body, { status: code, headers });
}

function signedInRedirect(auth: WebAuth): Response {
  return new Response(null, {
    status: 303,
    headers: securityHeaders({
      Location: "/",
      "Set-Cookie": auth.signinCookie(),
    }),
  });
}

function withCookie(cookie: string): Response {
  return new Response(null, {
    status: 204,
    headers: securityHeaders({ "Set-Cookie": cookie }),
  });
}

async function signinBody(
  req: Request,
  timeoutMs: number,
  readers: Set<ReadableStreamDefaultReader<Uint8Array>>,
): Promise<{ value?: unknown; error?: number }> {
  if (Number(req.headers.get("content-length")) > MAX_SIGNIN_BODY) {
    return { error: 413 };
  }
  if (!req.body) return {};
  const reader = req.body.getReader();
  readers.add(reader);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DOMException("sign-in timed out", "TimeoutError")),
        timeoutMs,
      );
    });
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_SIGNIN_BODY) return { error: 413 };
      text += decoder.decode(part.value, { stream: true });
    }
    complete = true;
    text += decoder.decode();
    try {
      return { value: JSON.parse(text) };
    } catch {
      return {};
    }
  } catch (error) {
    return error instanceof DOMException && error.name === "TimeoutError"
      ? { error: 408 }
      : {};
  } finally {
    clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => {});
    readers.delete(reader);
    reader.releaseLock();
  }
}

export async function createWeb(opts: WebOptions): Promise<WebHandler> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const publicDir = opts.publicDir ?? new URL("./public/", import.meta.url);
  const ownHost = canonicalHost(opts.addr);
  const assets = await loadAssets(publicDir);
  const auth = await WebAuth.create(opts.key);
  const uploads = await Uploads.open(opts.stateDir);
  const feed = new StateFeed(`${opts.stateDir}/state.json`);
  const connections = new Set<() => void>();
  const signinReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let signinPending = 0;
  const bridgeDeps = {
    sockPath: `${opts.stateDir}/sock`,
    eventsPath: `${opts.stateDir}/events.json`,
    feed,
    uploads,
    connections,
  };

  async function handle(req: Request): Promise<Response> {
    if (closed) return status(503);
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.host;
    if (ownHost === null || canonicalHost(host) !== ownHost) {
      return status(421);
    }
    const path = url.pathname;
    const get = req.method === "GET";
    if (!get && !originAllowed(req)) return status(403);

    if (get && path === "/") {
      const given = url.searchParams.get("key");
      if (given === null) return serveAsset(assets, "/index.html", req);
      if (crossSite(req)) return status(403, "open the sign-in link directly");
      const result = auth.signin(given, "link");
      if (result === "blocked") {
        return serveAsset(assets, "/index.html", req, 429);
      }
      return result === "ok"
        ? signedInRedirect(auth)
        : status(401, "wrong key");
    }
    if (get && ASSET_RE.test(path)) return serveAsset(assets, path, req);
    if (get && path === "/api/session") {
      return json({ signedIn: auth.signedIn(req) });
    }
    if (req.method === "POST" && path === "/api/signin") {
      if (crossSite(req)) return status(403);
      if (signinPending >= MAX_SIGNIN_PENDING) return status(503);
      signinPending++;
      let body: { value?: unknown; error?: number };
      try {
        body = await signinBody(
          req,
          opts.signinTimeoutMs ?? SIGNIN_BODY_TIMEOUT_MS,
          signinReaders,
        );
      } finally {
        signinPending--;
      }
      if (closed) return status(503);
      if (body.error) return status(body.error);
      const value = body.value;
      const key = value && typeof value === "object" && "key" in value
        ? value.key
        : undefined;
      const result = auth.signin(key, "form");
      if (result === "blocked") return status(429);
      return result === "ok" ? withCookie(auth.signinCookie()) : status(401);
    }

    if (!path.startsWith("/api/")) return status(404);
    if (!auth.signedIn(req)) return status(401);
    if (req.method === "POST" && path === "/api/signout") {
      return withCookie(auth.signoutCookie());
    }
    if (get && path === "/api/ws") {
      if (!originAllowed(req)) return status(403);
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return status(400);
      }
      if (connections.size >= MAX_BRIDGES) return status(503);
      return bridge(req, bridgeDeps);
    }
    // Media paths do not change content, so files.ts lets the browser keep
    // them privately for a day instead of fetching them again on a phone.
    if (get && path === "/api/file") return serveFile(opts.stateDir, url);
    if (req.method === "POST" && path === "/api/upload") {
      return uploads.receive(req, url);
    }
    return status(404);
  }

  let closed = false;
  return {
    handle,
    key: auth.key,
    close() {
      if (closed) return;
      closed = true;
      for (const close of connections) close();
      for (const reader of signinReaders) void reader.cancel().catch(() => {});
      feed.close();
      uploads.close();
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
  // A key from the environment stays out of the log: the log can go to the
  // journal, which other accounts may read. Only a minted key is printed,
  // because the log is the only place to find it.
  const minted = !usableKey(opts.key);
  if (minted) {
    log(
      "[web] no usable ENIL_WEB_KEY (16+ of A-Z a-z 0-9 - . _ ~); " +
        "this run's key is in the sign-in link",
    );
  }
  const host = where.hostname.includes(":")
    ? `[${where.hostname}]`
    : where.hostname;
  const signIn = `http://${host}:${where.port}/` +
    (minted ? `?key=${web.key}` : "");
  // A failed accept, such as EMFILE when descriptors run out, ends the
  // listener and rejects `finished`. Unhandled, that rejection would end the
  // daemon; handled without a new serve, the page would stay down.
  for (;;) {
    try {
      const server = Deno.serve({
        hostname: where.hostname,
        port: where.port,
        onListen: () => log(`[web] sign in: ${signIn}`),
        onError: (e) => {
          console.error(`[web] ${e instanceof Error ? e.message : String(e)}`);
          return status(500);
        },
      }, (req) => web.handle(req));
      await server.finished;
      return;
    } catch (e) {
      console.error(
        `[web] cannot serve ${opts.addr} (${
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
    Deno.env.get("XDG_STATE_HOME") || `${home}/.local/state`
  }/enil`;
  await startWeb({
    addr: Deno.env.get("ENIL_WEB_ADDR") ?? "127.0.0.1:3440",
    key: Deno.env.get("ENIL_WEB_KEY"),
    stateDir,
  });
}

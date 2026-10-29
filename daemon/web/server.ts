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
 * POST or WebSocket from another origin is refused.
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
const ASSET_RE = /^\/(?:app\.css|js\/[a-z][a-z0-9-]*\.js)$/;

export interface WebOptions {
  addr: string;
  key: string | undefined;
  stateDir: string;
  /** Where the page's files are; tests point it elsewhere. */
  publicDir?: URL;
  log?: (line: string) => void;
}

export interface WebHandler {
  handle(req: Request): Promise<Response>;
  /** The key in force, minted when the option was missing or unusable. */
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

async function serveAsset(publicDir: URL, path: string): Promise<Response> {
  let body: string;
  try {
    body = await Deno.readTextFile(new URL(path.slice(1), publicDir));
  } catch {
    return status(404);
  }
  const type = path.endsWith(".html")
    ? "text/html; charset=utf-8"
    : path.endsWith(".js")
    ? "text/javascript; charset=utf-8"
    : "text/css; charset=utf-8";
  return new Response(body, {
    headers: securityHeaders({ "Content-Type": type }),
  });
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

export async function createWeb(opts: WebOptions): Promise<WebHandler> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const publicDir = opts.publicDir ?? new URL("./public/", import.meta.url);
  const auth = await WebAuth.create(opts.key);
  const uploads = await Uploads.open(opts.stateDir);
  const feed = new StateFeed(`${opts.stateDir}/state.json`);
  const bridgeDeps = {
    sockPath: `${opts.stateDir}/sock`,
    eventsPath: `${opts.stateDir}/events.json`,
    feed,
    uploads,
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const get = req.method === "GET";
    if (!get && !originAllowed(req)) return status(403);

    if (get && path === "/") {
      const given = url.searchParams.get("key");
      if (given === null) return serveAsset(publicDir, "/index.html");
      const result = auth.signin(given);
      if (result === "blocked") return status(429);
      return result === "ok"
        ? signedInRedirect(auth)
        : status(401, "wrong key");
    }
    if (get && ASSET_RE.test(path)) return serveAsset(publicDir, path);
    if (get && path === "/api/session") {
      return json({ signedIn: auth.signedIn(req) });
    }
    if (req.method === "POST" && path === "/api/signin") {
      const body = await req.json().catch(() => null);
      const result = auth.signin(body?.key);
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
      return bridge(req, bridgeDeps);
    }
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
  if (!usableKey(opts.key)) {
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

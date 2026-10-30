import { assert, assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";
import { pathToFileURL } from "node:url";
import { WebAuth } from "./auth.ts";
import { sniffInline, uploadName, Uploads } from "./files.ts";
import { canonicalHost, createWeb, parseAddr } from "./server.ts";

const KEY = "test-key-0123456789abcdef";
const TEST_PORT = Number(Deno.env.get("ENIL_WEB_TEST_PORT") ?? "0");
const ADDR = "100.64.0.1:3440";

async function fixture(addr = ADDR) {
  const stateDir = await Deno.makeTempDir({ prefix: "enil-web-" });
  await Deno.mkdir(`${stateDir}/media`, { recursive: true });
  await Deno.writeTextFile(`${stateDir}/storage.json`, '{"secret":1}');
  await Deno.writeTextFile(
    `${stateDir}/state.json`,
    JSON.stringify({ login: { status: "ok" }, chats: [] }),
  );
  const web = await createWeb({
    addr,
    key: KEY,
    stateDir,
    log: () => {},
  });
  return { stateDir, web };
}

/** A fixture behind a real listener, configured with the port it got. */
async function served() {
  let handle = (_req: Request) =>
    Promise.resolve(new Response(null, { status: 503 }));
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: TEST_PORT, onListen: () => {} },
    (req) => handle(req),
  );
  const addr = `127.0.0.1:${server.addr.port}`;
  const { stateDir, web } = await fixture(addr);
  handle = web.handle;
  return { stateDir, web, server, addr };
}

function get(path: string, init: RequestInit = {}, addr = ADDR): Request {
  return new Request(`http://${addr}${path}`, init);
}

async function signedInCookie(
  web: Awaited<ReturnType<typeof createWeb>>,
  addr = ADDR,
): Promise<string> {
  const res = await web.handle(
    get("/api/signin", {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
      headers: { origin: `http://${addr}`, host: addr },
    }, addr),
  );
  assertEquals(res.status, 204);
  const set = res.headers.get("set-cookie") ?? "";
  assert(set.includes("HttpOnly") && set.includes("SameSite=Strict"));
  return set.split(";")[0];
}

Deno.test("parseAddr takes host:port and [v6]:port only", () => {
  assertEquals(parseAddr("100.64.0.1:3440"), {
    hostname: "100.64.0.1",
    port: 3440,
  });
  assertEquals(parseAddr("[fd7a::1]:80"), { hostname: "fd7a::1", port: 80 });
  assertEquals(parseAddr("3440"), null);
  assertEquals(parseAddr("host:99999"), null);
});

Deno.test("an upload name is one safe path component", () => {
  assertEquals(uploadName("../../etc/passwd"), "passwd");
  assertEquals(uploadName("a\\b\u0000c.png"), "bc.png");
  assertEquals(uploadName(".."), "file");
  assertEquals(uploadName(null), "file");
});

Deno.test("a long upload name is cut by UTF-8 bytes and keeps its type", async () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const cjk = uploadName("照".repeat(90) + ".txt");
  assertEquals(cjk, "照".repeat(65) + ".txt");
  assert(bytes(cjk) <= 200);
  // Four-byte code points are never split into a lone surrogate.
  for (const raw of ["😀".repeat(60), "a" + "😀".repeat(60) + ".png"]) {
    const name = uploadName(raw);
    assert(bytes(name) <= 200 && name.isWellFormed(), name);
  }
  assert(uploadName("a" + "😀".repeat(60) + ".png").endsWith(".png"));
  // An extension that cannot fit is cut with the rest of the name.
  assertEquals(uploadName("a." + "b".repeat(300)), "a." + "b".repeat(198));
  assertEquals(uploadName("a".repeat(300)), "a".repeat(200));

  const stateDir = await Deno.makeTempDir({ prefix: "enil-web-name-" });
  const uploads = await Uploads.open(stateDir);
  try {
    const name = "照".repeat(90) + ".txt";
    const res = await uploads.receive(
      new Request("http://box/api/upload", { method: "POST", body: "x" }),
      new URL(`http://box/api/upload?name=${encodeURIComponent(name)}`),
    );
    assertEquals(res.status, 200);
    const { path } = await res.json();
    assertEquals(path.split("/").pop(), cjk);
    assertEquals(await Deno.readTextFile(path), "x");
  } finally {
    uploads.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("an upload can be claimed once, until it is discarded", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "enil-web-claim-" });
  const uploads = await Uploads.open(stateDir);
  const upload = async () => {
    const res = await uploads.receive(
      new Request("http://box/api/upload", { method: "POST", body: "x" }),
      new URL("http://box/api/upload?name=test"),
    );
    return (await res.json()).path as string;
  };
  try {
    const one = await upload(), two = await upload();
    assertEquals(uploads.claim(one), true);
    assertEquals(uploads.claim(one), false);
    assertEquals(uploads.claim(two), true, "claims are per upload");
    assertEquals(uploads.claim(`${stateDir}/storage.json`), false);
    await uploads.discard(one);
    assertEquals(await uploads.owned(one), null);
  } finally {
    uploads.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("only images and mp4 are served inline", () => {
  assertEquals(
    sniffInline(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    "image/jpeg",
  );
  assertEquals(sniffInline(new TextEncoder().encode("<html><script>")), null);
});

Deno.test("sign-in: wrong key, right key, then too many tries", async () => {
  const { stateDir, web } = await fixture();
  try {
    const session = async (init: RequestInit = {}) =>
      (await (await web.handle(get("/api/session", init))).json()).signedIn;
    assertEquals(await session(), false);
    assertEquals((await web.handle(get("/api/file?path=/x"))).status, 401);
    const wrong = () =>
      web.handle(get("/api/signin", {
        method: "POST",
        body: JSON.stringify({ key: "nope" }),
      }));
    assertEquals((await wrong()).status, 401);
    const cookie = await signedInCookie(web);
    assertEquals(await session({ headers: { cookie } }), true);
    const viaLink = await web.handle(get(`/?key=${KEY}`));
    assertEquals(viaLink.status, 303);
    for (let i = 0; i < 9; i++) await wrong();
    assertEquals((await wrong()).status, 429);
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("wrong keys age out of each sign-in bucket independently", async () => {
  let now = 0;
  const auth = await WebAuth.create(KEY, () => now);
  for (let i = 0; i < 10; i++) {
    assertEquals(auth.signin("nope", "link"), "wrong");
  }
  assertEquals(auth.signin(KEY, "link"), "blocked");
  assertEquals(auth.signin(KEY, "form"), "ok");
  now = 5 * 60 * 1000;
  for (let i = 0; i < 10; i++) {
    assertEquals(auth.signin("nope", "form"), "wrong");
  }
  assertEquals(auth.signin(KEY, "form"), "blocked");
  now = 10 * 60 * 1000;
  assertEquals(auth.signin(KEY, "link"), "blocked");
  now++;
  assertEquals(auth.signin(KEY, "link"), "ok");
  assertEquals(auth.signin(KEY, "form"), "blocked");
  now = 15 * 60 * 1000 + 1;
  assertEquals(auth.signin(KEY, "form"), "ok");
});

Deno.test("sign-in buckets isolate link and form failures across connections", async () => {
  const { stateDir, web, server } = await served();
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const guesses = await Promise.all(
      Array.from(
        { length: 10 },
        (_, i) =>
          i % 2 === 0
            ? fetch(`${base}/?key=wrong`, { headers: { connection: "close" } })
            : fetch(`${base}/api/signin`, {
              method: "POST",
              headers: { connection: "close" },
              body: JSON.stringify({ key: "wrong" }),
            }),
      ),
    );
    assertEquals(guesses.map((r) => r.status), Array(10).fill(401));
    for (const response of guesses) await response.body?.cancel();
    const link = await fetch(`${base}/?key=${KEY}`);
    const post = await fetch(`${base}/api/signin`, {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
    });
    assertEquals([link.status, post.status], [200, 204]);
    await link.body?.cancel();
    for (let i = 0; i < 5; i++) {
      const wrongLink = await fetch(`${base}/?key=wrong`);
      const wrongPost = await fetch(`${base}/api/signin`, {
        method: "POST",
        body: JSON.stringify({ key: "wrong" }),
      });
      assertEquals([wrongLink.status, wrongPost.status], [401, 401]);
      await wrongLink.body?.cancel();
      await wrongPost.body?.cancel();
    }
    const blockedLink = await fetch(`${base}/?key=${KEY}`);
    const blockedPost = await fetch(`${base}/api/signin`, {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
    });
    assertEquals([blockedLink.status, blockedPost.status], [429, 429]);
    await blockedLink.body?.cancel();
    await blockedPost.body?.cancel();
  } finally {
    web.close();
    await server.shutdown();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("sign-in buckets keep the form usable after link lockout", async () => {
  const { stateDir, web } = await fixture();
  try {
    for (let i = 0; i < 10; i++) {
      assertEquals((await web.handle(get("/?key=wrong"))).status, 401);
    }
    const blocked = await web.handle(get(`/?key=${KEY}`, {
      headers: { "if-none-match": "*" },
    }));
    assertEquals(blocked.status, 429);
    assertEquals(blocked.headers.get("cache-control"), "no-store");
    assert(blocked.headers.get("content-type")?.startsWith("text/html"));
    assert((await blocked.text()).includes('id="signin-form"'));
    assertEquals(blocked.headers.get("set-cookie"), null);
    assert((await signedInCookie(web)).startsWith("enil_web="));
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("sign-in buckets keep links usable after form lockout", async () => {
  const { stateDir, web } = await fixture();
  try {
    for (let i = 0; i < 10; i++) {
      const wrong = await web.handle(get("/api/signin", {
        method: "POST",
        body: JSON.stringify({ key: "wrong" }),
      }));
      assertEquals(wrong.status, 401);
    }
    const blocked = await web.handle(get("/api/signin", {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
    }));
    assertEquals(blocked.status, 429);
    const link = await web.handle(get(`/?key=${KEY}`));
    assertEquals(link.status, 303);
    assertEquals(link.headers.get("location"), "/");
    assert(link.headers.get("set-cookie")?.startsWith("enil_web="));
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("sign-in bounds unauthenticated request bodies and waiters", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "enil-web-signin-" });
  const web = await createWeb({
    addr: ADDR,
    key: KEY,
    stateDir,
    signinTimeoutMs: 30,
    log: () => {},
  });
  try {
    const large = await web.handle(get("/api/signin", {
      method: "POST",
      body: "x".repeat(8193),
    }));
    assertEquals(large.status, 413);
    const pending = Array.from(
      { length: 16 },
      () =>
        web.handle(get("/api/signin", {
          method: "POST",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"key":"'));
            },
          }),
        })),
    );
    const extra = await web.handle(get("/api/signin", {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
    }));
    assertEquals(extra.status, 503);
    assertEquals(
      (await Promise.all(pending)).map((r) => r.status),
      Array(16).fill(408),
    );
    const cookie = await signedInCookie(web);
    assert(cookie.startsWith("enil_web="));
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("an unusable key is replaced by a minted one", async () => {
  const auth = await WebAuth.create("short");
  assert(auth.key !== "short" && auth.key.length >= 16);
});

/** The standalone server's log up to its sign-in line, then stop it. */
async function signInLog(key: string | undefined): Promise<string[]> {
  const stateHome = await Deno.makeTempDir({ prefix: "enil-web-log-" });
  // The server refuses port 0, so borrow a free port when none is given.
  let port = TEST_PORT;
  if (!port) {
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    port = probe.addr.port;
    probe.close();
  }
  const env: Record<string, string> = {
    HOME: Deno.env.get("HOME") ?? "/",
    XDG_STATE_HOME: stateHome,
    ENIL_WEB_ADDR: `127.0.0.1:${port}`,
  };
  const denoDir = Deno.env.get("DENO_DIR");
  if (denoDir) env.DENO_DIR = denoDir;
  if (key !== undefined) env.ENIL_WEB_KEY = key;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("./server.ts", import.meta.url).pathname],
    clearEnv: true,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const lines: string[] = [];
  const reader = child.stdout.pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream()).getReader();
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lines.push(value);
      if (value.startsWith("[web] sign in: ")) break;
    }
  } finally {
    clearTimeout(timer);
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    await child.status;
    await reader.cancel().catch(() => {});
    await Deno.remove(stateHome, { recursive: true });
  }
  return lines;
}

Deno.test("the log names a key from the environment by its variable only", async () => {
  const lines = await signInLog(KEY);
  const signIn = lines.find((l) => l.startsWith("[web] sign in: "));
  assert(signIn, lines.join("\n"));
  assert(signIn.endsWith("/?key=<ENIL_WEB_KEY>"), signIn);
  assert(!lines.some((l) => l.includes(KEY)), "the key reached the log");
});

Deno.test("the log carries a minted key, since nothing else does", async () => {
  const lines = await signInLog(undefined);
  assert(lines.some((l) => l.startsWith("[web] no usable ENIL_WEB_KEY")));
  const signIn = lines.find((l) => l.startsWith("[web] sign in: "));
  assert(signIn, lines.join("\n"));
  const key = /\/\?key=([A-Za-z0-9._~-]{16,})$/.exec(signIn)?.[1];
  assert(key && key !== "<ENIL_WEB_KEY>", signIn);
});

Deno.test("only the page's own files are served", async () => {
  const { stateDir, web } = await fixture();
  try {
    const page = await web.handle(get("/"));
    assertEquals(page.status, 200);
    assert(page.headers.get("content-security-policy")?.includes("'self'"));
    await page.body?.cancel();
    const js = await web.handle(get("/js/app.js"));
    assertEquals(
      js.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    await js.body?.cancel();
    for (const path of ["/server.ts", "/js/../server.ts", "/js/a/b.js"]) {
      const res = await web.handle(get(path));
      await res.body?.cancel();
      assertEquals(res.status, 404, path);
    }
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("static assets revalidate against content after a restart", async () => {
  const temp = await Deno.makeTempDir({ prefix: "enil-web-assets-" });
  const stateDir = `${temp}/state`;
  const publicPath = `${temp}/public`;
  await Deno.mkdir(`${publicPath}/js`, { recursive: true });
  await Deno.writeTextFile(`${publicPath}/index.html`, "<html>first</html>");
  await Deno.writeTextFile(`${publicPath}/app.css`, "body { color: red; }");
  await Deno.writeTextFile(`${publicPath}/js/test.js`, "export const n = 1;");
  const options = {
    addr: ADDR,
    key: KEY,
    stateDir,
    publicDir: pathToFileURL(`${publicPath}/`),
    log: () => {},
  };
  let web = await createWeb(options);
  try {
    for (const path of ["/", "/app.css", "/js/test.js"]) {
      const response = await web.handle(get(path));
      assertEquals(response.status, 200, path);
      assertEquals(response.headers.get("cache-control"), "no-cache");
      assertEquals(response.headers.get("x-content-type-options"), "nosniff");
      assert(
        response.headers.get("content-security-policy")?.includes("'self'"),
      );
      const body = await response.arrayBuffer();
      assertEquals(
        Number(response.headers.get("content-length")),
        body.byteLength,
      );
      const tag = response.headers.get("etag");
      assert(tag);
      assert(tag.startsWith('"') && tag.endsWith('"'));
      for (const value of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
        const cached = await web.handle(get(path, {
          headers: { "if-none-match": value },
        }));
        assertEquals(cached.status, 304, `${path}: ${value}`);
        assertEquals(cached.headers.get("etag"), tag);
        assertEquals(cached.headers.get("cache-control"), "no-cache");
        assertEquals(cached.headers.get("x-content-type-options"), "nosniff");
        assertEquals(
          cached.headers.get("content-security-policy"),
          response.headers.get("content-security-policy"),
        );
        assertEquals(await cached.text(), "");
      }
    }
    const before = await web.handle(get("/js/test.js"));
    const oldTag = before.headers.get("etag");
    await before.body?.cancel();
    assert(oldTag);
    const original = await Deno.stat(`${publicPath}/js/test.js`);
    assert(original.mtime);
    await Deno.writeTextFile(`${publicPath}/js/test.js`, "export const n = 2;");
    await Deno.utime(
      `${publicPath}/js/test.js`,
      original.atime ?? original.mtime,
      original.mtime,
    );
    assertEquals(
      (await Deno.stat(`${publicPath}/js/test.js`)).mtime?.getTime(),
      original.mtime.getTime(),
    );
    web.close();
    web = await createWeb(options);
    const changed = await web.handle(get("/js/test.js", {
      headers: { "if-none-match": oldTag },
    }));
    assertEquals(changed.status, 200);
    assert(changed.headers.get("etag") !== oldTag);
    assertEquals(await changed.text(), "export const n = 2;");
  } finally {
    web.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("API responses stay no-store; signed-in media is private", async () => {
  const { stateDir, web } = await fixture();
  try {
    const session = await web.handle(get("/api/session", {
      headers: { "if-none-match": "*" },
    }));
    assertEquals(session.status, 200);
    assertEquals(session.headers.get("cache-control"), "no-store");
    assertEquals(await session.json(), { signedIn: false });
    const denied = await web.handle(get("/api/file?path=/x"));
    assertEquals(denied.status, 401);
    assertEquals(denied.headers.get("cache-control"), "no-store");
    const socket = await web.handle(get("/api/ws"));
    assertEquals(socket.status, 401);
    assertEquals(socket.headers.get("cache-control"), "no-store");
    const upload = await web.handle(get("/api/upload", { method: "POST" }));
    assertEquals(upload.status, 401);
    assertEquals(upload.headers.get("cache-control"), "no-store");
    const redirect = await web.handle(get(`/?key=${KEY}`));
    assertEquals(redirect.status, 303);
    assertEquals(redirect.headers.get("cache-control"), "no-store");
    const cookie = await signedInCookie(web);
    await Deno.writeTextFile(`${stateDir}/media/test.txt`, "private media");
    const media = await web.handle(get(
      `/api/file?path=${encodeURIComponent(`${stateDir}/media/test.txt`)}`,
      { headers: { cookie, "if-none-match": "*" } },
    ));
    assertEquals(media.status, 200);
    assertEquals(
      media.headers.get("cache-control"),
      "private, max-age=86400",
    );
    assertEquals(
      media.headers.get("content-security-policy"),
      "default-src 'none'; sandbox",
    );
    assertEquals(await media.text(), "private media");
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("page responses preload the private session on 200 and 304", async () => {
  const { stateDir, web } = await fixture();
  try {
    const cookie = await signedInCookie(web);
    const page = await web.handle(get("/"));
    const tag = page.headers.get("etag");
    assert(tag);
    const link = "</api/session>; rel=preload; as=fetch; crossorigin";
    assertEquals(page.headers.get("link"), link);
    const html = await page.text();
    const signedIn = await web.handle(get("/", { headers: { cookie } }));
    assertEquals(signedIn.headers.get("etag"), tag);
    assertEquals(signedIn.headers.get("link"), link);
    assertEquals(await signedIn.text(), html);
    const cached = await web.handle(get("/", {
      headers: { cookie, "if-none-match": tag },
    }));
    assertEquals(cached.status, 304);
    assertEquals(cached.headers.get("link"), link);
    assertEquals(cached.headers.get("cache-control"), "no-cache");
    const stylesheet = await web.handle(get("/app.css"));
    assertEquals(stylesheet.headers.get("link"), null);
    await stylesheet.body?.cancel();
    const redirect = await web.handle(get(`/?key=${KEY}`));
    assertEquals(redirect.status, 303);
    assertEquals(redirect.headers.get("link"), null);
    const session = await web.handle(
      get("/api/session", { headers: { cookie } }),
    );
    assertEquals(session.headers.get("cache-control"), "no-store");
    assertEquals(await session.json(), { signedIn: true });
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("uncompressed assets do not vary by Accept-Encoding", async () => {
  const { stateDir, web } = await fixture();
  try {
    for (const path of ["/", "/app.css", "/js/app.js"]) {
      const plain = await web.handle(get(path));
      const tag = plain.headers.get("etag");
      const body = await plain.text();
      assert(tag);
      const response = await web.handle(get(path, {
        headers: { "accept-encoding": "gzip, br" },
      }));
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("content-encoding"), null);
      assertEquals(response.headers.get("vary"), null);
      assertEquals(response.headers.get("etag"), tag);
      assertEquals(await response.text(), body);
      const cached = await web.handle(get(path, {
        headers: { "accept-encoding": "gzip, br", "if-none-match": tag },
      }));
      assertEquals(cached.status, 304);
      assertEquals(cached.headers.get("vary"), null);
      assertEquals(cached.headers.get("content-encoding"), null);
    }
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("modulepreload lists the entrypoint's runtime import graph", async () => {
  const publicDir = new URL("./public/", import.meta.url);
  const html = await Deno.readTextFile(new URL("index.html", publicDir));
  const entries = [...html.matchAll(
    /<script type="module" src="(\/js\/[^\"]+)">/g,
  )];
  assertEquals(entries.length, 1, "expected exactly one module entrypoint");
  const entry = new URL(entries[0][1].slice(1), publicDir).href;
  const preloads = [...html.matchAll(
    /<link rel="modulepreload" href="(\/js\/[^\"]+)">/g,
  )].map((match) => match[1]);
  assertEquals(new Set(preloads).size, preloads.length, "duplicate preload");
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--frozen", "--json", entry],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  const graph = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    modules: Array<{
      specifier: string;
      dependencies?: Array<{ code?: { specifier: string } }>;
    }>;
  };
  const modules = new Map(graph.modules.map((item) => [item.specifier, item]));
  const visited = new Set<string>();
  function visit(specifier: string) {
    if (visited.has(specifier)) return;
    const module = modules.get(specifier);
    assert(module, `missing import ${specifier}`);
    assert(specifier.startsWith(new URL("js/", publicDir).href), specifier);
    visited.add(specifier);
    for (const dependency of module.dependencies ?? []) {
      if (dependency.code) visit(dependency.code.specifier);
    }
  }
  visit(entry);
  visited.delete(entry);
  const paths = [...visited].map((url) => `/js/${url.split("/").pop()}`);
  assertEquals(preloads.sort(), paths.sort());
});

Deno.test("a POST from another origin is refused", async () => {
  const { stateDir, web } = await fixture();
  try {
    const res = await web.handle(get("/api/signin", {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
      headers: { origin: "https://evil.example", host: "100.64.0.1:3440" },
    }));
    assertEquals(res.status, 403);
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("canonicalHost folds the forms of one address together", () => {
  assertEquals(canonicalHost("100.64.0.1:3440"), "100.64.0.1:3440");
  assertEquals(canonicalHost("[::ffff:7f00:1]:3440"), "127.0.0.1:3440");
  assertEquals(canonicalHost("[::FFFF:127.0.0.1]:3440"), "127.0.0.1:3440");
  assertEquals(canonicalHost("[FD7A:0::1]:3440"), "[fd7a::1]:3440");
  assertEquals(canonicalHost("100.64.0.1:80"), "100.64.0.1");
  assertEquals(canonicalHost("Box:3440"), "box:3440");
  assertEquals(canonicalHost("evil@100.64.0.1:3440"), null);
  assertEquals(canonicalHost("100.64.0.1:3440/x"), null);
  assertEquals(canonicalHost("100.64.0.1:99999"), null);
});

Deno.test("only the configured Host reaches any route", async () => {
  const { stateDir, web } = await fixture("127.0.0.1:3440");
  try {
    for (const host of ["127.0.0.1:3440", "[::ffff:7f00:1]:3440"]) {
      const page = await web.handle(
        get("/", { headers: { host } }, "127.0.0.1:3440"),
      );
      assertEquals(page.status, 200, host);
      await page.body?.cancel();
    }
    const cookie = await signedInCookie(web, "127.0.0.1:3440");
    for (const host of ["localhost:3440", "127.0.0.1:3441", "[::1]:3440"]) {
      for (
        const [method, path] of [
          ["GET", "/"],
          ["GET", "/app.css"],
          ["GET", "/js/app.js"],
          ["GET", "/api/session"],
          ["GET", "/api/file?path=/x"],
          ["GET", "/api/ws"],
          ["POST", "/api/signout"],
        ]
      ) {
        const res = await web.handle(
          new Request(`http://${host}${path}`, {
            method,
            headers: {
              host,
              cookie,
              origin: `http://${host}`,
              upgrade: "websocket",
            },
          }),
        );
        assertEquals(res.status, 421, `${host} ${method} ${path}`);
      }
    }
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("a rebound or cross-site sign-in cannot lock out the key", async () => {
  const { stateDir, web } = await fixture();
  try {
    const rebound = "rebind.example:3440";
    for (let i = 0; i < 12; i++) {
      const headers = { host: rebound, origin: `http://${rebound}` };
      const link = await web.handle(
        new Request(`http://${rebound}/?key=wrong`, { headers }),
      );
      const post = await web.handle(
        new Request(`http://${rebound}/api/signin`, {
          method: "POST",
          headers,
          body: JSON.stringify({ key: "wrong" }),
        }),
      );
      assertEquals([link.status, post.status], [421, 421]);
    }
    for (const site of ["cross-site", "same-site"]) {
      for (let i = 0; i < 12; i++) {
        const link = await web.handle(get("/?key=wrong", {
          headers: { "sec-fetch-site": site },
        }));
        const post = await web.handle(get("/api/signin", {
          method: "POST",
          headers: { "sec-fetch-site": site },
          body: JSON.stringify({ key: "wrong" }),
        }));
        assertEquals([link.status, post.status], [403, 403], site);
      }
      const right = await web.handle(get(`/?key=${KEY}`, {
        headers: { "sec-fetch-site": site },
      }));
      assertEquals(right.status, 403, site);
    }
    for (let i = 0; i < 12; i++) {
      const post = await web.handle(get("/api/signin", {
        method: "POST",
        headers: { origin: "http://other.example" },
        body: JSON.stringify({ key: "wrong" }),
      }));
      assertEquals(post.status, 403);
    }
    for (const site of ["none", "same-origin"]) {
      const link = await web.handle(get(`/?key=${KEY}`, {
        headers: { "sec-fetch-site": site },
      }));
      assertEquals(link.status, 303, site);
    }
    const viaLink = await web.handle(get(`/?key=${KEY}`));
    assertEquals(viaLink.status, 303);
    assert((await signedInCookie(web)).startsWith("enil_web="));
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("a served request names its Host on the wire", async () => {
  const { stateDir, web, server, addr } = await served();
  try {
    const exchange = async (host: string) => {
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port: server.addr.port,
      });
      try {
        await conn.write(new TextEncoder().encode(
          `GET /?key=wrong HTTP/1.1\r\nHost: ${host}\r\n` +
            "Connection: close\r\n\r\n",
        ));
        const bytes = new Uint8Array(4096);
        const size = await conn.read(bytes);
        return new TextDecoder().decode(bytes.subarray(0, size ?? 0));
      } finally {
        conn.close();
      }
    };
    for (let i = 0; i < 12; i++) {
      assert((await exchange(`rebind.example:${server.addr.port}`))
        .startsWith("HTTP/1.1 421"));
    }
    assert((await exchange(addr)).startsWith("HTTP/1.1 401"));
    const right = await fetch(`http://${addr}/?key=${KEY}`, {
      redirect: "manual",
    });
    await right.body?.cancel();
    assertEquals(right.status, 303);
  } finally {
    web.close();
    await server.shutdown();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("POST and WebSocket origins include scheme and normalize host case", async () => {
  const addr = "box:3440";
  const { stateDir, web } = await fixture(addr);
  try {
    const cookie = await signedInCookie(web, addr);
    for (
      const [origin, host, expected] of [
        ["null", "box:3440", 403],
        ["https://box:3440", "box:3440", 403],
        ["http://evil:3440", "evil:3440", 421],
        ["http://BOX:3440", "BOX:3440", 204],
      ] as const
    ) {
      const headers = { cookie, origin, host };
      const post = await web.handle(get("/api/signout", {
        method: "POST",
        headers,
      }, addr));
      const ws = await web.handle(get("/api/ws", { headers }, addr));
      assertEquals(post.status, expected);
      assertEquals(ws.status, expected === 204 ? 400 : expected);
    }
    const withoutOrigin = { cookie, host: "box:3440" };
    assertEquals(
      (await web.handle(get("/api/signout", {
        method: "POST",
        headers: withoutOrigin,
      }, addr))).status,
      204,
    );
    assertEquals(
      (await web.handle(get("/api/ws", {
        headers: withoutOrigin,
      }, addr))).status,
      400,
    );
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("/api/file serves media and the QR, never storage.json", async () => {
  const { stateDir, web } = await fixture();
  try {
    const cookie = await signedInCookie(web);
    const file = async (path: string) => {
      const res = await web.handle(
        get(`/api/file?path=${encodeURIComponent(path)}`, {
          headers: { cookie },
        }),
      );
      await res.body?.cancel();
      return res;
    };
    await Deno.symlink(
      `${stateDir}/storage.json`,
      `${stateDir}/media/link.jpg`,
    );
    await Deno.writeFile(
      `${stateDir}/qr-1.png`,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]),
    );
    await Deno.writeTextFile(
      `${stateDir}/media/page.jpg`,
      "<html><script>alert(1)</script></html>",
    );
    assertEquals((await file(`${stateDir}/storage.json`)).status, 404);
    assertEquals((await file(`${stateDir}/media/link.jpg`)).status, 404);
    assertEquals(
      (await file(`${stateDir}/media/../storage.json`)).status,
      404,
    );
    const qr = await file(`${stateDir}/qr-1.png`);
    assertEquals(qr.status, 200);
    assertEquals(qr.headers.get("content-type"), "image/png");
    const page = await file(`${stateDir}/media/page.jpg`);
    assertEquals(page.headers.get("content-type"), "application/octet-stream");
    assert(page.headers.get("content-disposition")?.startsWith("attachment"));
  } finally {
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("file reads reject hard links and a file swapped before open", async () => {
  const { stateDir, web } = await fixture();
  const secret = `${stateDir}/storage.json`;
  const linked = `${stateDir}/media/hard-link`;
  const target = `${stateDir}/media/race`;
  const open = Deno.open;
  try {
    const cookie = await signedInCookie(web);
    const request = (path: string) =>
      web.handle(get(`/api/file?path=${encodeURIComponent(path)}`, {
        headers: { cookie },
      }));
    await Deno.link(secret, linked);
    assertEquals((await request(linked)).status, 404);
    await Deno.remove(linked);
    await Deno.writeTextFile(target, "public media");
    Object.defineProperty(Deno, "open", {
      configurable: true,
      value: async (path: string | URL, options?: Deno.OpenOptions) => {
        if (path === target) {
          await Deno.remove(target);
          await Deno.symlink(secret, target);
        }
        return await open(path, options);
      },
    });
    assertEquals((await request(target)).status, 404);
  } finally {
    Object.defineProperty(Deno, "open", { configurable: true, value: open });
    web.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("uploads share a quota across restarts and concurrent requests", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "enil-web-quota-" });
  const old = `${stateDir}/media/web-uploads/old`;
  await Deno.mkdir(old, { recursive: true });
  const sparse = await Deno.open(`${old}/large`, { write: true, create: true });
  await sparse.truncate(1024 * 1024 * 1024 - 3);
  sparse.close();
  const uploads = await Uploads.open(stateDir);
  const upload = (body: Uint8Array<ArrayBuffer>) =>
    uploads.receive(
      new Request("http://box/api/upload", { method: "POST", body }),
      new URL("http://box/api/upload?name=test"),
    );
  try {
    const results = await Promise.all([
      upload(new Uint8Array([1, 2])),
      upload(new Uint8Array([3, 4])),
    ]);
    assertEquals(results.map((r) => r.status).sort(), [200, 507]);
    const success = results.find((r) => r.status === 200)!;
    const { path } = await success.json();
    await uploads.discard(path);
    const retry = await upload(new Uint8Array([5, 6]));
    assertEquals(retry.status, 200);
    await retry.body?.cancel();
  } finally {
    uploads.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("uploads cap active streams and remove interrupted files", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "enil-web-stream-" });
  const uploads = await Uploads.open(stateDir);
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const upload = () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
        controller.enqueue(new Uint8Array([1]));
      },
    });
    return uploads.receive(
      new Request("http://box/api/upload", { method: "POST", body }),
      new URL("http://box/api/upload?name=test"),
    );
  };
  try {
    const pending = Array.from({ length: 4 }, upload);
    assertEquals((await upload()).status, 503);
    for (const controller of controllers) controller.error(new Error("closed"));
    assertEquals((await Promise.all(pending)).map((r) => r.status), [
      400,
      400,
      400,
      400,
    ]);
    const entries = [];
    for await (const entry of Deno.readDir(uploads.dir)) {
      entries.push(entry.name);
    }
    assertEquals(entries, []);
    const declared = await uploads.receive(
      new Request("http://box/api/upload", {
        method: "POST",
        body: "x",
        headers: { "content-length": "1073741825" },
      }),
      new URL("http://box/api/upload?name=test"),
    );
    assertEquals(declared.status, 413);
  } finally {
    uploads.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("idle uploads time out and closing cancels active uploads", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "enil-web-idle-" });
  const uploads = await Uploads.open(stateDir, 20, 60);
  const upload = () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    return uploads.receive(
      new Request("http://box/api/upload", { method: "POST", body }),
      new URL("http://box/api/upload?name=test"),
    );
  };
  try {
    assertEquals((await upload()).status, 408);
    let timer: ReturnType<typeof setInterval> | undefined;
    const trickle = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => controller.enqueue(new Uint8Array([1])), 5);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    assertEquals(
      (await uploads.receive(
        new Request("http://box/api/upload", { method: "POST", body: trickle }),
        new URL("http://box/api/upload?name=test"),
      )).status,
      408,
    );
    clearInterval(timer);
    const pending = upload();
    uploads.close();
    assertEquals((await pending).status, 400);
    const entries = [];
    for await (const entry of Deno.readDir(uploads.dir)) {
      entries.push(entry.name);
    }
    assertEquals(entries, []);
  } finally {
    uploads.close();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("the WebSocket bridge relays, and refuses what a browser may not ask", async () => {
  const { stateDir, web, server, addr } = await served();
  const seen: string[] = [];
  let daemonClosed = false;
  const daemon = Deno.listen({ transport: "unix", path: `${stateDir}/sock` });
  (async () => {
    for await (const conn of daemon) {
      (async () => {
        const lines = conn.readable.pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream());
        const enc = new TextEncoder();
        try {
          for await (const line of lines) {
            seen.push(line);
            const req = JSON.parse(line);
            await conn.write(
              enc.encode(JSON.stringify({ id: req.id, ok: true }) + "\n"),
            );
          }
        } finally {
          daemonClosed = true;
        }
      })().catch(() => {});
    }
  })().catch(() => {});
  try {
    const cookie = await signedInCookie(web, addr);
    const port = server.addr.port;
    const upload = await web.handle(
      get("/api/upload?name=a.txt", {
        method: "POST",
        body: "hello",
        headers: { cookie },
      }, addr),
    );
    const { path } = await upload.json();
    assert(path.startsWith(await Deno.realPath(`${stateDir}/media`)));

    // A browser on another site cannot open it with the user's cookie.
    const evil = await fetch(`http://127.0.0.1:${port}/api/ws`, {
      headers: {
        cookie,
        origin: "https://evil.example",
        upgrade: "websocket",
        connection: "upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    await evil.body?.cancel();
    assertEquals(evil.status, 403);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    const frames: Record<string, unknown>[] = [];
    const wantId = (id: number) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const check = () => {
          const hit = frames.find((f) => f.id === id);
          if (hit) resolve(hit);
          else setTimeout(check, 10);
        };
        check();
      });
    ws.onmessage = (ev) => frames.push(JSON.parse(ev.data));
    await new Promise((r) => ws.onopen = r);
    ws.send(JSON.stringify({ id: 1, cmd: "probeClipboardImage", chat: "c" }));
    ws.send(
      JSON.stringify({
        id: 2,
        cmd: "sendFile",
        chat: "c",
        path: `${stateDir}/storage.json`,
      }),
    );
    ws.send(JSON.stringify({ id: 3, cmd: "sendFile", chat: "c", path }));
    ws.send(JSON.stringify({ id: 4, cmd: "history", chat: "c" }));
    assertEquals((await wantId(1)).ok, false);
    assertEquals((await wantId(2)).ok, false);
    assertEquals((await wantId(3)).ok, true);
    assertEquals((await wantId(4)).ok, true);
    assert(frames.some((f) => f.web === "state"));
    assertEquals(seen.map((l) => JSON.parse(l).id), [3, 4]);
    // The daemon has answered the send, so the upload is gone.
    await Deno.stat(path).then(
      () => Promise.reject(new Error("upload kept")),
      () => {},
    );
    const closed = new Promise<CloseEvent>((r) => ws.onclose = r);
    web.close();
    assertEquals((await closed).code, 1001);
    assertEquals((await web.handle(get("/api/session"))).status, 503);
    for (let i = 0; i < 100 && !daemonClosed; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(daemonClosed);
  } finally {
    web.close();
    daemon.close();
    await server.shutdown();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("the bridge caps concurrent daemon connections and frees slots", async () => {
  const { stateDir, web, server, addr } = await served();
  const daemon = Deno.listen({ transport: "unix", path: `${stateDir}/sock` });
  const peers: Deno.UnixConn[] = [];
  const accept = (async () => {
    for await (const conn of daemon) peers.push(conn);
  })().catch(() => {});
  const sockets: WebSocket[] = [];
  try {
    const cookie = await signedInCookie(web, addr);
    const port = server.addr.port;
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { cookie, origin: `http://127.0.0.1:${port}` },
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket did not open"));
      });
      return ws;
    };
    for (let i = 0; i < 32; i++) await open();
    const refused = await fetch(`http://127.0.0.1:${port}/api/ws`, {
      headers: {
        cookie,
        origin: `http://127.0.0.1:${port}`,
        upgrade: "websocket",
        connection: "upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    assertEquals(refused.status, 503);
    await refused.body?.cancel();
    const firstClosed = new Promise<void>((r) =>
      sockets[0].onclose = () => r()
    );
    sockets[0].close();
    await firstClosed;
    await open();
  } finally {
    web.close();
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    daemon.close();
    await accept;
    for (const peer of peers) {
      try {
        peer.close();
      } catch { /* already closed */ }
    }
    await server.shutdown();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("the bridge bounds frames and the queue behind a slow daemon", async () => {
  const { stateDir, web, server, addr } = await served();
  const daemon = Deno.listen({ transport: "unix", path: `${stateDir}/sock` });
  const peers: Deno.UnixConn[] = [];
  const accept = (async () => {
    for await (const conn of daemon) peers.push(conn);
  })().catch(() => {});
  const sockets: WebSocket[] = [];
  try {
    const cookie = await signedInCookie(web, addr);
    const port = server.addr.port;
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { cookie, origin: `http://127.0.0.1:${port}` },
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket did not open"));
      });
      return ws;
    };
    const large = await open();
    const largeClosed = new Promise<CloseEvent>((r) => large.onclose = r);
    large.send(new Uint8Array([1, 2, 3]));
    large.send(JSON.stringify({ cmd: "history", x: "x".repeat(1024 * 1024) }));
    assertEquals((await largeClosed).code, 4003);

    const connect = Deno.connect;
    let release!: () => void;
    const waitForDaemon = new Promise<void>((r) => release = r);
    Object.defineProperty(Deno, "connect", {
      configurable: true,
      value: async (options: Deno.UnixConnectOptions) => {
        await waitForDaemon;
        return await connect(options);
      },
    });
    try {
      const slow = await open();
      const slowClosed = new Promise<CloseEvent>((r) => slow.onclose = r);
      const frame = JSON.stringify({ cmd: "history" });
      for (let i = 0; i < 129; i++) slow.send(frame);
      assertEquals((await slowClosed).code, 4004);
    } finally {
      release();
      Object.defineProperty(Deno, "connect", {
        configurable: true,
        value: connect,
      });
    }
  } finally {
    web.close();
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    daemon.close();
    await accept;
    for (const peer of peers) {
      try {
        peer.close();
      } catch { /* already closed */ }
    }
    await server.shutdown();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("duplicate request IDs cannot release an upload on another reply", async () => {
  const { stateDir, web, server, addr } = await served();
  const daemon = Deno.listen({ transport: "unix", path: `${stateDir}/sock` });
  let peer: Deno.UnixConn | undefined;
  try {
    const cookie = await signedInCookie(web, addr);
    const upload = await web.handle(get("/api/upload?name=test", {
      method: "POST",
      headers: { cookie },
      body: "hello",
    }, addr));
    const { path } = await upload.json();
    const port = server.addr.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    const opened = new Promise<void>((r) => ws.onopen = () => r());
    peer = await daemon.accept();
    const reader = peer.readable.pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream()).getReader();
    await opened;
    ws.send(JSON.stringify({ id: 123, cmd: "history" }));
    assertEquals(JSON.parse((await reader.read()).value!).cmd, "history");
    const closed = new Promise<CloseEvent>((r) => ws.onclose = r);
    ws.send(JSON.stringify({ id: 123, cmd: "sendFile", path, chat: "c" }));
    assertEquals((await closed).code, 4004);
    assert((await Deno.stat(path)).isFile);
    assertEquals((await reader.read()).done, true);
    reader.releaseLock();
  } finally {
    web.close();
    try {
      peer?.close();
    } catch { /* already closed */ }
    daemon.close();
    await server.shutdown();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("an upload is claimed by one sendFile across connections", async () => {
  const { stateDir, web, server, addr } = await served();
  const seen: Record<string, unknown>[] = [];
  let answerSend!: (ok: boolean) => void;
  const daemon = Deno.listen({ transport: "unix", path: `${stateDir}/sock` });
  const peers: Deno.UnixConn[] = [];
  const accept = (async () => {
    for await (const conn of daemon) {
      peers.push(conn);
      (async () => {
        const lines = conn.readable.pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream());
        const enc = new TextEncoder();
        for await (const line of lines) {
          const req = JSON.parse(line);
          seen.push(req);
          // A send is held until the test answers it, like a slow upload.
          const ok = req.cmd === "sendFile"
            ? await new Promise<boolean>((r) => answerSend = r)
            : true;
          await conn.write(
            enc.encode(JSON.stringify({ id: req.id, ok }) + "\n"),
          );
        }
      })().catch(() => {});
    }
  })().catch(() => {});
  const sockets: WebSocket[] = [];
  try {
    const cookie = await signedInCookie(web, addr);
    const port = server.addr.port;
    const uploadFile = async () => {
      const res = await web.handle(get("/api/upload?name=a.txt", {
        method: "POST",
        headers: { cookie },
        body: "hello",
      }, addr));
      return (await res.json()).path as string;
    };
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { cookie, origin: `http://127.0.0.1:${port}` },
      });
      sockets.push(ws);
      const frames: Record<string, unknown>[] = [];
      ws.onmessage = (ev) => frames.push(JSON.parse(ev.data));
      await new Promise((r) => ws.onopen = r);
      const reply = (id: number) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const deadline = Date.now() + 5_000;
          const check = () => {
            const hit = frames.find((f) => f.id === id);
            if (hit) resolve(hit);
            else if (Date.now() > deadline) reject(new Error(`no reply ${id}`));
            else setTimeout(check, 10);
          };
          check();
        });
      const sendFile = (id: number, path: string) => {
        ws.send(JSON.stringify({ id, cmd: "sendFile", chat: "c", path }));
        return reply(id);
      };
      return { ws, reply, sendFile };
    };
    const sends = () => seen.filter((r) => r.cmd === "sendFile").length;
    const waitForSends = async (n: number) => {
      for (let i = 0; i < 200 && sends() < n; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(sends(), n);
    };

    const path = await uploadFile();
    const a = await open(), b = await open();
    const first = a.sendFile(1, path);
    await waitForSends(1);
    // Another connection, and the same connection again, are both refused,
    // and neither refusal removes the file the first send is reading.
    const refused = {
      ok: false,
      error: "每個從網頁上傳的檔案只能傳送一次",
    };
    assertEquals(await b.sendFile(1, path), { id: 1, ...refused });
    assertEquals(await a.sendFile(2, path), { id: 2, ...refused });
    assert((await Deno.stat(path)).isFile);
    assertEquals(sends(), 1);

    // The holder's failed send still discards the upload, as before; the
    // page retries by uploading the file again, and that upload can be sent.
    answerSend(false);
    assertEquals((await first).ok, false);
    await Deno.stat(path).then(
      () => Promise.reject(new Error("upload kept")),
      () => {},
    );
    const retry = await uploadFile();
    assert(retry !== path);
    const second = b.sendFile(2, retry);
    await waitForSends(2);
    answerSend(true);
    assertEquals((await second).ok, true);
    await Deno.stat(retry).then(
      () => Promise.reject(new Error("upload kept")),
      () => {},
    );
  } finally {
    web.close();
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    daemon.close();
    await accept;
    for (const peer of peers) {
      try {
        peer.close();
      } catch { /* already closed */ }
    }
    await server.shutdown();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("the bridge forwards only the commands the page sends", async () => {
  const { stateDir, web, server, addr } = await served();
  const seen: string[] = [];
  const daemon = Deno.listen({ transport: "unix", path: `${stateDir}/sock` });
  const peers: Deno.UnixConn[] = [];
  const accept = (async () => {
    for await (const conn of daemon) {
      peers.push(conn);
      (async () => {
        const lines = conn.readable.pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream());
        const enc = new TextEncoder();
        for await (const line of lines) {
          const req = JSON.parse(line);
          seen.push(req.cmd);
          await conn.write(
            enc.encode(JSON.stringify({ id: req.id, ok: true }) + "\n"),
          );
        }
      })().catch(() => {});
    }
  })().catch(() => {});
  let ws: WebSocket | undefined;
  try {
    const cookie = await signedInCookie(web, addr);
    const port = server.addr.port;
    ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    const frames: Record<string, unknown>[] = [];
    ws.onmessage = (ev) => frames.push(JSON.parse(ev.data));
    await new Promise((r) => ws!.onopen = r);
    // Every command in public/js. sendFile is left out: it needs an upload,
    // and its own tests cover it.
    const page = [
      "download",
      "hide",
      "history",
      "login",
      "logout",
      "markRead",
      "members",
      "preview",
      "react",
      "reply",
      "send",
      "sendSticker",
      "stickers",
      "sync",
      "unhide",
      "unsend",
    ];
    // Real daemon commands the page never sends, and one it does not know.
    const other = ["image", "poke", "readFile", "toString"];
    const all = [...other, ...page];
    all.forEach((cmd, id) => ws!.send(JSON.stringify({ id, cmd, chat: "c" })));
    for (
      let i = 0;
      i < 200 && frames.filter((f) => "id" in f).length <
        all.length;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    for (const [id, cmd] of other.entries()) {
      assertEquals(frames.find((f) => f.id === id), {
        id,
        ok: false,
        error: "網頁版不支援這個指令",
      }, cmd);
    }
    assertEquals(seen, page);
  } finally {
    web.close();
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    daemon.close();
    await accept;
    for (const peer of peers) {
      try {
        peer.close();
      } catch { /* already closed */ }
    }
    await server.shutdown();
    await Deno.remove(stateDir, { recursive: true });
  }
});

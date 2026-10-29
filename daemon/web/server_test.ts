import { assert, assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";
import { WebAuth } from "./auth.ts";
import { sniffInline, uploadName, Uploads } from "./files.ts";
import { createWeb, parseAddr } from "./server.ts";

const KEY = "test-key-0123456789abcdef";
const TEST_PORT = Number(Deno.env.get("ENIL_WEB_TEST_PORT") ?? "0");

async function fixture() {
  const stateDir = await Deno.makeTempDir({ prefix: "enil-web-" });
  await Deno.mkdir(`${stateDir}/media`, { recursive: true });
  await Deno.writeTextFile(`${stateDir}/storage.json`, '{"secret":1}');
  await Deno.writeTextFile(
    `${stateDir}/state.json`,
    JSON.stringify({ login: { status: "ok" }, chats: [] }),
  );
  const web = await createWeb({
    addr: "127.0.0.1:0",
    key: KEY,
    stateDir,
    log: () => {},
  });
  return { stateDir, web };
}

function get(path: string, init: RequestInit = {}): Request {
  return new Request(`http://box:3440${path}`, init);
}

async function signedInCookie(
  web: Awaited<ReturnType<typeof createWeb>>,
): Promise<string> {
  const res = await web.handle(
    get("/api/signin", {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
      headers: { origin: "http://box:3440", host: "box:3440" },
    }),
  );
  assertEquals(res.status, 204);
  const set = res.headers.get("set-cookie") ?? "";
  assert(set.includes("HttpOnly") && set.includes("SameSite=Strict"));
  return set.split(";")[0];
}

Deno.test("parseAddr takes host:port and [v6]:port only", () => {
  assertEquals(parseAddr("100.1.2.3:3440"), {
    hostname: "100.1.2.3",
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

Deno.test("wrong keys age out of the cap", async () => {
  let now = 0;
  const auth = await WebAuth.create(KEY, () => now);
  for (let i = 0; i < 10; i++) assertEquals(auth.signin("nope"), "wrong");
  assertEquals(auth.signin(KEY), "blocked");
  now += 10 * 60 * 1000 + 1;
  assertEquals(auth.signin(KEY), "ok");
});

Deno.test("an unusable key is replaced by a minted one", async () => {
  const auth = await WebAuth.create("short");
  assert(auth.key !== "short" && auth.key.length >= 16);
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

Deno.test("a POST from another origin is refused", async () => {
  const { stateDir, web } = await fixture();
  try {
    const res = await web.handle(get("/api/signin", {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
      headers: { origin: "https://evil.example", host: "box:3440" },
    }));
    assertEquals(res.status, 403);
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
  const { stateDir, web } = await fixture();
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
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: TEST_PORT, onListen: () => {} },
    (req) => web.handle(req),
  );
  try {
    const cookie = await signedInCookie(web);
    const port = server.addr.port;
    const upload = await web.handle(
      get("/api/upload?name=a.txt", {
        method: "POST",
        body: "hello",
        headers: { cookie },
      }),
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
  const { stateDir, web } = await fixture();
  const daemon = Deno.listen({ transport: "unix", path: `${stateDir}/sock` });
  const peers: Deno.UnixConn[] = [];
  const accept = (async () => {
    for await (const conn of daemon) peers.push(conn);
  })().catch(() => {});
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: TEST_PORT, onListen: () => {} },
    (req) => web.handle(req),
  );
  const sockets: WebSocket[] = [];
  try {
    const cookie = await signedInCookie(web);
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
  const { stateDir, web } = await fixture();
  const daemon = Deno.listen({ transport: "unix", path: `${stateDir}/sock` });
  const peers: Deno.UnixConn[] = [];
  const accept = (async () => {
    for await (const conn of daemon) peers.push(conn);
  })().catch(() => {});
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: TEST_PORT, onListen: () => {} },
    (req) => web.handle(req),
  );
  const sockets: WebSocket[] = [];
  try {
    const cookie = await signedInCookie(web);
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

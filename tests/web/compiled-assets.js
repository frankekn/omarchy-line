// Verify embedded assets and their content ETags in a compiled daemon.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../daemon/", import.meta.url));
const port = Number(Deno.env.get("ENIL_WEB_TEST_PORT") ?? "18474");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("ENIL_WEB_TEST_PORT must be a valid port");
}
const temp = await Deno.makeTempDir({
  dir: Deno.env.get("ENIL_WEB_TEST_TMPDIR"),
  prefix: "web-compiled-assets-",
});
const copy = join(temp, "daemon"), state = join(temp, "state");
const binary = join(temp, "enil");
const base = `http://127.0.0.1:${port}`;
const children = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cleaning, failed = true;

async function copyTree(from, to) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if ([".git", "node_modules", "enil", "enil.rev"].includes(entry.name)) {
      continue;
    }
    const src = join(from, entry.name), dest = join(to, entry.name);
    if (entry.isDirectory) await copyTree(src, dest);
    else if (entry.isFile) await Deno.copyFile(src, dest);
    else throw new Error(`Unexpected source entry: ${src}`);
  }
}

function start(command, args, cwd, env, log) {
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const process = { child, ended: false, error: null, code: null };
  process.done = new Promise((resolve) => {
    child.once("error", (error) => {
      process.error = error;
      process.ended = true;
      resolve();
    });
    child.once("close", (code) => {
      process.code = code;
      process.ended = true;
      resolve();
    });
  });
  children.push(process);
  return process;
}

async function stop(process) {
  if (!process.child.pid) return;
  const signal = (name) => {
    try {
      Deno.kill(-process.child.pid, name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  signal("SIGTERM");
  if (!process.ended) {
    let timer;
    await Promise.race([
      process.done,
      new Promise((resolve) => timer = setTimeout(resolve, 2000)),
    ]);
    clearTimeout(timer);
  }
  signal("SIGKILL");
  await process.done;
}

const cleanup = () =>
  cleaning ??= (async () => {
    for (const process of children.reverse()) await stop(process);
  })();
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  Deno.addSignalListener(signal, () => {
    void (async () => {
      await cleanup();
      Deno.exit(code);
    })();
  });
}

try {
  await copyTree(source, copy);
  const paths = [
    ["/", "index.html"],
    ["/app.css", "app.css"],
    ["/js/app.js", "js/app.js"],
    ["/js/text.js", "js/text.js"],
  ];
  const expected = new Map();
  for (const [url, path] of paths) {
    const bytes = await Deno.readFile(join(copy, "web", "public", path));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const etag = `"${
      Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
    }"`;
    expected.set(url, { bytes, etag });
  }
  const env = {
    ...Deno.env.toObject(),
    XDG_STATE_HOME: state,
    ENIL_WEB_ADDR: `127.0.0.1:${port}`,
    ENIL_WEB_KEY: "compiled-assets-test-0123456789",
    ENIL_ASSET_BINARY: binary,
    DENO_NO_PROMPT: "1",
    DENO_FROZEN: "true",
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(temp, "no-system-bus")}`,
  };
  const build = start(
    "sh",
    [
      "-c",
      '. ./enil-flags.sh\nexec deno compile --frozen $ENIL_DENO_FLAGS --include web/public --output "$ENIL_ASSET_BINARY" daemon.ts',
    ],
    copy,
    env,
    join(temp, "build.log"),
  );
  await build.done;
  if (build.error || build.code !== 0) {
    throw new Error(`build failed: ${build.error ?? build.code}`);
  }
  await stop(build);
  children.pop();
  // Only the compiled binary can provide these assets after this removal.
  await Deno.remove(join(copy, "web", "public"), { recursive: true });
  const daemon = start(binary, [], temp, env, join(temp, "daemon.log"));
  const deadline = Date.now() + 15000;
  for (;;) {
    if (daemon.ended) throw daemon.error ?? new Error("daemon exited");
    const log = await Deno.readTextFile(join(temp, "daemon.log"));
    if (log.includes(`[web] sign in: ${base}/`)) break;
    if (Date.now() >= deadline) throw new Error("daemon did not start");
    await delay(25);
  }
  const session = await fetch(`${base}/api/session`);
  assert.equal(session.headers.get("cache-control"), "no-store");
  assert.deepEqual(await session.json(), { signedIn: false });
  for (const [url, { bytes, etag }] of expected) {
    const response = await fetch(`${base}${url}`, {
      headers: { "accept-encoding": "identity" },
    });
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get("etag"), etag, url);
    assert.equal(response.headers.get("cache-control"), "no-cache", url);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes, url);
    const cached = await fetch(`${base}${url}`, {
      headers: { "accept-encoding": "identity", "if-none-match": etag },
    });
    assert.equal(cached.status, 304, url);
    assert.equal(cached.headers.get("etag"), etag, url);
    assert.equal(await cached.text(), "");
    console.log(`PASS compiled asset ${url}: content hash and 304`);
  }
  failed = false;
} catch (error) {
  console.error(`FAIL compiled assets: ${error.stack ?? error}`);
  console.error(`Artifacts: ${temp}`);
  throw error;
} finally {
  await cleanup();
  if (!failed) await Deno.remove(temp, { recursive: true });
}

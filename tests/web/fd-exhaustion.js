// Exhaust the daemon's file descriptors through idle web connections, then
// check that the daemon survives and the web listener comes back.
// Run: deno run -A tests/web/fd-exhaustion.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const daemonDir = fileURLToPath(new URL("../../daemon/", import.meta.url));
const port = Number(Deno.env.get("ENIL_WEB_TEST_PORT") ?? "18475");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("ENIL_WEB_TEST_PORT must be a valid port");
}
const FD_LIMIT = 256;
const IDLE_CONNECTIONS = 300;
const temp = await Deno.makeTempDir({
  dir: Deno.env.get("ENIL_WEB_TEST_TMPDIR"),
  prefix: "web-fd-exhaustion-",
});
const log = join(temp, "daemon.log");
const sockPath = join(temp, "state", "enil", "sock");
const base = `http://127.0.0.1:${port}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sockets = [];
let daemon, cleaning, failed = true;

function start() {
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = spawn("sh", [
      "-c",
      `ulimit -n ${FD_LIMIT} && exec "$0" run -A --frozen daemon.ts`,
      Deno.execPath(),
    ], {
      cwd: daemonDir,
      env: {
        ...Deno.env.toObject(),
        XDG_STATE_HOME: join(temp, "state"),
        ENIL_WEB_ADDR: `127.0.0.1:${port}`,
        ENIL_WEB_KEY: "fd-exhaustion-test-0123456789",
        DENO_NO_PROMPT: "1",
        DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(temp, "no-system-bus")}`,
      },
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
    child.once("close", (code, signal) => {
      process.code = code ?? signal;
      process.ended = true;
      resolve();
    });
  });
  return process;
}

async function stop(process) {
  if (!process?.child.pid || process.ended) return;
  const signal = (name) => {
    try {
      Deno.kill(-process.child.pid, name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  signal("SIGTERM");
  let timer;
  await Promise.race([
    process.done,
    new Promise((resolve) => timer = setTimeout(resolve, 3000)),
  ]);
  clearTimeout(timer);
  if (!process.ended) {
    signal("SIGKILL");
    await process.done;
  }
}

const cleanup = () =>
  cleaning ??= (async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await stop(daemon);
  })();
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  Deno.addSignalListener(signal, () => {
    void (async () => {
      await cleanup();
      Deno.exit(code);
    })();
  });
}

async function until(predicate, message, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (daemon.ended) {
      throw new Error(`daemon exited (${daemon.code}) waiting for ${message}`);
    }
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function socketAnswers() {
  let conn;
  try {
    conn = await Deno.connect({ transport: "unix", path: sockPath });
    await conn.write(new TextEncoder().encode('{"cmd":"none"}\n'));
    const bytes = new Uint8Array(4096);
    const timer = setTimeout(() => conn.close(), 1000);
    const size = await conn.read(bytes).finally(() => clearTimeout(timer));
    return size !== null && size > 0;
  } catch {
    return false;
  } finally {
    try {
      conn?.close();
    } catch { /* The read timer already closed it. */ }
  }
}

async function signedOut() {
  try {
    const response = await fetch(`${base}/api/session`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.status === 200 &&
      (await response.json()).signedIn === false;
  } catch {
    return false;
  }
}

try {
  daemon = start();
  await until(
    async () =>
      (await Deno.readTextFile(log).catch(() => "")).includes(
        `[web] sign in: ${base}/`,
      ),
    "web bind",
    30000,
  );
  assert.ok(await signedOut(), "web answers before exhaustion");
  for (let i = 0; i < IDLE_CONNECTIONS; i++) {
    try {
      sockets.push(await Deno.connect({ hostname: "127.0.0.1", port }));
    } catch (error) {
      // The listener closes when accept fails, which refuses or resets the
      // connects still in flight.
      if (
        !(error instanceof Deno.errors.ConnectionRefused) &&
        !(error instanceof Deno.errors.ConnectionReset)
      ) throw error;
      break;
    }
  }
  await until(
    async () => /Too many open files/.test(await Deno.readTextFile(log)),
    "the daemon to run out of descriptors",
    10000,
  );
  for (let i = 0; i < 4; i++) {
    sockets.push(await Deno.connect({ transport: "unix", path: sockPath }));
  }
  await delay(1000);
  assert.equal(daemon.ended, false, "daemon survives EMFILE");
  console.log("PASS daemon survives descriptor exhaustion");
  for (const socket of sockets.splice(0)) socket.close();
  await until(signedOut, "the web listener to recover", 30000);
  console.log("PASS web listener recovers after descriptors free up");
  await until(socketAnswers, "the daemon socket to answer", 10000);
  console.log("PASS daemon socket answers after descriptors free up");
  const text = await Deno.readTextFile(log);
  assert.match(text, /\[web\] cannot serve .*Too many open files/);
  assert.doesNotMatch(text, /\[unhandled\]/, "no rejection reaches the guard");
  console.log("PASS the web loop handles EMFILE before the guard sees it");
  failed = false;
} catch (error) {
  console.error(`FAIL fd exhaustion: ${error.stack ?? error}`);
  console.error(await Deno.readTextFile(log).catch(() => ""));
  console.error(`Artifacts: ${temp}`);
  throw error;
} finally {
  await cleanup();
  if (!failed) await Deno.remove(temp, { recursive: true });
}

// Check that the real daemon publishes committed state without a poll delay.
// Run: CHROMIUM=/usr/bin/chromium deno run --frozen -A tests/web/state-notify.js
import { chromium } from "npm:playwright@1.64.1";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temp = await Deno.makeTempDir({
  dir: Deno.env.get("ENIL_WEB_TEST_TMPDIR"),
  prefix: "web-state-notify-",
});
const configured = Deno.env.get("ENIL_WEB_TEST_PORT");
const port = configured === undefined ? 0 : Number(configured);
assert.ok(
  configured !== "" && Number.isInteger(port) && port >= 0 && port <= 65535,
);
const listener = Deno.listen({ hostname: "127.0.0.1", port });
const selected = listener.addr.port;
listener.close();
const base = `http://127.0.0.1:${selected}`;
const key = "devkey-0123456789abcdef";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fd = openSync(`${temp}/daemon.log`, "a", 0o600);
let daemon, browser, browserLaunch, failed = true, cleanupPromise;

function cleanup() {
  return cleanupPromise ??= (async () => {
    const launched = browser ?? await browserLaunch?.catch(() => null);
    await launched?.close().catch(() => {});
    if (daemon?.pid) {
      try {
        Deno.kill(-daemon.pid, "SIGTERM");
      } catch { /* Already stopped. */ }
      if (daemon.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => daemon.once("close", resolve)),
          delay(2000),
        ]);
      }
      try {
        Deno.kill(-daemon.pid, "SIGKILL");
      } catch { /* Already stopped. */ }
    }
  })();
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  Deno.addSignalListener(signal, () => {
    void cleanup().finally(() => Deno.exit(code));
  });
}

try {
  try {
    daemon = spawn(Deno.execPath(), ["run", "--frozen", "-A", "daemon.ts"], {
      cwd: `${root}daemon`,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...Deno.env.toObject(),
        XDG_STATE_HOME: temp,
        ENIL_WEB_ADDR: `127.0.0.1:${selected}`,
        ENIL_WEB_KEY: key,
        DENO_NO_PROMPT: "1",
        DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${temp}/no-system-bus`,
      },
    });
  } finally {
    closeSync(fd);
  }
  let spawnError;
  daemon.on("error", (error) => spawnError = error);
  const deadline = Date.now() + 15000;
  for (;;) {
    if (spawnError || daemon.exitCode !== null) {
      throw spawnError ?? new Error(`daemon exited: ${daemon.exitCode}`);
    }
    const log = await Deno.readTextFile(`${temp}/daemon.log`);
    if (log.includes(`[web] sign in: ${base}/`)) break;
    if (Date.now() >= deadline) throw new Error("daemon startup timed out");
    await delay(25);
  }
  browserLaunch = chromium.launch({
    executablePath: Deno.env.get("CHROMIUM") || undefined,
    args: ["--no-sandbox", "--no-proxy-server"],
  });
  browser = await browserLaunch;
  const page = await browser.newPage({ locale: "en-US" });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel("Web key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("#connection.connected").waitFor();
  await page.evaluate(() => {
    const socket = new WebSocket(
      `ws://${location.host}/api/ws`,
      "enil-state-delta-v1",
    );
    globalThis.__notifySocket = socket;
    globalThis.__notifyFrames = [];
    socket.onmessage = (event) => {
      globalThis.__notifyFrames.push({
        at: performance.now(),
        frame: JSON.parse(event.data),
      });
    };
  });
  await page.waitForFunction(() =>
    globalThis.__notifyFrames.some(({ frame }) =>
      frame.web === "state" && frame.state.login.status === "idle"
    )
  );
  let previous = await page.evaluate(() =>
    globalThis.__notifyFrames.find(({ frame }) =>
      frame.web === "state" && frame.state.login.status === "idle"
    ).frame
  );
  for (let i = 0; i < 5; i++) {
    const id = `notify-${i}`, revision = previous.state.chatsRevision;
    await page.evaluate(({ id, command }) => {
      globalThis.__notifySocket.send(JSON.stringify({
        id,
        cmd: command,
        chat: "state-notify-test",
      }));
    }, { id, command: i % 2 ? "unhide" : "hide" });
    await page.waitForFunction(({ id, revision }) => {
      const frames = globalThis.__notifyFrames;
      return frames.some(({ frame }) => frame.id === id) &&
        frames.some(({ frame }) =>
          frame.web === "state" && frame.state.chatsRevision > revision
        );
    }, { id, revision });
    const { reply, update } = await page.evaluate(({ id, revision }) => {
      const frames = globalThis.__notifyFrames;
      return {
        reply: frames.find(({ frame }) => frame.id === id),
        update: frames.find(({ frame }) =>
          frame.web === "state" && frame.state.chatsRevision > revision
        ),
      };
    }, { id, revision });
    assert.equal(reply.frame.ok, true);
    assert.equal(update.frame.generation, previous.generation);
    assert.equal(update.frame.version, previous.version + 1);
    assert.ok(update.at - reply.at < 200, "state notification was delayed");
    previous = update.frame;
  }
  await page.context().close();
  assert.deepEqual(errors, [], "browser console and page errors");
  failed = false;
  console.log("PASS state-notify real daemon and browser");
} catch (error) {
  console.error(`FAIL state-notify: ${error.stack ?? error}`);
  console.error(`Artifacts: ${temp}`);
  throw error;
} finally {
  await cleanup();
  if (!failed) await Deno.remove(temp, { recursive: true });
}

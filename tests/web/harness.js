// Isolated browser, stub and web server for each end-to-end suite.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "npm:playwright@1.64.1";

export { assert };
export const CHAT = "cstub-family";
export const KEY = "devkey-0123456789abcdef";
const root = fileURLToPath(new URL("../../", import.meta.url));
const daemonDir = `${root}daemon`;
const browserName = Deno.env.get("ENIL_WEB_BROWSER") ?? "chromium";
if (browserName !== "chromium" && browserName !== "webkit") {
  throw new Error("ENIL_WEB_BROWSER must be chromium or webkit");
}
const screenshotCspError =
  "Refused to apply a stylesheet because its hash, its nonce, or " +
  "'unsafe-inline' does not appear in the style-src directive of the " +
  "Content Security Policy.";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeCleanup;

// Child processes run in their own sessions. A signal to the runner must not
// leave the detached groups behind.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  Deno.addSignalListener(signal, () => {
    void (async () => {
      await activeCleanup?.();
      Deno.exit(code);
    })();
  });
}

function start(command, args, { cwd, env, log }) {
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
  const state = { child, ended: false, error: null };
  state.done = new Promise((resolve) => {
    child.once("error", (error) => {
      state.error = error;
      state.ended = true;
      resolve();
    });
    child.once("close", () => {
      state.ended = true;
      resolve();
    });
  });
  return state;
}

async function stop(state) {
  if (!state?.child.pid || state.ended) return;
  const signal = (name) => {
    try {
      Deno.kill(-state.child.pid, name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  // Signal the whole group so its descendants do not outlive the suite.
  signal("SIGTERM");
  let timer;
  await Promise.race([
    state.done,
    new Promise((resolve) => timer = setTimeout(resolve, 2000)),
  ]);
  clearTimeout(timer);
  if (!state.ended) {
    signal("SIGKILL");
    await state.done;
  }
}

export async function until(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function choosePort() {
  const configured = Deno.env.get("ENIL_WEB_TEST_PORT");
  const port = configured === undefined ? 0 : Number(configured);
  if (
    !Number.isInteger(port) || port < 0 || port > 65535 || configured === ""
  ) {
    throw new Error("ENIL_WEB_TEST_PORT must be a valid port");
  }
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  const selected = listener.addr.port;
  listener.close();
  return selected;
}

/** Record and optionally alter the protocol while preserving normal traffic. */
export async function tapSocket(page, hooks = {}) {
  const tap = { sent: [], received: [], socket: null, server: null };
  await page.routeWebSocket("**/api/ws", (socket) => {
    tap.socket = socket;
    const server = socket.connectToServer();
    tap.server = server;
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      tap.sent.push(frame);
      if (hooks.client?.(frame, tap) !== false) {
        server.send(JSON.stringify(frame));
      }
    });
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      tap.received.push(frame);
      if (hooks.server?.(frame, tap) !== false) {
        socket.send(JSON.stringify(frame));
      }
    });
  });
  return tap;
}

/** Start a fresh state directory, daemon stub, web server and browser. */
export async function runSuite(name, suite) {
  const port = choosePort();
  const stateRoot = Deno.env.get("ENIL_WEB_TEST_TMPDIR");
  const temp = await Deno.makeTempDir({
    dir: stateRoot,
    prefix: `web-${name}-`,
  });
  // The mapped address reaches the IPv4 listener, passes the server's Host
  // check as the same IP, and is not a secure context in either browser.
  const base = `http://[::ffff:7f00:1]:${port}`;
  const stateDir = `${temp}/enil`;
  const children = [];
  const contexts = [];
  const errors = [];
  const dialogs = [];
  const expiredImagePages = new Map();
  const blockedLinkPages = new Map();
  let browser, browserLaunch, screenshotPage;
  let failed = false;
  let cleanupPromise;
  const cleanup = () =>
    cleanupPromise ??= (async () => {
      for (const context of contexts) await context.close().catch(() => {});
      const launched = browser ?? await browserLaunch?.catch(() => null);
      await launched?.close().catch(() => {});
      for (const child of children.reverse()) await stop(child);
    })();
  activeCleanup = cleanup;
  const env = {
    ...Deno.env.toObject(),
    XDG_STATE_HOME: temp,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  try {
    const stub = start("python3", [`${daemonDir}/stub.py`], {
      cwd: root,
      env,
      log: `${temp}/stub.log`,
    });
    children.push(stub);
    await until(async () => {
      if (stub.ended) throw stub.error ?? new Error("stub exited");
      return await Deno.stat(`${stateDir}/sock`).then(() => true, () => false);
    }, "stub socket");
    const server = start(Deno.execPath(), [
      "run",
      "-A",
      "--frozen",
      "web/server.ts",
    ], {
      cwd: daemonDir,
      env: { ...env, ENIL_WEB_ADDR: `127.0.0.1:${port}`, ENIL_WEB_KEY: KEY },
      log: `${temp}/server.log`,
    });
    children.push(server);
    await until(async () => {
      if (server.ended) throw server.error ?? new Error("web server exited");
      const log = await Deno.readTextFile(`${temp}/server.log`).catch(() => "");
      return log.includes(`[web] sign in: http://127.0.0.1:${port}/`);
    }, "web server bind");
    browserLaunch = browserName === "webkit"
      ? webkit.launch()
      : chromium.launch({
        executablePath: Deno.env.get("CHROMIUM") || undefined,
        args: [
          "--no-sandbox",
          "--no-proxy-server",
        ],
      });
    browser = await browserLaunch;
    const harness = {
      base,
      browserName,
      stateDir,
      dialogs,
      step(name) {
        console.log(`  PASS ${name}`);
      },
      allowExpiredImage401(page) {
        if (browserName !== "webkit") return () => 0;
        const entry = { count: 0 };
        expiredImagePages.set(page, entry);
        return () => {
          expiredImagePages.delete(page);
          return entry.count;
        };
      },
      allowBlockedLink429(page) {
        const entry = { count: 0 };
        blockedLinkPages.set(page, entry);
        return () => {
          blockedLinkPages.delete(page);
          return entry.count;
        };
      },
      async context(options = {}) {
        const device = browserName === "webkit" && options.isMobile
          ? devices["iPhone 13"]
          : {};
        const context = await browser.newContext({ ...device, ...options });
        contexts.push(context);
        await context.addInitScript(() => {
          document.addEventListener("securitypolicyviolation", (event) => {
            console.log(
              "[csp] " + JSON.stringify({
                blockedURI: event.blockedURI,
                sourceFile: event.sourceFile,
                lineNumber: event.lineNumber,
                columnNumber: event.columnNumber,
                sample: event.sample,
                effectiveDirective: event.effectiveDirective,
                violatedDirective: event.violatedDirective,
                disposition: event.disposition,
              }),
            );
          });
        });
        // The stub's sticker and FLEX URLs are real HTTPS URLs; keep their
        // browser rendering deterministic without fetching external images.
        for (
          const [url, image] of [
            ["https://stickershop.line-scdn.net/**", "sticker.png"],
            ["https://placehold.co/**", "flex-status.png"],
          ]
        ) {
          await context.route(
            url,
            (route) =>
              route.fulfill({ path: `${root}docs/images/demo/${image}` }),
          );
        }
        context.on("page", (page) => {
          page.on("console", (message) => {
            const text = message.text();
            if (message.type() === "log" && text.startsWith("[csp] ")) {
              console.log(`  ${text}`);
            }
            if (message.type() !== "error") return;
            // Chromium and Android use interactive-widget; WebKit ignores it
            // and reports this harmless warning as an error.
            if (
              browserName === "webkit" &&
              text ===
                'Viewport argument key "interactive-widget" not recognized and ignored.'
            ) return;
            // Playwright's WebKit screenshot inserts "body {}" to sync
            // animations. Ignore only its exact CSP error during a failure
            // screenshot; ordinary page errors still fail the suite.
            if (
              browserName === "webkit" && screenshotPage === page &&
              text === screenshotCspError
            ) return;
            // An image already in flight may get 401 when an expiry test
            // clears its cookie. Allow only that page, URL and exact message.
            const expiry = expiredImagePages.get(page);
            if (
              browserName === "webkit" && expiry &&
              text ===
                "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
            ) {
              try {
                const location = new URL(message.location().url);
                if (
                  location.origin === base && location.pathname === "/api/file"
                ) {
                  expiry.count++;
                  return;
                }
              } catch { /* The error has no usable URL. */ }
            }
            // The blocked-link test deliberately loads the 429 document.
            const blocked = blockedLinkPages.get(page);
            if (
              blocked && text ===
                "Failed to load resource: the server responded with a status of 429 (Too Many Requests)"
            ) {
              try {
                const location = new URL(message.location().url);
                if (
                  location.origin === base && location.pathname === "/" &&
                  location.searchParams.has("key")
                ) {
                  blocked.count++;
                  return;
                }
              } catch { /* The error has no usable URL. */ }
            }
            errors.push(text);
          });
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("dialog", async (dialog) => {
            dialogs.push({ type: dialog.type(), message: dialog.message() });
            if (dialog.type() === "alert") await dialog.dismiss();
            else await dialog.accept();
          });
        });
        return context;
      },
      async signIn(page) {
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.getByLabel("Web key").fill(KEY);
        await page.getByRole("button", { name: /^(登入|Sign in)$/ }).click();
        await page.locator("#connection.connected").waitFor();
      },
      async state() {
        return JSON.parse(await Deno.readTextFile(`${stateDir}/state.json`));
      },
      async request(request) {
        const conn = await Deno.connect({
          transport: "unix",
          path: `${stateDir}/sock`,
        });
        try {
          const data = new TextEncoder().encode(JSON.stringify(request) + "\n");
          let offset = 0;
          while (offset < data.length) {
            offset += await conn.write(data.subarray(offset));
          }
          const bytes = new Uint8Array(65536);
          const decoder = new TextDecoder();
          let text = "";
          for (;;) {
            const n = await conn.read(bytes);
            if (n === null) throw new Error("stub closed before replying");
            text += decoder.decode(bytes.subarray(0, n), { stream: true });
            const end = text.indexOf("\n");
            if (end >= 0) {
              const reply = JSON.parse(text.slice(0, end));
              assert.equal(reply.ok, true, JSON.stringify(reply));
              return reply.data;
            }
          }
        } finally {
          conn.close();
        }
      },
    };
    await suite(harness);
    assert.deepEqual(errors, [], "browser console and page errors");
    for (const context of contexts) await context.close();
    assert.deepEqual(errors, [], "browser console and page errors on close");
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    let index = 0;
    for (const context of contexts) {
      for (const page of context.pages()) {
        screenshotPage = page;
        try {
          await page.screenshot({ path: `${temp}/failure-${++index}.png` })
            .catch(() => {});
        } finally {
          screenshotPage = undefined;
        }
      }
    }
    console.error(`FAIL ${name}: ${error.stack ?? error}`);
    if (errors.length) console.error("Browser errors:", errors);
    console.error(`Artifacts: ${temp}`);
    throw error;
  } finally {
    await cleanup();
    activeCleanup = undefined;
    if (!failed) await Deno.remove(temp, { recursive: true });
  }
}

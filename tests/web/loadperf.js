// Measure cold and warm web loads against an isolated stub at simulated RTTs.
// Run independently: CHROMIUM=/usr/bin/chromium deno run -A tests/web/loadperf.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "npm:playwright@1.64.1";

const root = fileURLToPath(new URL("../../", import.meta.url));
const daemonDir = `${root}daemon`;
const port = Number(Deno.env.get("ENIL_WEB_TEST_PORT") ?? "18470");
const stateRoot = Deno.env.get("ENIL_WEB_TEST_TMPDIR");
const key = "loadperf-key-0123456789";
const base = `http://enil.test:${port}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("ENIL_WEB_TEST_PORT must be a valid port");
}

async function importGraph() {
  const entry = new URL("../../daemon/web/public/js/app.js", import.meta.url);
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--frozen", "--json", entry.href],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  const graph = JSON.parse(new TextDecoder().decode(output.stdout));
  const byName = new Map(
    graph.modules.map((module) => [module.specifier, module]),
  );
  const visited = new Set();
  function walk(name, path) {
    assert.ok(!path.includes(name), `cyclic import: ${name}`);
    const module = byName.get(name);
    assert.ok(module, `missing graph module: ${name}`);
    visited.add(name);
    const children = (module.dependencies ?? []).flatMap((dependency) =>
      dependency.code?.specifier ? [dependency.code.specifier] : []
    );
    return 1 +
      Math.max(0, ...children.map((child) => walk(child, [...path, name])));
  }
  const depth = walk(entry.href, []);
  return { modules: visited.size, depth };
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
  if (!state?.child.pid) return;
  const signal = (name) => {
    try {
      Deno.kill(-state.child.pid, name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  signal("SIGTERM");
  if (!state.ended) {
    let timer;
    await Promise.race([
      state.done,
      new Promise((resolve) => timer = setTimeout(resolve, 2000)),
    ]);
    clearTimeout(timer);
  }
  signal("SIGKILL");
  await state.done;
}

async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function measure(page, cdp, latency, cache) {
  const requests = new Map();
  const extras = new Map();
  const errors = [];
  let navigationAt, sessionStartAt, sessionAt, socketAt, frameAt, socketId;
  const onRequest = ({ requestId, request, timestamp, type }) => {
    if (request.url.startsWith(`${base}/`)) {
      if (type === "Document") navigationAt = timestamp;
      if (request.url === `${base}/api/session`) sessionStartAt = timestamp;
      requests.set(requestId, {
        url: request.url,
        type,
        bytes: 0,
        status: 0,
        encoding: "",
      });
    }
  };
  const onResponse = ({ requestId, response, timestamp }) => {
    const row = requests.get(requestId);
    if (row) {
      row.status = response.status;
      if (row.url === `${base}/api/session`) sessionAt = timestamp;
      row.encoding = Object.entries(response.headers).find(([name]) =>
        name.toLowerCase() === "content-encoding"
      )?.[1] ?? "";
    }
  };
  const onExtra = ({ requestId, statusCode }) =>
    extras.set(requestId, statusCode);
  const onDone = ({ requestId, encodedDataLength }) => {
    const row = requests.get(requestId);
    if (row) row.bytes = encodedDataLength;
  };
  const onSocket = ({ requestId, url }) => {
    if (url === `ws://enil.test:${port}/api/ws`) socketId = requestId;
  };
  const onHandshake = ({ requestId, timestamp }) => {
    if (requestId === socketId) socketAt = timestamp;
  };
  const onFrame = ({ requestId, timestamp }) => {
    if (requestId === socketId && frameAt === undefined) frameAt = timestamp;
  };
  const onConsole = (message) => {
    if (message.type() === "error") errors.push(message.text());
  };
  const onPageError = (error) => errors.push(error.message);
  cdp.on("Network.requestWillBeSent", onRequest);
  cdp.on("Network.responseReceived", onResponse);
  cdp.on("Network.responseReceivedExtraInfo", onExtra);
  cdp.on("Network.loadingFinished", onDone);
  cdp.on("Network.webSocketCreated", onSocket);
  cdp.on("Network.webSocketWillSendHandshakeRequest", onHandshake);
  cdp.on("Network.webSocketFrameReceived", onFrame);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    if (cache === "cold") await page.goto(base, { waitUntil: "commit" });
    else await page.reload({ waitUntil: "commit" });
    await page.waitForFunction(() => globalThis.loadperfTimes.list, undefined, {
      polling: "raf",
      timeout: 30000,
    });
    const listMs = await page.evaluate(() => globalThis.loadperfTimes.list);
    await page.locator('#chat-list .chat-row[data-chat-id="ustub-notes"]')
      .click();
    await page.waitForFunction(
      () => globalThis.loadperfTimes.message,
      undefined,
      {
        polling: "raf",
        timeout: 30000,
      },
    );
    const messageMs = await page.evaluate(() =>
      globalThis.loadperfTimes.message
    );
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    assert.deepEqual(errors, [], "browser console and page errors");
    const rows = [...requests.entries()].map(([id, row]) => ({
      ...row,
      status: extras.get(id) ?? row.status,
    }));
    assert.equal(
      rows.find((row) => row.type === "Document")?.status,
      cache === "cold" ? 200 : 304,
    );
    assert.equal(
      rows.filter((row) => row.url === `${base}/api/session`).length,
      1,
    );
    assert.ok(
      navigationAt && sessionAt && socketAt && frameAt,
      "network timing",
    );
    const result = {
      latencyMs: latency,
      cache,
      listMs: Math.round(listMs),
      messageMs: Math.round(messageMs),
      requests: rows.length,
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      notModified: rows.filter((row) => row.status === 304).length,
      documentStatus: rows.find((row) => row.type === "Document")?.status,
      gzipResponses: rows.filter((row) => row.encoding === "gzip").length,
      sessionRequests: rows.filter((row) => row.url === `${base}/api/session`)
        .length,
      sessionStartMs: Math.round((sessionStartAt - navigationAt) * 1000),
      sessionResponseMs: Math.round((sessionAt - navigationAt) * 1000),
      socketStartMs: Math.round((socketAt - navigationAt) * 1000),
      firstSocketFrameMs: Math.round((frameAt - navigationAt) * 1000),
    };
    console.log(JSON.stringify(result));
  } finally {
    cdp.off("Network.requestWillBeSent", onRequest);
    cdp.off("Network.responseReceived", onResponse);
    cdp.off("Network.responseReceivedExtraInfo", onExtra);
    cdp.off("Network.loadingFinished", onDone);
    cdp.off("Network.webSocketCreated", onSocket);
    cdp.off("Network.webSocketWillSendHandshakeRequest", onHandshake);
    cdp.off("Network.webSocketFrameReceived", onFrame);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

async function checkWarmAuth(page, cdp) {
  let sessions = 0, documentId, document304 = false;
  const errors = [];
  const onRequest = ({ requestId, request, type }) => {
    if (type === "Document") documentId = requestId;
    if (request.url === `${base}/api/session`) sessions++;
  };
  const onExtra = ({ requestId, statusCode }) => {
    if (requestId === documentId && statusCode === 304) document304 = true;
  };
  const onConsole = (message) => {
    if (message.type() === "error") errors.push(message.text());
  };
  const onPageError = (error) => errors.push(error.message);
  cdp.on("Network.requestWillBeSent", onRequest);
  cdp.on("Network.responseReceivedExtraInfo", onExtra);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "commit" }),
      page.locator("#web-signout").click(),
    ]);
    await page.locator("#signin-screen").waitFor({ state: "visible" });
    assert.equal(await page.locator("#app").isHidden(), true);
    assert.equal(await page.locator("#signin-error").isHidden(), true);
    assert.equal(document304, true, "sign-out revalidates cached HTML");
    assert.equal(sessions, 1, "sign-out performs a fresh session check");
    await page.getByLabel("Web key").fill(key);
    await page.getByRole("button", { name: /^(登入|Sign in)$/ }).click();
    await page.locator("#connection.connected").waitFor();
    document304 = false;
    await page.reload({ waitUntil: "commit" });
    await page.locator("#connection.connected").waitFor();
    assert.equal(document304, true, "sign-in reload revalidates cached HTML");
    assert.equal(sessions, 2, "sign-in reload performs a fresh session check");
    assert.deepEqual(errors, [], "warm sign-out and sign-in browser errors");
    console.log(JSON.stringify({ warmAuth: "passed", sessions }));
  } finally {
    cdp.off("Network.requestWillBeSent", onRequest);
    cdp.off("Network.responseReceivedExtraInfo", onExtra);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

async function measureSignedOut(page, cdp, latency) {
  const errors = [];
  let sessions = 0, sockets = 0;
  const onRequest = ({ request }) => {
    if (request.url === `${base}/api/session`) sessions++;
  };
  const onSocket = () => sockets++;
  const onConsole = (message) => {
    if (message.type() === "error") errors.push(message.text());
  };
  const onPageError = (error) => errors.push(error.message);
  cdp.on("Network.requestWillBeSent", onRequest);
  cdp.on("Network.webSocketCreated", onSocket);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    await page.goto(base, { waitUntil: "commit" });
    await page.waitForFunction(
      () => globalThis.loadperfTimes.signin,
      undefined,
      {
        polling: "raf",
        timeout: 30000,
      },
    );
    const signinMs = await page.evaluate(() => globalThis.loadperfTimes.signin);
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    assert.deepEqual(errors, [], "signed-out browser errors");
    assert.equal(sessions, 1, "one signed-out session request");
    assert.equal(sockets, 0, "no signed-out WebSocket");
    console.log(JSON.stringify({
      latencyMs: latency,
      cache: "cold-signed-out",
      signinMs: Math.round(signinMs),
      sessionRequests: sessions,
      sockets,
    }));
  } finally {
    cdp.off("Network.requestWillBeSent", onRequest);
    cdp.off("Network.webSocketCreated", onSocket);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

const temp = await Deno.makeTempDir({
  dir: stateRoot,
  prefix: "web-loadperf-",
});
const children = [];
let browser, cleaning;
const cleanup = () =>
  cleaning ??= (async () => {
    await browser?.close().catch(() => {});
    for (const child of children.reverse()) await stop(child);
  })();
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  Deno.addSignalListener(signal, () => {
    void (async () => {
      await cleanup();
      Deno.exit(code);
    })();
  });
}
let failed = true;
try {
  const env = { ...Deno.env.toObject(), XDG_STATE_HOME: temp };
  const stub = start(
    "python3",
    [`${daemonDir}/stub.py`],
    root,
    env,
    `${temp}/stub.log`,
  );
  children.push(stub);
  await until(async () => {
    if (stub.ended) throw stub.error ?? new Error("stub exited");
    return await Deno.stat(`${temp}/enil/sock`).then(() => true, () => false);
  }, "stub socket");
  const server = start(
    Deno.execPath(),
    ["run", "--frozen", "-A", "web/server.ts"],
    daemonDir,
    { ...env, ENIL_WEB_ADDR: `127.0.0.1:${port}`, ENIL_WEB_KEY: key },
    `${temp}/server.log`,
  );
  children.push(server);
  await until(async () => {
    if (server.ended) throw server.error ?? new Error("server exited");
    const log = await Deno.readTextFile(`${temp}/server.log`).catch(() => "");
    return log.includes(`[web] sign in: http://127.0.0.1:${port}/`);
  }, "server bind");

  const signin = await fetch(`http://127.0.0.1:${port}/?key=${key}`, {
    redirect: "manual",
  });
  assert.equal(signin.status, 303);
  const setCookie = signin.headers.get("set-cookie");
  assert.ok(setCookie, "sign-in must return a cookie");
  const cookie = setCookie.split(";")[0].split("=");
  await signin.body?.cancel();
  console.log(
    JSON.stringify({ importGraph: await importGraph(), bandwidthMbps: 5 }),
  );
  browser = await chromium.launch({
    executablePath: Deno.env.get("CHROMIUM") || "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--no-proxy-server",
      "--host-resolver-rules=MAP enil.test 127.0.0.1",
    ],
  });
  const watchDisplay = (context) =>
    context.addInitScript(() => {
      const times = globalThis.loadperfTimes = {};
      const watch = () => {
        const signin = document.querySelector("#signin-screen");
        const list = document.querySelector(
          '#chat-list .chat-row[data-chat-id="ustub-notes"]',
        );
        const message = [...document.querySelectorAll("#messages .message-row")]
          .find((row) => row.textContent.includes("記得續約網域"));
        if (signin?.checkVisibility() && !times.signin) {
          times.signin = performance.now();
        }
        if (list?.checkVisibility() && !times.list) {
          times.list = performance.now();
        }
        if (message?.checkVisibility() && !times.message) {
          times.message = performance.now();
        }
      };
      new MutationObserver(watch).observe(document, {
        childList: true,
        attributes: true,
        subtree: true,
      });
      document.addEventListener("DOMContentLoaded", watch);
    });
  for (const latency of [150, 300]) {
    const signedOut = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "zh-TW",
      isMobile: true,
      hasTouch: true,
    });
    await watchDisplay(signedOut);
    const signedOutPage = await signedOut.newPage();
    const signedOutCdp = await signedOut.newCDPSession(signedOutPage);
    await signedOutCdp.send("Network.enable");
    await signedOutCdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency,
      downloadThroughput: 5_000_000 / 8,
      uploadThroughput: 5_000_000 / 8,
    });
    await measureSignedOut(signedOutPage, signedOutCdp, latency);
    await signedOut.close();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "zh-TW",
      isMobile: true,
      hasTouch: true,
    });
    await watchDisplay(context);
    await context.addCookies([{
      name: cookie[0],
      value: cookie[1],
      domain: "enil.test",
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
    }]);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    if (Deno.env.get("ENIL_WEB_TEST_IDENTITY") === "1") {
      await cdp.send("Network.setExtraHTTPHeaders", {
        headers: { "Accept-Encoding": "identity" },
      });
    }
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency,
      downloadThroughput: 5_000_000 / 8,
      uploadThroughput: 5_000_000 / 8,
    });
    await measure(page, cdp, latency, "cold");
    await measure(page, cdp, latency, "warm");
    if (latency === 150) await checkWarmAuth(page, cdp);
    await context.close();
  }
  failed = false;
} catch (error) {
  console.error(`FAIL loadperf: ${error.stack ?? error}`);
  console.error(`Artifacts: ${temp}`);
  throw error;
} finally {
  await cleanup();
  if (!failed) await Deno.remove(temp, { recursive: true });
}

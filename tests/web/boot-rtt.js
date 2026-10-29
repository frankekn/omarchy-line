// Verify the startup session check and authentication lifecycle in a browser.
// Run: CHROMIUM=/usr/bin/chromium deno run -A tests/web/boot-rtt.js
import { assert, KEY, runSuite, until } from "./harness.js";

await runSuite("boot-rtt", async (h) => {
  const loopback = h.base.replace("enil.test", "127.0.0.1");
  async function signInContext(context) {
    const response = await fetch(`${loopback}/?key=${KEY}`, {
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    const cookie = response.headers.get("set-cookie").split(";")[0].split("=");
    await response.body?.cancel();
    await context.addCookies([{
      name: cookie[0],
      value: cookie[1],
      url: h.base,
      httpOnly: true,
      sameSite: "Strict",
    }]);
  }
  const context = await h.context({ locale: "en-US" });
  await signInContext(context);
  const page = await context.newPage();
  let sessions = 0, sockets = 0;
  page.on("request", (request) => {
    if (request.url() === `${h.base}/api/session`) sessions++;
  });
  page.on("websocket", () => sockets++);
  await page.goto(h.base);
  await page.locator("#connection.connected").waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(sessions, 1);
  assert.equal(sockets, 1);
  h.step("signed-in-startup");

  const racing = await h.context({ locale: "en-US" });
  await signInContext(racing);
  const racingPage = await racing.newPage();
  let releaseApp, racingSockets = 0;
  const appGate = new Promise((resolve) => releaseApp = resolve);
  await racingPage.route("**/js/app.js", async (route) => {
    await appGate;
    await route.continue();
  });
  racingPage.on("websocket", () => racingSockets++);
  const appRequest = racingPage.waitForRequest(`${h.base}/js/app.js`);
  try {
    await racingPage.goto(h.base, { waitUntil: "commit" });
    await appRequest;
    await racing.clearCookies();
  } finally {
    releaseApp();
  }
  await racingPage.locator("#signin-screen").waitFor({ state: "visible" });
  await racingPage.waitForLoadState("networkidle");
  assert.equal(await racingPage.locator("#app").isHidden(), true);
  assert.equal(await racingPage.locator("#signin-error").isHidden(), true);
  assert.equal(racingSockets, 0);
  h.step("cookie-removed-before-startup");

  const stale = await h.context({ locale: "en-US" });
  await stale.addCookies([{
    name: "enil_web",
    value: "expired-or-rotated-cookie",
    url: h.base,
    httpOnly: true,
    sameSite: "Strict",
  }]);
  await stale.addInitScript(() => {
    globalThis.bootFlashes = [];
    new MutationObserver(() => {
      for (const id of ["app", "signin-error"]) {
        const node = document.getElementById(id);
        if (node && !node.hidden) globalThis.bootFlashes.push(id);
      }
    }).observe(document, { childList: true, attributes: true, subtree: true });
  });
  const connection = await Deno.connect({
    hostname: "127.0.0.1",
    port: Number(new URL(h.base).port),
  });
  try {
    const request = [
      "GET /api/ws HTTP/1.1",
      `Host: ${new URL(h.base).host}`,
      `Origin: ${h.base}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Cookie: enil_web=expired-or-rotated-cookie",
      "",
      "",
    ].join("\r\n");
    await connection.write(new TextEncoder().encode(request));
    const bytes = new Uint8Array(4096), decoder = new TextDecoder();
    let headers = "";
    while (!headers.includes("\r\n")) {
      const size = await connection.read(bytes);
      if (size === null) throw new Error("socket closed without a response");
      headers += decoder.decode(bytes.subarray(0, size), { stream: true });
    }
    assert.match(headers, /^HTTP\/1\.1 401\b/);
  } finally {
    connection.close();
  }
  const unsigned = await fetch(`${loopback}/api/session`, {
    headers: { Cookie: "enil_web=expired-or-rotated-cookie" },
  });
  assert.deepEqual(await unsigned.json(), { signedIn: false });
  const stalePage = await stale.newPage();
  let staleSockets = 0, staleSessions = 0;
  stalePage.on("websocket", () => staleSockets++);
  stalePage.on("request", (request) => {
    if (request.url() === `${h.base}/api/session`) staleSessions++;
  });
  await stalePage.goto(h.base);
  await stalePage.locator("#signin-screen").waitFor({ state: "visible" });
  await stalePage.waitForLoadState("networkidle");
  assert.equal(await stalePage.locator("#app").isHidden(), true);
  assert.equal(await stalePage.locator("#signin-error").isHidden(), true);
  assert.equal(staleSockets, 0);
  assert.equal(staleSessions, 1);
  assert.deepEqual(await stalePage.evaluate(() => globalThis.bootFlashes), []);
  h.step("expired-cookie-rejected-without-socket-or-error-flash");

  const expired = await h.context({ locale: "en-US" });
  await expired.addCookies([{
    name: "enil_web",
    value: "expired-cookie",
    domain: new URL(h.base).hostname,
    path: "/",
    expires: Date.now() / 1000 - 60,
    httpOnly: true,
    sameSite: "Strict",
  }]);
  assert.deepEqual(await expired.cookies(h.base), []);
  const expiredPage = await expired.newPage();
  let expiredSockets = 0;
  expiredPage.on("websocket", () => expiredSockets++);
  await expiredPage.goto(h.base);
  await expiredPage.locator("#signin-screen").waitFor({ state: "visible" });
  await expiredPage.waitForLoadState("networkidle");
  assert.equal(await expiredPage.locator("#signin-error").isHidden(), true);
  assert.equal(expiredSockets, 0);
  h.step("browser-expired-cookie");

  for (const mode of ["network", "unauthorized", "unavailable", "bad-json"]) {
    const failed = await h.context({ locale: "en-US" });
    await failed.addInitScript((mode) => {
      const fetchOriginal = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        if (input !== "/api/session") return fetchOriginal(input, init);
        if (mode === "network") return Promise.reject(new TypeError("offline"));
        if (mode === "unauthorized") {
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        if (mode === "unavailable") {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        return Promise.resolve(new Response("invalid JSON", { status: 200 }));
      };
    }, mode);
    const failedPage = await failed.newPage();
    let failedSockets = 0;
    failedPage.on("websocket", () => failedSockets++);
    await failedPage.goto(h.base);
    await failedPage.locator("#signin-screen").waitFor({ state: "visible" });
    assert.equal(await failedPage.locator("#app").isHidden(), true);
    if (mode === "unauthorized") {
      assert.equal(await failedPage.locator("#signin-error").isHidden(), true);
    } else {
      assert.equal(
        await failedPage.locator("#signin-error").textContent(),
        "Sign-in failed. Check your connection.",
      );
      assert.equal(await failedPage.locator("#signin-error").isVisible(), true);
    }
    assert.equal(failedSockets, 0);
    await failed.close();
  }
  h.step("network-error-differs-from-401-and-invalid-response");

  const lifecycle = await h.context({ locale: "en-US" });
  const lifePage = await lifecycle.newPage();
  let lifeSessions = 0;
  lifePage.on("request", (request) => {
    if (request.url() === `${h.base}/api/session`) lifeSessions++;
  });
  await h.signIn(lifePage);
  await lifePage.reload();
  await lifePage.locator("#connection.connected").waitFor();
  assert.equal(lifeSessions, 2, "one session per navigation");
  await lifePage.locator("#web-signout").click();
  await lifePage.locator("#signin-screen").waitFor({ state: "visible" });
  assert.equal(await lifePage.locator("#app").isHidden(), true);
  assert.equal(await lifePage.locator("#signin-error").isHidden(), true);
  assert.deepEqual(
    await lifePage.evaluate(async () => (await fetch("/api/session")).json()),
    { signedIn: false },
  );
  await lifePage.getByLabel("Web key").fill(KEY);
  await lifePage.getByRole("button", { name: "Sign in" }).click();
  await lifePage.locator("#connection.connected").waitFor();
  assert.deepEqual(
    await lifePage.evaluate(async () => (await fetch("/api/session")).json()),
    { signedIn: true },
  );
  h.step("warm-reload-signout-and-signin");

  const reconnect = await h.context({ locale: "en-US" });
  await signInContext(reconnect);
  const reconnectPage = await reconnect.newPage();
  let attempts = 0, reconnectSessions = 0;
  reconnectPage.on("request", (request) => {
    if (request.url() === `${h.base}/api/session`) reconnectSessions++;
  });
  await reconnectPage.routeWebSocket("**/api/ws", (socket) => {
    attempts++;
    if (attempts === 1) void socket.close({ code: 4001, reason: "offline" });
    else socket.connectToServer();
  });
  await reconnectPage.goto(h.base);
  await until(() => attempts >= 2, "WebSocket reconnect");
  await reconnectPage.locator("#connection.connected").waitFor();
  assert.equal(reconnectSessions, 1);
  h.step("reconnect-keeps-session-and-backoff");
});

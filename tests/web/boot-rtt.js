// Verify early session loading and the authentication lifecycle in a browser.
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
  assert.ok(
    sessions >= 1 && sessions <= (h.browserName === "chromium" ? 1 : 2),
  );
  assert.equal(sockets, 1);
  h.step("signed-in-startup");

  if (h.browserName === "chromium") {
    // Only this deliberate 401 handshake may log an error. All other console
    // and page errors on the isolated page are still checked exactly.
    const racing = await context.browser().newContext({ locale: "en-US" });
    await signInContext(racing);
    const racingPage = await racing.newPage();
    const racingErrors = [], racingPageErrors = [];
    racingPage.on("console", (message) => {
      if (message.type() === "error") racingErrors.push(message.text());
    });
    racingPage.on("pageerror", (error) => racingPageErrors.push(error.message));
    let releaseApp, racingSockets = 0, racingSessions = 0;
    const appGate = new Promise((resolve) => releaseApp = resolve);
    await racingPage.route("**/js/app.js", async (route) => {
      await appGate;
      await route.continue();
    });
    racingPage.on("websocket", () => racingSockets++);
    racingPage.on("request", (request) => {
      if (request.url() === `${h.base}/api/session`) racingSessions++;
    });
    const appRequest = racingPage.waitForRequest(`${h.base}/js/app.js`);
    const preloaded = racingPage.waitForResponse(`${h.base}/api/session`);
    try {
      await racingPage.goto(h.base, { waitUntil: "commit" });
      await appRequest;
      assert.deepEqual(await (await preloaded).json(), { signedIn: true });
      assert.equal(racingSockets, 0);
      assert.equal(racingSessions, 1);
      await racing.clearCookies();
      releaseApp();
      const signIn = racingPage.getByRole("link", { name: "Sign in again" });
      await signIn.waitFor({ state: "visible" });
      assert.equal(await racingPage.locator("#app").isVisible(), true);
      assert.equal(await racingPage.locator("#signin-screen").isHidden(), true);
      assert.equal(
        await racingPage.locator("#connection-text").textContent(),
        "Sign-in required",
      );
      assert.equal(racingSockets, 1);
      assert.equal(racingSessions, 2);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.equal(racingSockets, 1, "expired session must stop retries");
      await signIn.click();
      await racingPage.locator("#signin-screen").waitFor({ state: "visible" });
      assert.equal(racingSessions, 3);
    } finally {
      releaseApp();
      await racing.close();
    }
    assert.deepEqual(racingPageErrors, []);
    assert.deepEqual(racingErrors, [
      `WebSocket connection to 'ws://${new URL(h.base).host}/api/ws' ` +
      "failed: HTTP Authentication failed; no valid credentials available",
    ]);
    h.step("preload-cookie-race-offers-signin");
  }

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
  assert.ok(
    staleSessions >= 1 &&
      staleSessions <= (h.browserName === "chromium" ? 1 : 2),
  );
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
  assert.ok(
    lifeSessions >= 2 &&
      lifeSessions <= (h.browserName === "chromium" ? 2 : 4),
  );
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
  assert.ok(
    reconnectSessions >= 2 &&
      reconnectSessions <= (h.browserName === "chromium" ? 2 : 3),
  );
  h.step("reconnect-keeps-session-and-backoff");

  const live = await h.context({ locale: "en-US" });
  await signInContext(live);
  const livePage = await live.newPage();
  let liveAttempts = 0, firstSocket;
  await livePage.routeWebSocket("**/api/ws", (socket) => {
    liveAttempts++;
    if (liveAttempts === 1) {
      firstSocket = socket;
      socket.connectToServer();
    } else if (liveAttempts === 2) {
      void socket.close({ code: 4001, reason: "connection refused" });
    } else socket.connectToServer();
  });
  await livePage.goto(h.base);
  await livePage.locator("#connection.connected").waitFor();
  await livePage.locator('#chat-list .chat-row[data-chat-id="ustub-notes"]')
    .click();
  await livePage.locator("#message-input").fill("draft survives web expiry");
  const navigationOrigin = await livePage.evaluate(() =>
    performance.timeOrigin
  );
  await livePage.locator("#message-input").evaluate((input) => {
    input.dataset.retained = "yes";
  });
  const savedDrafts = await livePage.evaluate(() =>
    localStorage.getItem("enil.web.drafts.v1")
  );
  assert.ok(savedDrafts?.includes("draft survives web expiry"));
  await live.addCookies([{
    name: "enil_web",
    value: "cookie-from-previous-key",
    url: h.base,
    httpOnly: true,
    sameSite: "Strict",
  }]);
  assert.deepEqual(
    await livePage.evaluate(async () => (await fetch("/api/session")).json()),
    { signedIn: false },
  );
  await firstSocket.close({ code: 4001, reason: "connection lost" });
  const liveSignIn = livePage.getByRole("link", { name: "Sign in again" });
  await liveSignIn.waitFor({ state: "visible" });
  assert.equal(await livePage.locator("#app").isVisible(), true);
  assert.equal(await livePage.locator("#signin-screen").isHidden(), true);
  assert.equal(
    await livePage.evaluate(() => performance.timeOrigin),
    navigationOrigin,
  );
  assert.equal(
    await livePage.locator("#message-input").getAttribute(
      "data-retained",
    ),
    "yes",
  );
  assert.equal(
    await livePage.locator("#message-input").inputValue(),
    "draft survives web expiry",
  );
  assert.equal(
    await livePage.evaluate(() => localStorage.getItem("enil.web.drafts.v1")),
    savedDrafts,
  );
  assert.equal(liveAttempts, 2);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(liveAttempts, 2, "expired session must stop reconnecting");
  await liveSignIn.click();
  await livePage.locator("#signin-screen").waitFor({ state: "visible" });
  await livePage.getByLabel("Web key").fill(KEY);
  await livePage.getByRole("button", { name: "Sign in" }).click();
  await livePage.locator("#connection.connected").waitFor();
  await livePage.locator('#chat-list .chat-row[data-chat-id="ustub-notes"]')
    .click();
  assert.equal(
    await livePage.locator("#message-input").inputValue(),
    "draft survives web expiry",
  );
  h.step("live-expiry-preserves-draft-and-allows-signin");

  const fullStorage = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await fullStorage.addInitScript(() => {
    const originalInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) =>
      originalInterval(callback, delay === 30000 ? 100 : delay, ...args);
    Storage.prototype.setItem = function () {
      throw new DOMException("quota", "QuotaExceededError");
    };
    Storage.prototype.getItem = function () {
      throw new DOMException("unavailable", "SecurityError");
    };
    Storage.prototype.removeItem = function () {
      throw new DOMException("unavailable", "SecurityError");
    };
    History.prototype.replaceState = function () {
      throw new DOMException("unavailable", "SecurityError");
    };
  });
  const fullPage = await fullStorage.newPage();
  let fullAttempts = 0, fullSocket;
  await fullPage.routeWebSocket("**/api/ws", (socket) => {
    fullAttempts++;
    if (fullAttempts === 1) {
      fullSocket = socket;
      socket.connectToServer();
    } else if (fullAttempts === 2) {
      void socket.close({ code: 4001, reason: "expired" });
    } else socket.connectToServer();
  });
  await h.signIn(fullPage);
  await fullPage.locator('#chat-list .chat-row[data-chat-id="ustub-notes"]')
    .click();
  await fullPage.locator("#message-input").fill("draft when storage is full");
  assert.equal(await fullPage.locator("#toast").isVisible(), true);
  const beforeExpiry = await fullPage.evaluate(() => performance.timeOrigin);
  await fullPage.locator("#message-input").evaluate((input) => {
    input.dataset.retained = "yes";
  });
  await fullStorage.clearCookies();
  await fullSocket.close({ code: 4001, reason: "disconnected" });
  const fullSignIn = fullPage.getByRole("link", { name: "Sign in again" });
  await fullSignIn.waitFor({ state: "visible" });
  await fullSignIn.evaluate((link) => link.dataset.retained = "yes");
  assert.equal(await fullPage.locator("#app").isVisible(), true);
  assert.equal(
    await fullPage.evaluate(() => performance.timeOrigin),
    beforeExpiry,
  );
  assert.equal(
    await fullPage.locator("#message-input").getAttribute(
      "data-retained",
    ),
    "yes",
  );
  assert.equal(
    await fullPage.locator("#message-input").inputValue(),
    "draft when storage is full",
  );
  await fullPage.locator("#message-input").selectText();
  assert.equal(
    await fullPage.locator("#message-input").evaluate((input) =>
      input.value.slice(input.selectionStart, input.selectionEnd)
    ),
    "draft when storage is full",
  );
  assert.equal(fullAttempts, 2);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(fullAttempts, 2);
  assert.equal(await fullSignIn.getAttribute("data-retained"), "yes");
  await fullSignIn.click();
  await fullPage.locator("#signin-screen").waitFor({ state: "visible" });
  await fullPage.getByLabel("Web key").fill(KEY);
  await fullPage.getByRole("button", { name: "Sign in" }).click();
  await fullPage.locator("#connection.connected").waitFor();
  h.step("volatile-draft-remains-copyable-before-signin");

  const chinese = await h.context({ locale: "zh-TW" });
  await signInContext(chinese);
  const chinesePage = await chinese.newPage();
  let chineseAttempts = 0, chineseSocket;
  await chinesePage.routeWebSocket("**/api/ws", (socket) => {
    chineseAttempts++;
    if (chineseAttempts === 1) {
      chineseSocket = socket;
      socket.connectToServer();
    } else void socket.close({ code: 4001, reason: "expired" });
  });
  await chinesePage.goto(h.base);
  await chinesePage.locator("#connection.connected").waitFor();
  await chinese.clearCookies();
  await chineseSocket.close({ code: 4001, reason: "disconnected" });
  await chinesePage.getByRole("link", { name: "重新登入" }).waitFor();
  assert.match(
    await chinesePage.locator("#notices").textContent(),
    /複製.*草稿/,
  );
  assert.equal(
    await chinesePage.locator("#connection-text").textContent(),
    "需要重新登入",
  );
  await chinese.close();
  h.step("expired-notice-in-traditional-chinese");

  const deniedSession = await h.context({ locale: "en-US" });
  await signInContext(deniedSession);
  await deniedSession.addInitScript(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (input === "/api/session" && sessionStorage.getItem("deny-next")) {
        sessionStorage.removeItem("deny-next");
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return original(input, init);
    };
  });
  const deniedPage = await deniedSession.newPage();
  let deniedAttempts = 0, deniedSocket;
  await deniedPage.routeWebSocket("**/api/ws", (socket) => {
    deniedAttempts++;
    if (deniedAttempts === 1) {
      deniedSocket = socket;
      socket.connectToServer();
    } else void socket.close({ code: 4001, reason: "denied" });
  });
  await deniedPage.goto(h.base);
  await deniedPage.locator("#connection.connected").waitFor();
  await deniedSession.clearCookies();
  await deniedPage.evaluate(() => sessionStorage.setItem("deny-next", "1"));
  await deniedSocket.close({ code: 4001, reason: "disconnected" });
  const deniedSignIn = deniedPage.getByRole("link", { name: "Sign in again" });
  await deniedSignIn.waitFor({ state: "visible" });
  assert.equal(deniedAttempts, 2);
  await deniedSignIn.click();
  await deniedPage.locator("#signin-screen").waitFor({ state: "visible" });
  assert.equal(await deniedPage.locator("#signin-error").isHidden(), true);
  h.step("session-401-stops-reconnect");

  const offline = await h.context({ locale: "en-US" });
  await signInContext(offline);
  await offline.addInitScript(() => {
    const original = globalThis.fetch;
    globalThis.testOffline = false;
    globalThis.sessionFailures = 0;
    globalThis.fetch = (input, init) => {
      if (input === "/api/session" && globalThis.testOffline) {
        globalThis.sessionFailures++;
        return Promise.reject(new TypeError("offline"));
      }
      return original(input, init);
    };
  });
  const offlinePage = await offline.newPage();
  let offlineAttempts = 0, offlineSocket;
  await offlinePage.routeWebSocket("**/api/ws", (socket) => {
    offlineAttempts++;
    if (offlineAttempts === 1) {
      offlineSocket = socket;
      socket.connectToServer();
    } else void socket.close({ code: 4001, reason: "offline" });
  });
  await offlinePage.goto(h.base);
  await offlinePage.locator("#connection.connected").waitFor();
  await offlinePage.evaluate(() => globalThis.testOffline = true);
  await offlineSocket.close({ code: 4001, reason: "offline" });
  await until(() => offlineAttempts >= 3, "continued offline reconnect", 10000);
  assert.equal(await offlinePage.locator("#signin-screen").isHidden(), true);
  assert.equal(await offlinePage.locator("#app").isVisible(), true);
  assert.equal(
    await offlinePage.getByRole("link", { name: "Sign in again" }).count(),
    0,
  );
  assert.match(
    await offlinePage.locator("#connection-text").textContent(),
    /reconnecting/i,
  );
  assert.equal(await offlinePage.evaluate(() => globalThis.sessionFailures), 2);
  h.step("network-error-keeps-reconnecting");

  for (const signedIn of [false, true]) {
    const noReuse = await h.context({ locale: "en-US" });
    if (signedIn) await signInContext(noReuse);
    await noReuse.addInitScript(() => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) =>
        original(
          input === "/api/session" ? "/api/session?preload-miss=1" : input,
          init,
        );
    });
    const noReusePage = await noReuse.newPage();
    let requests = 0;
    noReusePage.on("request", (request) => {
      if (request.url().startsWith(`${h.base}/api/session`)) requests++;
    });
    await noReusePage.goto(h.base);
    await noReusePage.locator(
      signedIn ? "#connection.connected" : "#signin-screen",
    ).waitFor({ state: "visible" });
    await noReusePage.waitForLoadState("networkidle");
    assert.ok(
      requests >= (h.browserName === "chromium" ? 2 : 1) &&
        requests <= 2,
    );
    assert.equal(await noReusePage.locator("#signin-error").isHidden(), true);
    await noReuse.close();
  }
  h.step("preload-not-reused-falls-back-to-fresh-session");

  if (h.browserName === "chromium") {
    const noHint = await h.context({ locale: "en-US" });
    await signInContext(noHint);
    const noHintPage = await noHint.newPage();
    const noHintCdp = await noHint.newCDPSession(noHintPage);
    await noHintCdp.send("Fetch.enable", {
      patterns: [{ urlPattern: `${h.base}/`, requestStage: "Response" }],
    });
    noHintCdp.on("Fetch.requestPaused", async (event) => {
      await noHintCdp.send("Fetch.continueResponse", {
        requestId: event.requestId,
        responseCode: event.responseStatusCode,
        responseHeaders: event.responseHeaders.filter((header) =>
          header.name.toLowerCase() !== "link"
        ),
      });
    });
    let noHintRequests = 0;
    noHintPage.on("request", (request) => {
      if (request.url() === `${h.base}/api/session`) noHintRequests++;
    });
    await noHintPage.goto(h.base);
    await noHintPage.locator("#connection.connected").waitFor();
    await noHintPage.waitForLoadState("networkidle");
    assert.equal(noHintRequests, 1);
    h.step("ignored-preload-falls-back-to-normal-session");
  }
});

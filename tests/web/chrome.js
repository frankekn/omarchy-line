// Page chrome without a top bar: the settings button and the connection status
// sit at the bottom left, leaving the page and signing out of LINE are in the
// settings dialog, the LINE sign-in screen keeps both, and the tab title is
// "Line Web". Axe and no horizontal scroll at 1280, 390 and 320 px.
import axe from "npm:axe-core@4.10.3";
import { assert, KEY, tapSocket, until } from "./harness.js";

async function axeScan(page, label) {
  const violations = await page.evaluate(async () => {
    const scan = await globalThis.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    return scan.violations.flatMap((rule) =>
      rule.nodes.map((node) => `${rule.id} ${node.target.join(" ")}`)
    );
  });
  assert.deepEqual(violations, [], `axe ${label}`);
}

async function overflow(page) {
  return await page.evaluate(() =>
    [
      document.scrollingElement,
      ...document.querySelectorAll(
        ".sidebar, .sidebar-bottom, .app-corner, .line-login, .chat-header, " +
          ".settings",
      ),
    ].flatMap((node) =>
      node && node.getClientRects().length &&
        node.scrollWidth > node.clientWidth + 1
        ? [`${node.className || node.tagName} ${node.scrollWidth}`]
        : []
    )
  );
}

// The button sits in the bottom row: the account row of the sidebar, which
// spans the screen on a phone, or the corner row without a sidebar.
async function bottomLeft(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const { width, height } = page.viewportSize();
  assert.ok(box, `${selector} has a box`);
  assert.ok(box.width >= 44 && box.height >= 44, `${selector} target size`);
  assert.ok(box.y + box.height <= height, `${selector} inside the viewport`);
  assert.ok(box.y + box.height > height - 72, `${selector} at the bottom`);
  const sidebar = await page.locator("#sidebar").boundingBox();
  const right = sidebar ? sidebar.x + sidebar.width : width;
  assert.ok(box.x >= 0 && box.x + box.width <= right, `${selector} x`);
  return box;
}

export async function chrome(h) {
  await desktop(h);
  await phone(h);
  await narrow(h);
}

async function desktop(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    // This context bypasses CSP to inject axe; the app's headers are
    // unchanged.
    bypassCSP: true,
  });
  const page = await context.newPage();
  let block = false, live = null;
  // Pass traffic through; `block` refuses new sockets to hold an outage.
  await page.routeWebSocket("**/api/ws", (socket) => {
    if (block) return socket.close({ code: 4001, reason: "test outage" });
    live = socket;
    socket.connectToServer();
  });
  await page.goto(h.base, { waitUntil: "domcontentloaded" });
  await until(
    async () => (await page.title()) === "Line Web · Sign-in required",
    "signed-out title",
  );
  for (const name of ["application-name", "apple-mobile-web-app-title"]) {
    assert.equal(
      await page.locator(`meta[name="${name}"]`).getAttribute("content"),
      "Line Web",
    );
  }
  await page.getByLabel("Web key").fill(KEY);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("#connection.connected").waitFor();
  await until(
    async () => /^\(\d+\) Line Web$/.test(await page.title()),
    "unread title",
  );
  assert.equal(
    await page.locator(".app-bar, .brand, #app > header").count(),
    0,
  );
  assert.equal(await page.locator(".app-corner").isVisible(), false);
  // The sidebar starts at the top of the page.
  const sidebar = await page.locator("#sidebar").boundingBox();
  assert.equal(sidebar?.y, 0);
  h.step("no-top-bar-and-title");

  // The list shortcuts and Sync are outlined buttons on one row, lined up
  // with the search box.
  await page.locator("#next-unread").waitFor();
  const header = await page.evaluate(() => {
    const box = (node) => node.getBoundingClientRect();
    const search = box(document.querySelector(".search-wrap"));
    const buttons = [
      ...document.querySelectorAll(".nav-actions button:not([hidden])"),
    ];
    const sync = document.getElementById("sync");
    return {
      outlined: [...buttons, sync].every((node) =>
        getComputedStyle(node).borderTopStyle === "solid"
      ),
      rows: new Set(buttons.map((node) => box(node).top)).size,
      left: box(buttons[0]).left - search.left,
      right: box(sync).right - search.right,
    };
  });
  assert.deepEqual(header, { outlined: true, rows: 1, left: 0, right: 0 });
  // The empty pane names the keys that get to a chat.
  assert.match(
    await page.locator("#empty-description").textContent(),
    /^Press (Ctrl\+K|⌘K) to switch chats, or (Alt\+↓|⌥↓) for the next unread\.$/,
  );
  assert.equal(await page.locator("#empty-description kbd").count(), 2);
  h.step("list-header-buttons-and-empty-pane");

  const opener = await bottomLeft(page, "#settings-open");
  const status = await page.locator("#connection").boundingBox();
  assert.ok(status && status.x < opener.x, "status left of the button");
  assert.equal(
    await page.locator("#connection-text").textContent(),
    "Connected",
  );
  await page.locator("#settings-open").click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor();
  const account = dialog.getByRole("region", { name: "Account" });
  await account.waitFor();
  const leave = account.getByRole("button", { name: "Leave web page" });
  const logout = account.getByRole("button", { name: "Sign out of LINE" });
  await leave.waitFor();
  await logout.waitFor();
  assert.match(
    await leave.evaluate((node) =>
      document.getElementById(node.getAttribute("aria-describedby"))
        .textContent
    ),
    /this browser only/,
  );
  assert.match(
    await logout.evaluate((node) =>
      document.getElementById(node.getAttribute("aria-describedby"))
        .textContent
    ),
    /daemon out of LINE/,
  );
  await page.addScriptTag({ content: axe.source });
  await axeScan(page, "1280 settings");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "settings-open",
  );
  await axeScan(page, "1280 list");
  h.step("settings-from-bottom-left-1280");

  // A dropped connection shows in the account row, in the warning color.
  const color = () =>
    page.locator("#connection").evaluate((node) =>
      getComputedStyle(node).color
    );
  const calm = await color();
  block = true;
  await live.close({ code: 4001, reason: "test outage" });
  await page.locator("#connection:not(.connected)").waitFor();
  assert.equal(
    await page.locator("#connection-text").textContent(),
    "Disconnected, reconnecting",
  );
  assert.equal(await page.locator("#connection").isVisible(), true);
  assert.notEqual(await color(), calm, "disconnected status stands out");
  await until(
    async () => / · Offline$/.test(await page.title()),
    "offline title",
  );
  block = false;
  await page.locator("#connection.connected").waitFor({ timeout: 20000 });
  assert.equal(await color(), calm);
  h.step("disconnected-status-visible");

  // Sign out of LINE from the dialog: confirm, close, send `logout`.
  await page.close();
  const outPage = await context.newPage();
  let logoutId = null;
  const tap = await tapSocket(outPage, {
    client(frame) {
      if (frame.cmd !== "logout") return true;
      logoutId = frame.id;
      return false;
    },
  });
  await outPage.goto(h.base, { waitUntil: "domcontentloaded" });
  await outPage.locator("#connection.connected").waitFor();
  await outPage.locator("#settings-open").click();
  const before = h.dialogs.length;
  await outPage.locator("#line-logout").click();
  await until(() => logoutId !== null, "logout command");
  assert.deepEqual(h.dialogs.slice(before), [
    { type: "confirm", message: "Sign out of LINE?" },
  ]);
  await outPage.locator("#settings").waitFor({ state: "hidden" });
  tap.socket.send(JSON.stringify({ id: logoutId, ok: true, data: null }));
  h.step("line-logout-from-settings");

  // The LINE sign-in screen keeps settings and the status in the corner.
  const state = await h.state();
  tap.socket.send(JSON.stringify({
    web: "state",
    state: {
      ...state,
      me: {},
      login: { status: "qr", qrPng: `${h.stateDir}/media/stub-shot1.png` },
    },
  }));
  await outPage.getByAltText("LINE login QR code").waitFor();
  assert.equal(await outPage.locator("#workspace").isHidden(), true);
  await bottomLeft(outPage, "#corner-settings");
  assert.equal(
    await outPage.evaluate(() => document.activeElement?.id),
    "corner-settings",
  );
  assert.equal(
    await outPage.locator("#corner-connection-text").textContent(),
    "Connected",
  );
  await outPage.addScriptTag({ content: axe.source });
  await axeScan(outPage, "1280 LINE sign-in");
  await outPage.locator("#corner-settings").click();
  await outPage.getByRole("dialog", { name: "Settings" }).waitFor();
  assert.equal(await outPage.locator("#line-logout").isVisible(), false);
  await outPage.getByRole("radio", { name: "Nord" }).check();
  assert.equal(
    await outPage.evaluate(() => document.documentElement.dataset.theme),
    "nord",
  );
  await axeScan(outPage, "1280 LINE sign-in settings");
  await outPage.keyboard.press("Escape");
  assert.equal(
    await outPage.evaluate(() => document.activeElement?.id),
    "corner-settings",
  );
  // Back to signed in: the focus follows the button to the sidebar.
  tap.socket.send(JSON.stringify({ web: "state", state }));
  await outPage.locator("#workspace:not([hidden])").waitFor();
  assert.equal(await outPage.locator(".app-corner").isVisible(), false);
  assert.equal(
    await outPage.evaluate(() => document.activeElement?.id),
    "settings-open",
  );
  h.step("line-sign-in-screen-settings");

  // Leave the web page from the dialog.
  await outPage.locator("#settings-open").click();
  await outPage.locator("#web-signout").click();
  await outPage.locator("#signin-screen").waitFor();
  assert.deepEqual(
    await outPage.evaluate(async () => (await fetch("/api/session")).json()),
    { signedIn: false },
  );
  h.step("leave-web-page-from-settings");
  await context.close();
}

async function phone(h) {
  const context = await h.context({
    locale: "zh-TW",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    bypassCSP: true,
  });
  const page = await context.newPage();
  // The account row clears the iOS home indicator. Chromium can emulate the
  // safe area; WebKit here has no API for it.
  const inset = 34;
  if (h.browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, bottom: inset, left: 0, right: 0 },
    });
  }
  await h.signIn(page);
  const opener = await bottomLeft(page, "#settings-open");
  if (h.browserName === "chromium") {
    assert.ok(
      opener.y + opener.height <= 844 - inset,
      `settings clears the home indicator: ${opener.y + opener.height}`,
    );
  }
  await page.addScriptTag({ content: axe.source });
  await axeScan(page, "390 list");
  await page.locator("#settings-open").tap();
  await page.getByRole("dialog", { name: "設定" }).waitFor();
  await page.getByRole("button", { name: "離開網頁" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "登出 LINE" }).waitFor();
  await axeScan(page, "390 settings");
  await page.locator("#settings-close").tap();
  h.step("settings-from-bottom-left-390");

  // In a chat only the chat's own header is at the top.
  await page.getByRole("button", { name: /STUB 家庭群組/ }).tap();
  await page.locator("article.message-row").first().waitFor();
  const header = await page.locator("#chat-view .chat-header").boundingBox();
  assert.equal(header?.y, 0);
  assert.equal(await page.locator("#settings-open").isVisible(), false);
  assert.equal(await page.locator(".app-corner").isVisible(), false);
  assert.deepEqual(await overflow(page), [], "390 chat");
  await axeScan(page, "390 chat");
  h.step("chat-has-only-its-header-390");
  await context.close();
}

async function narrow(h) {
  const context = await h.context({
    locale: "zh-TW",
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
    bypassCSP: true,
  });
  await context.addInitScript(() => {
    if (location.protocol !== "http:") return;
    localStorage["enil.settings"] = JSON.stringify({
      theme: "system",
      textSize: 150,
      sound: false,
    });
  });
  const page = await context.newPage();
  const tap = await tapSocket(page);
  await h.signIn(page);
  await page.addScriptTag({ content: axe.source });
  await bottomLeft(page, "#settings-open");
  assert.deepEqual(await overflow(page), [], "320 list");
  await axeScan(page, "320 150% list");
  await page.locator("#settings-open").tap();
  await page.locator("#web-signout").scrollIntoViewIfNeeded();
  assert.deepEqual(await overflow(page), [], "320 settings");
  await axeScan(page, "320 150% settings");
  await page.locator("#settings-close").tap();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).tap();
  await page.locator(`#messages article.message-row`).first().waitFor();
  assert.equal(
    await page.locator("#active-name").textContent(),
    "STUB 家庭群組",
  );
  assert.deepEqual(await overflow(page), [], "320 chat");
  await page.locator("#back").tap();

  const state = await h.state();
  tap.socket.send(JSON.stringify({
    web: "state",
    state: {
      ...state,
      me: {},
      login: { status: "qr", qrPng: `${h.stateDir}/media/stub-shot1.png` },
    },
  }));
  await page.getByAltText("LINE login QR code").waitFor();
  await bottomLeft(page, "#corner-settings");
  assert.deepEqual(await overflow(page), [], "320 LINE sign-in");
  await axeScan(page, "320 150% LINE sign-in");
  tap.socket.send(JSON.stringify({ web: "state", state }));
  await page.locator("#workspace:not([hidden])").waitFor();
  h.step("no-overflow-320-150");
  await context.close();
}

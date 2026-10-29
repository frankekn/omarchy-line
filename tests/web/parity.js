// Parity with panel navigation, sync, search and the media viewer.
import { assert, CHAT, tapSocket, until } from "./harness.js";

async function dispatchTouches(page, events) {
  await page.locator("#lightbox-stage").evaluate((stage, events) => {
    for (const [type, points] of events) {
      // WebKit cannot construct Touch objects. The view reads the coordinates
      // from event.touches, so provide those on a synthetic event instead.
      const event = new Event(type, {
        bubbles: true,
        cancelable: type === "touchmove",
      });
      Object.defineProperty(event, "touches", {
        value: points.map(([identifier, clientX, clientY]) => ({
          identifier,
          target: stage,
          clientX,
          clientY,
        })),
      });
      stage.dispatchEvent(event);
    }
  }, events);
}

export async function parity(h) {
  const desktop = await h.context({
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  });
  const mobile = await h.context({
    locale: "zh-TW",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const now = Date.now() - 100000;
  const makeMessage = (id, from, contentType, text, extra = {}) => ({
    id,
    chat: CHAT,
    from,
    fromName: from === "ustub-me-0000" ? "Me" : "Peer",
    time: now + Number(id.slice(-1)) * 1000,
    text,
    contentType,
    hasMedia: false,
    mediaState: "ok",
    unsent: false,
    decryptFailed: false,
    ...extra,
  });
  const messages = [
    makeMessage("parity1", "peer", "NONE", "Original quoted message"),
    makeMessage("parity2", "ustub-me-0000", "NONE", "Own message"),
    makeMessage("parity3", "peer", "CHATEVENT", "CHATEVENT"),
    makeMessage("parity4", "peer", "IMAGE", "First picture", {
      hasMedia: true,
      previewable: true,
      mediaPath: `${h.stateDir}/media/stub-shot1.png`,
    }),
    makeMessage("parity5", "peer", "IMAGE", "Second picture", {
      hasMedia: true,
      previewable: true,
      mediaPath: `${h.stateDir}/media/stub-shot2.png`,
    }),
    makeMessage("parity6", "ustub-me-0000", "NONE", "A reply", {
      replyTo: {
        id: "parity1",
        fromName: "Peer",
        text: "Original quoted message",
      },
    }),
    makeMessage("parity7", "ustub-me-0000", "NONE", "A missing reply", {
      replyTo: { id: "not-loaded", text: "Missing original" },
    }),
  ];
  const page = await desktop.newPage();
  let uploadRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/upload")) uploadRequests++;
  });
  let heldSync;
  let holdHistory = false;
  let heldHistory;
  let boot = "";
  const histories = new Set();
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.cmd === "sync") {
        heldSync = frame.id;
        return false;
      }
      if (frame.cmd === "history" && frame.chat === CHAT) {
        histories.add(frame.id);
      }
      return true;
    },
    server(frame) {
      if (frame.web === "state") {
        boot = String(frame.state.bootId || "");
        frame.state.link = {
          push: "down",
          reason: "restricted",
          code: "BANNED",
        };
        frame.state.chats = frame.state.chats.map((row) =>
          row.mid === CHAT
            ? {
              ...row,
              unread: 2,
              lastFrom: "UniqueSender",
              lastText: "UniquePreview",
            }
            : row
        );
      }
      if (histories.has(frame.id)) {
        frame.data = messages;
        histories.delete(frame.id);
        if (holdHistory) {
          holdHistory = false;
          heldHistory = frame;
          return false;
        }
      }
      return true;
    },
  });
  await h.signIn(page);
  if (!(await page.locator("#sync").count())) {
    throw new Error("The web page does not contain the parity sync feature");
  }
  await page.getByRole("button", { name: /account is restricted/ }).waitFor();
  await page.locator("#sync").click();
  await until(() => heldSync !== undefined, "first sync request");
  assert.equal(await page.locator("#sync").textContent(), "Syncing…");
  assert.equal(await page.locator("#sync").isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: /account is restricted/ })
      .isDisabled(),
    true,
  );
  await page.locator("#sync").evaluate((button) => button.click());
  assert.equal(tap.sent.filter((frame) => frame.cmd === "sync").length, 1);
  tap.socket.send(
    JSON.stringify({ id: heldSync, ok: true, data: { at: Date.now() } }),
  );
  await page.getByText(/Synced/).waitFor();
  await page.getByRole("button", { name: /account is restricted/ }).click();
  await until(
    () => tap.sent.filter((frame) => frame.cmd === "sync").length === 2,
    "restriction sync",
  );
  tap.socket.send(
    JSON.stringify({ id: heldSync, ok: true, data: { at: Date.now() } }),
  );
  await until(
    async () => !(await page.locator("#sync").isDisabled()),
    "sync completion",
  );
  await page.locator("#sync").click();
  await until(
    () => tap.sent.filter((frame) => frame.cmd === "sync").length === 3,
    "failed sync request",
  );
  tap.socket.send(
    JSON.stringify({ id: heldSync, ok: false, error: "fixture sync failure" }),
  );
  await page.getByText("fixture sync failure").waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), false);
  h.step("sync-guard-failure");

  assert.ok(
    (await page.locator(".chat-row").first().textContent()).includes(
      "UniqueSender: UniquePreview",
    ),
  );
  await page.getByLabel("Search chats").fill("uniquesender");
  assert.equal(await page.locator(".chat-row").count(), 1);
  await page.getByLabel("Search chats").fill("uniquepreview");
  assert.equal(await page.locator(".chat-row").count(), 1);
  h.step("search-sender-preview");
  holdHistory = true;
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await until(() => heldHistory, "held history response");
  const buffered = makeMessage(
    "parity8",
    "ustub-me-0000",
    "NONE",
    "Buffered during sync",
  );
  tap.socket.send(
    JSON.stringify({
      event: { seq: 999999, kind: "message", chat: CHAT, message: buffered },
      boot,
    }),
  );
  const syncCount = tap.sent.filter((frame) => frame.cmd === "sync").length;
  await page.locator("#sync").click();
  await until(
    () => tap.sent.filter((frame) => frame.cmd === "sync").length > syncCount,
    "sync while history is pending",
  );
  tap.socket.send(
    JSON.stringify({ id: heldSync, ok: true, data: { at: Date.now() } }),
  );
  await page.locator('article[data-message-id="parity8"]').waitFor();
  heldHistory.data = [makeMessage("parity1", "peer", "NONE", "Stale response")];
  tap.socket.send(JSON.stringify(heldHistory));
  const marker = makeMessage(
    "parity9",
    "ustub-me-0000",
    "NONE",
    "Response barrier",
  );
  tap.socket.send(
    JSON.stringify({
      event: { seq: 1000000, kind: "message", chat: CHAT, message: marker },
      boot,
    }),
  );
  await page.getByRole("log").getByText("Response barrier", { exact: true })
    .waitFor();
  assert.equal(await page.getByText("Stale response").count(), 0);
  await page.locator('article[data-message-id="parity7"]').waitFor();
  h.step("history-supersession");
  const unreadNext = await page.locator(".unread-divider").evaluate((node) =>
    node.nextElementSibling?.dataset.messageId
  );
  assert.equal(unreadNext, "parity4");
  const beforeSync = tap.sent.filter((frame) => frame.cmd === "sync").length;
  await page.locator("#sync").click();
  await until(
    () => tap.sent.filter((frame) => frame.cmd === "sync").length > beforeSync,
    "second sync",
  );
  const historyCount =
    tap.sent.filter((frame) => frame.cmd === "history").length;
  tap.socket.send(
    JSON.stringify({ id: heldSync, ok: true, data: { at: Date.now() } }),
  );
  await until(
    () =>
      tap.sent.filter((frame) => frame.cmd === "history").length > historyCount,
    "history after sync",
  );
  assert.equal(
    await page.locator(".unread-divider").evaluate((node) =>
      node.nextElementSibling?.dataset.messageId
    ),
    "parity4",
  );
  h.step("unread-divider-sync");

  const beforeUpload = uploadRequests;
  await page.locator("#conversation").evaluate((input) => {
    const head = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File(
      [head, new Uint8Array(20 * 1024 * 1024)],
      "oversized.txt",
      { type: "text/plain" },
    );
    const data = new DataTransfer();
    data.items.add(file);
    input.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.getByText(/Image too large \(over 20 MB\)/).waitFor();
  assert.equal(uploadRequests, beforeUpload);
  h.step("disguised-image-limit");
  await page.locator('article[data-message-id="parity6"] .quote').click();
  assert.equal(
    await page.locator('article[data-message-id="parity1"]').evaluate((row) =>
      row.classList.contains("quote-target")
    ),
    true,
  );
  const historyBefore =
    tap.sent.filter((frame) => frame.cmd === "history").length;
  await page.locator('article[data-message-id="parity7"] .quote').click();
  await page.getByText(/The original isn't in this page/).waitFor();
  assert.equal(
    tap.sent.filter((frame) => frame.cmd === "history").length,
    historyBefore,
  );
  h.step("quote-navigation");

  await page.locator('article[data-message-id="parity4"] img.media-image')
    .click();
  await page.locator("#lightbox[open]").waitFor();
  assert.ok(
    (await page.locator("#lightbox-image").getAttribute("src")).includes(
      "stub-shot1.png",
    ),
  );
  await page.keyboard.press("ArrowRight");
  await until(
    async () =>
      (await page.locator("#lightbox-image").getAttribute("src"))?.includes(
        "stub-shot2.png",
      ),
    "next image",
  );
  await page.locator("#lightbox-prev").click();
  await page.locator("#lightbox-stage").hover();
  await page.mouse.wheel(0, -100);
  await until(
    async () =>
      (await page.locator("#lightbox-image").getAttribute("style"))?.includes(
        "1.2",
      ),
    "wheel zoom",
  );
  await page.locator("#lightbox-stage").dblclick();
  assert.ok(
    (await page.locator("#lightbox-image").getAttribute("style")).includes(
      "scale(1)",
    ),
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#lightbox").evaluate((dialog) => dialog.open),
    false,
  );
  h.step("desktop-image-viewer");

  const input = page.getByLabel("Message", { exact: true });
  await input.fill("/jk");
  await page.keyboard.press("j");
  assert.equal(await input.inputValue(), "/jkj");
  await page.keyboard.press("Escape");
  assert.equal(
    await input.evaluate((element) => document.activeElement === element),
    true,
  );
  await input.blur();
  await page.locator("#chat-list").focus();
  await page.keyboard.press("/");
  assert.equal(
    await page.getByLabel("Search chats").evaluate((el) =>
      document.activeElement === el
    ),
    true,
  );
  await page.getByLabel("Search chats").fill("");
  await page.getByLabel("Search chats").blur();
  await page.locator("#chat-list").focus();
  await page.keyboard.press("j");
  assert.equal(await page.locator(".chat-row:focus").count(), 1);
  const selected = await page.locator(".chat-row:focus").getAttribute(
    "data-chat-id",
  );
  await page.keyboard.press("Enter");
  await until(
    () =>
      tap.sent.filter((frame) => frame.cmd === "history").at(-1)?.chat ===
        selected,
    "keyboard selection history",
  );
  assert.equal(
    tap.sent.filter((frame) => frame.cmd === "history").at(-1).chat,
    selected,
  );
  await input.blur();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#workspace").evaluate((el) =>
      el.classList.contains("chat-open")
    ),
    false,
  );
  h.step("keyboard-navigation");

  const phone = await mobile.newPage();
  const phoneHistories = new Set();
  let phoneSync;
  const phoneTap = await tapSocket(phone, {
    client(frame) {
      if (frame.cmd === "sync") {
        phoneSync = frame.id;
        return false;
      }
      if (frame.cmd === "history" && frame.chat === CHAT) {
        phoneHistories.add(frame.id);
      }
      return true;
    },
    server(frame) {
      if (frame.web === "state") {
        frame.state.link = {
          push: "down",
          reason: "restricted",
          code: "BANNED",
        };
      }
      if (phoneHistories.has(frame.id)) {
        frame.data = messages;
        phoneHistories.delete(frame.id);
      }
      return true;
    },
  });
  await h.signIn(phone);
  await phone.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await phone.locator('article[data-message-id="parity7"]').waitFor();
  assert.equal(
    await phone.locator("#workspace").evaluate((el) =>
      el.classList.contains("chat-open")
    ),
    true,
  );
  assert.equal(await phone.locator("#sync").isVisible(), false);
  await phone.getByRole("button", { name: /LINE 帳號受到限制/ }).click();
  await phone.getByRole("button", { name: /同步中/ }).waitFor();
  assert.equal(
    await phone.getByRole("button", { name: /同步中/ }).isDisabled(),
    true,
  );
  await until(() => phoneSync !== undefined, "mobile sync");
  phoneTap.socket.send(
    JSON.stringify({ id: phoneSync, ok: true, data: { at: Date.now() } }),
  );
  await phone.getByRole("button", { name: /點此重試/ }).waitFor();
  h.step("mobile-restriction-sync");
  await phone.locator('article[data-message-id="parity4"] img.media-image')
    .click();
  await dispatchTouches(phone, [
    ["touchstart", [[1, 100, 100], [2, 200, 100]]],
    ["touchmove", [[1, 50, 100], [2, 250, 100]]],
    ["touchend", []],
  ]);
  assert.ok(
    (await phone.locator("#lightbox-image").getAttribute("style")).includes(
      "scale(2)",
    ),
  );
  const beforePan = await phone.locator("#lightbox-image").getAttribute(
    "style",
  );
  await phone.keyboard.press("Shift+ArrowRight");
  const afterPan = await phone.locator("#lightbox-image").getAttribute("style");
  assert.notEqual(afterPan, beforePan);
  const box = await phone.locator("#lightbox-stage").boundingBox();
  await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await phone.mouse.down();
  await phone.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2);
  await phone.mouse.up();
  assert.notEqual(
    await phone.locator("#lightbox-image").getAttribute("style"),
    afterPan,
  );
  const beforeTouchPan = await phone.locator("#lightbox-image").getAttribute(
    "style",
  );
  await dispatchTouches(phone, [
    ["touchstart", [[1, 200, 200]]],
    ["touchmove", [[1, 170, 200]]],
    ["touchend", []],
  ]);
  assert.notEqual(
    await phone.locator("#lightbox-image").getAttribute("style"),
    beforeTouchPan,
  );
  for (
    const id of ["prev", "next", "zoom-out", "zoom-in", "download", "close"]
  ) {
    const control = await phone.locator(`#lightbox-${id}`).boundingBox();
    assert.ok(
      control && control.x >= 0 && control.x + control.width <= 390,
      `${id} fits on mobile`,
    );
  }
  await phone.setViewportSize({ width: 320, height: 700 });
  for (
    const id of ["prev", "next", "zoom-out", "zoom-in", "download", "close"]
  ) {
    const control = await phone.locator(`#lightbox-${id}`).boundingBox();
    assert.ok(
      control && control.x >= 0 && control.x + control.width <= 320,
      `${id} fits at 320px`,
    );
  }
  await phone.locator("#lightbox-close").click();
  h.step("mobile-image-viewer");
  await phone.getByRole("button", { name: "返回" }).click();
  assert.equal(await phone.locator("#sidebar").isVisible(), true);
  h.step("mobile-navigation");
}

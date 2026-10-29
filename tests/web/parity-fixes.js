// Regression coverage for parity review findings.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function syncAccount(h) {
  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  const syncIds = [];
  let overrideAccount = false;
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.cmd === "sync") {
        syncIds.push(frame.id);
        return false;
      }
      return true;
    },
    server(frame) {
      if (overrideAccount && frame.web === "state") {
        frame.state.me = { mid: "u-new-account", displayName: "New account" };
      }
      return true;
    },
  });
  await h.signIn(page);
  await page.locator("#sync").click();
  await until(() => syncIds.length === 1, "old account sync");
  const state = await h.state();
  overrideAccount = true;
  tap.socket.send(JSON.stringify({
    web: "state",
    state: {
      ...state,
      me: { mid: "u-new-account", displayName: "New account" },
    },
  }));
  await page.getByText("New account", { exact: true }).waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), false);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  await page.locator("#sync").click();
  await until(() => syncIds.length === 2, "new account sync");
  const histories = tap.sent.filter((frame) => frame.cmd === "history").length;
  tap.socket.send(
    JSON.stringify({ id: syncIds[0], ok: true, data: { at: Date.now() } }),
  );
  const barrier = {
    id: "sync-account-barrier",
    chat: CHAT,
    from: "u-other",
    fromName: "Peer",
    text: "Old sync handled",
    time: Date.now(),
    contentType: "NONE",
  };
  tap.socket.send(JSON.stringify({
    event: { seq: 999999, kind: "message", chat: CHAT, message: barrier },
    boot: state.bootId,
  }));
  await page.getByText("Old sync handled", { exact: true }).waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), true);
  assert.equal(await page.getByText(/Synced/).count(), 0);
  assert.equal(
    tap.sent.filter((frame) => frame.cmd === "history").length,
    histories,
  );
  tap.socket.send(
    JSON.stringify({ id: syncIds[1], ok: false, error: "new sync failed" }),
  );
  await page.getByText("new sync failed", { exact: true }).waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), false);
  await page.locator("#sync").click();
  await until(() => syncIds.length === 3, "second account sync");
  overrideAccount = false;
  tap.socket.send(JSON.stringify({ web: "state", state }));
  await page.getByText("STUB User", { exact: true }).waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), false);
  tap.socket.send(JSON.stringify({
    id: syncIds[2],
    ok: false,
    error: "stale account error",
  }));
  const restored = await h.state();
  tap.socket.send(JSON.stringify({
    web: "state",
    state: { ...restored, me: { ...restored.me, displayName: "Restored" } },
  }));
  await page.getByText("Restored", { exact: true }).waitFor();
  assert.equal(await page.getByText("stale account error").count(), 0);
  await context.close();
  h.step("sync-account-generation");
}

export async function unreadBoundary(h) {
  for (const inHistory of [false, true]) {
    const context = await h.context({ locale: "en-US" });
    const page = await context.newPage();
    const histories = new Set();
    let held, boot = "";
    const tap = await tapSocket(page, {
      client(frame) {
        if (frame.cmd === "history" && frame.chat === CHAT) {
          histories.add(frame.id);
        }
        return true;
      },
      server(frame) {
        if (frame.web === "state") {
          boot = String(frame.state.bootId || "");
          frame.state.chats = frame.state.chats.map((row) =>
            row.mid === CHAT ? { ...row, unread: 2 } : row
          );
        }
        if (histories.delete(frame.id) && !held) {
          held = frame;
          return false;
        }
        return true;
      },
    });
    await h.signIn(page);
    await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
    await until(() => held, "initial history");
    const now = Date.now() - 10000;
    const message = (id, time) => ({
      id,
      chat: CHAT,
      from: "u-other",
      fromName: "Peer",
      text: id,
      time,
      contentType: "NONE",
      hasMedia: false,
      mediaState: "ok",
    });
    const newer = message("new-after-open", now + 3000);
    tap.socket.send(JSON.stringify({
      event: { seq: 999999, kind: "message", chat: CHAT, message: newer },
      boot,
    }));
    held.data = [
      message("read0", now),
      message("unread1", now + 1000),
      message("unread2", now + 2000),
      ...(inHistory ? [newer] : []),
    ];
    tap.socket.send(JSON.stringify(held));
    await page.getByText("new-after-open", { exact: true }).waitFor();
    assert.equal(
      await page.locator(".unread-divider").evaluate((node) =>
        node.nextElementSibling?.dataset.messageId
      ),
      "unread1",
    );
    await context.close();
  }
  h.step("unread-opening-boundary");
}

export async function chatPatchOrder(h) {
  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  const tap = await tapSocket(page);
  await h.signIn(page);
  const state = await h.state();
  const row = (mid, lastTime, extra = {}) => ({
    mid,
    name: `Chat ${mid}`,
    lastTime,
    unread: 0,
    ...extra,
  });
  const rows = [
    row("ca", 200),
    row("cc", 200),
    row("cb", 100),
    row("cd", 50, { unread: 1 }),
    row("ce", 400, { hidden: true }),
  ];
  let revision = Number(state.chatsRevision || 0) + 100;
  tap.socket.send(JSON.stringify({
    web: "state",
    state: { ...state, chats: rows, chatsRevision: revision },
  }));
  await until(
    async () => await page.locator(".chat-row").count() === 4,
    "chats",
  );
  const focused = page.locator('[data-chat-id="ca"]');
  await focused.focus();
  await focused.evaluate((node) => globalThis.savedChatRow = node);
  tap.socket.send(JSON.stringify({
    chat: { ...rows[2], lastTime: 300, lastText: "new" },
    chatsRevision: ++revision,
    boot: state.bootId,
  }));
  await page.getByText("new", { exact: true }).waitFor();
  const order = () =>
    page.locator(".chat-row").evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.chatId)
    );
  assert.deepEqual(await order(), ["cd", "cb", "ca", "cc"]);
  assert.equal(
    await focused.evaluate((node) =>
      node === globalThis.savedChatRow && node === document.activeElement
    ),
    true,
  );
  await page.locator("#search").fill("Chat");
  assert.deepEqual(await order(), ["cd", "cb", "ca", "cc", "ce"]);
  await context.close();
  h.step("chat-patch-order-and-focus");
}

function picture(h, id, file, time = Date.now()) {
  return {
    id,
    chat: CHAT,
    from: "other",
    fromName: "Peer",
    text: id,
    time,
    contentType: "IMAGE",
    hasMedia: true,
    previewable: true,
    mediaState: "ok",
    mediaPath: `${h.stateDir}/media/${file}`,
  };
}

async function pictureFixture(h, messages, hooks = {}) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 1200, height: 850 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const histories = new Set();
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.cmd === "history" && frame.chat === CHAT) {
        histories.add(frame.id);
      }
      return hooks.client?.(frame) !== false;
    },
    server(frame) {
      if (histories.delete(frame.id)) frame.data = messages;
      return hooks.server?.(frame) !== false;
    },
  });
  await h.signIn(page);
  const state = await h.state();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.locator(`article[data-message-id="${messages[0].id}"] img`)
    .waitFor();
  return { context, page, tap, state };
}

export async function lightboxModifiers(h) {
  const messages = [picture(h, "key-image", "stub-shot1.png")];
  const { context, page } = await pictureFixture(h, messages);
  const image = page.locator('article[data-message-id="key-image"] img');
  const composed = await image.evaluate((node) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(composed, false);
  assert.equal(
    await page.locator("#lightbox").evaluate((node) => node.open),
    false,
  );
  await image.click();
  await page.locator("#lightbox[open]").waitFor();
  await page.evaluate(() => {
    globalThis.ctrlPrevented = null;
    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key === "=") {
        globalThis.ctrlPrevented = event.defaultPrevented;
      }
    });
  });
  const before = await page.locator("#lightbox-image").getAttribute("style");
  await page.keyboard.press("Control+=");
  assert.equal(await page.evaluate(() => globalThis.ctrlPrevented), false);
  assert.equal(
    await page.locator("#lightbox-image").getAttribute("style"),
    before,
  );
  for (
    const modifier of [{ metaKey: true }, { altKey: true }, {
      isComposing: true,
    }]
  ) {
    const prevented = await page.locator("#lightbox").evaluate(
      (node, options) => {
        const event = new KeyboardEvent("keydown", {
          key: "=",
          bubbles: true,
          cancelable: true,
          ...options,
        });
        node.dispatchEvent(event);
        return event.defaultPrevented;
      },
      modifier,
    );
    assert.equal(prevented, false);
    assert.equal(
      await page.locator("#lightbox-image").getAttribute("style"),
      before,
    );
  }
  await page.keyboard.press("=");
  assert.notEqual(
    await page.locator("#lightbox-image").getAttribute("style"),
    before,
  );
  await context.close();
  h.step("lightbox-modifiers-and-composition");
}

export async function shortcutScope(h) {
  const { context, page, tap } = await pictureFixture(
    h,
    [picture(h, "scope-image", "stub-shot1.png")],
    { client: (frame) => frame.cmd !== "sync" },
  );
  await page.evaluate(() => {
    globalThis.lastShortcutPrevented = null;
    document.addEventListener("keydown", (event) => {
      if (event.key === "r") {
        globalThis.lastShortcutPrevented = event.defaultPrevented;
      }
    });
  });
  const syncCount = () =>
    tap.sent.filter((frame) => frame.cmd === "sync").length;
  for (
    const selector of [
      "#web-signout",
      "#sync",
      ".message-actions button",
      'article[data-message-id="scope-image"] img',
    ]
  ) {
    await page.locator(selector).first().focus();
    await page.keyboard.press("r");
    assert.equal(
      await page.evaluate(() => globalThis.lastShortcutPrevented),
      false,
    );
    assert.equal(syncCount(), 0);
  }
  for (const selector of [".chat-row", "#messages"]) {
    const target = page.locator(selector).first();
    if (selector === "#messages") {
      await target.evaluate((node) => node.tabIndex = 0);
    }
    await target.focus();
    const before = syncCount();
    await page.keyboard.press("r");
    await until(() => syncCount() === before + 1, `sync from ${selector}`);
    assert.equal(
      await page.evaluate(() => globalThis.lastShortcutPrevented),
      true,
    );
    const id = tap.sent.filter((frame) => frame.cmd === "sync").at(-1).id;
    tap.socket.send(JSON.stringify({ id, ok: false, error: "fixture sync" }));
    await until(
      async () => !(await page.locator("#sync").isDisabled()),
      "sync idle",
    );
  }
  await page.locator("#messages").blur();
  await page.keyboard.press("/");
  assert.equal(
    await page.locator("#search").evaluate((node) =>
      node === document.activeElement
    ),
    true,
  );
  await context.close();
  h.step("character-shortcut-focus-scope");
}

export async function reactionEscape(h) {
  const now = Date.now();
  const messages = [
    picture(h, "reaction-1", "stub-shot1.png", now),
    picture(h, "reaction-2", "stub-shot2.png", now + 1),
  ];
  const { context, page } = await pictureFixture(h, messages);
  const first = page.locator('article[data-message-id="reaction-1"]');
  const second = page.locator('article[data-message-id="reaction-2"]');
  await first.getByRole("button", { name: "Reply" }).click();
  await page.locator("#stickers").click();
  await first.getByRole("button", { name: "React" }).click();
  await second.getByRole("button", { name: "React" }).click();
  assert.equal(await page.locator(".reaction-picker").count(), 2);
  await second.getByRole("button", { name: "LOVE" }).focus();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".reaction-picker").count(), 0);
  assert.equal(
    await second.getByRole("button", { name: "React" }).evaluate(
      (node) => node === document.activeElement,
    ),
    true,
  );
  assert.equal(await page.locator("#sticker-picker").isVisible(), true);
  assert.equal(
    await page.locator("#workspace").evaluate((node) =>
      node.classList.contains("chat-open")
    ),
    true,
  );
  await first.getByRole("button", { name: "React" }).click();
  assert.equal(await page.locator(".reaction-picker").count(), 1);
  const input = page.locator("#message-input");
  await input.fill("@ST");
  await page.getByRole("button", { name: "@STUB 媽" }).waitFor();
  const composing = await input.evaluate((node) => {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(composing, false);
  assert.equal(await page.locator(".reaction-picker").count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".reaction-picker").count(), 0);
  assert.equal(await page.locator("#mention-picker").isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#mention-picker").isHidden(), true);
  await input.blur();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#sticker-picker").isHidden(), true);
  assert.equal(await page.locator("#reply-target").isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#reply-target").isHidden(), true);
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#workspace").evaluate((node) =>
      node.classList.contains("chat-open")
    ),
    false,
  );
  await context.close();
  h.step("reaction-escape-priority");
}

export async function lightboxUpdates(h) {
  const first = picture(h, "dynamic-1", "stub-shot1.png", Date.now() - 1000);
  let previewRequest;
  const { context, page, tap, state } = await pictureFixture(h, [first], {
    client(frame) {
      if (frame.cmd === "preview" && frame.messageId === "dynamic-2") {
        previewRequest = frame;
        return false;
      }
      return true;
    },
  });
  await page.locator('article[data-message-id="dynamic-1"] img').click();
  await page.locator("#lightbox-zoom-in").click();
  const image = page.locator("#lightbox-image");
  const zoom = await image.getAttribute("style");
  const src = await image.getAttribute("src");
  const second = picture(h, "dynamic-2", "stub-shot2.png");
  delete second.mediaPath;
  let seq = 999999;
  const event = (kind, data) =>
    tap.socket.send(JSON.stringify({
      event: { seq: seq++, kind, chat: CHAT, ...data },
      boot: state.bootId,
    }));
  event("message", { message: second });
  await until(() => previewRequest, "new image preview request");
  assert.match(await page.locator("#lightbox-name").textContent(), /1 \/ 1/);
  tap.socket.send(JSON.stringify({
    id: previewRequest.id,
    ok: true,
    data: { path: `${h.stateDir}/media/stub-shot2.png` },
  }));
  await until(
    async () => !(await page.locator("#lightbox-next").isDisabled()),
    "new picture in viewer",
  );
  assert.match(await page.locator("#lightbox-name").textContent(), /1 \/ 2/);
  assert.equal(await image.getAttribute("style"), zoom);
  assert.equal(await image.getAttribute("src"), src);
  event("message", {
    message: {
      ...second,
      id: "dynamic-text",
      contentType: "NONE",
      hasMedia: false,
      text: "Unrelated update",
      time: Date.now() + 1000,
    },
  });
  await page.getByText("Unrelated update").waitFor({ state: "attached" });
  assert.equal(await image.getAttribute("style"), zoom);
  assert.equal(await image.getAttribute("src"), src);
  await page.locator("#lightbox-next").click();
  assert.match(await page.locator("#lightbox-name").textContent(), /2 \/ 2/);
  event("unsend", { messageId: "dynamic-1" });
  await until(async () =>
    (await page.locator("#lightbox-name").textContent())
      .includes("1 / 1"), "removed picture in viewer");
  assert.equal(await page.locator("#lightbox-prev").isDisabled(), true);
  await context.close();
  h.step("lightbox-live-picture-list");
}

export async function lightboxFailure(h) {
  await Deno.writeFile(
    `${h.stateDir}/media/invalid.jpg`,
    new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  );
  const now = Date.now();
  const messages = [
    picture(h, "valid", "stub-shot1.png", now),
    picture(h, "invalid", "invalid.jpg", now + 1),
  ];
  const { context, page } = await pictureFixture(h, messages);
  await page.locator('article[data-message-id="valid"] img').click();
  const image = page.locator("#lightbox-image");
  await page.locator("#lightbox-next").click();
  await until(
    async () =>
      await image.evaluate((node) => node.complete && node.naturalWidth === 0),
    "invalid image decode",
  );
  const error = page.locator("#lightbox-error");
  assert.equal(await error.count(), 1);
  assert.equal(await error.getAttribute("role"), "alert");
  assert.equal(await error.isVisible(), true);
  assert.equal(await error.textContent(), "Could not load attachment");
  await page.locator("#lightbox-prev").click();
  await until(
    async () =>
      await image.evaluate((node) => node.complete && node.naturalWidth > 0),
    "valid image decode",
  );
  assert.equal(await error.isHidden(), true);
  await context.close();
  h.step("lightbox-decode-failure");
}

export async function lightboxOriginal(h) {
  const now = Date.now();
  const messages = [
    picture(h, "original-1", "stub-shot1.png", now),
    picture(h, "original-2", "stub-shot2.png", now + 1),
  ];
  const { context, page, tap, state } = await pictureFixture(h, messages, {
    client: (frame) => frame.cmd !== "download",
  });
  const commands = () => tap.sent.filter((frame) => frame.cmd === "download");
  const reply = (index, path) =>
    tap.socket.send(JSON.stringify({
      id: commands()[index].id,
      ok: true,
      data: { path },
    }));
  const path1 = `${h.stateDir}/media/stub-shot2.png`;
  const path2 = `${h.stateDir}/media/stub-shot1.png`;
  const image = page.locator("#lightbox-image");
  const first = page.locator('article[data-message-id="original-1"] img');
  await first.click();
  const firstPreview = await image.getAttribute("src");
  await until(() => commands().length === 1, "first original request");
  assert.equal(commands()[0].messageId, "original-1");
  const downloaded = page.waitForEvent("download");
  await page.locator("#lightbox-download").click();
  assert.equal(commands().length, 1);
  await page.locator("#lightbox-next").click();
  await until(() => commands().length === 2, "second original request");
  const secondPreview = await image.getAttribute("src");
  reply(0, path1);
  await downloaded;
  assert.equal(await image.getAttribute("src"), secondPreview);
  await page.locator("#lightbox-zoom-in").click();
  const zoom = await image.getAttribute("style");
  reply(1, path2);
  await until(async () =>
    (await image.getAttribute("src"))?.endsWith(
      encodeURIComponent(path2),
    ), "second original displayed");
  assert.equal(await image.getAttribute("style"), zoom);
  await page.locator("#lightbox-prev").click();
  await until(async () =>
    (await image.getAttribute("src"))?.endsWith(
      encodeURIComponent(path1),
    ), "cached first original displayed");
  assert.equal(commands().length, 2);

  await page.locator("#lightbox-close").click();
  await first.click();
  await until(() => commands().length === 3, "reopened original request");
  await page.locator("#lightbox-close").click();
  await first.click();
  assert.equal(commands().length, 3);
  reply(2, path1);
  await until(() => commands().length === 4, "request for new opening");
  assert.equal(await image.getAttribute("src"), firstPreview);
  reply(3, path1);
  await until(async () =>
    (await image.getAttribute("src"))?.endsWith(
      encodeURIComponent(path1),
    ), "new opening original displayed");

  await page.locator("#lightbox-close").click();
  await first.click();
  await until(() => commands().length === 5, "failed original request");
  tap.socket.send(JSON.stringify({
    id: commands()[4].id,
    ok: false,
    error: "original unavailable",
  }));
  tap.socket.send(JSON.stringify({
    web: "state",
    state: { ...state, me: { ...state.me, displayName: "Failure barrier" } },
  }));
  await page.getByText("Failure barrier", { exact: true }).waitFor();
  assert.equal(await image.getAttribute("src"), firstPreview);
  await page.locator("#lightbox-close").click();
  await first.click();
  await until(() => commands().length === 6, "retry original request");
  assert.equal(await image.getAttribute("src"), firstPreview);
  reply(5, path1);
  await until(async () =>
    (await image.getAttribute("src"))?.endsWith(
      encodeURIComponent(path1),
    ), "retried original displayed");

  await page.locator("#lightbox-close").click();
  await first.click();
  await until(() => commands().length === 7, "old account original request");
  tap.socket.send(JSON.stringify({
    web: "state",
    state: { ...state, me: { mid: "u-next", displayName: "Next" } },
  }));
  await page.getByText("Next", { exact: true }).waitFor();
  assert.equal(
    await page.locator("#lightbox").evaluate((node) => node.open),
    false,
  );
  const closedSrc = await image.getAttribute("src");
  reply(6, path1);
  tap.socket.send(JSON.stringify({
    web: "state",
    state: { ...state, me: { mid: "u-next", displayName: "Barrier" } },
  }));
  await page.getByText("Barrier", { exact: true }).waitFor();
  assert.equal(await image.getAttribute("src"), closedSrc);
  await context.close();

  const fixture = await pictureFixture(
    h,
    [picture(h, "flex-before", "stub-shot1.png")],
    { client: (frame) => frame.cmd !== "download" },
  );
  await fixture.page.route(
    "https://example.test/image.png",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        path: `${h.stateDir}/media/stub-shot1.png`,
      }),
  );
  const flex = {
    id: "flex-image",
    chat: CHAT,
    from: "other",
    fromName: "Peer",
    time: Date.now() + 1000,
    text: "Flex image",
    contentType: "FLEX",
    flexImages: [
      "https://example.test/image.png",
      "https://example.test/image.png",
    ],
  };
  fixture.tap.socket.send(JSON.stringify({
    event: { seq: 999999, kind: "message", chat: CHAT, message: flex },
    boot: fixture.state.bootId,
  }));
  await fixture.page.locator('article[data-message-id="flex-image"] img')
    .first()
    .waitFor({ state: "attached" });
  await fixture.page.locator('article[data-message-id="flex-before"] img')
    .click();
  await until(
    () => fixture.tap.sent.some((frame) => frame.cmd === "download"),
    "non-FLEX original",
  );
  const flexCount =
    fixture.tap.sent.filter((frame) => frame.cmd === "download").length;
  await fixture.page.locator("#lightbox-next").click();
  assert.equal(
    await fixture.page.locator("#lightbox-image").getAttribute("src"),
    "https://example.test/image.png",
  );
  assert.equal(
    fixture.tap.sent.filter((frame) => frame.cmd === "download").length,
    flexCount,
  );
  await fixture.page.locator("#lightbox-next").click();
  assert.match(
    await fixture.page.locator("#lightbox-name").textContent(),
    /3 \/ 3/,
  );
  fixture.tap.socket.send(JSON.stringify({
    event: {
      seq: 1000000,
      kind: "message",
      chat: CHAT,
      message: {
        ...flex,
        id: "flex-barrier",
        contentType: "NONE",
        text: "Flex barrier",
        time: Date.now() + 2000,
      },
    },
    boot: fixture.state.bootId,
  }));
  await fixture.page.getByText("Flex barrier").waitFor({ state: "attached" });
  assert.match(
    await fixture.page.locator("#lightbox-name").textContent(),
    /3 \/ 3/,
  );
  await fixture.page.locator("#lightbox-close").click();
  await fixture.page.locator('article[data-message-id="flex-image"] img').last()
    .evaluate((node) => node.click());
  assert.match(
    await fixture.page.locator("#lightbox-name").textContent(),
    /3 \/ 3/,
  );
  await fixture.context.close();
  h.step("lightbox-original-concurrency");
}

export async function parityFixes(h) {
  await syncAccount(h);
  await unreadBoundary(h);
  await chatPatchOrder(h);
  await lightboxModifiers(h);
  await shortcutScope(h);
  await reactionEscape(h);
  await lightboxUpdates(h);
  await lightboxFailure(h);
  await lightboxOriginal(h);
}

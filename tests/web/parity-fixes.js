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

export async function parityFixes(h) {
  await syncAccount(h);
  await unreadBoundary(h);
  await chatPatchOrder(h);
  await lightboxModifiers(h);
}

// Push ordering, failures, login states and reconnect backoff.
import { assert, CHAT, KEY, tapSocket, until } from "./harness.js";
import { Buffer } from "node:buffer";

export async function edge(h) {
  const context = await h.context({ locale: "en-US", colorScheme: "dark" });
  const page = await context.newPage();
  let observedBoot = "";
  let failFile = true;
  const filePaths = [];
  const tap = await tapSocket(page, {
    client(frame, channel) {
      if (frame.cmd === "sendFile") {
        filePaths.push(frame.path);
        if (failFile) {
          failFile = false;
          channel.socket.send(
            JSON.stringify({ id: frame.id, ok: false, error: "test refusal" }),
          );
          return false;
        }
      }
      return true;
    },
    server(frame) {
      if (frame.web === "state") {
        observedBoot = String(frame.state.bootId || "");
      }
      return true;
    },
  });
  await h.signIn(page);
  assert.equal(
    await page.getByLabel("Search chats").getAttribute("placeholder"),
    "Search chats",
  );
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  const state = await h.state();
  await until(() => observedBoot === state.bootId, "current state boot ID");
  const chat = state.chats.find((row) => row.mid === CHAT);
  tap.socket.send(JSON.stringify({
    chat: { ...chat, name: "Pushed chat row" },
    chatsRevision: state.chatsRevision + 100,
    boot: state.bootId,
  }));
  tap.socket.send(JSON.stringify({
    web: "state",
    state: {
      ...state,
      chatList: { complete: false },
      chatsRevision: state.chatsRevision,
    },
  }));
  await page.getByRole("button", { name: /Pushed chat row/ }).waitFor();
  assert.equal(await page.locator("#list-warning").isVisible(), false);
  h.step("chat-revision-watermark");
  let seq = Math.max(0, ...(state.events || []).map((event) => event.seq)) + 1;
  const message = {
    id: "ui-edge-message",
    chat: CHAT,
    from: "u-other",
    fromName: "Other",
    text: "Push once",
    time: Date.now(),
    contentType: "NONE",
    hasMedia: false,
    unsent: false,
    decryptFailed: false,
    mediaState: "ok",
  };
  const event = {
    seq: seq++,
    at: Date.now(),
    kind: "message",
    chat: CHAT,
    message,
  };
  tap.socket.send(JSON.stringify({ event, boot: state.bootId }));
  tap.socket.send(
    JSON.stringify({
      web: "events",
      events: { bootId: state.bootId, events: [event] },
    }),
  );
  const log = page.getByRole("log");
  await log.getByText("Push once", { exact: true }).waitFor();
  assert.equal(await log.getByText("Push once", { exact: true }).count(), 1);
  tap.socket.send(JSON.stringify({
    event: {
      seq: seq++,
      at: Date.now(),
      kind: "edit",
      chat: CHAT,
      message: { ...message, text: "Edited safely" },
    },
    boot: state.bootId,
  }));
  await log.getByText("Edited safely", { exact: true }).waitFor();
  tap.socket.send(JSON.stringify({
    event: {
      seq: seq++,
      at: Date.now(),
      kind: "reaction",
      chat: CHAT,
      messageId: message.id,
      reactions: [{ type: "LOVE", count: 2, mine: false }],
    },
    boot: state.bootId,
  }));
  const row = page.locator('article[data-message-id="ui-edge-message"]');
  await row.getByRole("button", { name: /❤️ 2/ }).waitFor();
  tap.socket.send(JSON.stringify({
    event: {
      seq: seq++,
      at: Date.now(),
      kind: "unsend",
      chat: CHAT,
      messageId: message.id,
    },
    boot: state.bootId,
  }));
  await row.getByText("Message unsent").waitFor();
  h.step("push-ring-dedup-edit-reaction-unsend");

  await page.reload();
  await page.locator("#connection.connected").waitFor();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await log.getByText("晚上回來吃飯嗎？").waitFor();
  const fileName = `retry-${Date.now()}.png`;
  await page.locator("#file-input").setInputFiles({
    name: fileName,
    mimeType: "image/png",
    buffer: Buffer.from(
      await Deno.readFile(`${h.stateDir}/media/stub-shot1.png`),
    ),
  });
  const pending = page.locator("article.message-row").filter({
    hasText: fileName,
  });
  await pending.getByRole("button", { name: "Retry" }).click();
  await pending.getByRole("button", { name: "Unsend" }).waitFor();
  assert.equal(filePaths.length, 2);
  assert.notEqual(filePaths[0], filePaths[1]);
  h.step("upload-retry-fresh-copy");
  tap.socket.send(JSON.stringify({
    web: "state",
    state: {
      ...state,
      link: { push: "down", reason: "restricted", code: "BANNED" },
      refresh: { failures: 2 },
      updatedAt: Date.now() - 181000,
    },
  }));
  await page.getByText(/account is restricted/).waitFor();
  const notices = await page.locator("#notices").textContent();
  assert.ok(notices.includes("chat list may be stale"));
  assert.ok(notices.includes("daemon is offline"));
  h.step("offline-restricted-stale-notices");
  const loginState = (status, fields = {}) =>
    tap.socket.send(JSON.stringify({
      web: "state",
      state: { ...state, me: {}, login: { status, ...fields } },
    }));
  loginState("idle");
  await page.getByRole("button", { name: "Sign in to LINE" }).waitFor();
  loginState("qr", { qrPng: `${h.stateDir}/media/stub-shot1.png` });
  await page.getByAltText("LINE login QR code").waitFor();
  loginState("pin", { pin: "123456" });
  await page.getByText("123456", { exact: true }).waitFor();
  loginState("error", { error: "test error" });
  await page.getByRole("button", { name: "Try again" }).waitFor();
  loginState("ok");
  h.step("line-login-states-english");

  const backoff = await context.newPage();
  const attempts = [];
  await backoff.routeWebSocket("**/api/ws", async (socket) => {
    attempts.push(Date.now());
    if (attempts.length <= 3) {
      await socket.close({ code: 4001, reason: "daemon offline" });
    } else socket.connectToServer();
  });
  await backoff.goto(h.base);
  await backoff.locator("#connection.connected").waitFor({ timeout: 20000 });
  assert.equal(attempts.length, 4);
  const intervals = attempts.slice(1).map((time, i) => time - attempts[i]);
  assert.ok(
    intervals[0] >= 900 && intervals[1] >= 1800 && intervals[2] >= 3600,
    `intervals ${intervals}`,
  );
  h.step("reconnect-backoff");

  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${h.base}/?key=wrong-${i}`);
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
  for (
    const [locale, message, noHistory] of [
      [
        "en-US",
        "Link sign-in is temporarily locked. Enter your web key below.",
      ],
      ["zh-TW", "連結登入暫時被鎖定，請在下方輸入 web key。"],
      [
        "en-US",
        "Link sign-in is temporarily locked. Enter your web key below.",
        true,
      ],
    ]
  ) {
    const blockedContext = await h.context({ locale });
    if (noHistory) {
      await blockedContext.addInitScript(() => {
        History.prototype.replaceState = () => {
          throw new DOMException("unavailable", "SecurityError");
        };
      });
    }
    const blockedPage = await blockedContext.newPage();
    const endExpected429 = h.allowBlockedLink429(blockedPage);
    const response = await blockedPage.goto(`${h.base}/?key=${KEY}`);
    assert.equal(response.status(), 429);
    await blockedPage.locator("#signin-screen").waitFor({ state: "visible" });
    assert.equal(
      await blockedPage.locator("#signin-error").textContent(),
      message,
    );
    assert.equal(await blockedPage.locator("#signin-error").isVisible(), true);
    assert.equal(
      new URL(blockedPage.url()).searchParams.has("key"),
      !!noHistory,
    );
    await blockedPage.getByLabel("Web key").fill(KEY);
    await blockedPage.locator('#signin-form button[type="submit"]').click();
    await blockedPage.locator("#connection.connected").waitFor();
    await blockedPage.waitForLoadState("networkidle");
    endExpected429();
    await blockedContext.close();
  }
  h.step("blocked-link-keeps-manual-signin-available");
}

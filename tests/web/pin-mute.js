// Pinned and muted chats: list order and marks, the tab title, the sound,
// next unread, the quick switcher, keyboard use, contrast and a narrow screen.
import axe from "npm:axe-core@4.10.3";
import { assert, tapSocket, until } from "./harness.js";

// Count started tones instead of playing them (same fake as settings.js).
function instrument() {
  globalThis.__tones = 0;
  class FakeParam {
    setValueAtTime() {}
    exponentialRampToValueAtTime() {}
  }
  class FakeNode {
    constructor() {
      this.frequency = new FakeParam();
      this.gain = new FakeParam();
    }
    connect(node) {
      return node;
    }
    start() {
      globalThis.__tones++;
    }
    stop() {}
  }
  globalThis.AudioContext = class {
    currentTime = 0;
    destination = {};
    resume() {
      return Promise.resolve();
    }
    createOscillator() {
      return new FakeNode();
    }
    createGain() {
      return new FakeNode();
    }
  };
  if (location.protocol === "http:") {
    localStorage["enil.settings"] = JSON.stringify({
      theme: "system",
      textSize: 100,
      sound: true,
    });
  }
}

export async function pinMute(h) {
  await desktop(h);
  await narrow(h);
}

async function desktop(h) {
  const context = await h.context({
    locale: "zh-TW",
    viewport: { width: 1280, height: 800 },
    // Lets the test inject axe; the app's headers are unchanged.
    bypassCSP: true,
  });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  let boot = "", account = "";
  const tap = await tapSocket(page, {
    server(frame) {
      if (frame.web === "state" && frame.state) {
        boot = String(frame.state.bootId || boot);
        account = String(frame.state.me?.mid || account);
      }
      return true;
    },
  });
  await h.signIn(page);
  await until(() => boot && account, "state frame");
  const order = () =>
    page.locator("#chat-list .chat-row").evaluateAll((rows) =>
      rows.map((row) => row.dataset.chatId)
    );
  const row = (mid) => page.locator(`.chat-row[data-chat-id="${mid}"]`);
  const stateRow = async (mid) =>
    (await h.state()).chats.find((chat) => chat.mid === mid);

  // Fixture unread: family 3, work 1, lunch 2.
  await until(async () => (await page.title()) === "(6) Line Web", "title (6)");

  // Muting keeps the row and its count, dims the badge, and leaves the
  // unread group and the tab title.
  await h.request({ id: 1, cmd: "mute", chat: "cstub-family" });
  await until(async () => (await page.title()) === "(3) Line Web", "title (3)");
  const family = row("cstub-family");
  await family.locator(".badge.quiet", { hasText: "3" }).waitFor();
  await family.locator(".row-mark-icon.muted").waitFor();
  assert.match(await family.textContent(), /已靜音/);
  const muted = await order();
  assert.deepEqual(
    muted.slice(0, 2).sort(),
    ["cstub-work", "rstub-lunch"],
    "unmuted unread chats lead",
  );
  assert.ok(muted.includes("cstub-family"), "a muted chat stays listed");
  h.step("mute keeps the row, dims the count and leaves the title");

  // Sound: none for the muted chat, one for another chat.
  let seq = 2_000_000;
  const inject = (chat) => {
    seq++;
    tap.socket.send(JSON.stringify({
      boot,
      event: {
        seq,
        kind: "message",
        chat,
        message: {
          id: String(9_100_000 + seq),
          chat,
          from: "upeer-sound",
          fromName: "Peer",
          time: Date.now(),
          text: `sound ${seq}`,
          contentType: "NONE",
        },
      },
    }));
  };
  inject("cstub-family");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => globalThis.__tones), 0, "muted");
  inject("cstub-work");
  await until(
    async () => await page.evaluate(() => globalThis.__tones) === 1,
    "tone for an unmuted chat",
  );
  h.step("a muted chat plays no sound");

  // Next unread skips the muted chat and hides once the rest is read.
  const next = page.getByRole("button", { name: "下一個未讀" });
  for (let i = 0; i < 2; i++) {
    await next.click();
    await until(
      async () =>
        !["", "STUB 家庭群組"].includes(
          await page.locator("#active-name").textContent(),
        ),
      "next unread",
    );
    assert.notEqual(
      await page.locator("#active-name").textContent(),
      "STUB 家庭群組",
    );
  }
  await until(async () => (await page.title()) === "Line Web", "all read");
  await next.waitFor({ state: "hidden" });
  assert.equal(Number(await family.locator(".badge").textContent()), 3);
  h.step("next unread skips a muted chat");

  // Pin with the keyboard: the quick switcher opens a chat, then Enter on
  // the focused header action.
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "切換聊天室" });
  await input.fill("alice");
  await page.keyboard.press("Enter");
  await page.locator("#active-name", { hasText: "STUB Alice" }).waitFor();
  const summary = page.locator("#chat-options > summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "pin-chat",
  );
  const pin = page.locator("#pin-chat");
  assert.equal(await pin.textContent(), "釘選");
  await pin.focus();
  await page.keyboard.press("Enter");
  await page.locator("#pin-chat", { hasText: "取消釘選" }).waitFor();
  await until(
    async () => (await order())[0] === "ustub-alice",
    "pinned chat first",
  );
  await row("ustub-alice").locator(".row-mark-icon.pinned").waitFor();
  assert.match(await row("ustub-alice").textContent(), /已釘選/);
  assert.equal((await stateRow("ustub-alice")).pinned, true);
  h.step("keyboard pins from the header and the row moves to the top");

  // A second pin sorts with the first by recency.
  await h.request({ id: 2, cmd: "pin", chat: "ustub-notes" });
  const state = await h.state();
  const pinned = state.chats.filter((chat) => chat.pinned)
    .sort((a, b) => b.lastTime - a.lastTime).map((chat) => chat.mid);
  assert.deepEqual(pinned.slice().sort(), ["ustub-alice", "ustub-notes"]);
  await until(
    async () => (await order()).slice(0, 2).join() === pinned.join(),
    "pinned chats in recency order",
  );
  h.step("pinned chats sort among themselves by recent activity");

  // The quick switcher uses the same order and shows the marks.
  await page.keyboard.press("Control+k");
  await input.fill("");
  const options = page.locator("#switcher-list [role=option]");
  assert.deepEqual(
    await options.evaluateAll((nodes) =>
      nodes.slice(0, 2).map((node) => node.dataset.chatId)
    ),
    pinned,
  );
  await page.getByRole("option", { name: /STUB Alice.*已釘選/ }).waitFor();
  await page.getByRole("option", { name: /STUB 家庭群組.*已靜音/ }).waitFor();
  await page.keyboard.press("Escape");
  h.step("quick switcher follows the pinned order");

  // Contrast with pinned and muted rows, both schemes.
  await page.addScriptTag({ content: axe.source });
  for (const colorScheme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme });
    const violations = await page.evaluate(async () => {
      const scan = await globalThis.axe.run(document, {
        runOnly: { type: "rule", values: ["color-contrast"] },
      });
      return scan.violations.flatMap((rule) =>
        rule.nodes.map((node) => node.target)
      );
    });
    assert.deepEqual(violations, [], colorScheme);
  }
  h.step("pinned and muted rows pass contrast");

  // Escape closes only the disclosure and returns focus to its summary.
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#chat-options").evaluate((node) => node.open),
    false,
  );
  assert.equal(
    await summary.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Space");
  await page.locator("#active-name").click();
  assert.equal(
    await page.locator("#chat-options").evaluate((node) => node.open),
    false,
  );
  await summary.click();
  h.step("chat options supports Enter, Tab, Space, Escape and outside click");

  // Mute and undo with the keyboard; the daemon files follow.
  const mute = page.locator("#mute-chat");
  await mute.focus();
  await page.keyboard.press("Space");
  await page.locator("#mute-chat", { hasText: "取消靜音" }).waitFor();
  await until(
    async () => (await stateRow("ustub-alice")).muted === true,
    "alice muted",
  );
  await page.keyboard.press("Space");
  await page.locator("#mute-chat", { hasText: "靜音" }).waitFor();
  await pin.focus();
  await page.keyboard.press("Enter");
  await page.locator("#pin-chat", { hasText: /^釘選$/ }).waitFor();
  await until(async () => {
    const chat = await stateRow("ustub-alice");
    return !("pinned" in chat) && !("muted" in chat);
  }, "alice flags cleared");
  await row("ustub-alice").locator(".row-marks:empty").waitFor({
    state: "attached",
  });
  h.step("keyboard mutes, unmutes and unpins");

  // A second device sees the same preferences.
  const other = await context.newPage();
  await other.goto(h.base, { waitUntil: "domcontentloaded" });
  await other.locator("#connection.connected").waitFor();
  await other.locator(
    '.chat-row[data-chat-id="ustub-notes"] .row-mark-icon.pinned',
  )
    .waitFor();
  await other.locator('.chat-row[data-chat-id="cstub-family"] .badge.quiet')
    .waitFor();
  h.step("another page shares pinned and muted");
  await context.close();
}

async function narrow(h) {
  await h.request({ id: 3, cmd: "pin", chat: "cstub-work" });
  await h.request({ id: 4, cmd: "mute", chat: "cstub-work" });
  const context = await h.context({
    locale: "zh-TW",
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
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
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 工作/ }).click();
  await page.locator("#chat-options > summary").click();
  await page.locator("#pin-chat", { hasText: "取消釘選" }).waitFor();
  await page.locator("#mute-chat", { hasText: "取消靜音" }).waitFor();
  const overflow = await page.evaluate(() =>
    [
      document.scrollingElement,
      ...document.querySelectorAll(".chat-header, .chat-actions"),
    ].flatMap((node) =>
      node.scrollWidth > node.clientWidth + 1
        ? [`${node.className || node.tagName} ${node.scrollWidth}`]
        : []
    )
  );
  assert.deepEqual(overflow, []);
  const panel = await page.locator(".chat-options-panel").boundingBox();
  const header = await page.locator(".chat-header").boundingBox();
  assert.ok(
    panel && header && panel.x >= header.x &&
      panel.x + panel.width <= header.x + header.width,
    "panel stays inside header width",
  );
  const search = await page.locator("#chat-search").boundingBox();
  const summary = await page.locator("#chat-options > summary").boundingBox();
  assert.ok(
    search && summary && search.width === 44 && search.height === 44 &&
      search.y === summary.y &&
      summary.y + summary.height <= header.y + header.height,
    "search and disclosure stay on one header row",
  );
  for (const id of ["pin-chat", "mute-chat", "hide-chat"]) {
    const box = await page.locator(`#${id}`).boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, id);
    assert.ok(box.x >= 0 && box.x + box.width <= 320, id);
  }
  h.step("header actions fit 320 px at 150% text");
  await context.close();
}

// Interleave a touch gesture with a chat-list reorder.
import { assert, CHAT, tapSocket } from "./harness.js";
import { withoutReadUpdates } from "./drafts-fixture.js";

export async function draftsTouch(h, account, alice) {
  const context = await h.context({
    locale: "en-US",
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 600 },
  });
  await context.addInitScript(({ origin, account, alice }) => {
    if (location.origin !== origin) return;
    globalThis.__touchClicks = [];
    globalThis.__touchDowns = [];
    globalThis.addEventListener("pointerdown", (event) => {
      const row = event.target.closest?.(".chat-row");
      if (row) {
        globalThis.__touchDowns.push({
          chat: row.dataset.chatId,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
        });
      }
    }, true);
    globalThis.addEventListener("click", (event) => {
      const row = event.target.closest?.(".chat-row");
      if (row) {
        globalThis.__touchClicks.push({ chat: row.dataset.chatId, event });
      }
    }, true);
    if (sessionStorage.getItem("draft-touch")) return;
    sessionStorage.setItem("draft-touch", "1");
    localStorage.setItem(
      "enil.web.drafts.v1",
      JSON.stringify({
        [account]: {
          [alice]: { text: "Alice draft", reply: null, pending: [] },
        },
      }),
    );
  }, { origin: h.base, account, alice });
  const state = await h.state();
  const familyChat = state.chats.find((chat) => chat.mid === CHAT);
  const workChat = state.chats.find((chat) => chat.mid === "cstub-work");
  assert.ok(familyChat && workChat);
  state.chats = [
    familyChat,
    workChat,
    ...state.chats.filter((chat) => chat !== familyChat && chat !== workChat),
  ];
  for (const chat of state.chats) chat.unread = 0;
  familyChat.unread = 1;
  familyChat.lastText = "Touch reorder fixture";
  workChat.unread = 1;
  // Only the explicit test update may change this fixture's ordering.
  state.chatsRevision = Number.MAX_SAFE_INTEGER - 1;
  const page = await context.newPage();
  const tap = await tapSocket(page, { client: withoutReadUpdates });
  await h.signIn(page);
  const family = page.getByRole("button", { name: /STUB 家庭群組/ });
  const input = page.getByLabel("Message", { exact: true });
  tap.socket.send(JSON.stringify({ web: "state", state }));
  await family.getByText(/Touch reorder fixture/).waitFor();
  await family.locator(".badge").waitFor();
  await page.getByRole("button", { name: /STUB Alice/ }).tap();
  assert.equal(await input.inputValue(), "Alice draft");
  await page.getByRole("button", { name: "Back", exact: true }).tap();
  const box = await family.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  const cdp = h.browserName === "chromium"
    ? await context.newCDPSession(page)
    : null;
  if (cdp) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
  } else {
    // Playwright's WebKit tap is atomic, so interleave synthetic events.
    await family.evaluate((row, { x, y }) => {
      row.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          isPrimary: true,
          pointerId: 71,
          pointerType: "touch",
          button: 0,
          buttons: 1,
          clientX: x,
          clientY: y,
        }),
      );
    }, point);
  }
  const pressed = await page.evaluate(() => globalThis.__touchDowns.at(-1));
  assert.equal(pressed.chat, CHAT);
  assert.equal(pressed.pointerType, "touch");
  state.chatsRevision++;
  familyChat.unread = 0;
  tap.socket.send(JSON.stringify({ web: "state", state }));
  await family.locator(".badge").waitFor({ state: "detached" });
  assert.notEqual((await family.boundingBox()).y, box.y);
  const hit = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest(".chat-row")?.dataset.chatId,
    point,
  );
  assert.equal(hit, "cstub-work");
  const count = await page.evaluate(() => globalThis.__touchClicks.length);
  if (cdp) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } else {
    await page.evaluate(({ x, y }) => {
      document.elementFromPoint(x, y).dispatchEvent(
        new PointerEvent("click", {
          bubbles: true,
          cancelable: true,
          pointerId: 71,
          pointerType: "touch",
          detail: 1,
          clientX: x,
          clientY: y,
        }),
      );
    }, point);
  }
  await page.waitForFunction((n) => globalThis.__touchClicks.length > n, count);
  const misdirected = await page.evaluate(() => {
    const { chat, event } = globalThis.__touchClicks.at(-1);
    return {
      chat,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      prevented: event.defaultPrevented,
    };
  });
  assert.equal(misdirected.chat, "cstub-work");
  assert.equal(misdirected.pointerId, pressed.pointerId);
  assert.equal(misdirected.pointerType, pressed.pointerType);
  assert.equal(misdirected.prevented, true);
  assert.equal(
    await page.locator("#workspace").evaluate((node) =>
      node.classList.contains("chat-open")
    ),
    false,
  );
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("enil.web.drafts.v1") || "{}")
  );
  assert.equal(stored[account][alice].text, "Alice draft");
  assert.equal(stored[account][CHAT], undefined);
  assert.equal(stored[account][misdirected.chat], undefined);
  await family.tap();
  await page.getByRole("heading", { name: "STUB 家庭群組", exact: true })
    .waitFor();
  assert.equal(await input.inputValue(), "");
  await context.close();
  h.step("touch-reorder-cannot-open-the-wrong-chat");
}

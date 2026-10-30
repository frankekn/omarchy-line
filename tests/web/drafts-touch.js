// Interleave a touch gesture with a chat-list reorder.
import { assert, CHAT, tapSocket } from "./harness.js";

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
    globalThis.addEventListener("click", (event) => {
      const row = event.target.closest?.(".chat-row");
      if (row) globalThis.__touchClicks.push(row.dataset.chatId);
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
  const page = await context.newPage();
  const tap = await tapSocket(page);
  await h.signIn(page);
  const family = page.getByRole("button", { name: /STUB 家庭群組/ });
  const input = page.getByLabel("Message", { exact: true });
  state.chatsRevision += 100;
  state.chats.find((chat) => chat.mid === CHAT).unread = 1;
  tap.socket.send(JSON.stringify({ web: "state", state }));
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
  state.chatsRevision += 100;
  state.chats.find((chat) => chat.mid === CHAT).unread = 0;
  tap.socket.send(JSON.stringify({ web: "state", state }));
  await family.locator(".badge").waitFor({ state: "detached" });
  assert.notEqual((await family.boundingBox()).y, box.y);
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
  const misdirected = await page.evaluate(() =>
    globalThis.__touchClicks.at(-1)
  );
  assert.ok(["cstub-work", "rstub-lunch"].includes(misdirected));
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
  assert.equal(stored[account][misdirected], undefined);
  await family.tap();
  await page.getByRole("heading", { name: "STUB 家庭群組", exact: true })
    .waitFor();
  assert.equal(await input.inputValue(), "");
  await context.close();
  h.step("touch-reorder-cannot-open-the-wrong-chat");
}

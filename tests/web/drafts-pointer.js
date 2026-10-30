// A delayed pointer click must not cross an account change.
import { assert, CHAT, tapSocket } from "./harness.js";

export async function draftPointer(h, account, alice) {
  const other = "u-draft-pointer-other";
  const context = await h.context({ locale: "en-US" });
  await context.addInitScript(({ origin, account, alice, other, chat }) => {
    if (location.origin !== origin) return;
    globalThis.__pointerClicks = [];
    globalThis.addEventListener("click", (event) => {
      const row = event.target.closest?.(".chat-row");
      if (row) globalThis.__pointerClicks.push(row.dataset.chatId);
    }, true);
    if (sessionStorage.getItem("draft-pointer")) return;
    sessionStorage.setItem("draft-pointer", "1");
    localStorage.setItem(
      "enil.web.drafts.v1",
      JSON.stringify({
        [account]: {
          [alice]: { text: "Alice draft", reply: null, pending: [] },
        },
        [other]: { [chat]: { text: "Other draft", reply: null, pending: [] } },
      }),
    );
  }, { origin: h.base, account, alice, other, chat: CHAT });
  const state = await h.state();
  const page = await context.newPage();
  let activeAccount = state.me;
  const tap = await tapSocket(page, {
    server(frame) {
      if (frame.web === "state") frame.state.me = activeAccount;
      return true;
    },
  });
  await h.signIn(page);
  const family = page.getByRole("button", { name: /STUB 家庭群組/ });
  const aliceRow = page.getByRole("button", { name: /STUB Alice/ });
  const input = page.getByLabel("Message", { exact: true });
  const active = (id) =>
    page.waitForFunction(
      (expected) =>
        document.querySelector(".chat-row.active")?.dataset.chatId === expected,
      id,
    );
  // Assistive technology can activate a row without any pointer event.
  await family.evaluate((row) => {
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await active(CHAT);
  await aliceRow.evaluate((row) => row.click());
  await active(alice);
  assert.equal(await input.inputValue(), "Alice draft");

  // An unrelated press cannot turn a later assistive click into a rejection.
  await family.evaluate((row) => {
    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        pointerId: 9201,
        pointerType: "touch",
        button: 0,
      }),
    );
    document.querySelector('[data-chat-id="cstub-work"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
  });
  await active("cstub-work");
  await family.evaluate((row, alice) => {
    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        pointerId: 9202,
        pointerType: "touch",
        button: 0,
      }),
    );
    document.querySelector(`[data-chat-id="${alice}"]`).click();
  }, alice);
  await active(alice);
  await family.evaluate((row) => {
    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        pointerId: 9203,
        pointerType: "touch",
        button: 0,
      }),
    );
    document.querySelector('[data-chat-id="cstub-work"]').dispatchEvent(
      new PointerEvent("click", {
        bubbles: true,
        pointerId: 9204,
        pointerType: "touch",
        detail: 1,
      }),
    );
  });
  await active("cstub-work");
  h.step("assistive-clicks-without-matching-pointer");
  await aliceRow.evaluate((row) => row.click());
  await page.waitForFunction(
    (id) => document.querySelector(".chat-row.active")?.dataset.chatId === id,
    alice,
  );
  assert.equal(await input.inputValue(), "Alice draft");
  const box = await family.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await family.evaluate((row, { x, y }) => {
    for (const type of ["pointerdown", "pointerup"]) {
      row.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          isPrimary: true,
          pointerType: "touch",
          pointerId: 9101,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerdown" ? 1 : 0,
        }),
      );
    }
  }, point);
  activeAccount = { mid: other, displayName: "Touch account" };
  tap.socket.send(
    JSON.stringify({ web: "state", state: { ...state, me: activeAccount } }),
  );
  await page.getByText("Touch account", { exact: true }).waitFor();
  await family.evaluate((row, { x, y }) => {
    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        pointerType: "touch",
        pointerId: 9102,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
      }),
    );
    row.dispatchEvent(
      new PointerEvent("click", {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        pointerId: 9101,
        clientX: x,
        clientY: y,
        detail: 1,
      }),
    );
    row.dispatchEvent(
      new PointerEvent("pointercancel", {
        bubbles: true,
        pointerType: "touch",
        pointerId: 9102,
      }),
    );
  }, point);
  // A click from a different pointer cannot be attributed to the new press.
  await active(CHAT);
  assert.equal(await input.inputValue(), "Other draft");
  activeAccount = state.me;
  tap.socket.send(
    JSON.stringify({ web: "state", state: { ...state, me: activeAccount } }),
  );
  await page.getByText(state.me.displayName, { exact: true }).waitFor();
  await page.getByRole("button", { name: /STUB Alice/ }).click();
  await page.waitForFunction(
    (id) => document.querySelector(".chat-row.active")?.dataset.chatId === id,
    alice,
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  activeAccount = { mid: other, displayName: "Other account" };
  tap.socket.send(
    JSON.stringify({ web: "state", state: { ...state, me: activeAccount } }),
  );
  await page.getByText("Other account", { exact: true }).waitFor();
  const count = await page.evaluate(() => globalThis.__pointerClicks.length);
  await page.mouse.up();
  await page.waitForFunction(
    (n) => globalThis.__pointerClicks.length > n,
    count,
  );
  assert.equal(await page.locator(".chat-row.active").count(), 0);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("enil.web.drafts.v1") || "{}")
  );
  assert.equal(saved[account][alice].text, "Alice draft");
  assert.equal(saved[other][CHAT].text, "Other draft");
  await family.press("Enter");
  await page.waitForFunction(
    (id) => document.querySelector(".chat-row.active")?.dataset.chatId === id,
    CHAT,
  );
  assert.equal(await input.inputValue(), "Other draft");
  await context.close();
  h.step("pointer-click-cannot-cross-accounts");
}

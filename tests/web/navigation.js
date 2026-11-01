// Unread tab title and favicon, the quick switcher, and next unread.
import { assert, CHAT, until } from "./harness.js";

export async function navigation(h) {
  const context = await h.context({ locale: "zh-TW" });
  await context.addInitScript(() => {
    const raf = globalThis.requestAnimationFrame;
    globalThis.__rafCount = 0;
    globalThis.requestAnimationFrame = (callback) => {
      globalThis.__rafCount++;
      return raf.call(globalThis, callback);
    };
  });
  const page = await context.newPage();
  await page.goto(h.base, { waitUntil: "domcontentloaded" });
  await until(
    async () => (await page.title()) === "enil · 需要登入",
    "signed-out title",
  );
  h.step("signed-out-title");
  await h.signIn(page);
  const icon = () =>
    page.evaluate(() =>
      document.querySelector('link[rel="icon"]').getAttribute("href")
    );
  // Fixture unread: family 3, work 1, lunch 2.
  await until(async () => (await page.title()) === "(6) enil", "title (6)");
  assert.match(await icon(), /^data:image\/svg\+xml,/);
  await h.request({ id: 1, cmd: "hide", chat: "rstub-lunch" });
  await until(async () => (await page.title()) === "(4) enil", "hidden");
  await h.request({ id: 2, cmd: "poke", chat: CHAT, text: "nav poke" });
  await until(async () => (await page.title()) === "(5) enil", "poke");
  h.step("unread-title-and-favicon");

  // The switcher: Ctrl+K from the search box, ranking, keys and ARIA.
  await page.getByLabel("搜尋聊天").focus();
  await page.keyboard.press("Control+k");
  const dialog = page.locator("#switcher");
  await dialog.waitFor();
  const input = page.getByRole("combobox", { name: "切換聊天室" });
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    true,
  );
  await input.fill("stub a");
  const names = () =>
    page.locator("#switcher-list [role=option] .switcher-name")
      .allTextContents();
  assert.equal((await names())[0], "STUB Alice");
  await input.fill("stub alice");
  assert.deepEqual(await names(), ["STUB Alice"]);
  await input.fill("sb家群");
  assert.deepEqual(await names(), ["STUB 家庭群組"]);
  await input.fill("午餐");
  const lunch = page.getByRole("option", { name: /STUB 午餐揪團.*已隱藏/ });
  await lunch.waitFor();
  await input.fill("stub");
  const status = await page.locator("#switcher-status").textContent();
  assert.equal(status, "5 個結果");
  const first = await names();
  // Unread chats lead their tier.
  assert.equal(first[0], "STUB 家庭群組");
  await page.keyboard.press("ArrowDown");
  const active = await input.getAttribute("aria-activedescendant");
  assert.equal(
    await page.locator(`#${active}`).getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "search",
  );
  await page.keyboard.press("Control+k");
  await input.fill("alice");
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await page.locator("#active-name", { hasText: "STUB Alice" }).waitFor();
  h.step("switcher-rank-keys-aria");

  // Keystroke cost with 121 chats.
  const cost = await page.evaluate(async () => {
    const { rankChats } = await import("/js/view-switcher.js");
    const chats = Array.from({ length: 121 }, (_, i) => ({
      mid: `c${i}`,
      name: `聊天室 ${i} Chat room number ${i}`,
      unread: i % 4,
      lastTime: i * 1000,
    }));
    const queries = ["c", "ch", "cha", "chat", "chat r", "聊", "crn1", "zz"];
    const start = performance.now();
    for (let n = 0; n < 50; n++) {
      for (const query of queries) rankChats(chats, query);
    }
    return (performance.now() - start) / (50 * queries.length);
  });
  console.log(`  rank 121 chats: ${cost.toFixed(3)} ms per keystroke`);
  assert.ok(cost < 2, `rank cost ${cost}ms`);
  h.step("switcher-cost");

  // IME composition does not open the switcher.
  await page.getByLabel("訊息", { exact: true }).focus();
  await page.evaluate(() => {
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(await dialog.isVisible(), false);
  h.step("ime-composing");

  // Next unread cycles through the list order and wraps.
  const next = page.getByRole("button", { name: "下一個未讀" });
  await next.click();
  await page.locator("#active-name", { hasText: "STUB 家庭群組" }).waitFor();
  await next.click();
  await page.locator("#active-name", { hasText: "STUB 工作 / Deploy" })
    .waitFor();
  await until(async () => (await page.title()) === "enil", "all read");
  assert.equal(await next.isHidden(), true);
  assert.match(await icon(), /^data:image\/png/);
  await h.request({ id: 3, cmd: "poke", chat: CHAT, text: "again" });
  await next.waitFor();
  await page.locator("#messages").focus();
  await page.keyboard.press("]");
  await page.locator("#active-name", { hasText: "STUB 家庭群組" }).waitFor();
  h.step("next-unread-cycle");

  // Idle: no animation frames.
  await page.locator("#messages").focus();
  await page.waitForTimeout(500);
  await page.evaluate(() => globalThis.__rafCount = 0);
  await page.waitForTimeout(10000);
  assert.equal(await page.evaluate(() => globalThis.__rafCount), 0);
  h.step("idle-no-raf");
}

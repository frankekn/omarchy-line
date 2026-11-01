// Full message search: the dialog, its keyboard and ARIA contract, chat
// scope, hidden chats, and opening a hit that needs older pages first.
import axe from "npm:axe-core@4.10.3";
import { assert, CHAT, tapSocket, until } from "./harness.js";

async function selectedText(page) {
  return await page.locator('#message-search-list [aria-selected="true"]')
    .textContent();
}

async function stubSearch(h) {
  const context = await h.context({
    locale: "zh-TW",
    viewport: { width: 1200, height: 800 },
  });
  const page = await context.newPage();
  const tap = await tapSocket(page);
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).waitFor();

  // Enter in the chat filter turns its text into a message search.
  const filter = page.getByLabel("搜尋聊天");
  await filter.fill("明天");
  await filter.press("Enter");
  const dialog = page.locator("#message-search");
  await dialog.waitFor();
  const input = page.getByRole("combobox", { name: "搜尋訊息" });
  assert.equal(await input.inputValue(), "明天");
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    true,
  );
  const options = page.locator("#message-search-list [role=option]");
  await until(async () => (await options.count()) === 2, "two hits");
  assert.equal(
    await page.locator("#message-search-status").textContent(),
    "2 筆結果",
  );
  assert.match(
    await page.locator("#message-search-scope").textContent(),
    /只搜尋這台 daemon 已快取的訊息。/,
  );
  // Newest first: the family mention (60 min ago), then Alice (600 min).
  assert.match(await options.nth(0).textContent(), /STUB 家庭群組/);
  assert.match(await options.nth(1).textContent(), /STUB Alice/);
  assert.deepEqual(
    await page.locator("#message-search-list mark").allTextContents(),
    ["明天", "明天"],
  );
  const searches = tap.sent.filter((frame) => frame.cmd === "search");
  assert.deepEqual(
    { q: searches[0].q, limit: searches[0].limit, chat: searches[0].chat },
    { q: "明天", limit: 30, chat: undefined },
  );
  h.step("enter-in-filter-searches");

  // Arrow keys move the active option; Enter on an unchanged query opens it.
  assert.match(await selectedText(page), /STUB 家庭群組/);
  await input.press("ArrowDown");
  assert.match(await selectedText(page), /STUB Alice/);
  assert.equal(
    await input.getAttribute("aria-activedescendant"),
    "message-search-option-1",
  );
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await until(
    async () =>
      (await page.locator("#active-name").textContent()) === "STUB Alice",
    "Alice opened",
  );
  const target = page.locator('article[data-message-id="ustub-alice-m1"]');
  await until(
    () => target.evaluate((row) => row.classList.contains("quote-target")),
    "hit highlighted",
  );
  // The open reads the chat exactly like a click on its row.
  const opened = tap.sent.find((frame) =>
    frame.cmd === "history" && frame.chat === "ustub-alice" && !frame.before
  );
  assert.equal(opened.markRead, true);
  h.step("keyboard-opens-hit-like-a-row-click");

  // In-chat search is scoped to the open chat and can widen to all chats.
  await page.getByRole("button", { name: "在此聊天室搜尋" }).click();
  await dialog.waitFor();
  assert.equal(await input.inputValue(), "");
  assert.equal(
    await page.locator("#message-search-chat-name").textContent(),
    "STUB Alice",
  );
  await input.fill("明天");
  await input.press("Enter");
  await until(async () => (await options.count()) === 1, "scoped hit");
  assert.equal(tap.sent.at(-1).chat, "ustub-alice");
  await page.getByRole("button", { name: "搜尋全部聊天室" }).click();
  await until(async () => (await options.count()) === 2, "widened");
  assert.equal(
    await page.locator("#message-search-chat").isVisible(),
    false,
  );
  h.step("chat-scope");

  // A query with no hits says so; recalled messages never match.
  await input.fill("zzz-no-such-text");
  await input.press("Enter");
  await page.getByText("沒有找到符合的訊息。").waitFor();
  await input.fill("收回");
  await input.press("Enter");
  await until(
    async () =>
      tap.sent.at(-1).q === "收回" &&
      (await page.locator("#message-search-status").textContent()) ===
        "0 筆結果",
    "recalled text finds nothing",
  );
  h.step("no-results");

  // Escape closes the dialog and gives focus back.
  await input.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "chat-search",
  );
  // A hidden chat leaves the default search but stays searchable by scope.
  await h.request({ id: 1, cmd: "hide", chat: "ustub-alice" });
  // The button carries the chat filter text over and searches at once. Enter
  // on that unchanged query would open the hit, so wait for the results.
  const before = tap.sent.length;
  await page.getByRole("button", { name: "搜尋訊息" }).click();
  assert.equal(await input.inputValue(), "明天");
  await until(
    async () =>
      (await page.locator("#message-search-status").textContent()) ===
        "1 筆結果",
    "hidden skipped",
  );
  const prefilled = tap.sent.slice(before).filter((frame) =>
    frame.cmd === "search"
  );
  assert.deepEqual(
    prefilled.map((frame) => ({ q: frame.q, chat: frame.chat })),
    [{ q: "明天", chat: undefined }],
  );
  assert.equal(await options.count(), 1);
  assert.match(await options.nth(0).textContent(), /STUB 家庭群組/);
  await input.press("Escape");
  await h.request({ id: 2, cmd: "unhide", chat: "ustub-alice" });
  h.step("hidden-chat-skipped");
  await context.close();
}

async function deepJump(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 1200, height: 800 },
    // Only to inject axe; the app's headers are unchanged.
    bypassCSP: true,
  });
  const page = await context.newPage();
  const now = Date.now() - 3_600_000;
  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: String(1000 + i),
    chat: CHAT,
    from: "u-search-peer",
    fromName: "Peer",
    time: now + i * 1000,
    text: i === 10 ? "the deep needle is here" : `filler ${i}`,
    contentType: "NONE",
  }));
  const tap = await tapSocket(page, {
    client(frame, connection) {
      const reply = (data) =>
        connection.socket.send(
          JSON.stringify({ id: frame.id, ok: true, data }),
        );
      if (frame.cmd === "search") {
        reply({
          results: [{
            chat: CHAT,
            id: "1010",
            time: rows[10].time,
            from: "u-search-peer",
            fromName: "Peer",
            snippet: "the deep needle is here",
            match: [9, 15],
          }],
          partial: false,
          more: false,
          scanned: 5,
        });
        return false;
      }
      if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
      const end = frame.before
        ? rows.findIndex((row) => row.id === frame.before)
        : rows.length;
      reply(rows.slice(Math.max(0, end - 50), end));
      return false;
    },
  });
  await h.signIn(page);
  await page.addScriptTag({ content: axe.source });
  await page.getByRole("button", { name: "Search messages" }).click();
  const input = page.getByRole("combobox", { name: "Search messages" });
  await input.fill("NEEDLE");
  await input.press("Enter");
  const option = page.locator("#message-search-list [role=option]").first();
  await option.waitFor();
  assert.equal(
    await page.locator("#message-search-list mark").textContent(),
    "needle",
  );
  assert.match(
    await page.locator("#message-search-scope").textContent(),
    /Searches only messages this daemon has cached\./,
  );
  const scan = await page.evaluate(async () =>
    (await globalThis.axe.run(document.getElementById("message-search"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    })).violations.map((rule) => rule.id)
  );
  assert.deepEqual(scan, []);
  h.step("english-dialog-and-axe");

  await option.click();
  const target = page.locator('article[data-message-id="1010"]');
  await target.waitFor({ timeout: 15000 });
  await until(
    () => target.evaluate((row) => row.classList.contains("quote-target")),
    "deep hit highlighted",
  );
  const older = tap.sent.filter((frame) =>
    frame.cmd === "history" && frame.chat === CHAT && frame.before
  );
  assert.deepEqual(older.map((frame) => frame.before), ["1100", "1050"]);
  await until(async () => {
    const box = await target.boundingBox();
    const list = await page.locator("#messages").boundingBox();
    return box && list && box.y >= list.y &&
      box.y + box.height <= list.y + list.height;
  }, "deep hit scrolled into view");
  h.step("jump-pages-back-to-old-hit");
  await context.close();
}

async function narrow(h) {
  // 320 px at 200% text: the header button and the dialog stay usable.
  const context = await h.context({
    locale: "zh-TW",
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.locator("article.message-row").first().waitFor();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const button = page.getByRole("button", { name: "在此聊天室搜尋" });
  await button.waitFor();
  const box = await button.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box));
  await button.click();
  const input = page.getByRole("combobox", { name: "搜尋訊息" });
  await input.fill("明天");
  await input.press("Enter");
  const option = page.locator("#message-search-list [role=option]").first();
  await option.waitFor();
  const dialog = await page.locator("#message-search").boundingBox();
  assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 320);
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
    true,
  );
  h.step("narrow-200-percent");
  await context.close();
}

export async function search(h) {
  await stubSearch(h);
  await deepJump(h);
  await narrow(h);
}

// Mentions, hidden chats, and the stub's LINE login flow.
import { assert, tapSocket } from "./harness.js";

export async function mentions(h) {
  const context = await h.context({ locale: "zh-TW", colorScheme: "dark" });
  const page = await context.newPage();
  const tap = await tapSocket(page);
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  const input = page.getByLabel("訊息", { exact: true });
  await input.fill("😀 @ST");
  const picker = page.locator("#mention-picker");
  await picker.getByRole("button", { name: "@STUB 媽" }).waitFor();
  const mentionBox = await page.locator("#mention-picker").boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  assert.ok(mentionBox && composerBox);
  assert.ok(
    Math.abs(mentionBox.x - composerBox.x) < 1,
    "mention picker aligns with the composer",
  );
  await picker.getByRole("button", { name: "@STUB 媽" }).click();
  await input.press("Home");
  await page.keyboard.insertText("hi ");
  await input.press("End");
  await page.keyboard.insertText("@Al");
  await picker.getByRole("button", { name: "@All" }).click();
  const expected = "hi 😀 @STUB 媽 @All ";
  assert.equal(await input.inputValue(), expected);
  await page.getByRole("button", { name: /STUB Alice/ }).click();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  assert.equal(await input.inputValue(), expected);
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll(".message-text")].some((node) =>
        node.textContent === text
      ),
    expected,
  );
  const request = tap.sent.find((m) => m.cmd === "send" && m.text === expected);
  assert.equal(request.mentions.length, 2);
  assert.equal(
    request.text.slice(request.mentions[0].start, request.mentions[0].end),
    "@STUB 媽",
  );
  assert.equal(request.mentions[0].start, 6);
  assert.equal(
    request.text.slice(request.mentions[1].start, request.mentions[1].end),
    "@All",
  );
  assert.equal(request.mentions[1].all, true);
  await page.locator("article.message-row").filter({
    hasText: "hi 😀 @STUB 媽 @All",
  })
    .locator(".mention").first().waitFor();
  h.step("mention-utf16-draft");
  // A person's mention opens the 1:1 chat with them; @All and the reader's own
  // mention stay plain text.
  const log = page.getByRole("log");
  const fixture = log.locator("article.message-row").filter({
    hasText: "明天聚餐",
  });
  assert.equal(await fixture.locator("button.mention").count(), 1);
  assert.equal(
    await fixture.locator("strong.mention").textContent(),
    "@All",
  );
  await fixture.getByRole("button", { name: "@STUB 媽" }).click();
  await page.getByRole("alert").getByText("還沒有和這個人的聊天室。")
    .waitFor();
  const text = "@STUB Alice @STUB User 看一下";
  await h.request({
    id: 90,
    cmd: "poke",
    chat: "cstub-family",
    text,
    mentions: [
      { start: 0, end: 11, mid: "ustub-alice", name: "STUB Alice" },
      { start: 12, end: 22, mid: "ustub-me-0000", name: "STUB User" },
    ],
  });
  const poked = log.locator("article.message-row").filter({ hasText: text });
  await poked.waitFor();
  assert.equal(await poked.locator("button.mention").count(), 1);
  assert.equal(
    await poked.locator("strong.mention").textContent(),
    "@STUB User",
  );
  await poked.getByRole("button", { name: "@STUB Alice" }).click();
  await page.locator("#active-name").getByText("STUB Alice", { exact: true })
    .waitFor();
  await log.getByText("明天的會議改十點").first().waitFor();
  // Inside Alice's own chat, her mention would reopen the same chat.
  const inAlice = "@STUB Alice 在嗎";
  await h.request({
    id: 91,
    cmd: "poke",
    chat: "ustub-alice",
    text: inAlice,
    mentions: [{ start: 0, end: 11, mid: "ustub-alice", name: "STUB Alice" }],
  });
  const own = log.locator("article.message-row").filter({ hasText: inAlice });
  await own.waitFor();
  assert.equal(await own.locator("button.mention").count(), 0);
  assert.equal(
    await own.locator("strong.mention").textContent(),
    "@STUB Alice",
  );
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  h.step("mention-opens-chat");
  await page.locator("#chat-options > summary").click();
  await page.getByRole("button", { name: "隱藏", exact: true }).click();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).waitFor({
    state: "hidden",
  });
  await page.getByLabel("搜尋聊天").fill("STUB 家庭");
  await page.getByRole("button", { name: /STUB 家庭群組.*已隱藏/ }).click();
  await page.locator("#chat-options > summary").click();
  await page.getByRole("button", { name: "取消隱藏", exact: true }).click();
  await page.getByLabel("搜尋聊天").fill("");
  await page.getByRole("button", { name: /STUB 家庭群組/ }).waitFor();
  h.step("hide-search-unhide");
  await page.getByRole("button", { name: "設定" }).click();
  await page.getByRole("button", { name: "登出 LINE" }).click();
  await page.getByRole("button", { name: "登入 LINE" }).click();
  await page.getByAltText("LINE login QR code").waitFor({ timeout: 10000 });
  await page.locator("#login-pin").waitFor({ timeout: 12000 });
  await page.locator("#workspace").waitFor({ timeout: 12000 });
  assert.equal(
    await page.getByRole("button", { name: /STUB 家庭群組/ }).count(),
    0,
  );
  h.step("line-logout-qr-pin-login");
}

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
  await page.getByRole("button", { name: "@STUB 媽" }).click();
  await input.press("Home");
  await page.keyboard.insertText("hi ");
  await input.press("End");
  await page.keyboard.insertText("@Al");
  await page.getByRole("button", { name: "@All" }).click();
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
  await page.getByRole("button", { name: "隱藏", exact: true }).click();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).waitFor({
    state: "hidden",
  });
  await page.getByLabel("搜尋聊天").fill("STUB 家庭");
  await page.getByRole("button", { name: /STUB 家庭群組.*已隱藏/ }).click();
  await page.getByRole("button", { name: "取消隱藏", exact: true }).click();
  await page.getByLabel("搜尋聊天").fill("");
  await page.getByRole("button", { name: /STUB 家庭群組/ }).waitFor();
  h.step("hide-search-unhide");
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

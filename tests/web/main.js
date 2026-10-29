// Core desktop and mobile conversation flows.
import { assert, CHAT, tapSocket, until } from "./harness.js";
import { Buffer } from "node:buffer";

export async function main(h) {
  let blocked = "";
  const desktop = await h.context({
    viewport: { width: 1400, height: 900 },
    locale: "zh-TW",
    colorScheme: "dark",
    acceptDownloads: true,
  });
  const page = await desktop.newPage();
  const tap = await tapSocket(page, {
    client: (frame) => !blocked || frame.text !== blocked,
  });
  await h.signIn(page);
  assert.equal(await page.evaluate(() => globalThis.isSecureContext), false);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  const log = page.getByRole("log");
  const input = page.getByLabel("訊息", { exact: true });
  await log.getByText("晚上回來吃飯嗎？").waitFor();
  await input.fill("桌面測試文字 http://example.com/path");
  await input.press("Enter");
  const sentRow = page.locator("article.message-row").filter({
    hasText: "桌面測試文字",
  });
  await sentRow.getByRole("link", { name: "http://example.com/path" })
    .waitFor();
  await sentRow.getByRole("button", { name: "收回" }).waitFor();
  const sent = tap.sent.find((frame) =>
    frame.cmd === "send" &&
    frame.text?.startsWith("桌面測試文字")
  );
  assert.match(sent.requestId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  h.step("login-history-send-link");

  await h.request({ id: 1, cmd: "poke", chat: CHAT, text: "即時測試：新訊息" });
  await log.getByText("即時測試：新訊息", { exact: true }).waitFor();
  await h.request({
    id: 2,
    cmd: "poke",
    chat: CHAT,
    text: "<img src=x onerror=alert(1)>",
  });
  await log.getByText("<img src=x onerror=alert(1)>", { exact: true })
    .waitFor();
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.equal(h.dialogs.filter((dialog) => dialog.type === "alert").length, 0);
  h.step("incoming-text-xss");
  const incoming = page.locator("article.message-row").filter({
    hasText: "即時測試：新訊息",
  });
  await incoming.getByRole("button", { name: "表情" }).click();
  await incoming.getByRole("button", { name: "LOVE" }).click();
  await incoming.getByRole("button", { name: /❤️ 1/ }).waitFor();
  await incoming.getByRole("button", { name: "回覆" }).click();
  await input.fill("測試回覆");
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await page.locator("article.message-row").filter({ hasText: "測試回覆" })
    .locator(".quote").waitFor();
  h.step("reaction-reply");
  await page.getByRole("button", { name: "貼圖", exact: true }).click();
  await page.locator("#sticker-content .sticker-cell").first().click();
  const sticker = page.locator(".message-row.own .sticker-image").first();
  await sticker.waitFor();
  assert.match(
    await sticker.getAttribute("src"),
    /^https:\/\/stickershop\.line-scdn\.net\//,
  );
  await sticker.evaluate((image) => image.decode());
  assert.ok(tap.sent.some((frame) => frame.cmd === "sendSticker"));
  h.step("sticker");
  await page.locator("#file-input").setInputFiles({
    name: "ui-test.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      await Deno.readFile(`${h.stateDir}/media/stub-shot1.png`),
    ),
  });
  await page.locator("article.message-row").filter({ hasText: "ui-test.png" })
    .getByRole("button", { name: "收回" }).waitFor();
  assert.ok(tap.sent.some((frame) => frame.cmd === "sendFile"));
  h.step("file-upload");
  await sentRow.getByRole("button", { name: "收回" }).click();
  await page.getByText("已收回訊息").last().waitFor();
  assert.ok(
    h.dialogs.some((d) => d.type === "confirm" && d.message.includes("收回")),
  );
  h.step("unsend-confirmation");

  await input.fill("切換後保留的草稿");
  await page.getByRole("button", { name: /STUB 工作/ }).click();
  await page.getByText("STUB deploy #4821 succeeded").first().waitFor();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  assert.equal(await input.inputValue(), "切換後保留的草稿");
  await page.reload();
  await page.locator("#connection.connected").waitFor();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  assert.equal(await input.inputValue(), "切換後保留的草稿");
  await input.fill("");
  h.step("draft-switch-reload");

  blocked = "尚未確認送達的測試";
  await input.fill(blocked);
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await log.getByText(blocked, { exact: true }).waitFor();
  const beforeReconnect = tap.sent.length;
  await tap.socket.close({ code: 4001, reason: "test disconnect" });
  await page.getByText("尚未確認送達", { exact: true }).waitFor();
  await page.locator("#connection.connected").waitFor({ timeout: 10000 });
  await until(
    () =>
      tap.sent.slice(beforeReconnect).some((frame) =>
        frame.cmd === "history" && frame.chat === CHAT
      ),
    "history after reconnect",
  );
  assert.equal(tap.sent.filter((frame) => frame.text === blocked).length, 1);
  await page.reload();
  await page.locator("#connection.connected").waitFor();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await log.getByText("晚上回來吃飯嗎？").waitFor();
  const ambiguous = page.locator("article.message-row").filter({
    hasText: blocked,
  });
  await ambiguous.getByRole("button", { name: "重送" }).waitFor();
  assert.equal(tap.sent.filter((frame) => frame.text === blocked).length, 1);
  blocked = "";
  await ambiguous.getByRole("button", { name: "重送" }).click();
  await ambiguous.getByRole("button", { name: "收回" }).waitFor();
  assert.ok(
    h.dialogs.some((d) => d.type === "confirm" && d.message.includes("重送")),
  );
  h.step("disconnect-manual-retry");
  await desktop.close();

  const mobile = await h.context({
    viewport: { width: 390, height: 844 },
    locale: "zh-TW",
    colorScheme: "light",
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  const phoneTap = await tapSocket(phone);
  await h.signIn(phone);
  await phone.getByRole("button", { name: /STUB 工作/ }).click();
  await phone.getByText("STUB deploy #4821 succeeded").first().waitFor();
  assert.equal(await phone.locator("#sidebar").isVisible(), false);
  await phone.getByRole("button", { name: "返回" }).click();
  assert.equal(await phone.locator("#sidebar").isVisible(), true);
  h.step("mobile-navigation");
  await phone.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await phone.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  await phone.getByRole("button", { name: "返回" }).click();
  const start = phoneTap.sent.length;
  await h.request({ id: 3, cmd: "poke", chat: CHAT, text: "未開啟時的訊息" });
  await phone.locator("#chat-list").getByText("未開啟時的訊息").waitFor();
  await phoneTap.socket.close({ code: 4001, reason: "test disconnect" });
  await phone.getByText("連線中斷，準備重連", { exact: true }).waitFor();
  await phone.locator("#connection.connected").waitFor({ timeout: 10000 });
  await until(
    () =>
      phoneTap.sent.slice(start).some((frame) =>
        frame.cmd === "history" && frame.chat === CHAT &&
        frame.markRead === false
      ),
    "background history after reconnect",
  );
  const afterBack = phoneTap.sent.slice(start);
  assert.equal(afterBack.some((frame) => frame.cmd === "markRead"), false);
  assert.ok(afterBack.some((frame) =>
    frame.cmd === "history" &&
    frame.chat === CHAT && frame.markRead === false
  ));
  h.step("mobile-background-unread");
}

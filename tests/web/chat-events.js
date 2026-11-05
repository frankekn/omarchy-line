import { assert, CHAT, tapSocket } from "./harness.js";

export async function chatEvents(h) {
  for (const locale of ["en-US", "zh-TW"]) {
    const english = locale === "en-US";
    const context = await h.context({
      locale,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const histories = new Set();
    const event = {
      id: "event-announcement",
      chat: CHAT,
      from: "ustub-mom",
      fromName: "Sender",
      text: "Jordan設定了公告",
      contentType: "CHATEVENT",
      chatEvent: { kind: "announcement", actor: "Jordan" },
      time: Date.now(),
    };
    await tapSocket(page, {
      client(frame) {
        if (frame.cmd === "history" && frame.chat === CHAT && !frame.before) {
          histories.add(frame.id);
        }
        return true;
      },
      server(frame) {
        if (histories.delete(frame.id) && Array.isArray(frame.data)) {
          frame.data = [
            event,
            { ...event, id: "event-unknown", chatEvent: undefined, text: "" },
            {
              ...event,
              id: "event-member",
              chatEvent: { kind: "announcement", actor: "" },
            },
            {
              ...event,
              id: "post-album",
              contentType: "POSTNOTIFICATION",
              chatEvent: undefined,
              text: "新增了 12 個項目到相簿「旅行$&」",
              postEvent: { kind: "album", album: "旅行$&", count: 12 },
            },
            {
              ...event,
              id: "post-album-one",
              contentType: "POSTNOTIFICATION",
              chatEvent: undefined,
              text: "新增了 1 個項目到相簿「家」",
              postEvent: { kind: "album", album: "家", count: 1 },
            },
            {
              ...event,
              id: "post-note",
              contentType: "POSTNOTIFICATION",
              chatEvent: undefined,
              text: "發佈了記事本貼文",
              postEvent: { kind: "note", text: "" },
            },
            { ...event, id: "event-unsent", unsent: true },
            { ...event, id: "event-encrypted", decryptFailed: true },
          ];
        }
        return true;
      },
    });
    await h.signIn(page);
    await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
    const row = page.locator('[data-message-id="event-announcement"]');
    await row.waitFor();
    assert.equal(
      await row.locator(".message-text").innerText(),
      english ? "Jordan set an announcement" : "Jordan設定了公告",
    );
    assert.equal(await row.locator(".sender, button").count(), 0);
    const unknown = page.locator('[data-message-id="event-unknown"]');
    assert.equal(
      await unknown.locator(".message-text").innerText(),
      english ? "Unsupported chat event" : "尚未支援的聊天室事件",
    );
    const member = page.locator('[data-message-id="event-member"]');
    assert.equal(
      await member.locator(".message-text").innerText(),
      english ? "A member set an announcement" : "成員設定了公告",
    );
    assert.equal(
      await page.locator('[data-message-id="post-album"] .message-text')
        .innerText(),
      english
        ? "Added 12 items to the album “旅行$&”"
        : "新增了 12 個項目到相簿「旅行$&」",
    );
    assert.equal(
      await page.locator('[data-message-id="post-album-one"] .message-text')
        .innerText(),
      english
        ? "Added 1 item to the album “家”"
        : "新增了 1 個項目到相簿「家」",
    );
    assert.equal(
      await page.locator('[data-message-id="post-note"] .message-text')
        .innerText(),
      english ? "Posted a note" : "發佈了記事本貼文",
    );
    for (const id of ["event-unsent", "event-encrypted"]) {
      const masked = page.locator(`[data-message-id="${id}"]`);
      assert.equal(
        await masked.locator(".message-text").innerText().then((s) =>
          /Jordan|announcement|公告/.test(s)
        ),
        false,
      );
      assert.equal(
        await masked.evaluate((node) =>
          node.classList.contains("event-notice")
        ),
        false,
      );
    }
    const style = await row.locator(".bubble").evaluate((node) => {
      const s = getComputedStyle(node);
      return { background: s.backgroundColor, fontStyle: s.fontStyle };
    });
    assert.equal(style.background, "rgba(0, 0, 0, 0)");
    assert.equal(style.fontStyle, "normal");
    assert((await row.boundingBox()).height < 50);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.evaluate(() => document.documentElement.style.fontSize = "21px");
    assert(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
    );
    const bounds = await row.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 320);
    assert.equal(await row.locator("time").count(), 1);
    h.step(`chat-events-${locale}-meaning-mask-and-compact-layout`);
  }
}

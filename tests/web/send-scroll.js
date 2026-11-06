import { Buffer } from "node:buffer";
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function sendScroll(h) {
  for (let i = 0; i < 40; i++) {
    await h.request({
      id: i,
      cmd: "poke",
      chat: CHAT,
      text: `Scroll row ${i}`,
    });
  }
  const image = Buffer.from(
    await Deno.readFile(
      new URL("../../docs/images/demo/sticker.png", import.meta.url),
    ),
  );
  for (
    const { outcome, scrollAway } of [
      { outcome: "load", scrollAway: false },
      { outcome: "load", scrollAway: true },
      { outcome: "error", scrollAway: false },
      { outcome: "error", scrollAway: true },
    ]
  ) {
    const context = await h.context({
      locale: "en-US",
      viewport: { width: 390, height: 640 },
    });
    const page = await context.newPage();
    const url = "https://stickershop.line-scdn.net/late-scroll.png";
    let release;
    const held = new Promise((resolve) => release = resolve);
    let requested = false;
    await page.route(url, async (route) => {
      requested = true;
      await held;
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: outcome === "load" ? image : Buffer.from("invalid image"),
      });
    });
    await tapSocket(page, {
      client(frame, connection) {
        if (frame.cmd === "stickers") {
          connection.socket.send(JSON.stringify({
            id: frame.id,
            ok: true,
            data: {
              packages: [{
                id: "1",
                name: "Delayed",
                version: 1,
                stickers: [{ id: "4", url }],
              }],
            },
          }));
          return false;
        }
        if (frame.cmd === "sendSticker") {
          connection.socket.send(JSON.stringify({ id: frame.id, ok: true }));
          return false;
        }
        return true;
      },
    });
    try {
      await h.signIn(page);
      await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
      await page.getByText("Scroll row 39", { exact: true }).waitFor();
      await page.locator("#stickers").click();
      const sticker = page.locator("#sticker-content .sticker-cell").first();
      await sticker.waitFor();
      await until(() => requested, "delayed sticker request");
      await sticker.click();
      const sentImage = page.locator(".message-row.own .sticker-image").last();
      await sentImage.waitFor({ state: "attached" });
      if (outcome === "error") {
        // A broken image can change the fallback's layout after the event.
        await sentImage.evaluate((img) => {
          img.addEventListener("error", () => img.style.height = "120px", {
            once: true,
          });
        });
      }
      await page.waitForFunction(() => {
        const list = document.getElementById("messages");
        return list.scrollHeight - list.scrollTop - list.clientHeight <= 2;
      });
      await page.evaluate(() =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
      );
      if (scrollAway) {
        await page.locator("#messages").evaluate((list) => {
          list.dispatchEvent(
            new WheelEvent("wheel", { deltaY: -10, bubbles: true }),
          );
          list.scrollTop -= 200;
          list.dispatchEvent(new Event("scroll"));
        });
        // Allow offscreen row sizing to settle before the held image loads.
        await page.evaluate(() =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(resolve))
            )
          )
        );
      }
      const before = await page.locator("#messages").evaluate((list) => ({
        top: list.scrollTop,
        height: list.scrollHeight,
        gap: list.scrollHeight - list.scrollTop - list.clientHeight,
      }));
      if (scrollAway) {
        assert.ok(before.gap > 50, "reader moved away from the bottom");
      }
      release();
      if (outcome === "load") await sentImage.evaluate((img) => img.decode());
      else {
        await sentImage.evaluate((img) =>
          new Promise((resolve) => {
            if (img.complete && img.naturalWidth === 0) resolve();
            else img.addEventListener("error", () => resolve(), { once: true });
          })
        );
      }
      await page.evaluate(() =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
      );
      const after = await page.locator("#messages").evaluate((list) => ({
        top: list.scrollTop,
        height: list.scrollHeight,
        gap: list.scrollHeight - list.scrollTop - list.clientHeight,
      }));
      assert.ok(
        after.height - before.height > 40,
        `late ${outcome} grows the list (${
          scrollAway ? "scrolled away" : "following"
        }): ` +
          `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      );
      if (scrollAway) {
        assert.ok(
          after.gap >= before.gap - 2,
          `reader who scrolled away keeps their place: ${
            JSON.stringify(before)
          } -> ${JSON.stringify(after)}`,
        );
      } else {
        assert.ok(
          after.gap <= 2,
          `delayed sticker ${outcome} leaves ${after.gap}px below`,
        );
      }
    } finally {
      release();
      await context.close();
    }
  }
  h.step(
    "late sticker load or error follows only while the reader stays at the bottom",
  );

  // Android resizes the window for the keyboard. The shorter list must keep
  // the newest message in view, but not pull back a reader who scrolled up.
  for (const scrollAway of [false, true]) {
    const context = await h.context({
      locale: "en-US",
      viewport: { width: 412, height: 860 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await h.signIn(page);
      await page.locator("#chat-list").getByText("Scroll row 39").first()
        .click();
      await page.getByRole("log").getByText("Scroll row 39").waitFor();
      const gap = () =>
        page.locator("#messages").evaluate((list) =>
          Math.round(list.scrollHeight - list.scrollTop - list.clientHeight)
        );
      // Opening the chat can run a short programmatic scroll that pauses
      // following. Start only once the list has stayed at the bottom.
      let last = Infinity;
      await until(async () => {
        const now = await gap();
        const settled = now <= 2 && last <= 2;
        last = now;
        if (!settled) await page.waitForTimeout(250);
        return settled;
      }, "settled at bottom");
      if (scrollAway) {
        await page.locator("#messages").evaluate((list) => {
          list.dispatchEvent(
            new WheelEvent("wheel", { deltaY: -10, bubbles: true }),
          );
          list.scrollTop -= 200;
          list.dispatchEvent(new Event("scroll"));
        });
      }
      const before = await gap();
      await page.getByLabel("Message", { exact: true }).focus();
      await page.setViewportSize({ width: 412, height: 500 });
      if (scrollAway) {
        await page.waitForTimeout(300);
        assert.ok(
          await gap() >= before,
          `keyboard pulled a scrolled-up reader down: ${before} -> ${await gap()}`,
        );
      } else {
        await until(
          async () => await gap() <= 2,
          "newest message above keyboard",
        );
      }
    } finally {
      await context.close();
    }
  }
  h.step("keyboard keeps the newest message in view only while following");
}

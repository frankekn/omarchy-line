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
  for (const scrollAway of [false, true]) {
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
        body: image,
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
      await sentImage.evaluate((img) => img.decode());
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
        `decoded sticker grows the list (${
          scrollAway ? "scrolled away" : "following"
        }): ` +
          `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      );
      if (scrollAway) {
        assert.ok(
          Math.abs(after.top - before.top) <= 2,
          "reading position stays put",
        );
      } else {
        assert.ok(
          after.gap <= 2,
          `delayed sticker leaves ${after.gap}px below`,
        );
      }
    } finally {
      release();
      await context.close();
    }
  }
  h.step("late sticker load follows only while the reader stays at the bottom");
}

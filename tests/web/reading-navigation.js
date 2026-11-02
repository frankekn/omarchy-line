// Reading older messages must not lose the route back to live following.
import { assert } from "./harness.js";

export async function readingNavigation(h, exposeFollowContext) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await exposeFollowContext(context);
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-06-15T12:00:00Z"));
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.waitForFunction(() => !globalThis.__followModel.loading);
  await page.evaluate(() => {
    const model = globalThis.__followModel, ctx = globalThis.__followCtx;
    globalThis.__readingMessage = (index) => ({
      id: String(900000 + index),
      chat: model.active,
      from: "u-reading",
      fromName: "Reader",
      contentType: "NONE",
      text: `Reading ${index}`,
      time: Date.now() + (index - 60) * 60000,
    });
    model.messages = [
      { ...globalThis.__readingMessage(-1), time: Date.now() - 86400000 },
      ...Array.from(
        { length: 61 },
        (_, index) => globalThis.__readingMessage(index),
      ),
    ];
    model.noOlder = true;
    model.unreadMarkId = "";
    ctx.renderMessages("bottom");
  });
  const jump = page.getByRole("button", {
    name: "Jump to latest",
    exact: true,
  });
  assert.equal(await jump.isVisible(), false);
  assert.equal(
    await page.locator(".day-divider").filter({ hasText: "Today" }).count(),
    1,
  );
  assert.equal(
    await page.locator(".day-divider").filter({ hasText: "Yesterday" }).count(),
    1,
  );
  await page.locator("#messages").evaluate((list) => {
    list.scrollTop -= 500;
  });
  await jump.waitFor();
  const receive = (index) =>
    page.evaluate((index) => {
      const model = globalThis.__followModel, ctx = globalThis.__followCtx;
      ctx.onFrame({
        boot: model.boot,
        event: {
          seq: model.seq + 1,
          kind: "message",
          chat: model.active,
          message: globalThis.__readingMessage(index),
        },
      });
    }, index);
  await receive(61);
  assert.equal(await jump.isVisible(), true);
  const bounds = await jump.boundingBox();
  assert.ok(bounds.width >= 44 && bounds.height >= 44);
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await jump.press("Enter");
  await page.waitForFunction(() => {
    const list = document.getElementById("messages");
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 2;
  });
  assert.equal(await jump.isVisible(), false);
  assert.equal(
    await page.locator("#messages").evaluate((node) =>
      node === document.activeElement
    ),
    true,
  );
  await receive(62);
  await page.waitForFunction(() => {
    const list = document.getElementById("messages");
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 2;
  });
  await page.clock.setFixedTime(new Date("2026-06-16T12:00:00Z"));
  await page.evaluate(() => globalThis.__followCtx.renderMessages("preserve"));
  assert.equal(
    await page.locator(".day-divider").filter({ hasText: "Today" }).count(),
    0,
  );
  assert.equal(
    await page.locator(".day-divider").filter({ hasText: "Yesterday" }).count(),
    1,
  );
  h.step(
    "history keeps its position and can return to live following; day captions update across midnight",
  );

  await page.evaluate(() => {
    const model = globalThis.__followModel, ctx = globalThis.__followCtx;
    model.messages = Array.from(
      { length: 200 },
      (_, i) => globalThis.__readingMessage(i),
    );
    model.messages[150].text = "Long quote ".repeat(40);
    model.messages[199].text = "Long tail ".repeat(40);
    model.noOlder = true;
    ctx.renderMessages("preserve");
    const list = document.getElementById("messages");
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    list.scrollTop = 0;
  });
  const settle = () =>
    page.evaluate(() =>
      new Promise((resolve) => {
        let frames = 3;
        function tick() {
          if (--frames) requestAnimationFrame(tick);
          else resolve();
        }
        requestAnimationFrame(tick);
      })
    );
  await settle();
  const measure = () =>
    page.evaluate(() => ({
      height: document.querySelector('[data-message-id="900199"]')
        .getBoundingClientRect().height,
      scrollHeight: document.getElementById("messages").scrollHeight,
    }));
  const before = await measure();
  assert.ok(before.height > 150);
  await receive(200);
  await settle();
  const after = await measure();
  assert.ok(
    Math.abs(after.height - before.height) <= 1,
    JSON.stringify({ before, after }),
  );
  assert.ok(after.scrollHeight >= before.scrollHeight);
  await jump.click();
  await settle();
  await receive(201);
  await settle();
  assert.ok(
    await page.locator("#messages").evaluate((list) =>
      list.scrollHeight - list.scrollTop - list.clientHeight <= 2
    ),
  );
  h.step(
    "a former tail keeps its measured height and live following remains stable",
  );

  const quote = page.locator('[data-message-id="900150"]');
  await page.evaluate(() => globalThis.__followCtx.scrollToMessage("900150"));
  await settle();
  const quoteHeight = await quote.evaluate((node) =>
    node.getBoundingClientRect().height
  );
  await jump.click();
  await settle();
  assert.equal(
    await quote.evaluate((node) => node.classList.contains("quote-target")),
    true,
  );
  await page.waitForFunction(() =>
    !document.querySelector('[data-message-id="900150"]').classList.contains(
      "quote-target",
    )
  );
  const releasedHeight = await quote.evaluate((node) =>
    node.getBoundingClientRect().height
  );
  assert.ok(
    Math.abs(quoteHeight - releasedHeight) <= 1,
    JSON.stringify({ quoteHeight, releasedHeight }),
  );
  h.step("an offscreen quote retains its height when its highlight expires");
  await context.close();
}

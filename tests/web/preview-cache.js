// Preview eviction must preserve visible media and allow it to reload later.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function previewCache(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  // Expose the already retained model in this isolated page only.
  const source = await Deno.readTextFile(
    new URL("../../daemon/web/public/js/app.js", import.meta.url),
  );
  const marker = "model = createModel();";
  assert.ok(source.includes(marker));
  await page.route("**/js/app.js", async (route) => {
    await route.fulfill({
      contentType: "text/javascript",
      body: source.replace(
        marker,
        "model = globalThis.__previewModel = createModel();",
      ),
    });
  });
  const requests = [], histories = [];
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.cmd === "history" && frame.chat === CHAT) {
        histories.push(frame);
        return false;
      }
      if (frame.cmd === "preview") {
        requests.push(frame);
        return false;
      }
      return true;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await until(() => histories.length === 1, "held preview history");
  const path = `${h.stateDir}/media/stub-shot1.png`;
  await page.evaluate((imagePath) => {
    const cache = globalThis.__previewModel.previews;
    cache.set("visible-preview", imagePath);
    cache.set("old-preview", imagePath);
    for (let i = 0; i < 1998; i++) cache.set(`cached-${i}`, imagePath);
  }, path);
  const now = Date.now();
  const message = (id, time, image = false) => ({
    id,
    chat: CHAT,
    from: "u-preview-peer",
    fromName: "Peer",
    time,
    text: image ? "" : id,
    contentType: image ? "IMAGE" : "NONE",
    hasMedia: image,
    previewable: image,
  });
  const rows = [
    message("old-preview", now - 60000, true),
    ...Array.from(
      { length: 30 },
      (_, i) => message(`spacer-${i}`, now - 50000 + i),
    ),
    message("visible-preview", now - 2000, true),
    message("new-preview", now - 1000, true),
  ];
  tap.socket.send(
    JSON.stringify({ id: histories[0].id, ok: true, data: rows }),
  );
  const visible = page.locator(
    'article[data-message-id="visible-preview"] img.media-image',
  );
  await visible.waitFor();
  await visible.scrollIntoViewIfNeeded();
  const original = await visible.elementHandle();
  await until(
    () => requests.some((request) => request.messageId === "new-preview"),
    "new preview request",
  );
  const newRequest = requests.find((request) =>
    request.messageId === "new-preview"
  );
  tap.socket.send(
    JSON.stringify({ id: newRequest.id, ok: true, data: { path } }),
  );
  await page.locator('article[data-message-id="new-preview"] img.media-image')
    .waitFor();
  let result = await page.evaluate(() => ({
    size: globalThis.__previewModel.previews.size,
    visible: globalThis.__previewModel.previews.has("visible-preview"),
    old: globalThis.__previewModel.previews.has("old-preview"),
  }));
  assert.deepEqual(result, { size: 2000, visible: true, old: false });
  assert.equal(await original.evaluate((node) => node.isConnected), true);
  assert.equal(
    await visible.evaluate((node, old) => node === old, original),
    true,
  );

  await page.evaluate(() => {
    const row = document.querySelector(
      'article[data-message-id="old-preview"]',
    );
    row.scrollIntoView({ block: "center" });
  });
  await until(
    () => requests.some((request) => request.messageId === "old-preview"),
    "evicted preview requested again",
  );
  const oldRequest = requests.find((request) =>
    request.messageId === "old-preview"
  );
  tap.socket.send(
    JSON.stringify({ id: oldRequest.id, ok: true, data: { path } }),
  );
  await page.locator('article[data-message-id="old-preview"] img.media-image')
    .waitFor();
  result = await page.evaluate(() => ({
    size: globalThis.__previewModel.previews.size,
    old: globalThis.__previewModel.previews.has("old-preview"),
  }));
  assert.deepEqual(result, { size: 2000, old: true });
  await context.close();
  h.step("preview-cache-eviction-and-reload");
}

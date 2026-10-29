// History pagination, media viewing, paste and drop.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function media(h) {
  for (let i = 0; i < 65; i++) {
    await h.request({
      id: i,
      cmd: "poke",
      chat: CHAT,
      text: `History fixture ${i}`,
    });
  }
  const context = await h.context({
    locale: "en-US",
    colorScheme: "dark",
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const tap = await tapSocket(page);
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  const log = page.getByRole("log");
  await log.getByText("History fixture 64", { exact: true }).waitFor();
  assert.ok(
    tap.sent.some((m) =>
      m.cmd === "history" && m.count === 50 && m.markRead === true
    ),
  );
  await log.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await log.getByText("History fixture 0", { exact: true }).waitFor();
  assert.ok(tap.sent.some((m) => m.cmd === "history" && m.before));
  h.step("history-pagination");
  const state = await h.state();
  const all = await h.request({
    id: 990,
    cmd: "history",
    chat: CHAT,
    count: 200,
  });
  const picture = all.find((message) => message.id === "cstub-family-m3");
  const seq = Math.max(...state.events.map((event) => event.seq)) + 1;
  tap.socket.send(JSON.stringify({
    event: {
      seq,
      at: Date.now(),
      kind: "edit",
      chat: CHAT,
      message: { ...picture, previewable: true },
    },
    boot: state.bootId,
  }));
  const imageRow = page.locator('article[data-message-id="cstub-family-m3"]');
  await imageRow.waitFor({ state: "attached" });
  await imageRow.scrollIntoViewIfNeeded();
  await imageRow.locator("img.media-image").waitFor();
  await until(
    () =>
      tap.sent.some((m) => m.cmd === "preview" && m.messageId === picture.id),
    "lazy preview request",
  );
  await imageRow.locator("img.media-image").click();
  await page.locator("#lightbox[open]").waitFor();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download original" }).click();
  assert.ok(await downloaded);
  await page.locator("#lightbox-close").click();
  h.step("lazy-preview-lightbox-download");

  const bytes = Array.from(
    await Deno.readFile(`${h.stateDir}/media/stub-shot1.png`),
  );
  await page.getByLabel("Message", { exact: true }).evaluate((node, data) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File([new Uint8Array(data)], "paste-test.png", { type: "image/png" }),
    );
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, bytes);
  await page.locator("article.message-row").filter({
    hasText: "paste-test.png",
  }).waitFor();
  await page.locator("#conversation").evaluate((node, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(data)], "drop-test.png", { type: "image/png" }),
    );
    node.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, bytes);
  await page.locator("article.message-row").filter({ hasText: "drop-test.png" })
    .waitFor();
  await until(
    () => tap.sent.filter((m) => m.cmd === "sendFile").length >= 2,
    "paste and drop sends",
  );
  assert.ok(tap.sent.filter((m) => m.cmd === "sendFile").length >= 2);
  h.step("paste-drop-upload");
}

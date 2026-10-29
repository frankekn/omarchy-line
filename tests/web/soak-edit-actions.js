// Reproduce the reaction-picker regression after an incoming edit. This probe
// is separate from CI and fails until the product behavior is fixed.
// CHROMIUM=/usr/bin/chromium ENIL_WEB_TEST_PORT=18460 \
//   deno run --frozen -A tests/web/soak-edit-actions.js
import { assert, CHAT, runSuite, tapSocket } from "./harness.js";

await runSuite("soak-edit-actions", async (h) => {
  assert.equal(h.browserName, "chromium");
  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const tap = await tapSocket(page);
  await h.signIn(page);
  const state = await h.state();
  const history = await h.request({
    id: 1,
    cmd: "history",
    chat: CHAT,
    count: 50,
    markRead: false,
  });
  const original = history.find((message) =>
    message.text === "晚上回來吃飯嗎？"
  );
  assert.ok(original);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  const row = page.locator(`article[data-message-id="${original.id}"]`);
  await row.waitFor();
  const react = () => row.getByRole("button", { name: "React", exact: true });
  await react().click();
  const before = await row.locator(".reaction-picker").count();
  const beforeVisible = await row.locator(".reaction-picker").isVisible();
  await react().click();
  let seq = Math.max(0, ...state.events.map((event) => event.seq));
  async function snapshot(label) {
    await cdp.send("HeapProfiler.collectGarbage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const elements = await page.evaluate(() =>
      document.querySelectorAll("*").length
    );
    console.log(JSON.stringify({ label, dom, heap, elements }));
  }
  await snapshot(0);
  let afterFirst;
  for (let i = 0; i < 300; i++) {
    const message = { ...original, text: `Edited soak ${i}` };
    tap.socket.send(JSON.stringify({
      event: { seq: ++seq, at: Date.now(), kind: "edit", chat: CHAT, message },
      boot: state.bootId,
    }));
    if (i === 0 || (i + 1) % 100 === 0) {
      await row.getByText(message.text, { exact: true }).waitFor();
      await snapshot(i + 1);
    }
    if (i === 0) {
      await react().click();
      afterFirst = await row.locator(".reaction-picker").count();
      await react().click();
    }
  }
  await react().click();
  const afterRepeated = await row.locator(".reaction-picker").count();
  const afterVisible = await row.locator(".reaction-picker").isVisible();
  console.log(JSON.stringify({
    before,
    beforeVisible,
    afterFirst,
    afterRepeated,
    afterVisible,
  }));
  assert.equal(before, 1, "reaction picker before edit");
  assert.equal(beforeVisible, true, "reaction picker is visible before edit");
  assert.equal(afterFirst, 1, "reaction picker after edit");
  assert.equal(afterRepeated, 1, "reaction picker after repeated edits");
  await cdp.detach();
});

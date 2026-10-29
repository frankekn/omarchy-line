// Measure a page that stays at the bottom while receiving 20,000 messages.
// Run with the same isolated browser, stub and port setup as the other suites.
import { assert, CHAT, runSuite } from "./harness.js";

const appUrl = new URL("../../daemon/web/public/js/app.js", import.meta.url);
let app = await Deno.readTextFile(appUrl);
for (
  const [old, replacement] of [
    [
      "  model = createModel();",
      "  model = createModel();\nglobalThis.__growthModel = model;",
    ],
    ["ctx = finish();", "ctx = finish();\nglobalThis.__growthCtx = ctx;"],
  ]
) {
  assert.equal(app.split(old).length, 2, `instrumentation target: ${old}`);
  app = app.replace(old, replacement);
}

await runSuite("window-growth", async (h) => {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.route(
    "**/js/app.js",
    (route) => route.fulfill({ contentType: "text/javascript", body: app }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const cdp = await context.newCDPSession(page);
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  await page.waitForFunction(() => !globalThis.__growthModel.loading);
  await page.evaluate((chat) => {
    const model = globalThis.__growthModel;
    const now = Date.now();
    model.messages = Array.from({ length: 50 }, (_, i) => ({
      id: String(1_000_000 + i),
      chat,
      from: model.account,
      fromName: "Me",
      time: now - (50 - i) * 1000,
      text: `Initial ${i}`,
      contentType: "NONE",
    }));
    model.noOlder = true;
    model.unreadMarkId = "";
    model.loading = false;
    model.loadingOlder = false;
    model.historyEvents = [];
    globalThis.__growthTime = now;
    globalThis.__growthCtx.renderMessages("bottom");
  }, CHAT);

  async function snapshot(received, samples) {
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
    await cdp.send("HeapProfiler.collectGarbage");
    const [heap, dom, state] = await Promise.all([
      cdp.send("Runtime.getHeapUsage"),
      cdp.send("Memory.getDOMCounters"),
      page.evaluate(() => {
        const list = document.getElementById("messages");
        return {
          modelRows: globalThis.__growthModel.messages.length,
          renderedRows: list.querySelectorAll(".message-row").length,
          bottomDistance: list.scrollHeight - list.clientHeight -
            list.scrollTop,
        };
      }),
    ]);
    assert.ok(
      state.bottomDistance <= 2,
      `not following: ${state.bottomDistance}`,
    );
    const sorted = samples.slice().sort((a, b) => a - b);
    const middle = sorted.length / 2;
    const medianMs = sorted.length
      ? (sorted[Math.floor((sorted.length - 1) / 2)] +
        sorted[Math.floor(middle)]) / 2
      : null;
    console.log(
      "GROWTH_RESULT " +
        JSON.stringify({ received, state, dom, heap, medianMs }),
    );
  }

  await snapshot(0, []);
  const checkpoints = new Set([500, 5000, 10000, 15000, 20000]);
  let recent = [];
  for (let count = 0; count < 20000; count += 50) {
    const result = await page.evaluate(({ count, chat }) => {
      const model = globalThis.__growthModel;
      const samples = [];
      for (let i = count; i < count + 50; i++) {
        const message = {
          id: String(2_000_000 + i),
          chat,
          from: model.account,
          fromName: "Me",
          time: globalThis.__growthTime + i + 1,
          text: `Live ${i} 測試訊息`,
          contentType: "NONE",
        };
        const start = performance.now();
        globalThis.__growthCtx.onFrame({
          event: { seq: model.seq + 1, kind: "message", chat, message },
          boot: model.boot,
        });
        samples.push(performance.now() - start);
      }
      const latest = String(2_000_000 + count + 49);
      return {
        samples,
        latestInModel: model.messages.some((message) => message.id === latest),
        latestRendered: !!document.querySelector(
          `article[data-message-id="${latest}"]`,
        ),
      };
    }, { count, chat: CHAT });
    assert.equal(result.latestInModel, true);
    assert.equal(result.latestRendered, true);
    recent = result.samples.slice(-20);
    const received = count + 50;
    if (checkpoints.has(received)) await snapshot(received, recent);
  }
  h.step("20,000 messages");
});

// Measure message-list prototypes against the real page and isolated stub.
// Usage: deno run --frozen -A tests/web/window-measure.js <variant> <cpu> <dir>
import { assert, CHAT, runSuite, tapSocket } from "./harness.js";

const [variant = "baseline", cpu = "1", prototypeDir = ""] = Deno.args;
const variants = new Set([
  "baseline",
  "delegate-only",
  "content-only",
  "delegated",
  "cap",
  "virtual",
  "hybrid",
]);
if (!variants.has(variant) || !["1", "4"].includes(cpu)) {
  throw new Error(
    "Expected a known variant and CPU 1/4",
  );
}
if (!prototypeDir && variant !== "baseline") {
  throw new Error("A prototype directory is required for this variant");
}
const publicDir = new URL("../../daemon/web/public/", import.meta.url);
const appSource = await Deno.readTextFile(new URL("js/app.js", publicDir));
function replaceOnce(source, old, next) {
  assert.equal(source.split(old).length, 2, `instrumentation target: ${old}`);
  return source.replace(old, next);
}
const app = replaceOnce(
  replaceOnce(
    appSource,
    "  model = createModel();",
    "  model = createModel();\nglobalThis.__windowModel = model;",
  ),
  "ctx = finish();",
  "ctx = finish();\nglobalThis.__windowCtx = ctx;",
);

await runSuite(`window-${variant}-${cpu}`, async (h) => {
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
  if (prototypeDir) {
    for (
      const [url, file, type] of [
        ["**/js/view-messages.js", "view-messages.js", "text/javascript"],
        ["**/js/controller-state.js", "controller-state.js", "text/javascript"],
        ["**/app.css", "app.css", "text/css"],
      ]
    ) {
      const body = await Deno.readTextFile(
        `${prototypeDir}/${variant}/${file}`,
      );
      await context.route(
        url,
        (route) => route.fulfill({ contentType: type, body }),
      );
    }
  }
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(cpu) });
  await tapSocket(page, {
    client(frame, tap) {
      if (frame.cmd !== "markRead") return true;
      tap.socket.send(
        JSON.stringify({ id: frame.id, ok: true, data: { marked: false } }),
      );
      return false;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  await page.waitForFunction(() => !globalThis.__windowModel.loading);

  // Check the prototype's delegated buttons before collecting any numbers.
  let delegatedActions = null;
  if (["delegated", "delegate-only"].includes(variant)) {
    delegatedActions = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".message-row")].find((item) =>
        item.querySelectorAll(".message-actions button").length >= 2
      );
      const [reply, react] = row.querySelectorAll(".message-actions button");
      reply.click();
      const replied = !!globalThis.__windowModel.reply;
      globalThis.__windowCtx.cancelReply();
      react.click();
      const opened = !!row.querySelector(".reaction-picker");
      react.click();
      return {
        replied,
        opened,
        closed: !row.querySelector(".reaction-picker"),
      };
    });
    assert.deepEqual(delegatedActions, {
      replied: true,
      opened: true,
      closed: true,
    });
  }

  async function install(count) {
    return await page.evaluate(({ count, variant, stateDir, chat }) => {
      const model = globalThis.__windowModel, context = globalThis.__windowCtx;
      const start = Date.now() - count * 60_000;
      const rows = Array.from({ length: count }, (_, i) => {
        const own = i % 10 < 3, image = i % 200 === 199;
        return {
          id: String(9_000_000 + i),
          chat,
          from: own ? model.account : "ustub-peer",
          fromName: own ? "Me" : "STUB Peer",
          time: start + i * 60_000,
          text: image ? "" : `Message ${i} 測試訊息 ` +
            (i === 100 ? "HISTORY-NEEDLE-0100 " : "") +
            (i % 5 === 0 ? `https://example.test/${i}` : "hello"),
          contentType: image ? "IMAGE" : "NONE",
          hasMedia: image,
          unsent: false,
          decryptFailed: false,
          mediaState: "ok",
          ...(image
            ? {
              previewable: true,
              mediaPath: `${stateDir}/media/stub-shot1.png`,
            }
            : {}),
          ...(i % 20 === 1
            ? {
              replyTo: {
                id: String(9_000_000 + Math.max(0, i - 1)),
                fromName: "Peer",
                text: "quoted",
              },
            }
            : {}),
          ...(i % 25 === 2
            ? { reactions: [{ type: "NICE", count: 1, mine: false }] }
            : {}),
        };
      });
      model.messages = ["cap", "hybrid"].includes(variant)
        ? rows.slice(-500)
        : rows;
      model.loading = false;
      model.loadingOlder = false;
      model.noOlder = true;
      model.historyEvents = [];
      model.unreadMarkId = "";
      globalThis.__windowStart = undefined;
      const startRender = performance.now();
      context.renderMessages("bottom");
      return {
        renderMs: performance.now() - startRender,
        modelRows: model.messages.length,
      };
    }, { count, variant, stateDir: h.stateDir, chat: CHAT });
  }
  async function settled() {
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
    await cdp.send("HeapProfiler.collectGarbage");
  }
  async function snapshot() {
    await settled();
    const [heap, dom, rowInfo] = await Promise.all([
      cdp.send("Runtime.getHeapUsage"),
      cdp.send("Memory.getDOMCounters"),
      page.evaluate(() => {
        const rows = [...document.querySelectorAll(".message-row")];
        const sample = Array.from(
          { length: Math.min(100, rows.length) },
          (_, i) => {
            const row = rows[(i * 97) % rows.length];
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_ALL);
            let nodes = 1;
            while (walker.nextNode()) nodes++;
            return { nodes, elements: row.querySelectorAll("*").length + 1 };
          },
        );
        return {
          renderedRows: rows.length,
          modelRows: globalThis.__windowModel.messages.length,
          documentElements: document.querySelectorAll("*").length,
          averageRowNodes: sample.reduce((n, row) => n + row.nodes, 0) /
            sample.length,
          averageRowElements: sample.reduce((n, row) => n + row.elements, 0) /
            sample.length,
          role: document.getElementById("messages").getAttribute("role"),
        };
      }),
    ]);
    return { heap, dom, ...rowInfo };
  }
  const smallInstall = await install(50);
  const small = await snapshot();
  const bigInstall = await install(10000);
  const large = await snapshot();

  // The CDP listener count includes all descendants of each sampled row.
  const listeners = [];
  for (let i = 0; i < Math.min(20, large.renderedRows); i++) {
    const index = (i * 97) % large.renderedRows;
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('.message-row')[${index}]`,
      objectGroup: "window-listeners",
    });
    const result = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: evaluated.result.objectId,
      depth: -1,
    });
    listeners.push(result.listeners.length);
  }
  await cdp.send("Runtime.releaseObjectGroup", {
    objectGroup: "window-listeners",
  });

  const identity = await page.evaluate(() => {
    const text = document.querySelector(
      'article[data-message-id="9009998"] .message-text',
    );
    const image = document.querySelector(
      'article[data-message-id="9009999"] img.media-image',
    );
    if (!text || !image) return { available: false };
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    globalThis.__windowSelectionNode = text;
    globalThis.__windowMediaNode = image;
    return { available: true, text: getSelection().toString() };
  });
  assert.equal(identity.available, true);
  const samples = [];
  for (let i = 0; i < 12; i++) {
    samples.push(
      await page.evaluate(async ({ i, chat }) => {
        const model = globalThis.__windowModel;
        const message = {
          id: String(9_100_000 + i),
          chat,
          from: "ustub-peer",
          fromName: "STUB Peer",
          time: Date.now() + i * 1000,
          text: `live ${i} 新訊息`,
          contentType: "NONE",
          hasMedia: false,
          unsent: false,
          decryptFailed: false,
          mediaState: "ok",
        };
        const payload = JSON.stringify({
          event: {
            seq: model.seq + 1,
            at: Date.now(),
            kind: "message",
            chat,
            message,
          },
          boot: model.boot,
        });
        const start = performance.now();
        globalThis.__windowCtx.onFrame(JSON.parse(payload));
        const handlerMs = performance.now() - start;
        const frameMs = await new Promise((resolve) =>
          requestAnimationFrame(() => resolve(performance.now() - start))
        );
        return { handlerMs, frameMs };
      }, { i, chat: CHAT }),
    );
  }
  // A fast no-op must never count as a successful message measurement.
  const delivery = await page.evaluate(() => {
    const modelIds = new Set(
      globalThis.__windowModel.messages.map((message) => String(message.id)),
    );
    const renderedIds = new Set(
      [...document.querySelectorAll(".message-row")].map((row) =>
        row.dataset.messageId
      ),
    );
    const expected = Array.from(
      { length: 12 },
      (_, i) => String(9_100_000 + i),
    );
    return {
      model: expected.filter((id) => modelIds.has(id)).length,
      rendered: expected.filter((id) => renderedIds.has(id)).length,
    };
  });
  assert.deepEqual(delivery, { model: 12, rendered: 12 });
  const afterIdentity = await page.evaluate(() => ({
    selection: getSelection().toString(),
    selectionNode: globalThis.__windowSelectionNode.isConnected,
    mediaNode: globalThis.__windowMediaNode.isSameNode(
      document.querySelector(
        'article[data-message-id="9009999"] img.media-image',
      ),
    ),
  }));
  assert.equal(afterIdentity.selection, identity.text);
  assert.equal(afterIdentity.selectionNode, true);
  assert.equal(afterIdentity.mediaNode, true);
  const after = await snapshot();
  const findInPage = await page.evaluate(() =>
    globalThis.find(
      "HISTORY-NEEDLE-0100",
      false,
      false,
      true,
      false,
      false,
      false,
    )
  );
  let manualWindow = null;
  if (["virtual", "hybrid"].includes(variant)) {
    manualWindow = await page.evaluate(() => {
      const model = globalThis.__windowModel;
      globalThis.__windowStart = Math.floor(model.messages.length / 2);
      const expected = String(model.messages[globalThis.__windowStart].id);
      globalThis.__windowCtx.renderMessages("preserve");
      return {
        expected,
        rendered: !!document.querySelector(
          `article[data-message-id="${expected}"]`,
        ),
        rows: document.querySelectorAll(".message-row").length,
      };
    });
    assert.equal(manualWindow.rendered, true);
    assert.ok(manualWindow.rows <= 120);
  }
  console.log(
    "WINDOW_RESULT " + JSON.stringify({
      variant,
      cpu: Number(cpu),
      corpus: 10000,
      cap: ["cap", "hybrid"].includes(variant) ? 500 : null,
      renderedLimit: ["virtual", "hybrid"].includes(variant) ? 120 : null,
      delegatedActions,
      smallInstall,
      bigInstall,
      small,
      large,
      after,
      listeners,
      samples,
      delivery,
      selectionSurvived: afterIdentity.selectionNode,
      mediaIdentity: afterIdentity.mediaNode,
      findInPage,
      manualWindow,
    }),
  );
  h.step("window-measurement");
});

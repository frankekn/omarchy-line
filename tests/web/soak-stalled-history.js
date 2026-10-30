// Probe event retention while a history request is stalled. The fixture keeps
// the socket open, injects incoming messages, and then releases the reply.
// CHROMIUM=/usr/bin/chromium ENIL_WEB_TEST_PORT=18460 \
//   deno run --frozen -A tests/web/soak-stalled-history.js
import { assert, CHAT, runSuite, tapSocket, until } from "./harness.js";

await runSuite("soak-stalled-history", async (h) => {
  assert.equal(h.browserName, "chromium");
  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Debugger.enable");
  const source = await Deno.readTextFile(
    new URL("../../daemon/web/public/js/app.js", import.meta.url),
  );
  const lineNumber = source.split("\n").findIndex((line) =>
    line.startsWith("const { assembling, provide, finish } = makeRegistry();")
  );
  assert.ok(lineNumber >= 0);
  await cdp.send("Debugger.setBreakpointByUrl", {
    url: `${h.base}/js/app.js`,
    lineNumber,
  });
  let captured;
  const capture = new Promise((resolve, reject) =>
    captured = { resolve, reject }
  );
  cdp.on("Debugger.paused", (event) => {
    void (async () => {
      try {
        const result = await cdp.send("Debugger.evaluateOnCallFrame", {
          callFrameId: event.callFrames[0].callFrameId,
          expression: "globalThis.__soakModel = model; true",
          returnByValue: true,
        });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result));
        captured.resolve(result.result.value);
      } catch (error) {
        captured.reject(error);
      } finally {
        await cdp.send("Debugger.resume");
      }
    })();
  });
  let held;
  const tap = await tapSocket(page, {
    client(frame, channel) {
      if (frame.cmd === "history" && !held) {
        held = frame;
        return false;
      }
      if (frame.cmd === "markRead") {
        channel.socket.send(JSON.stringify({ id: frame.id, ok: true }));
        return false;
      }
      return true;
    },
  });
  await h.signIn(page);
  assert.equal(await capture, true);
  await cdp.send("Debugger.disable");
  const state = await h.state();
  const history = await h.request({
    id: 1,
    cmd: "history",
    chat: CHAT,
    count: 50,
    markRead: false,
  });
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await until(() => held, "held history request");
  await page.waitForFunction(() => globalThis.__soakModel.loading);
  let seq = await page.evaluate(() => globalThis.__soakModel.seq);
  async function snapshot(events) {
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const model = await page.evaluate(() => ({
      loading: globalThis.__soakModel.loading,
      historyEvents: globalThis.__soakModel.historyEvents.length,
      messages: globalThis.__soakModel.messages.length,
      requests: globalThis.__soakModel.requests.size,
    }));
    console.log(JSON.stringify({ events, heap, dom, model }));
    return model;
  }
  assert.equal((await snapshot(0)).historyEvents, 0);
  for (let i = 0; i < 1000; i++) {
    const message = {
      id: `stalled-${i}`,
      chat: CHAT,
      from: "u-soak-peer",
      fromName: "Peer",
      time: Date.now() + i,
      contentType: "NONE",
      text: `Message while history is stalled ${i}`,
    };
    tap.socket.send(JSON.stringify({
      event: {
        seq: ++seq,
        at: Date.now(),
        kind: "message",
        chat: CHAT,
        message,
      },
      boot: state.bootId,
    }));
    if ((i + 1) % 250 === 0) {
      await page.waitForFunction(
        (value) => globalThis.__soakModel.seq >= value,
        seq,
      );
      const model = await snapshot(i + 1);
      assert.equal(model.historyEvents, i + 1);
      assert.equal(model.messages, 0);
      assert.equal(model.requests, 1);
    }
  }
  tap.socket.send(JSON.stringify({ id: held.id, ok: true, data: history }));
  await page.waitForFunction(
    (expected) => {
      const model = globalThis.__soakModel;
      return !model.loading && model.historyEvents.length === 0 &&
        model.messages.length === expected && model.requests.size === 0;
    },
    history.length + 1000,
    { timeout: 120000 },
  );
  const released = await snapshot("released");
  assert.equal(released.historyEvents, 0);
  assert.equal(released.messages, history.length + 1000);
  assert.equal(
    await page.locator("#messages .message-row").count(),
    released.messages,
  );
  await cdp.detach();
});

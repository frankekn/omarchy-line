// Local, isolated Chromium soak; this is not part of the CI suite.
// CHROMIUM=/usr/bin/chromium ENIL_WEB_TEST_PORT=18460 \
//   deno run --frozen -A tests/web/soak.js --scale 0.1 --output /tmp/soak.jsonl
import { assert, runSuite, until } from "./harness.js";

const args = Deno.args.slice();
let scale = 1, output = "";
while (args.length) {
  const option = args.shift();
  if (option === "--scale") scale = Number(args.shift());
  else if (option === "--output") output = args.shift() || "";
  else throw new Error(`Unknown argument: ${option}`);
}
if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
  throw new Error("--scale must be greater than 0 and at most 1");
}
if (output) await Deno.writeTextFile(output, "");
const count = (n) => Math.max(1, Math.round(n * scale));
const targets = {
  received: count(20000),
  switches: count(1000),
  older: count(200),
  reconnect: count(100),
  lightbox: count(200),
  sends: count(550),
  edits: count(300),
  reactions: count(300),
  unsends: count(300),
  accounts: count(20),
  stubEvents: count(250),
};
async function emit(value) {
  const line = JSON.stringify(value);
  console.log(line);
  if (output) await Deno.writeTextFile(output, line + "\n", { append: true });
}

await runSuite("soak", async (h) => {
  assert.equal(h.browserName, "chromium", "soak metrics require Chromium CDP");
  const context = await h.context({
    locale: "en-US",
    viewport: {
      width: 1280,
      height: 900,
    },
  });
  // Weak references do not keep the observers or their targets alive.
  await context.addInitScript(() => {
    const records = {};
    for (const name of ["IntersectionObserver", "ResizeObserver"]) {
      const Original = globalThis[name];
      if (!Original) continue;
      const refs = [];
      globalThis[name] = class extends Original {
        constructor(...args) {
          super(...args);
          refs.push(new WeakRef(this));
        }
      };
      records[name] = { refs, created: () => refs.length };
    }
    const timers = { timeout: new Set(), interval: new Set() };
    const nativeTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const nativeInterval = globalThis.setInterval;
    const nativeClearInterval = globalThis.clearInterval;
    globalThis.setTimeout = (fn, delay, ...args) => {
      const id = nativeTimeout(() => {
        timers.timeout.delete(id);
        if (typeof fn === "function") fn(...args);
        else globalThis.eval(String(fn));
      }, delay);
      timers.timeout.add(id);
      return id;
    };
    globalThis.clearTimeout = (id) => {
      timers.timeout.delete(id);
      timers.interval.delete(id);
      nativeClearTimeout(id);
    };
    globalThis.setInterval = (fn, delay, ...args) => {
      const id = nativeInterval(fn, delay, ...args);
      timers.interval.add(id);
      return id;
    };
    globalThis.clearInterval = (id) => {
      timers.timeout.delete(id);
      timers.interval.delete(id);
      nativeClearInterval(id);
    };
    globalThis.__soakInstrumentation = () => ({
      observers: Object.fromEntries(
        Object.entries(records).map(([name, data]) => [
          name,
          {
            created: data.created(),
            live: data.refs.filter((r) => r.deref()).length,
          },
        ]),
      ),
      timers: { timeout: timers.timeout.size, interval: timers.interval.size },
    });
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Debugger.enable");
  const appSource = await Deno.readTextFile(
    new URL("../../daemon/web/public/js/app.js", import.meta.url),
  );
  const breakpoint = appSource.split("\n").findIndex((line) =>
    line.startsWith("const { assembling, provide, finish } = makeRegistry();")
  );
  assert.ok(breakpoint >= 0, "model capture breakpoint exists");
  await cdp.send("Debugger.setBreakpointByUrl", {
    url: `${h.base}/js/app.js`,
    lineNumber: breakpoint,
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

  const chatIds = Array.from(
    { length: 50 },
    (_, i) => `csoak${String(i).padStart(2, "0")}`,
  );
  const chats = chatIds.map((mid, i) => ({
    mid,
    name: `Soak chat ${i}`,
    unread: 0,
    lastText: "",
    lastTime: 0,
    lastFrom: "",
  }));
  const now = Date.now();
  const historyRow = (chat, i) => ({
    id: `h-${chat}-${i}`,
    chat,
    from: "u-soak-peer",
    fromName: "Peer",
    time: now - (60000 - i) * 1000,
    contentType: "NONE",
    text: `History ${i}`,
    ...(i === 49999
      ? {
        contentType: "IMAGE",
        text: "",
        hasMedia: true,
        previewable: true,
      }
      : {}),
  });
  let socket, state, boot, account, seq = 0, revision = 1, connections = 0;
  const ring = [], attempts = new Map();
  const counts = {
    received: 0,
    activeReceived: 0,
    switches: 0,
    older: 0,
    reconnect: 0,
    lightbox: 0,
    sends: 0,
    failures: 0,
    retries: 0,
    edits: 0,
    reactions: 0,
    unsends: 0,
    accounts: 0,
    previews: 0,
    fixtureEvents: 0,
    stubEvents: 0,
  };
  const stateFrame = () => ({
    web: "state",
    state: {
      ...state,
      me: { mid: account, displayName: account },
      events: ring.slice(),
      chatsRevision: revision,
      chats,
      chatList: { complete: true, loaded: chatIds.length },
    },
  });
  const sendFrame = (frame) => socket.send(JSON.stringify(frame));
  function event(kind, chat, extra) {
    const item = { seq: ++seq, at: Date.now(), kind, chat, ...extra };
    ring.push(item);
    if (ring.length > 200) ring.shift();
    counts.fixtureEvents++;
    sendFrame({ event: item, boot });
    return item;
  }
  await page.routeWebSocket("**/api/ws", (ws) => {
    socket = ws;
    connections++;
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.cmd === "history") {
        const end = frame.before
          ? Number(String(frame.before).split("-").at(-1))
          : 50000;
        if (!Number.isFinite(end)) {
          throw new Error(`Bad history cursor: ${frame.before}`);
        }
        if (frame.before) counts.older++;
        const data = Array.from(
          { length: 50 },
          (_, i) => historyRow(frame.chat, end - 50 + i),
        );
        ws.send(JSON.stringify({ id: frame.id, ok: true, data }));
      } else if (frame.cmd === "members") {
        ws.send(JSON.stringify({
          id: frame.id,
          ok: true,
          data: [
            { mid: "u-soak-peer", name: "Peer" },
            { mid: account, name: account },
          ],
        }));
      } else if (frame.cmd === "preview") {
        counts.previews++;
        ws.send(
          JSON.stringify({
            id: frame.id,
            ok: true,
            data: { path: `${h.stateDir}/media/stub-shot1.png` },
          }),
        );
      } else if (frame.cmd === "markRead") {
        ws.send(JSON.stringify({ id: frame.id, ok: true }));
      } else if (frame.cmd === "send") {
        const seen = attempts.get(frame.text) || 0;
        attempts.set(frame.text, seen + 1);
        const fail = Number(frame.text.split(" ").at(-1)) % 10 === 0 &&
          seen === 0;
        if (fail) counts.failures++;
        else {
          counts.sends++;
          if (seen) counts.retries++;
        }
        ws.send(
          JSON.stringify({
            id: frame.id,
            ok: !fail,
            ...(fail ? { error: "soak refusal" } : {}),
          }),
        );
      } else server.send(raw);
    });
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.web === "state") {
        state = frame.state;
        boot ||= state.bootId;
        account ||= state.me.mid;
        ws.send(JSON.stringify(stateFrame()));
      } else if (frame.web !== "events" && !frame.event && !frame.chat) {
        ws.send(raw);
      }
    });
  });
  await h.signIn(page);
  assert.equal(await capture, true);
  await cdp.send("Debugger.disable");
  assert.equal(await page.locator("#chat-list .chat-row").count(), 50);
  await until(() => state && socket, "fixture socket");

  async function settle() {
    await page.waitForFunction(
      () => {
        const m = globalThis.__soakModel;
        return m.connected && !m.loading && !m.loadingOlder &&
          !m.requests.size &&
          !m.previewPending.size;
      },
      null,
      { timeout: 120000 },
    );
  }
  async function openChat(chat) {
    await page.locator(`.chat-row[data-chat-id="${chat}"]`).evaluate((node) =>
      node.click()
    );
    await page.waitForFunction(
      (id) => {
        const m = globalThis.__soakModel;
        return m.active === id && !m.loading && m.messages.length >= 50;
      },
      chat,
      { timeout: 120000 },
    );
    await settle();
  }
  async function waitSeq(n) {
    await page.waitForFunction(
      (value) => globalThis.__soakModel.seq >= value,
      n,
      { timeout: 120000 },
    );
  }
  async function snapshot(stage, progress) {
    await settle();
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const roots = {};
    for (
      const expression of [
        "document",
        "window",
        "visualViewport",
        "document.getElementById('lightbox-stage')",
      ]
    ) {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        objectGroup: "soak-roots",
      });
      if (result.result.objectId) {
        const listeners = await cdp.send("DOMDebugger.getEventListeners", {
          objectId: result.result.objectId,
          depth: 1,
        });
        roots[expression] = listeners.listeners.length;
      }
    }
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "soak-roots" });
    const pageMetrics = await page.evaluate(() => {
      const m = globalThis.__soakModel;
      const collections = {};
      for (const [key, value] of Object.entries(m)) {
        if (Array.isArray(value)) collections[key] = value.length;
        else if (value instanceof Map || value instanceof Set) {
          collections[key] = value.size;
        }
      }
      const draftAccounts = Object.values(m.drafts);
      const drafts = draftAccounts.flatMap((chats) => Object.values(chats));
      collections.draftAccounts = draftAccounts.length;
      collections.draftChats = drafts.length;
      collections.emptyDrafts = drafts.filter((d) =>
        !d.text && !d.reply && !d.pending?.length
      ).length;
      collections.pendingDrafts = drafts.reduce(
        (sum, d) => sum + (d.pending?.length || 0),
        0,
      );
      collections.stateEvents = Array.isArray(m.state?.events)
        ? m.state.events.length
        : 0;
      let storageBytes = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        storageBytes += 2 *
          (key.length + (localStorage.getItem(key) || "").length);
      }
      return {
        collections,
        storageBytes,
        storageKeys: localStorage.length,
        elements: document.querySelectorAll("*").length,
        messageRows: document.querySelectorAll("#messages .message-row").length,
        instrumentation: globalThis.__soakInstrumentation(),
      };
    });
    const stubEvents = (await h.state()).events?.length || 0;
    await emit({
      type: "snapshot",
      stage,
      progress,
      heap,
      dom,
      roots,
      ...pageMetrics,
      counts: { ...counts },
      fixtureRing: ring.length,
      stubEvents,
    });
  }
  async function phase(name, total, action) {
    await snapshot(name, 0);
    const checkpoints = new Set(
      [0.25, 0.5, 0.75, 1].map((x) => Math.ceil(total * x)),
    );
    for (let i = 0; i < total; i++) {
      await action(i);
      if (checkpoints.has(i + 1)) await snapshot(name, i + 1);
    }
  }
  async function perf(label) {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const chat = await page.evaluate(() => globalThis.__soakModel.active);
      const message = {
        id: `perf-${label}-${i}`,
        chat,
        from: "u-soak-peer",
        fromName: "Peer",
        time: Date.now(),
        contentType: "NONE",
        text: `Perf ${label} ${i}`,
      };
      const start = await page.evaluate(() => performance.now());
      const item = event("message", chat, { message });
      await waitSeq(item.seq);
      await page.waitForFunction(
        (id) => !!document.querySelector(`article[data-message-id="${id}"]`),
        message.id,
        { timeout: 120000 },
      );
      const end = await page.evaluate(() =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            setTimeout(() => resolve(performance.now()), 0)
          )
        )
      );
      samples.push(Math.round((end - start) * 100) / 100);
    }
    await emit({
      type: "perf",
      label,
      samplesMs: samples,
      rows: await page.locator("#messages .message-row").count(),
    });
  }
  await openChat(chatIds[0]);
  await perf("initial");
  // Each block visits all 50 chats; the currently open chat keeps receiving.
  await phase("receive", Math.ceil(targets.received / 50), async (block) => {
    const end = Math.min(targets.received, (block + 1) * 50);
    for (let i = block * 50; i < end; i++) {
      const chat = chatIds[i % 50];
      const message = {
        id: `live-${i}`,
        chat,
        from: "u-soak-peer",
        fromName: "Peer",
        time: now + i,
        contentType: "NONE",
        text: `Live ${i}`,
        ...(chat === chatIds[0] && i % 200 === 0
          ? {
            contentType: "IMAGE",
            text: "",
            hasMedia: true,
            previewable: true,
          }
          : {}),
      };
      event("message", chat, { message });
      const row = chats[i % chatIds.length];
      row.lastText = `Live ${i}`;
      row.lastTime = now + i;
      row.lastFrom = "Peer";
      if (chat !== chatIds[0]) row.unread++;
      sendFrame({ chat: row, chatsRevision: ++revision, boot });
      counts.received++;
      if (chat === chatIds[0]) counts.activeReceived++;
    }
    await waitSeq(seq);
    await page.waitForFunction(
      (value) => globalThis.__soakModel.chatRevision >= value,
      revision,
      { timeout: 120000 },
    );
  });
  assert.equal(counts.received, targets.received);
  assert.equal(
    await page.evaluate((total) => {
      const ids = new Set(globalThis.__soakModel.messages.map((row) => row.id));
      let found = 0;
      for (let i = 0; i < total; i += 50) if (ids.has(`live-${i}`)) found++;
      return found;
    }, targets.received),
    counts.activeReceived,
    "every message for the open chat was applied",
  );
  assert.equal(
    await page.evaluate(() =>
      globalThis.__soakModel.chats.filter((row) =>
        row.lastText.startsWith("Live ")
      ).length
    ),
    Math.min(50, targets.received),
  );
  await perf("after-receive");
  // Bring each visible placeholder into view to exercise the preview cache.
  const imageIds = await page.evaluate(() =>
    globalThis.__soakModel.messages
      .filter((m) => m.id.startsWith("live-") && m.previewable).map((m) => m.id)
  );
  await phase("previews", imageIds.length || 1, async (i) => {
    if (!imageIds.length) return;
    const id = imageIds[i];
    await page.evaluate((key) => {
      const row = document.querySelector(`article[data-message-id="${key}"]`);
      if (!row) throw new Error(`Missing preview row ${key}`);
      row.scrollIntoView({ block: "center" });
    }, id);
    await page.waitForFunction(
      (key) => globalThis.__soakModel.previews.has(key),
      id,
      { timeout: 120000 },
    );
  });
  await phase("switches", targets.switches, async (i) => {
    await openChat(chatIds[(i + 1) % chatIds.length]);
    counts.switches++;
  });
  await openChat(chatIds[0]);
  await phase("history", targets.older, async () => {
    const previous = counts.older;
    await page.locator("#messages").evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    await until(() => counts.older > previous, "older history request", 120000);
    await settle();
    assert.equal(counts.older, previous + 1);
  });
  assert.equal(counts.older, targets.older);
  const historyCount = 50 + targets.older * 50;
  assert.equal(
    await page.evaluate(() => globalThis.__soakModel.messages.length),
    historyCount,
    "each older page added 50 distinct messages",
  );
  assert.equal(
    await page.locator("#messages .message-row").count(),
    historyCount,
  );
  await perf("long-history");
  await openChat(chatIds[1]);
  await snapshot("history-released", targets.older);
  await phase("reconnect", targets.reconnect, async () => {
    const previous = connections;
    socket.close({ code: 4001, reason: "soak reconnect" });
    await until(() => connections > previous, "new WebSocket", 30000);
    await settle();
    counts.reconnect++;
  });
  await phase("lightbox", targets.lightbox, async () => {
    await page.locator("#messages img.media-image").last().waitFor();
    await page.locator("#messages img.media-image").last().evaluate((node) =>
      node.click()
    );
    assert.equal(
      await page.locator("#lightbox").evaluate((node) => node.open),
      true,
    );
    await page.locator("#lightbox-close").evaluate((node) => node.click());
    assert.equal(
      await page.locator("#lightbox").evaluate((node) => node.open),
      false,
    );
    counts.lightbox++;
  });
  await phase("send", targets.sends, async (i) => {
    const text = `Soak send ${i}`;
    await page.locator("#message-input").fill(text);
    await page.locator("#composer").evaluate((form) => form.requestSubmit());
    if (i % 10 === 0) {
      const row = page.locator(".message-row").filter({ hasText: text });
      await row.locator(".retry-button").waitFor({ timeout: 120000 });
      await row.locator(".retry-button").evaluate((node) => node.click());
    }
    await until(() => counts.sends >= i + 1, "send acknowledgement", 120000);
    await settle();
  });
  assert.equal(counts.sends, targets.sends);
  assert.equal(counts.failures, counts.retries);
  assert.ok(counts.failures > 0);
  assert.equal(
    await page.evaluate(() => globalThis.__soakModel.sent.size),
    Math.min(targets.sends, 500),
  );

  const active = chatIds[1];
  const seeds = Math.max(targets.edits, targets.reactions, targets.unsends);
  for (let i = 0; i < seeds; i++) {
    const message = {
      id: `event-${i}`,
      chat: active,
      from: "u-soak-peer",
      fromName: "Peer",
      time: now + 100000 + i,
      contentType: "NONE",
      text: `Seed ${i}`,
    };
    event("message", active, { message });
  }
  await waitSeq(seq);
  for (
    const [stage, target] of [["edits", targets.edits], [
      "reactions",
      targets.reactions,
    ], ["unsends", targets.unsends]]
  ) {
    await phase(stage, target, async (i) => {
      const id = `event-${i}`;
      if (stage === "edits") {
        event("edit", active, {
          message: {
            id,
            chat: active,
            from: "u-soak-peer",
            fromName: "Peer",
            time: now + 100000 + i,
            contentType: "NONE",
            text: `Edited ${i}`,
          },
        });
      } else if (stage === "reactions") {
        event("reaction", active, {
          messageId: id,
          reactions: [{ type: "LOVE", count: 1, mine: false }],
        });
      } else event("unsend", active, { messageId: id });
      counts[stage]++;
      await waitSeq(seq);
    });
    const actual = await page.evaluate(({ stage, target }) => {
      const rows = globalThis.__soakModel.messages;
      return Array.from({ length: target }, (_, i) => {
        const m = rows.find((row) => row.id === `event-${i}`);
        return stage === "edits"
          ? m?.text === `Edited ${i}`
          : stage === "reactions"
          ? m?.reactions?.[0]?.type === "LOVE"
          : m?.unsent === true;
      }).every(Boolean);
    }, { stage, target });
    assert.ok(actual, `${stage} applied to every target`);
  }
  await phase("accounts", targets.accounts, async (i) => {
    account = `u-soak-account-${i}`;
    sendFrame(stateFrame());
    await page.waitForFunction(
      (id) => globalThis.__soakModel.account === id,
      account,
    );
    await openChat(chatIds[i % chatIds.length]);
    if (i % 2 === 0) {
      await page.locator("#message-input").fill(`Account draft ${i}`);
    }
    counts.accounts++;
  });
  await perf("final");
  await snapshot("final", 1);
  const originalState = await h.state();
  const firstStubSeq = Math.max(
    0,
    ...originalState.events.map((item) => item.seq),
  );
  await phase("stub-ring", targets.stubEvents, async (i) => {
    await h.request({
      id: i,
      cmd: "poke",
      chat: "cstub-family",
      text: `Stub event ${i}`,
    });
    counts.stubEvents++;
  });
  const stubEvents = (await h.state()).events;
  assert.equal(stubEvents.at(-1).seq, firstStubSeq + targets.stubEvents);
  assert.equal(
    stubEvents.length,
    Math.min(200, originalState.events.length + targets.stubEvents),
  );
  await emit({
    type: "complete",
    scale,
    targets,
    counts,
    fixtureRing: ring.length,
    stubEvents: stubEvents.length,
    connections,
  });
  await cdp.detach();
});

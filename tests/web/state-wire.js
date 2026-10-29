// Exercise full snapshots, patches and reconnects through a real browser.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function stateWire(h) {
  const app = await Deno.readTextFile(
    new URL("../../daemon/web/public/js/app.js", import.meta.url),
  );
  const target = "  model = createModel();";
  assert.equal(app.split(target).length, 2);
  const context = await h.context({ locale: "en-US" });
  await context.route("**/js/app.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: app.replace(
        target,
        `${target}\nglobalThis.__wireTestModel = model;`,
      ),
    }));
  const initial = await h.state();
  initial.chats.push(...Array.from({ length: 495 }, (_, i) => ({
    ...initial.chats[0],
    mid: `cwire-${String(i).padStart(4, "0")}`,
    name: `Wire chat ${i}`,
    lastText: `Preview ${i} ${"testing ".repeat(10)}`,
    lastTime: Date.now() - i * 1000,
    unread: 0,
  })));
  initial.chatsRevision += 100;
  initial.chatList.loaded = initial.chats.length;
  let stamp = Date.now();
  async function write(state) {
    const tmp = `${h.stateDir}/wire-test.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(state, null, 2));
    const time = new Date(stamp += 1000);
    await Deno.utime(tmp, time, time);
    await Deno.rename(tmp, `${h.stateDir}/state.json`);
  }
  async function modelState() {
    return await page.evaluate(() => globalThis.__wireTestModel.state);
  }
  async function assertCurrent(state) {
    await page.waitForFunction((expected) => {
      const model = globalThis.__wireTestModel;
      return model.state?.chatsRevision === expected.revision &&
        model.account === expected.account &&
        model.state?.updatedAt === expected.updatedAt;
    }, {
      revision: state.chatsRevision,
      account: state.me.mid,
      updatedAt: state.updatedAt,
    });
    assert.deepEqual(await modelState(), await h.state());
  }
  await write(initial);
  const page = await context.newPage();
  const tap = await tapSocket(page, {
    client(frame, channel) {
      if (!["history", "members", "markRead"].includes(frame.cmd)) return true;
      channel.socket.send(JSON.stringify({ id: frame.id, ok: true, data: [] }));
      return false;
    },
  });
  await h.signIn(page);
  await page.waitForFunction(() =>
    document.querySelectorAll(".chat-row").length === 500
  );
  await assertCurrent(initial);
  const first = tap.received.find((frame) => frame.web === "state");
  assert.ok(first?.generation);
  assert.equal(
    await page.evaluate(() => globalThis.__wireTestModel.socket.protocol),
    "enil-state-delta-v1",
  );
  const legacy = await context.newPage();
  await legacy.goto(`${h.base}/api/session`);
  await legacy.evaluate(() => {
    globalThis.__legacyFrames = [];
    globalThis.__legacySocket = new WebSocket(`ws://${location.host}/api/ws`);
    globalThis.__legacySocket.onmessage = (event) => {
      globalThis.__legacyFrames.push(JSON.parse(event.data));
    };
  });
  await legacy.waitForFunction(() =>
    globalThis.__legacyFrames.some((frame) => frame.web === "state")
  );
  assert.deepEqual(
    await legacy.evaluate(() =>
      globalThis.__legacyFrames.find((frame) => frame.web === "state")
    ),
    { web: "state", state: initial },
  );
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();

  // An older file patch must not overwrite the newer live chat push.
  const oldRow = initial.chats.find((row) => row.mid === CHAT);
  tap.socket.send(JSON.stringify({
    chat: { ...oldRow, name: "Live push" },
    chatsRevision: initial.chatsRevision + 2,
    boot: initial.bootId,
  }));
  await page.getByText("Live push", { exact: true }).first().waitFor();
  const older = structuredClone(initial);
  older.chats.find((row) => row.mid === CHAT).name = "Older snapshot";
  older.chatsRevision++;
  older.updatedAt++;
  await write(older);
  await until(
    () => tap.received.some((frame) => frame.web === "state-delta"),
    "first delta",
  );
  await assertCurrent(older);
  await legacy.waitForFunction(
    (revision) =>
      globalThis.__legacyFrames.some((frame) =>
        frame.web === "state" && frame.state.chatsRevision === revision
      ),
    older.chatsRevision,
  );
  assert.deepEqual(
    await legacy.evaluate(
      (revision) =>
        globalThis.__legacyFrames.find((frame) =>
          frame.web === "state" && frame.state.chatsRevision === revision
        ),
      older.chatsRevision,
    ),
    { web: "state", state: older },
  );
  assert.equal(
    await page.getByText("Live push", { exact: true }).count() > 0,
    true,
  );
  const delta = tap.received.find((frame) => frame.web === "state-delta");

  const settled = structuredClone(older);
  settled.chats.find((row) => row.mid === CHAT).name = "Live push";
  settled.chatsRevision++;
  settled.updatedAt++;
  await write(settled);
  await assertCurrent(settled);
  assert.deepEqual(
    await page.evaluate(() => globalThis.__wireTestModel.chats),
    settled.chats,
  );

  // A reordered snapshot falls back to full; the next edit is a delta again.
  const reordered = structuredClone(settled);
  [reordered.chats[10], reordered.chats[11]] = [
    reordered.chats[11],
    reordered.chats[10],
  ];
  reordered.chatsRevision++;
  reordered.updatedAt++;
  await write(reordered);
  await assertCurrent(reordered);
  assert.ok(
    tap.received.some((frame) =>
      frame.web === "state" &&
      frame.state.chatsRevision === reordered.chatsRevision
    ),
  );
  const edited = structuredClone(reordered);
  edited.chats[100].lastText = "Patched after full";
  edited.chatsRevision++;
  edited.updatedAt++;
  await write(edited);
  await assertCurrent(edited);
  assert.ok(
    tap.received.some((frame) =>
      frame.web === "state-delta" &&
      frame.state.chatsRevision === edited.chatsRevision
    ),
  );

  // Switching accounts forces a full snapshot and closes the old chat.
  const switched = structuredClone(edited);
  switched.me = { mid: "u-other", displayName: "Other account" };
  switched.chatsRevision++;
  switched.updatedAt++;
  await write(switched);
  await assertCurrent(switched);
  assert.ok(
    tap.received.some((frame) =>
      frame.web === "state" && frame.state.me.mid === "u-other"
    ),
  );
  assert.equal(
    await page.evaluate(() => globalThis.__wireTestModel.active),
    "",
  );

  // A replay is ignored. A missing patch forces a reconnect and a fresh full.
  tap.socket.send(JSON.stringify(delta));
  await page.waitForTimeout(150);
  assert.deepEqual(await modelState(), switched);
  const latest = tap.received.filter((frame) => frame.web === "state").at(-1);
  tap.socket.send(JSON.stringify({
    web: "state-delta",
    generation: latest.generation,
    base: latest.version + 1,
    version: latest.version + 2,
    state: {},
    remove: [],
    put: [],
  }));
  await until(
    () => tap.received.filter((frame) => frame.web === "state").length >= 4,
    "reconnect full snapshot",
    15000,
  );
  await page.locator("#connection.connected").waitFor();
  await assertCurrent(switched);
  assert.deepEqual(
    await page.evaluate(() => globalThis.__wireTestModel.chats),
    switched.chats,
  );

  // With no connected pages, the next subscriber must not be seeded with
  // the previous account from the feed's cache.
  await legacy.evaluate(() => globalThis.__legacySocket.close());
  await legacy.waitForFunction(() =>
    globalThis.__legacySocket.readyState === 3
  );
  const reconnectAt = tap.received.length;
  await page.evaluate(() => globalThis.__wireTestModel.socket.close());
  await page.waitForFunction(() => !globalThis.__wireTestModel.connected);
  const offlineSwitch = structuredClone(switched);
  offlineSwitch.me = { mid: "u-offline-switch", displayName: "Offline switch" };
  offlineSwitch.chatsRevision++;
  offlineSwitch.updatedAt++;
  await write(offlineSwitch);
  await until(
    () =>
      tap.received.slice(reconnectAt).some((frame) => frame.web === "state"),
    "full snapshot after offline account switch",
    15000,
  );
  const reconnected = tap.received.slice(reconnectAt).find((frame) =>
    frame.web === "state"
  );
  assert.equal(reconnected.state.me.mid, "u-offline-switch");
  await assertCurrent(offlineSwitch);
  h.step("state-deltas-reconnect-account-and-live-push");
}

// Regression coverage for parity review findings.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function syncAccount(h) {
  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  const syncIds = [];
  let overrideAccount = false;
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.cmd === "sync") {
        syncIds.push(frame.id);
        return false;
      }
      return true;
    },
    server(frame) {
      if (overrideAccount && frame.web === "state") {
        frame.state.me = { mid: "u-new-account", displayName: "New account" };
      }
      return true;
    },
  });
  await h.signIn(page);
  await page.locator("#sync").click();
  await until(() => syncIds.length === 1, "old account sync");
  const state = await h.state();
  overrideAccount = true;
  tap.socket.send(JSON.stringify({
    web: "state",
    state: {
      ...state,
      me: { mid: "u-new-account", displayName: "New account" },
    },
  }));
  await page.getByText("New account", { exact: true }).waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), false);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  await page.locator("#sync").click();
  await until(() => syncIds.length === 2, "new account sync");
  const histories = tap.sent.filter((frame) => frame.cmd === "history").length;
  tap.socket.send(
    JSON.stringify({ id: syncIds[0], ok: true, data: { at: Date.now() } }),
  );
  const barrier = {
    id: "sync-account-barrier",
    chat: CHAT,
    from: "u-other",
    fromName: "Peer",
    text: "Old sync handled",
    time: Date.now(),
    contentType: "NONE",
  };
  tap.socket.send(JSON.stringify({
    event: { seq: 999999, kind: "message", chat: CHAT, message: barrier },
    boot: state.bootId,
  }));
  await page.getByText("Old sync handled", { exact: true }).waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), true);
  assert.equal(await page.getByText(/Synced/).count(), 0);
  assert.equal(
    tap.sent.filter((frame) => frame.cmd === "history").length,
    histories,
  );
  tap.socket.send(
    JSON.stringify({ id: syncIds[1], ok: false, error: "new sync failed" }),
  );
  await page.getByText("new sync failed", { exact: true }).waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), false);
  await page.locator("#sync").click();
  await until(() => syncIds.length === 3, "second account sync");
  overrideAccount = false;
  tap.socket.send(JSON.stringify({ web: "state", state }));
  await page.getByText("STUB User", { exact: true }).waitFor();
  assert.equal(await page.locator("#sync").isDisabled(), false);
  tap.socket.send(JSON.stringify({
    id: syncIds[2],
    ok: false,
    error: "stale account error",
  }));
  const restored = await h.state();
  tap.socket.send(JSON.stringify({
    web: "state",
    state: { ...restored, me: { ...restored.me, displayName: "Restored" } },
  }));
  await page.getByText("Restored", { exact: true }).waitFor();
  assert.equal(await page.getByText("stale account error").count(), 0);
  await context.close();
  h.step("sync-account-generation");
}

export async function parityFixes(h) {
  await syncAccount(h);
}

// Regression cases for history races, acknowledged sends and group members.
import { assert, CHAT, tapSocket, until } from "./harness.js";

const family = /STUB 家庭群組/;
const pixel = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

async function newPage(h, hooks) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === h.base) return await route.continue();
    await route.fulfill({ status: 200, contentType: "image/png", body: pixel });
  });
  const page = await context.newPage();
  const tap = await tapSocket(page, hooks);
  await h.signIn(page);
  return { context, page, tap, state: await h.state() };
}

const row = (id, text, time) => ({
  id: String(id),
  chat: CHAT,
  from: "u-peer",
  fromName: "Peer",
  text,
  time,
  contentType: "NONE",
  hasMedia: false,
  mediaState: "ok",
});

async function olderEvent(h) {
  let older;
  const now = Date.now();
  const { context, page, tap, state } = await newPage(h, {
    client(frame, channel) {
      if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
      if (frame.before) older = frame;
      else {
        channel.socket.send(JSON.stringify({
          id: frame.id,
          ok: true,
          data: Array.from(
            { length: 50 },
            (_, i) => row(500 + i, `loaded ${i}`, now - (50 - i) * 1000),
          ),
        }));
      }
      return false;
    },
  });
  await page.getByRole("button", { name: family }).click();
  await page.getByRole("log").getByText("loaded 49", { exact: true }).waitFor();
  const stable = await page.locator('article[data-message-id="549"]')
    .elementHandle();
  await page.getByRole("button", { name: "Load older messages" }).click();
  await until(() => older, "older history request");
  let seq = Math.max(0, ...(state.events || []).map((event) => event.seq)) + 1;
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: { seq: seq++, kind: "unsend", chat: CHAT, messageId: "499" },
  }));
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: {
      seq: seq++,
      kind: "message",
      chat: CHAT,
      message: row("live-marker", "Live while older loads", now + 1000),
    },
  }));
  await page.getByRole("log").getByText("Live while older loads").waitFor();
  tap.socket.send(JSON.stringify({
    id: older.id,
    ok: true,
    data: [row(499, "REVOKED OLD CONTENT", now - 60000)],
  }));
  const revoked = page.locator('article[data-message-id="499"]');
  await revoked.getByText("Message unsent").waitFor();
  assert.equal(await revoked.getByText("REVOKED OLD CONTENT").count(), 0);
  assert.equal(await stable.evaluate((node) => node.isConnected), true);
  await context.close();
  h.step("older-history-event-replay-keeps-keyed-rows");
}

async function olderSuperseded(h) {
  let older, sync, refresh;
  let histories = 0;
  const now = Date.now();
  const { context, page, tap, state } = await newPage(h, {
    client(frame, channel) {
      if (frame.cmd === "sync") {
        sync = frame;
        return false;
      }
      if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
      if (frame.before) older = frame;
      else if (++histories === 1) {
        channel.socket.send(JSON.stringify({
          id: frame.id,
          ok: true,
          data: Array.from(
            { length: 50 },
            (_, i) => row(500 + i, `original ${i}`, now - (50 - i) * 1000),
          ),
        }));
      } else refresh = frame;
      return false;
    },
  });
  await page.getByRole("button", { name: family }).click();
  await page.getByRole("log").getByText("original 49", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Load older messages" }).click();
  await until(() => older, "older request before sync");
  let seq = Math.max(0, ...(state.events || []).map((event) => event.seq)) +
    10000;
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: { seq: seq++, kind: "unsend", chat: CHAT, messageId: "520" },
  }));
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: {
      seq: seq++,
      kind: "message",
      chat: CHAT,
      message: row("before-sync", "Before sync", now + 1000),
    },
  }));
  await page.getByText("Before sync", { exact: true }).waitFor();
  await page.locator('article[data-message-id="520"]').getByText(
    "Message unsent",
  )
    .waitFor();
  await page.locator("#sync").click();
  await until(() => sync, "sync request");
  tap.socket.send(JSON.stringify({
    id: sync.id,
    ok: true,
    data: { at: Date.now() },
  }));
  await until(() => refresh, "replacement history");
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: {
      seq: seq++,
      kind: "message",
      chat: CHAT,
      message: row("during-sync", "During sync", now + 2000),
    },
  }));
  tap.socket.send(JSON.stringify({
    id: refresh.id,
    ok: true,
    data: [row(520, "original 20", now - 30000)],
  }));
  await page.getByText("During sync", { exact: true }).waitFor();
  await page.locator('article[data-message-id="520"]').getByText(
    "Message unsent",
  )
    .waitFor();
  assert.equal(await page.getByText("original 20", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Before sync", { exact: true }).count(), 1);
  await until(
    () =>
      tap.sent.some((frame) =>
        frame.cmd === "markRead" &&
        frame.upTo === "during-sync"
      ),
    "buffered message read",
  );
  for (const id of ["before-sync", "during-sync"]) {
    assert.equal(
      tap.sent.filter((frame) => frame.cmd === "markRead" && frame.upTo === id)
        .length,
      1,
    );
  }
  tap.socket.send(JSON.stringify({
    id: older.id,
    ok: true,
    data: [row(499, "Stale older response", now - 60000)],
  }));
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: {
      seq: seq++,
      kind: "message",
      chat: CHAT,
      message: row("older-barrier", "Older response barrier", now + 3000),
    },
  }));
  await page.getByText("Older response barrier", { exact: true }).waitFor();
  assert.equal(await page.getByText("Stale older response").count(), 0);
  await context.close();
  h.step("sync-supersedes-older-preserves-events");
}

async function unreadSyncSupersession(h) {
  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  const histories = [], syncs = [];
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.cmd === "history" && frame.chat === CHAT) {
        histories.push(frame);
        return false;
      }
      if (frame.cmd === "sync") {
        syncs.push(frame);
        return false;
      }
      return true;
    },
    server(frame) {
      if (frame.web === "state") {
        frame.state.chats = frame.state.chats.map((row) =>
          row.mid === CHAT ? { ...row, unread: 2 } : row
        );
      }
      return true;
    },
  });
  await h.signIn(page);
  const state = await h.state();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await until(() => histories.length === 1, "opening history");
  const now = Date.now() - 10000;
  const message = (id, offset) => ({
    id,
    chat: CHAT,
    from: "u-other",
    fromName: "Peer",
    text: id,
    time: now + offset,
    contentType: "NONE",
    hasMedia: false,
    mediaState: "ok",
  });
  const first = message("during-opening", 3000);
  const second = message("during-replacement", 4000);
  let seq = 999999;
  const push = (row) =>
    tap.socket.send(JSON.stringify({
      event: { seq: seq++, kind: "message", chat: CHAT, message: row },
      boot: state.bootId,
    }));
  push(first);
  await page.locator("#sync").click();
  await until(() => syncs.length === 1, "sync during opening history");
  tap.socket.send(JSON.stringify({
    id: syncs[0].id,
    ok: true,
    data: { at: Date.now() },
  }));
  await until(() => histories.length === 2, "replacement opening history");
  push(second);
  tap.socket.send(JSON.stringify({
    id: histories[1].id,
    ok: true,
    data: [
      message("read-before", 0),
      message("unread-first", 1000),
      message("unread-last", 2000),
      first,
      second,
    ],
  }));
  await page.getByText("during-replacement", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".unread-divider").evaluate((node) =>
      node.nextElementSibling?.dataset.messageId
    ),
    "unread-first",
  );
  await until(
    () =>
      tap.sent.some((frame) =>
        frame.cmd === "markRead" && frame.upTo === second.id
      ),
    "replacement message read",
  );
  for (const row of [first, second]) {
    assert.equal(
      tap.sent.filter((frame) =>
        frame.cmd === "markRead" && frame.upTo === row.id
      ).length,
      1,
    );
  }
  tap.socket.send(JSON.stringify({
    id: histories[0].id,
    ok: true,
    data: [message("stale-history", 0)],
  }));
  push(message("stale-response-barrier", 5000));
  await page.getByText("stale-response-barrier", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("stale-history", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.locator(".unread-divider").evaluate((node) =>
      node.nextElementSibling?.dataset.messageId
    ),
    "unread-first",
  );
  await context.close();
  h.step("unread-boundary-sync-supersession");
}

async function acknowledgedSend(h) {
  let sent, historyReply = null;
  const { context, page, tap, state } = await newPage(h, {
    client(frame, channel) {
      if (frame.cmd === "send" && frame.text.startsWith("ACK BEFORE")) {
        sent = frame;
        channel.socket.send(JSON.stringify({ id: frame.id, ok: true }));
        return false;
      }
      if (frame.cmd === "history" && frame.chat === CHAT && historyReply) {
        const data = historyReply;
        historyReply = null;
        channel.socket.send(JSON.stringify({ id: frame.id, ok: true, data }));
        return false;
      }
      return true;
    },
  });
  await page.getByRole("button", { name: family }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？", { exact: true })
    .waitFor();
  const stable = await page.locator("#messages article").first()
    .elementHandle();
  await page.getByLabel("Message", { exact: true }).fill("ACK BEFORE ECHO");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(() => sent, "acknowledged send");
  await page.getByText("Sent", { exact: true }).waitFor();
  assert.equal(await stable.evaluate((node) => node.isConnected), true);
  assert.equal(
    await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("enil.web.drafts.v1"),
      )["ustub-me-0000"]["cstub-family"].pending.length
    ),
    0,
  );
  await page.getByRole("button", { name: /STUB Alice/ }).click();
  historyReply = [];
  await page.getByRole("button", { name: family }).click();
  await until(() => historyReply === null, "stale history response");
  await page.getByText("Sent", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("log").getByText("ACK BEFORE ECHO", {
      exact: true,
    }).count(),
    1,
  );
  const seq = Math.max(0, ...(state.events || []).map((event) => event.seq)) +
    1;
  const delivered = {
    ...row("confirmed-echo", "ACK BEFORE ECHO", Date.now()),
    from: "ustub-me-0000",
    requestId: sent.requestId,
  };
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: { seq, kind: "message", chat: CHAT, message: delivered },
  }));
  await page.locator('article[data-message-id="confirmed-echo"]').waitFor();
  assert.equal(
    await page.locator('article[data-message-id^="pending-"]').count(),
    0,
  );
  assert.equal(
    await page.getByRole("log").getByText("ACK BEFORE ECHO", {
      exact: true,
    }).count(),
    1,
  );

  sent = null;
  await page.getByLabel("Message", { exact: true }).fill("ACK BEFORE HISTORY");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(() => sent, "second acknowledged send");
  await page.getByText("Sent", { exact: true }).waitFor();
  await page.getByRole("button", { name: /STUB Alice/ }).click();
  historyReply = [{
    ...row("confirmed-history", "ACK BEFORE HISTORY", Date.now()),
    from: "ustub-me-0000",
    requestId: sent.requestId,
  }];
  await page.getByRole("button", { name: family }).click();
  await page.locator('article[data-message-id="confirmed-history"]').waitFor();
  assert.equal(
    await page.locator('article[data-message-id^="pending-"]').count(),
    0,
  );
  assert.equal(
    await page.getByRole("log").getByText("ACK BEFORE HISTORY", {
      exact: true,
    }).count(),
    1,
  );
  await context.close();
  h.step("acknowledged-send-keyed-reconcile-echo-and-history");
}

async function membersRace(h) {
  const requests = [];
  const { context, page, tap, state } = await newPage(h, {
    client(frame) {
      if (frame.cmd === "members" && frame.chat === CHAT) {
        requests.push(frame);
        return false;
      }
      return true;
    },
  });
  await page.getByRole("button", { name: family }).click();
  await until(() => requests.length === 1, "first members request");
  await page.getByRole("button", { name: /STUB Alice/ }).click();
  await page.getByRole("button", { name: family }).click();
  await until(() => requests.length === 2, "second members request");
  tap.socket.send(JSON.stringify({
    id: requests[1].id,
    ok: true,
    data: [{ mid: `u${"a".repeat(32)}`, name: "New Member" }],
  }));
  await page.getByLabel("Message", { exact: true }).fill("@");
  await page.getByRole("button", { name: "@New Member" }).waitFor();
  tap.socket.send(JSON.stringify({
    id: requests[0].id,
    ok: true,
    data: [{ mid: `u${"b".repeat(32)}`, name: "Stale Member" }],
  }));
  const seq = Math.max(0, ...(state.events || []).map((event) => event.seq)) +
    1;
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: {
      seq,
      kind: "message",
      chat: CHAT,
      message: row("members-barrier", "Members barrier", Date.now()),
    },
  }));
  await page.getByText("Members barrier", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "@New Member" }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "@Stale Member" }).count(),
    0,
  );
  await context.close();
  h.step("stale-members-after-reopen");
}

async function membersFailure(h) {
  let failed = false;
  const { context, page } = await newPage(h, {
    client(frame, channel) {
      if (frame.cmd === "members" && frame.chat === CHAT) {
        failed = true;
        channel.socket.send(JSON.stringify({
          id: frame.id,
          ok: false,
          error: "Members unavailable for test",
        }));
        return false;
      }
      return true;
    },
  });
  await page.getByRole("button", { name: family }).click();
  await until(() => failed, "members failure");
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("@");
  await page.getByRole("button", { name: "@All" }).waitFor();
  await page.locator("#mention-picker").getByText(
    "Members unavailable for test",
  )
    .waitFor();
  await input.fill("@Nobody");
  await page.locator("#mention-picker").getByText(
    "Members unavailable for test",
  )
    .waitFor();
  assert.equal(await page.locator("#mention-picker button").count(), 0);
  await input.press("Escape");
  assert.equal(await page.locator("#mention-picker").isVisible(), false);
  await context.close();
  h.step("members-failure-mention-picker");
}

export async function review(h) {
  await olderEvent(h);
  await olderSuperseded(h);
  await unreadSyncSupersession(h);
  await acknowledgedSend(h);
  await membersRace(h);
  await membersFailure(h);
}

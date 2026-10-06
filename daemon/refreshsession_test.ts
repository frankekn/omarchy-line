/**
 * The real runRefresh()/startRound(), driven across logout without a session.
 * The summary cache and its epoch bookkeeping live in daemon/chatsummary.ts,
 * so the stub prelude imports the real store factory and pokes it the way the
 * daemon's push paths do -- the sliced rounds run against the genuine
 * accessors, not a re-typed stand-in.
 */
import { assert, assertEquals } from "@std/assert";
import { sliceBlock } from "./slice_test.ts";

const PUSH = new URL("./modules/push.ts", import.meta.url);
const LOGIN = new URL("./modules/login.ts", import.meta.url);
const CHATSUMMARY = new URL("./chatsummary.ts", import.meta.url);

async function loadModule() {
  // runRefresh and the incremental round moved into modules/refresh.ts.
  const src = await Deno.readTextFile(
    new URL("./modules/refresh.ts", import.meta.url),
  );
  const begin = src.indexOf("async function runRefresh(");
  const end = src.indexOf("// enil:incremental-end");
  if (begin < 0 || end <= begin) throw new Error("runRefresh block missing");
  // The push path (and its summary block) moved into modules/push.ts.
  const pushSrc = await Deno.readTextFile(
    new URL("./modules/push.ts", import.meta.url),
  );
  const summaryBegin = pushSrc.indexOf("// enil:pushsummary-begin");
  const summaryEnd = pushSrc.indexOf("// enil:pushsummary-end", summaryBegin);
  if (summaryBegin < 0 || summaryEnd <= summaryBegin) {
    throw new Error("push summary block missing");
  }
  const summaryBlock = pushSrc.slice(summaryBegin, summaryEnd);
  const block = src.slice(begin, end);
  const prelude = `
import { createChatSummaryStore, summaryMessageIsCurrent } from "${CHATSUMMARY.href}";
type Json = Record<string, unknown>;
type PluginChat = Record<string, unknown>;
let resolveBoxes: (value: unknown) => void = () => {};
let rejectBoxes: (reason: unknown) => void = () => {};
let boxesCalls = 0;
function pendingBoxes() {
  boxesCalls++;
  return new Promise((resolve, reject) => {
    resolveBoxes = resolve;
    rejectBoxes = reject;
  });
}
const calls = {
  writes: 0, failures: 0, oks: 0, retries: 0, names: 0, halts: 0,
  timings: [] as string[],
};
const recentCalls: string[] = [];
const recentResults = new Map<string, unknown>();
const decryptFailures = new Set<string>();
const timings = { record(key: string, elapsed: number) {
  if (elapsed >= 0) calls.timings.push(key);
} };
let holdWrite = false;
let releaseWrite: () => void = () => {};
const clientA = {
  base: {
    talk: {
      getMessageBoxes: () => pendingBoxes(),
      getRecentMessagesV2: async (
        args: { messageBoxId: string; messagesCount: number },
      ) => {
        recentCalls.push(args.messageBoxId);
        const value = recentResults.get(args.messageBoxId);
        if (value instanceof Error) throw value;
        return value;
      },
    },
    e2ee: {
      decryptE2EEMessage: async (v: unknown) => {
        const id = (v as { id?: unknown }).id;
        if (typeof id === "string" && decryptFailures.has(id)) {
          throw new Error("decrypt boom");
        }
        return v;
      },
    },
  },
};
let client: typeof clientA | null = clientA;
let sessionGeneration = 1;
function sessionIsCurrent(c: typeof clientA, generation: number) {
  return client === c && sessionGeneration === generation;
}
let refreshing = false;
let refreshAgain = false;
let refreshGeneration = 0;
let refreshRetryTimer: number | null = null;
const REFRESH_RETRY_MS = 1;
const CHAT_LIMIT = 500;
// The real store, not a stub: the sliced rounds read and rebind its state
// through the same accessors the daemon's rounds use. The versions-map alias
// mirrors daemon.ts's -- the one piece of the state that never rebinds.
const chatSummaryStore = createChatSummaryStore({ chatLimit: CHAT_LIMIT });
const { chatSummaryVersions } = chatSummaryStore;
let chats: PluginChat[] = [{ mid: "old" }];
let chatsRevision = 0;
let chatListHealth: { complete: boolean; loaded: number } | null = null;
// The real rounds reassign the published list through these accessors since
// the state module split; each wraps exactly the assignment it replaced.
function setChats(next: PluginChat[]) {
  chats = next;
}
function bumpChatsRevision() {
  chatsRevision++;
}
function setChatListHealth(
  next: { complete: boolean; loaded: number } | null,
) {
  chatListHealth = next;
}
let replacementResult = true;
const cursors = new Map();
function capCursors() {}
const console = { log() {}, error() {} };
let selfMid = "";
function isMe(from: unknown) {
  return String(from ?? "") === selfMid;
}
async function resolveName(v: string, _owner: typeof clientA, _generation: number) {
  calls.names++;
  return v;
}
function avatarNow() { return undefined; }
async function e2eeFilePayload(
  _raw: unknown,
  _owner: typeof clientA,
  _generation: number,
) { return null; }
function previewText(value: unknown) { return String(value ?? ""); }
// The real pool runs decrypts 8 wide; the sliced rounds only need the
// ordered-map contract, and these tests schedule work by hand anyway.
const DECRYPT_WIDTH = 8;
async function pooledMap(items: unknown[], _limit: number, fn: (item: unknown) => Promise<unknown>) {
  const out: unknown[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}
function noteRefreshOk() { calls.oks++; }
function noteRefreshFailed() { calls.failures++; }
// The classifier answers per thrown error so one prelude covers a network
// failure, a maintenance window and an account restriction.
function classifyLoginError(e: unknown) {
  const text = String((e as { message?: unknown } | null)?.message ?? "");
  if (/ABUSE_BLOCK|BANNED|EXCESSIVE_ACCESS/.test(text)) return "restricted";
  if (/MAINTENANCE_ERROR/.test(text)) return "unknown";
  return "network";
}
let restriction: { code: string; since: number } | null = null;
function haltForRestriction() {
  calls.halts++;
  restriction = { code: "X", since: 1 };
}

function clearRefreshRetry() {
  if (refreshRetryTimer !== null) clearTimeout(refreshRetryTimer);
  refreshRetryTimer = null;
}
// state.ts's stateWriteOwed() compares against the revision the last
// committed write carried; this stand-in keeps the same ledger (the real one
// is pinned by statepublished_test.ts), so the round's own decision to skip
// is what runs here.
let publishedRevision: number | null = null;
function stateWriteOwed() { return chatsRevision !== publishedRevision; }
async function writeState() {
  calls.writes++;
  const revision = chatsRevision;
  if (holdWrite) await new Promise<void>((resolve) => releaseWrite = resolve);
  publishedRevision = revision;
}
async function refreshChats() { calls.retries++; return replacementResult; }
// Incremental-round state; the daemon declares these beside the summary
// store and the test toggles them the way the panel and the env would.
let INCREMENTAL_REFRESH = true;
let forceFullRefresh = true;
const dirtyMids = new Map<
  string,
  { reason: "message" | "unsend"; pending: number }
>();
export function replacementSucceeds(value: boolean) { replacementResult = value; }
export function start() { return startRound(clientA, 1); }
export function succeed(hasNext = false) { resolveBoxes({ messageBoxes: [], hasNext }); }
export function succeedWithUnread() {
  resolveBoxes({
    messageBoxes: [{ id: "other", unreadCount: 7, lastMessages: [] }],
    hasNext: false,
  });
}
export function succeedWithNewerMessage() {
  resolveBoxes({
    messageBoxes: [{
      id: "pushed",
      unreadCount: 4,
      lastMessages: [{ id: "m2", createdTime: 20, from: "newer", text: "latest" }],
    }],
    hasNext: false,
  });
}
export function succeedWithEqualTimeMessage(id: string, text: string) {
  resolveBoxes({
    messageBoxes: [{
      id: "pushed",
      unreadCount: 4,
      lastMessages: [{ id, createdTime: 10, from: "sender", text }],
    }],
    hasNext: false,
  });
}
export function fail() { rejectBoxes(new Error("late failure")); }
export function failWith(message: string) { rejectBoxes(new Error(message)); }
export function boxesCalled() { return boxesCalls; }
export function restricted() { return restriction !== null; }
export function logout() {
  sessionGeneration++;
  client = null;
  refreshing = false;
  refreshAgain = false;
  refreshGeneration = sessionGeneration;
  // Mirrors the real logout cleanup; the source contract test below ties the
  // two together.
  dirtyMids.clear();
  forceFullRefresh = true;
}
export function pushSummary(id = "m1") {
  chats = [{ mid: "pushed", lastText: "new", lastTime: 10, lastFrom: "sender" }];
  cursors.set("box:pushed", { chat: "pushed" });
  chatsRevision++;
  chatSummaryStore.chatSummaryEpoch++;
  chatSummaryStore.chatSummaryVersions.set(
    "pushed",
    chatSummaryStore.chatSummaryEpoch,
  );
  chatSummaryStore.chatSummaryMessageIds.set("pushed", id);
}
export function recallSummary(id: string) {
  if (chatSummaryStore.chatSummaryMessageIds.get("pushed") !== id) return;
  chats = [{ ...chats[0], lastText: "已收回訊息" }];
  chatsRevision++;
  chatSummaryStore.chatSummaryEpoch++;
  chatSummaryStore.chatSummaryVersions.set(
    "pushed",
    chatSummaryStore.chatSummaryEpoch,
  );
}
// A row patch (push summary, unsend, avatar) moves the revision and leaves
// the file to whoever writes next -- here, nothing else about the list moves.
export function patchRowWithoutWrite() { chatsRevision++; }
export function invalidateMetadata() { chatSummaryStore.chatMetadataEpoch++; }
export function cacheSize() { return chatSummaryStore.summaryCache.size; }
export function hasPushedCursor() { return cursors.has("box:pushed"); }
export function seedBoxCursor(mid: string) { cursors.set("box:" + mid, { chat: mid }); }
export function hasBoxCursor(mid: string) { return cursors.has("box:" + mid); }
export function summaryMessageId(mid: string) {
  return chatSummaryStore.chatSummaryMessageIds.get(mid);
}
export function pauseWrite() { holdWrite = true; }
export function finishWrite() { releaseWrite(); }
export function armRetry() {
  refreshRetryTimer = setTimeout(() => calls.retries++, 1);
}
export function setIncremental(value: boolean) { INCREMENTAL_REFRESH = value; }
export function clearForceFull() { forceFullRefresh = false; }
export function forceFullValue() { return forceFullRefresh; }
export function dirty(
  mid: string,
  reason: "message" | "unsend" = "message",
  pending = 0,
) {
  dirtyMids.set(mid, { reason, pending });
}
export function dirtySize() { return dirtyMids.size; }
export function dirtySet() { return [...dirtyMids.keys()]; }
export function dirtyEntry(mid: string) {
  return dirtyMids.get(mid);
}
export function retryArmed() {
  return refreshRetryTimer !== null;
}
export function seedSummaryId(mid: string, id: string) {
  chatSummaryStore.chatSummaryMessageIds.set(mid, id);
}
export function seedRecent(mid: string, message: unknown) {
  recentResults.set(mid, message);
}
export function failRecent(mid: string) {
  recentResults.set(mid, new Error("no box"));
}
export function failDecrypt(id: string) { decryptFailures.add(id); }
export function recentCallsList() { return [...recentCalls]; }
export function seedChats(rows: PluginChat[]) { chats = rows; }
export function setSelf(mid: string) { selfMid = mid; }
export function seedListHealth() {
  chatListHealth = { complete: true, loaded: 7 };
}
export function summaryOf(mid: string) {
  return chatSummaryStore.summaryCache.get(mid);
}
export { calls };
export function state() { return { chats, refreshing, chatsRevision, chatListHealth }; }
`;
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(file, prelude + summaryBlock + block);
  try {
    return await import("file://" + file + `?v=${crypto.randomUUID()}`);
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

Deno.test("a successful refresh that settles after logout cannot publish", async () => {
  const m = await loadModule();
  const round = m.start();
  m.logout();
  m.succeed();
  assertEquals(await round, false);
  assertEquals(m.calls, {
    writes: 0,
    failures: 0,
    oks: 0,
    retries: 0,
    names: 0,
    halts: 0,
    timings: ["chats.decrypt", "chats.refresh"],
  });
  assertEquals(m.state(), {
    chats: [{ mid: "old" }],
    refreshing: false,
    chatsRevision: 0,
    chatListHealth: null,
  });
});

Deno.test("a failed refresh that settles after logout cannot restore health", async () => {
  const m = await loadModule();
  const round = m.start();
  m.logout();
  m.fail();
  assertEquals(await round, false);
  assertEquals(m.calls, {
    writes: 0,
    failures: 0,
    oks: 0,
    retries: 0,
    names: 0,
    halts: 0,
    // The boxes fetch itself failed: no decrypt pool ever started.
    timings: ["chats.refresh"],
  });
  assertEquals(m.state(), {
    chats: [{ mid: "old" }],
    refreshing: false,
    chatsRevision: 0,
    chatListHealth: null,
  });
});

Deno.test("a current refresh publishes revision and incomplete-list health", async () => {
  const m = await loadModule();
  const round = m.start();
  m.succeed(true);
  assertEquals(await round, true);
  assertEquals(m.calls, {
    writes: 1,
    failures: 0,
    oks: 1,
    retries: 0,
    names: 0,
    halts: 0,
    timings: ["chats.decrypt", "chats.refresh"],
  });
  assertEquals(m.state(), {
    chats: [],
    refreshing: false,
    chatsRevision: 1,
    chatListHealth: { complete: false, loaded: 0 },
  });
});

Deno.test("a full round that changes nothing does not rewrite state.json", async () => {
  const m = await loadModule();
  const first = m.start();
  m.succeed();
  assertEquals(await first, true);
  assertEquals(m.calls.writes, 1);
  // Same boxes, same list health: the file already says all of it. The
  // round still counts as a success -- health and the dirty set settle.
  const second = m.start();
  m.succeed();
  assertEquals(await second, true);
  assertEquals(m.calls.writes, 1);
  assertEquals(m.calls.oks, 2);
  assertEquals(m.state().chatsRevision, 1);
  assertEquals(m.forceFullValue(), false);
});

Deno.test("a full round still writes what the list changed", async () => {
  const m = await loadModule();
  const first = m.start();
  m.succeed();
  assertEquals(await first, true);
  // The list health flips from complete to partial: a revision bump.
  const second = m.start();
  m.succeed(true);
  assertEquals(await second, true);
  assertEquals(m.calls.writes, 2);
  // A row patch the file never received is flushed by the next round even
  // though that round itself found nothing new.
  m.patchRowWithoutWrite();
  const third = m.start();
  m.succeed(true);
  assertEquals(await third, true);
  assertEquals(m.calls.writes, 3);
});

Deno.test("an incomplete refresh retains cursors for omitted chats", async () => {
  const m = await loadModule();
  m.seedBoxCursor("retained");
  const round = m.start();
  m.succeed(true);
  assertEquals(await round, true);
  assertEquals(m.hasBoxCursor("retained"), true);
});

Deno.test("a complete refresh removes cursors for omitted chats", async () => {
  const m = await loadModule();
  m.seedBoxCursor("gone");
  const round = m.start();
  m.succeed(false);
  assertEquals(await round, true);
  assertEquals(m.hasBoxCursor("gone"), false);
});

Deno.test("a push prevents an older refresh snapshot from replacing its summary", async () => {
  const m = await loadModule();
  const round = m.start();
  m.pushSummary();
  m.succeed();
  assertEquals(await round, true);
  assertEquals(m.state().chats, [
    { mid: "pushed", lastText: "new", lastTime: 10, lastFrom: "sender" },
  ]);
  assertEquals(m.calls.writes, 1);
  assertEquals(m.calls.retries, 0);
  assertEquals(m.hasPushedCursor(), true);
});

Deno.test("a pushed summary does not discard unrelated fetched unread counts", async () => {
  const m = await loadModule();
  const round = m.start();
  m.pushSummary();
  m.succeedWithUnread();
  assertEquals(await round, true);
  assertEquals(m.state().chats, [
    { mid: "pushed", lastText: "new", lastTime: 10, lastFrom: "sender" },
    {
      mid: "other",
      name: "other",
      unread: 7,
      lastText: "",
      lastTime: 0,
      lastFrom: "",
    },
  ]);
  assertEquals(m.calls.retries, 0);
});

Deno.test("an older pushed summary cannot replace a newer fetched message", async () => {
  const m = await loadModule();
  const round = m.start();
  m.pushSummary();
  m.succeedWithNewerMessage();
  assertEquals(await round, true);
  assertEquals(m.state().chats, [{
    mid: "pushed",
    name: "pushed",
    unread: 4,
    lastText: "latest",
    lastTime: 20,
    lastFrom: "newer",
  }]);
  assertEquals(m.summaryMessageId("pushed"), "m2");
});

Deno.test("an older equal-time recall cannot replace a newer fetched message", async () => {
  const m = await loadModule();
  const round = m.start();
  m.pushSummary("100");
  m.recallSummary("100");
  m.succeedWithEqualTimeMessage("200", "latest");
  assertEquals(await round, true);
  assertEquals(m.state().chats[0].lastText, "latest");
  assertEquals(m.summaryMessageId("pushed"), "200");
});

Deno.test("a same-message recall wins equal-time refresh reconciliation", async () => {
  const m = await loadModule();
  const round = m.start();
  m.pushSummary("200");
  m.recallSummary("200");
  m.succeedWithEqualTimeMessage("200", "已收回訊息");
  assertEquals(await round, true);
  assertEquals(m.state().chats[0].lastText, "已收回訊息");
  assertEquals(m.summaryMessageId("pushed"), "200");
});

Deno.test("metadata invalidated during refresh is not put back in cache", async () => {
  const m = await loadModule();
  const round = m.start();
  m.invalidateMetadata();
  m.succeedWithUnread();
  assertEquals(await round, true);
  assertEquals(m.cacheSize(), 0);
});

Deno.test("summary version eviction preserves updates needed by an active refresh", async () => {
  const source = await Deno.readTextFile(PUSH);
  const update = source.slice(
    source.indexOf("chatSummaryVersions.delete(chat)"),
    source.indexOf(
      "pushEvent({",
      source.indexOf("chatSummaryVersions.delete(chat)"),
    ),
  );
  // The cap moved with the state into chatsummary.ts, so its pin reads there;
  // the update ordering it protects is still daemon.ts's push path.
  const moduleSource = await Deno.readTextFile(CHATSUMMARY);
  const cap = moduleSource.slice(
    moduleSource.indexOf("function capChatSummaryVersions"),
    moduleSource.indexOf(
      "// The rounds read and rebind",
      moduleSource.indexOf("function capChatSummaryVersions"),
    ),
  );
  assertEquals(
    update.indexOf("delete(chat)") < update.indexOf("set(chat"),
    true,
  );
  assertEquals(cap.includes("version > activeSummaryWindow.epoch"), true);
  assertEquals(cap.includes("if (!removed) break"), true);
});

Deno.test("an old write cannot clear the new session's retry timer", async () => {
  const m = await loadModule();
  m.pauseWrite();
  const round = m.start();
  m.succeed();
  while (m.calls.writes === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  m.logout();
  m.armRetry();
  m.finishWrite();
  assertEquals(await round, false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(m.calls.retries, 1);
});

// ---- incremental rounds ----

Deno.test("an incremental round rebuilds only the dirty chat's row", async () => {
  const m = await loadModule();
  const untouched = {
    mid: "still",
    name: "still",
    unread: 1,
    lastText: "old",
    lastTime: 5,
    lastFrom: "peer",
  };
  m.seedChats([
    {
      mid: "dirty",
      name: "dirty",
      unread: 2,
      lastText: "old",
      lastTime: 10,
      lastFrom: "peer",
    },
    untouched,
  ]);
  m.clearForceFull();
  m.seedRecent("dirty", [{
    id: "m2",
    createdTime: 20,
    from: "peer",
    text: "hello",
  }]);
  m.dirty("dirty");
  const round = m.start();
  assertEquals(await round, true);
  // Only the dirty chat went to the box API.
  assertEquals(m.recentCallsList(), ["dirty"]);
  // Its row was replaced in place and moved to the front by lastTime; the
  // other row is the same object the round started with.
  assertEquals(m.state().chats, [
    {
      mid: "dirty",
      name: "dirty",
      unread: 3,
      lastText: "hello",
      lastTime: 20,
      lastFrom: "peer",
    },
    untouched,
  ]);
  assert(m.state().chats[1] === untouched);
  // The rebuilt row entered the summary cache, so the next full round hits.
  assertEquals(m.summaryOf("dirty"), {
    lastMessageId: "m2",
    chat: {
      mid: "dirty",
      name: "dirty",
      unread: 3,
      lastText: "hello",
      lastTime: 20,
      lastFrom: "peer",
    },
  });
  assertEquals(m.summaryMessageId("dirty"), "m2");
  assertEquals(m.calls.writes, 1);
  assertEquals(m.state().chatsRevision, 1);
});

Deno.test("a dirty set larger than the cap falls back to a full round", async () => {
  const m = await loadModule();
  m.clearForceFull();
  for (let i = 0; i < 9; i++) m.dirty("chat" + i);
  const round = m.start();
  m.succeed();
  assertEquals(await round, true);
  // No per-chat requests: the round was a full sweep.
  assertEquals(m.recentCallsList(), []);
  // And publishing the full list retired the dirty set and the forced-full
  // flag with it.
  assertEquals(m.dirtySize(), 0);
  assertEquals(m.forceFullValue(), false);
});

Deno.test("a dirty set at the cap still goes incremental", async () => {
  const m = await loadModule();
  m.clearForceFull();
  for (let i = 0; i < 8; i++) {
    m.dirty("chat" + i);
    m.seedRecent("chat" + i, [{
      id: "m" + i,
      createdTime: 1,
      from: "peer",
      text: "t" + i,
    }]);
  }
  const round = m.start();
  assertEquals(await round, true);
  assertEquals(m.recentCallsList().length, 8);
});

Deno.test("an incremental round leaves box cursors and list health alone", async () => {
  const m = await loadModule();
  m.clearForceFull();
  m.seedListHealth();
  m.seedBoxCursor("dirty");
  m.dirty("dirty");
  m.seedRecent("dirty", [{
    id: "m2",
    createdTime: 20,
    from: "peer",
    text: "hello",
  }]);
  const round = m.start();
  assertEquals(await round, true);
  // Cursor GC and the completeness claim belong to full rounds only: this
  // round cannot know the chat did not just drop off the list's last page.
  assertEquals(m.hasBoxCursor("dirty"), true);
  assertEquals(m.state().chatListHealth, { complete: true, loaded: 7 });
});

Deno.test("an incremental round does not recount the message the row shows", async () => {
  const m = await loadModule();
  m.clearForceFull();
  // The row a push CREATED already counted this message (its literal 1), so
  // the dirty entry carries no debt; the fetched newest is the very message
  // the row shows, and adding one again would read 2 for a single unseen
  // message. The row a push merely updated is the other case -- see the
  // credit test below.
  m.seedChats([{
    mid: "dirty",
    name: "dirty",
    unread: 1,
    lastText: "hi",
    lastTime: 20,
    lastFrom: "peer",
  }]);
  m.seedRecent("dirty", [{
    id: "m2",
    createdTime: 20,
    from: "peer",
    text: "hi",
  }]);
  m.dirty("dirty");
  assertEquals(await m.start(), true);
  assertEquals(m.state().chats[0].unread, 1);
});

Deno.test("an incremental round credits the unread a push left uncounted on an existing row", async () => {
  const m = await loadModule();
  m.clearForceFull();
  // The push REPAINTED a row the list already had: lastTime moved onto the
  // pushed message while unread stayed at the pre-push 2, and the push booked
  // that one message as debt (pending 1). The fetched newest is the very
  // message the row shows -- strictly-newer is false, which is exactly why
  // the debt exists -- so the payoff is the only source of the +1.
  m.seedChats([{
    mid: "dirty",
    name: "dirty",
    unread: 2,
    lastText: "hi",
    lastTime: 20,
    lastFrom: "peer",
  }]);
  m.seedRecent("dirty", [{
    id: "m2",
    createdTime: 20,
    from: "peer",
    text: "hi",
  }]);
  m.dirty("dirty", "message", 1);
  assertEquals(await m.start(), true);
  assertEquals(m.state().chats[0].unread, 3);
  // Paid once: nothing is left owed on the entry, and the entry is gone with
  // the round that answered it.
  assertEquals(m.dirtySize(), 0);
});

Deno.test("two uncounted pushes on one row settle together", async () => {
  const m = await loadModule();
  m.clearForceFull();
  // Two pushes landed between full rounds; neither counted. The entry
  // accumulated one debt per pushed message, and one incremental round pays
  // both at once.
  m.seedChats([{
    mid: "dirty",
    name: "dirty",
    unread: 1,
    lastText: "hi",
    lastTime: 30,
    lastFrom: "peer",
  }]);
  m.seedRecent("dirty", [{
    id: "m3",
    createdTime: 30,
    from: "peer",
    text: "hi",
  }]);
  m.dirty("dirty", "message", 2);
  assertEquals(await m.start(), true);
  assertEquals(m.state().chats[0].unread, 3);
  assertEquals(m.dirtySize(), 0);
});

Deno.test("an incremental round still counts a fetched message strictly newer than the row", async () => {
  const m = await loadModule();
  m.clearForceFull();
  // No debt: the fetch answered a message the push path never showed (its
  // push simply has not landed yet). Strictly newer than the row's summary
  // is the one increment the round proves on its own.
  m.seedChats([{
    mid: "dirty",
    name: "dirty",
    unread: 2,
    lastText: "old",
    lastTime: 10,
    lastFrom: "peer",
  }]);
  m.seedRecent("dirty", [{
    id: "m2",
    createdTime: 20,
    from: "peer",
    text: "fresh",
  }]);
  m.dirty("dirty", "message", 0);
  assertEquals(await m.start(), true);
  assertEquals(m.state().chats[0].unread, 3);
});

Deno.test("a per-chat failure keeps its booked unread debt for the retry", async () => {
  const m = await loadModule();
  m.clearForceFull();
  m.failRecent("dirty");
  m.dirty("dirty", "message", 1);
  assertEquals(await m.start(), true);
  // The row was left as the push rendered it, so the debt was not paid; the
  // re-added entry must carry it into the round that eventually answers.
  assertEquals(m.forceFullValue(), true);
  assertEquals(m.dirtyEntry("dirty"), { reason: "message", pending: 1 });
  // The armed retry fires within the prelude's REFRESH_RETRY_MS; drain it so
  // no timer leaks past the test.
  await new Promise((resolve) => setTimeout(resolve, 5));
});

Deno.test("a row the round cannot install puts its unread debt back on the book", async () => {
  const m = await loadModule();
  m.clearForceFull();
  // Server lag: the box answers with the message before the push, while the
  // row already shows the pushed one. The guard keeps the newer shown row,
  // so the round installs nothing -- and the debt it was carrying must not
  // vanish with the dirty set it started from.
  const row = {
    mid: "dirty",
    name: "dirty",
    unread: 2,
    lastText: "new",
    lastTime: 20,
    lastFrom: "peer",
  };
  m.seedChats([row]);
  m.seedSummaryId("dirty", "m2");
  m.seedRecent("dirty", [{
    id: "m1",
    createdTime: 15,
    from: "peer",
    text: "older",
  }]);
  m.dirty("dirty", "message", 1);
  assertEquals(await m.start(), true);
  assert(m.state().chats[0] === row);
  assertEquals(m.dirtyEntry("dirty"), { reason: "message", pending: 1 });
});

Deno.test("an unsend on a chat with booked debt pays it without an API call", async () => {
  const m = await loadModule();
  m.clearForceFull();
  // A push repainted the row and booked one uncounted message; the recall
  // then drew the tombstone. The recall changes no unread -- the message is
  // still unread on the server -- so the debt stands, and this round must
  // pay it onto the standing row precisely because fetching here could
  // paint the recalled message back.
  const row = {
    mid: "dirty",
    name: "dirty",
    unread: 2,
    lastText: "已收回訊息",
    lastTime: 20,
    lastFrom: "peer",
  };
  m.seedChats([row]);
  m.dirty("dirty", "unsend", 1);
  assertEquals(await m.start(), true);
  assertEquals(m.recentCallsList(), []);
  assertEquals(m.state().chats[0].unread, 3);
  assertEquals(m.state().chats[0].lastText, "已收回訊息");
});

Deno.test("an incremental round leaves unread alone for our own message", async () => {
  const m = await loadModule();
  m.setSelf("me");
  m.clearForceFull();
  m.seedChats([{
    mid: "dirty",
    name: "dirty",
    unread: 0,
    lastText: "old",
    lastTime: 10,
    lastFrom: "我",
  }]);
  m.seedRecent("dirty", [{
    id: "m2",
    createdTime: 20,
    from: "me",
    text: "sent from the phone",
  }]);
  m.dirty("dirty");
  assertEquals(await m.start(), true);
  assertEquals(m.state().chats[0].unread, 0);
  assertEquals(m.state().chats[0].lastFrom, "我");
});

Deno.test("an unsend-dirtied chat is reconciled locally without an API call", async () => {
  const m = await loadModule();
  m.clearForceFull();
  // onTalkOp already painted the tombstone before the round ran.
  const row = {
    mid: "dirty",
    name: "dirty",
    unread: 0,
    lastText: "已收回訊息",
    lastTime: 20,
    lastFrom: "peer",
  };
  m.seedChats([row]);
  m.dirty("dirty", "unsend");
  assertEquals(await m.start(), true);
  assertEquals(m.recentCallsList(), []);
  assert(m.state().chats[0] === row);
  // Nothing changed, so nothing was published.
  assertEquals(m.calls.writes, 0);
  assertEquals(m.state().chatsRevision, 0);
});

Deno.test("a chat the box API refuses forces the next round full and stays dirty", async () => {
  const m = await loadModule();
  m.clearForceFull();
  m.failRecent("dirty");
  m.dirty("dirty");
  assertEquals(await m.start(), true);
  assertEquals(m.forceFullValue(), true);
  assertEquals(m.dirtySet(), ["dirty"]);
  // The armed retry fires within the prelude's REFRESH_RETRY_MS; drain it so
  // no timer leaks past the test.
  await new Promise((resolve) => setTimeout(resolve, 5));
});

Deno.test("a per-chat failure arms the retry chain without failing the round", async () => {
  const m = await loadModule();
  m.clearForceFull();
  m.failRecent("dirty");
  m.dirty("dirty");
  assertEquals(await m.start(), true);
  // The round answers true -- the list did get fresher and the panel has
  // nothing to be alarmed about -- but it must not report a clean refresh,
  // and the repair may not wait for the five-minute backstop or the next
  // push: the same timer a whole-round failure arms is armed here.
  assertEquals(m.calls.oks, 0);
  assertEquals(m.calls.failures, 0);
  assertEquals(m.retryArmed(), true);
  assertEquals(m.forceFullValue(), true);
  // The timer runs the repair itself, and forceFullRefresh makes that repair
  // answer the whole list.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(m.calls.retries, 1);
});

Deno.test("a clean incremental round leaves the retry chain alone", async () => {
  const m = await loadModule();
  m.clearForceFull();
  m.seedChats([{
    mid: "dirty",
    name: "dirty",
    unread: 0,
    lastText: "old",
    lastTime: 10,
    lastFrom: "peer",
  }]);
  m.seedRecent("dirty", [{
    id: "m2",
    createdTime: 20,
    from: "peer",
    text: "hello",
  }]);
  m.dirty("dirty");
  assertEquals(await m.start(), true);
  // A round with nothing to retry reports success to the health tracker and
  // never touches the timer.
  assertEquals(m.calls.oks, 1);
  assertEquals(m.calls.failures, 0);
  assertEquals(m.retryArmed(), false);
  assertEquals(m.calls.retries, 0);
});

Deno.test("a decrypt failure keeps the shown row and forces a full round", async () => {
  const m = await loadModule();
  m.clearForceFull();
  const row = {
    mid: "dirty",
    name: "dirty",
    unread: 2,
    lastText: "pushed",
    lastTime: 20,
    lastFrom: "peer",
  };
  m.seedChats([row]);
  m.seedRecent("dirty", [{
    id: "m2",
    createdTime: 30,
    from: "peer",
    text: "secret",
  }]);
  m.failDecrypt("m2");
  m.dirty("dirty");
  assertEquals(await m.start(), true);
  // The pushed row stands; a fallback-text row was not published over it and
  // nothing entered the summary cache.
  assert(m.state().chats[0] === row);
  assertEquals(m.summaryOf("dirty"), undefined);
  assertEquals(m.forceFullValue(), true);
  // The armed retry fires within the prelude's REFRESH_RETRY_MS; drain it so
  // no timer leaks past the test.
  await new Promise((resolve) => setTimeout(resolve, 5));
});

Deno.test("logout clears the dirty set and forces the next round full", async () => {
  const m = await loadModule();
  m.clearForceFull();
  m.dirty("c1");
  m.logout();
  assertEquals(m.dirtySize(), 0);
  assertEquals(m.forceFullValue(), true);
});

Deno.test("the real logout clears incremental state with the rest of the session", async () => {
  const source = await Deno.readTextFile(LOGIN);
  const start = source.indexOf("  setMe({});");
  const end = source.indexOf("releaseStateWrites();", start);
  const cleanup = source.slice(start, end);
  assertEquals(cleanup.includes("dirtyMids.clear();"), true);
  // The full-round switch is flipped through the refresh module's accessor.
  assertEquals(cleanup.includes("setForceFullRefresh(true);"), true);
});

Deno.test("the real push path books the uncounted debt on the dirty entry", async () => {
  const source = await Deno.readTextFile(PUSH);
  const start = source.indexOf("async function onIncomingMessage(");
  const end = source.indexOf("// enil:readop-begin", start);
  const push = source.slice(start, end);
  // The booking rides on the row-update branch: a push that repaints an
  // existing row owes one unread, and only when the message is not our own.
  // The dirty set must be written after that branch, carrying the debt.
  assertEquals(push.includes("repaintedRow = true;"), true);
  const booking = push.indexOf(
    "const priorDebt = dirtyMids.get(chat)?.pending ?? 0;",
  );
  const painted = push.indexOf("repaintedRow = true;");
  const set = push.indexOf("dirtyMids.set(chat, {", booking);
  assert(booking > 0 && painted > 0 && set > booking);
  assertEquals(push.slice(booking, set).includes("owesOne"), true);
});

Deno.test("the incremental switch off sends every round to the full sweep", async () => {
  const m = await loadModule();
  m.setIncremental(false);
  m.clearForceFull();
  m.seedRecent("c1", [{
    id: "m1",
    createdTime: 1,
    from: "peer",
    text: "t",
  }]);
  m.dirty("c1");
  const round = m.start();
  m.succeed();
  assertEquals(await round, true);
  assertEquals(m.recentCallsList(), []);
  assertEquals(m.dirtySize(), 0);
});

Deno.test("the incremental switch reads ENIL_INCREMENTAL", async () => {
  // The constant itself lives beside the other ENIL_* knobs since the env
  // module split; the kill switch's consultation order is what this pins.
  const env = await Deno.readTextFile(
    new URL("./modules/env.ts", import.meta.url),
  );
  assert(env.includes('Deno.env.get("ENIL_INCREMENTAL")'));
  // The kill switch is consulted before the dirty set is, so ENIL_INCREMENTAL=0
  // alone is enough to keep every round full.
  const refresh = await Deno.readTextFile(
    new URL("./modules/refresh.ts", import.meta.url),
  );
  const due = refresh.indexOf("function incrementalRefreshDue(");
  const gate = refresh.indexOf("if (!INCREMENTAL_REFRESH)", due);
  const empty = refresh.indexOf("dirtyMids.size === 0", due);
  assert(gate > 0 && empty > gate);
});

// ---- the read branch books its own unread correction ----

const READ_ME = "u" + "0".repeat(31) + "1";
const READ_PEER = "u" + "0".repeat(31) + "2";

/**
 * The read branch of onTalkOp, hand-sliced out of the daemon and wrapped in a
 * function the test can call. It lives between the enil: marker blocks -- it
 * is one branch of a larger function -- but its wiring is what the incremental
 * round stands on: which reads force the next round full, and which ones the
 * panel hears about. applyReadOp and asMessageId come from the real readop and
 * readrange blocks, so the self-read withholding is the daemon's own decision
 * rather than a stub's.
 */
async function loadReadBranch() {
  // onTalkOp moved into modules/push.ts.
  const src = await Deno.readTextFile(
    new URL("./modules/push.ts", import.meta.url),
  );
  const start = src.indexOf(`    if (ev.kind === "read") {`);
  const end = src.indexOf(`if (ev.kind === "reaction") {`, start);
  if (start < 0 || end <= start) throw new Error("read branch missing");
  const branch = src.slice(start, end).trimEnd();
  const prelude = `
type Json = Record<string, unknown>;
interface PluginEvent {
  kind: "read";
  chat: string;
  by?: string;
  upTo?: string;
}
interface ReadEvent extends PluginEvent {
  messageId: string;
}
const me: Json = { mid: "${READ_ME}" };
const readRanges = new Map<string, Map<string, bigint>>();
const readIndex = new Map<string, bigint[]>();
// The state the branch owns, spied the way the panel would feel it.
let forceFullRefresh = false;
function setForceFullRefresh(value: boolean) {
  forceFullRefresh = value;
}
let scheduled = 0;
function scheduleRefresh(): void {
  scheduled++;
}
const pushed: PluginEvent[] = [];
function pushEvent(ev: PluginEvent): void {
  pushed.push(ev);
}
`;
  const [readrange, readop] = await Promise.all([
    sliceBlock("readrange"),
    sliceBlock("readop"),
  ]);
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(
    file,
    prelude + readrange + readop +
      `export function onReadBranch(ev: ReadEvent): void {
` + branch + `
}
export function forceFullValue() {
  return forceFullRefresh;
}
export function scheduledCount() {
  return scheduled;
}
export function pushedList() {
  return pushed;
}
export function seedOwnCursor(chat: string, upTo: bigint) {
  let ranges = readRanges.get(chat);
  if (!ranges) readRanges.set(chat, ranges = new Map());
  ranges.set(String(me.mid), upTo);
}
export function ownCursor(chat: string) {
  return readRanges.get(chat)?.get(String(me.mid));
}
export function resetSpies() {
  forceFullRefresh = false;
  scheduled = 0;
}
`,
  );
  try {
    return await import("file://" + file + `?v=${crypto.randomUUID()}`);
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

Deno.test("our own read op from another device forces a full round and schedules it", async () => {
  const m = await loadReadBranch();
  // op 40 arrives decoded as by=ourselves. The unread the list shows is the
  // last full round's server count, and the phone just moved that count with
  // no per-box source able to say by how much -- so the branch must book a
  // full round and set the debouncer moving. Without it the next dirty push
  // pays its pending onto the stale number (5 shown, phone reads, server 0,
  // +1 arrives, shows 6 instead of 1).
  m.onReadBranch({
    kind: "read",
    chat: READ_PEER,
    messageId: "18000000000006",
    by: READ_ME,
  });
  assertEquals(m.forceFullValue(), true);
  assertEquals(m.scheduledCount(), 1);
  // And the withholding stands: our own read is still not an event.
  assertEquals(m.pushedList(), []);
});

Deno.test("an own read that advances a known cursor still forces a full round", async () => {
  const m = await loadReadBranch();
  m.seedOwnCursor(READ_PEER, 18000000000005n);
  m.onReadBranch({
    kind: "read",
    chat: READ_PEER,
    messageId: "18000000000006",
    by: READ_ME,
  });
  assertEquals(m.forceFullValue(), true);
  assertEquals(m.scheduledCount(), 1);
  assertEquals(m.ownCursor(READ_PEER), 18000000000006n);
});

Deno.test("the echo of our own markRead does not book a second full round", async () => {
  const m = await loadReadBranch();
  // markChatRead recorded the cursor it sent and already scheduled the round
  // that settles unread; the op 40 LINE echoes back for that very check must
  // not force one more.
  m.seedOwnCursor(READ_PEER, 18000000000006n);
  m.onReadBranch({
    kind: "read",
    chat: READ_PEER,
    messageId: "18000000000006",
    by: READ_ME,
  });
  assertEquals(m.forceFullValue(), false);
  assertEquals(m.scheduledCount(), 0);
  assertEquals(m.pushedList(), []);
});

Deno.test("a duplicate or replayed own read op books nothing", async () => {
  const m = await loadReadBranch();
  const op = {
    kind: "read" as const,
    chat: READ_PEER,
    messageId: "18000000000008",
    by: READ_ME,
  };
  m.onReadBranch(op);
  assertEquals(m.scheduledCount(), 1);
  m.resetSpies();
  // The same op again (a reconnect replaying the backlog), then an older one.
  m.onReadBranch(op);
  m.onReadBranch({ ...op, messageId: "18000000000007" });
  assertEquals(m.forceFullValue(), false);
  assertEquals(m.scheduledCount(), 0);
  assertEquals(m.ownCursor(READ_PEER), 18000000000008n);
});

Deno.test("a peer's read op leaves the next round incremental", async () => {
  const m = await loadReadBranch();
  // op 55 says the peer read ours; our own unread did not move, so no full
  // round is owed and none is booked.
  m.onReadBranch({
    kind: "read",
    chat: READ_PEER,
    messageId: "18000000000007",
    by: READ_PEER,
  });
  assertEquals(m.forceFullValue(), false);
  assertEquals(m.scheduledCount(), 0);
  // The announcement the branch exists for is untouched.
  assertEquals(m.pushedList(), [{
    kind: "read",
    chat: READ_PEER,
    by: READ_PEER,
    upTo: "18000000000007",
  }]);
});

Deno.test("a refused account halts the round: no retry, and the next round sends nothing", async () => {
  for (const code of ["ABUSE_BLOCK", "BANNED", "EXCESSIVE_ACCESS"]) {
    const m = await loadModule();
    const round = m.start();
    m.failWith(
      `Request internal failed, getMessageBoxes(/S4) -> {"code":"${code}"}`,
    );
    assertEquals(await round, false, code);
    assertEquals(m.calls.halts, 1, code);
    assertEquals(m.calls.failures, 1, code);
    assertEquals(m.retryArmed(), false, code);
    // The poll, the debouncer and the refreshAgain chain all land here: a
    // halted account answers them with no request on the wire.
    assertEquals(await m.start(), false, code);
    assertEquals(m.boxesCalled(), 1, code);
  }
});

Deno.test("a maintenance window halts nothing: the next poll runs a round", async () => {
  const m = await loadModule();
  const round = m.start();
  m.failWith(
    'Request internal failed, getMessageBoxes(/S4) -> {"code":"MAINTENANCE_ERROR"}',
  );
  assertEquals(await round, false);
  assertEquals(m.calls.halts, 0);
  assertEquals(m.restricted(), false);
  const next = m.start();
  m.succeed();
  assertEquals(await next, true);
  assertEquals(m.boxesCalled(), 2);
});

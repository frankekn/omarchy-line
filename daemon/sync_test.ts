/**
 * The manual `sync` command: the gate, the reply shape, the failure wording,
 * and the two things that make it feel instant -- not awaiting the 8s push
 * reconnect, and coalescing onto a refresh that is already on the wire.
 *
 * Imports nothing from the live daemon -- it slices the block between the
 * `enil:sync` markers out of daemon.ts and runs it on stub module state, so no
 * LINE session, no socket and no state dir are touched.
 *
 *   deno test -A sync_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const CHATSUMMARY = new URL("./chatsummary.ts", import.meta.url).href;

interface SyncModule {
  calls: { reconnect: string[]; refresh: number; log: string[]; lift: number };
  restriction: { code: string; since: number } | null;
  setRestriction(r: { code: string; since: number } | null): void;
  finishReconnect(): void;
  refreshChats(): Promise<boolean>;
  refreshErrorHint(): string;
  setChats(chats: Array<{ mid: string }>): void;
  setClient(client: object | null): void;
  replaceClient(client: object | null): void;
  setLink(link: { push: "up" | "down"; since: number } | null): void;
  setRefresh(ok: boolean, delayMs?: number): void;
  pushSummaryEpoch(): void;
  setRefreshHealth(
    health: {
      at: number;
      failures: number;
      reason?: "token_expired" | "network" | "restricted" | "unknown";
    } | null,
  ): void;
  state(): {
    link: { push: "up" | "down"; since: number };
    reconnecting: boolean;
  };
  syncNow(): Promise<{
    ok: boolean;
    error?: string;
    data?: { chats: number; link: string; at: number };
  }>;
}

/** Stub module state + the real sliced code + a test handle. */
async function loadModule() {
  const prelude = `
import { createChatSummaryStore } from "${CHATSUMMARY}";
export const calls = {
  reconnect: [] as string[], refresh: 0, log: [] as string[], lift: 0,
};
type Chat = { mid: string };
type LinkState = { push: "up" | "down"; since: number };
type Health = { at: number; failures: number; reason?: "token_expired" | "network" | "unknown" };
export let client: object | null = null;
export let sessionGeneration = 1;
export let chats: Chat[] = [];
export let link: LinkState | null = { push: "up", since: 1 };
export let restriction: { code: string; since: number } | null = null;
export function setRestriction(r: { code: string; since: number } | null) {
  restriction = r;
}
function liftRestriction() { restriction = null; calls.lift++; }
export let refreshHealth: Health | null = null;
function refreshHealthValue() { return refreshHealth; }
// The real store: the sliced syncNow reads its epoch state the way the
// daemon's does, and the stub round below publishes through the accessors.
const chatSummaryStore = createChatSummaryStore({ chatLimit: 500 });
// syncNow forces the next round full; the stub rounds here are all full.
let forceFullRefresh = true;
function setForceFullRefresh(value: boolean) {
  forceFullRefresh = value;
}
// The shared vocabulary from the errortext block; the strings are repeated
// here on purpose, so a drift in daemon.ts fails the assertions below.
const NET_DOWN_TEXT = "連不上 LINE，稍後重試";
const TOKEN_EXPIRED_TEXT = "登入已過期，請重新掃描";
let refreshResult = true;
let refreshDelayMs = 0;
export let refreshing = false;
export let refreshInFlight: Promise<boolean> | null = null;
let reconnecting = false;
let reconnectResolve: (() => void) | null = null;

export function setClient(c: object | null) { client = c; }
export function replaceClient(c: object | null) {
  sessionGeneration++;
  client = c;
}
function sessionIsCurrent(c: object, generation: number) {
  return client === c && sessionGeneration === generation;
}
export function setChats(c: Chat[]) { chats = c; }
export function setLink(l: LinkState | null) { link = l; }
export function setRefreshHealth(h: Health | null) { refreshHealth = h; }
export function setRefresh(ok: boolean, delayMs = 0) {
  refreshResult = ok;
  refreshDelayMs = delayMs;
}
export function pushSummaryEpoch() { chatSummaryStore.chatSummaryEpoch++; }
export function state() { return { link, reconnecting }; }
/** Lets the pending reconnect finish, the way the 8s grace eventually does. */
export function finishReconnect() {
  reconnecting = false;
  reconnectResolve?.();
  reconnectResolve = null;
}

// Shadows the global so the one [sync] line is assertable and stays out of the
// suite output.
const console = { log(...a: unknown[]) { calls.log.push(a.join(" ")); } };

function reconnectPush(reason: string): Promise<void> {
  if (reconnecting) return Promise.resolve();  // the real one swallows it too
  reconnecting = true;
  calls.reconnect.push(reason);
  // The real one marks the link down synchronously, before its first await.
  link = { push: "down", since: 2 };
  // And then sleeps PUSH_REINIT_GRACE_MS. This one never settles until the
  // test says so, which is what makes "syncNow does not await it" provable.
  return new Promise<void>((r) => { reconnectResolve = r; });
}

// Mirrors the real pair: refreshChats() is the coalescing entry point and
// publishes the round on refreshInFlight, runRefresh() is the round itself.
// Every successful round appends one chat, so the count in a reply says which
// round the reply actually read.
async function runRefresh(): Promise<boolean> {
  const summaryEpoch = chatSummaryStore.chatSummaryEpoch;
  const roundResult = refreshResult;
  const roundDelayMs = refreshDelayMs;
  refreshing = true;
  calls.refresh++;
  try {
    if (roundDelayMs) await new Promise((r) => setTimeout(r, roundDelayMs));
    if (roundResult) chats = [...chats, { mid: "u" + (chats.length + 1) }];
    if (roundResult) chatSummaryStore.lastRefreshSummaryEpoch = summaryEpoch;
    return roundResult;
  } finally { refreshing = false; }
}

async function refreshChats(): Promise<boolean> {
  if (refreshing) return true;   // the real coalescing answer, verbatim
  const round = runRefresh();
  refreshInFlight = round;
  try {
    return await round;
  } finally {
    if (refreshInFlight === round) refreshInFlight = null;
  }
}

export { refreshChats, refreshErrorHint, syncNow };
`;
  return await loadBlock<SyncModule>("sync", prelude);
}

/** Resolves to "hung" if `p` has not settled within `ms`, without leaking a timer. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bell = new Promise<"hung">((r) => {
    timer = setTimeout(() => r("hung"), ms);
  });
  try {
    return await Promise.race([p, bell]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("no session: the same refusal the socket gate gives, and nothing runs", async () => {
  const m = await loadModule();
  assertEquals(await m.syncNow(), { ok: false, error: "尚未登入" });
  // A sync that cannot work must not rebuild a link there is no session for.
  assertEquals(m.calls.reconnect, []);
  assertEquals(m.calls.refresh, 0);
  assertEquals(m.calls.log, []);
});

Deno.test("success answers the count, the link and a timestamp", async () => {
  const m = await loadModule();
  m.setClient({});
  m.setChats([{ mid: "u1" }, { mid: "c2" }, { mid: "u3" }]);
  const before = Date.now();
  const res = await m.syncNow();
  assertEquals(res.ok, true);
  assert(res.data);
  // 4, not 3: the round this press ran appended one, and the count is read
  // after it. A reply that said 3 would be stamping the pre-press list.
  assertEquals(res.data.chats, 4);
  // Read before the reconnect: reconnectPush has already moved the module's
  // own `link` to down by now, and answering "down" to every sync ever made
  // would say nothing about anything.
  assertEquals(res.data.link, "up");
  assertEquals(m.state().link.push, "down");
  assert(res.data.at >= before && res.data.at <= Date.now(), "at is now");
  assertEquals(m.calls.refresh, 1);
  // One line, no user data: a count of manual syncs is all the journal wants.
  assertEquals(m.calls.log, ["[sync] requested"]);
  m.finishReconnect();
});

Deno.test("a link that was already down is reported as down", async () => {
  const m = await loadModule();
  m.setClient({});
  m.setLink({ push: "down", since: 1 });
  const res = await m.syncNow();
  assert(res.data);
  assertEquals(res.data.link, "down");
  m.finishReconnect();
});

Deno.test("a failed refresh becomes advice, never a raw error", async () => {
  for (
    const [kind, hint] of [
      ["network", "連不上 LINE，稍後重試"],
      ["token_expired", "登入已過期，請重新掃描"],
      ["unknown", "LINE 沒有回應，稍後再試"],
      [null, "LINE 沒有回應，稍後再試"],
    ] as const
  ) {
    const m = await loadModule();
    m.setClient({});
    // What noteRefreshFailed() leaves behind: hint() reads only `reason`.
    m.setRefreshHealth(kind ? { at: 0, failures: 1, reason: kind } : null);
    m.setRefresh(false);
    const res = await m.syncNow();
    assertEquals(res, { ok: false, error: `同步失敗：${hint}` });
    assertEquals(m.refreshErrorHint(), hint);
    m.finishReconnect();
  }
});

Deno.test("the 8s push reconnect is fired, not awaited", async () => {
  const m = await loadModule();
  m.setClient({});
  // The stub reconnect never settles on its own; awaiting it would hang here.
  const res = await within(m.syncNow(), 1_000);
  assert(res !== "hung", "syncNow waited for the reconnect to finish");
  assertEquals(res.ok, true);
  assertEquals(m.calls.reconnect, ["manual"]);
  assertEquals(m.state().reconnecting, true, "the reconnect is still running");
  m.finishReconnect();
});

Deno.test("a sync landing on a live refresh waits it out, then runs its own", async () => {
  const m = await loadModule();
  m.setClient({});
  m.setChats([{ mid: "u1" }]);
  m.setRefresh(true, 40);
  // The second press lands while the first press's round is still on the wire.
  const [first, second] = await Promise.all([m.syncNow(), m.syncNow()]);
  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
  assert(first.data);
  assert(second.data);
  // Each round appends one chat, so the counts say which round each reply read:
  // 2 is "after the first round", 3 is "after a round that started *after* the
  // second press". Taking the coalescing `true` would have made the second
  // reply say 1 -- the list exactly as it was before the button was touched.
  assertEquals(first.data.chats, 2, "the first press reports its own round");
  assertEquals(second.data.chats, 3, "the second press waited for a fresh one");
  assertEquals(m.calls.refresh, 2, "one round per press");
  assertEquals(m.calls.reconnect, ["manual"], "one rebuild, not two");
  m.finishReconnect();
});

Deno.test("a sync waiting behind an old round cannot refresh a replacement session", async () => {
  const m = await loadModule();
  m.setClient({});
  m.setRefresh(true, 40);
  const oldRound = m.refreshChats();
  const sync = m.syncNow();
  m.replaceClient({});
  await oldRound;
  assertEquals(await sync, {
    ok: false,
    error: "登入狀態已變更，請再試一次",
  });
  assertEquals(m.calls.refresh, 1, "no refresh ran against the new account");
  m.finishReconnect();
});

Deno.test("the fire-and-forget callers still coalesce", async () => {
  const m = await loadModule();
  m.setClient({});
  m.setChats([{ mid: "u1" }]);
  m.setRefresh(true, 40);
  // A push event or the 5-minute poll arriving mid-round must not open a second
  // getMessageBoxes; only syncNow pays for freshness.
  const all = await Promise.all([
    m.refreshChats(),
    m.refreshChats(),
    m.refreshChats(),
  ]);
  assertEquals(all, [true, true, true]);
  // One real round, plus the single one refreshAgain would queue -- which this
  // stub does not model, so exactly one here.
  assertEquals(m.calls.refresh, 1);
});

Deno.test("manual sync requests the result of a coalesced round", async () => {
  // refreshChats (the coalescing pins) moved into modules/refresh.ts; syncNow
  // is still read out of daemon.ts. Joined in the original section order.
  const source = [
    await Deno.readTextFile(
      new URL("./modules/refresh.ts", import.meta.url),
    ),
    await Deno.readTextFile(new URL("./modules/login.ts", import.meta.url)),
  ].join("\n");
  const start = source.indexOf("async function syncNow()");
  const branch = source.slice(start, source.indexOf("// enil:sync-end", start));
  assert(branch.includes("await refreshChats(true)"));
  assert(source.includes("if (waitForCurrent && refreshInFlight)"));
  assert(source.includes("return await refreshInFlight"));
  // The reconcile reads the summary store's epochs (fmt wraps the gate, so
  // the pin is the comparison prefix); the boundary it fixes must be checked
  // after every joined round.
  assert(branch.includes("chatSummaryStore.lastRefreshSummaryEpoch <"));
  assert(
    branch.includes(
      "chatSummaryStore.lastRefreshSummaryEpoch < requiredEpoch",
    ),
  );
});

Deno.test("manual sync propagates a required reconciliation failure", async () => {
  const m = await loadModule();
  m.setClient({});
  m.setRefresh(true, 30);
  const sync = m.syncNow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  m.pushSummaryEpoch();
  m.setRefresh(false);
  const result = await sync;
  assertEquals(result.ok, false);
  assertEquals(m.calls.refresh, 2);
  m.finishReconnect();
});

Deno.test("a manual sync lifts a restriction halt before it refreshes", async () => {
  const m = await loadModule();
  m.setClient({});
  m.setRestriction({ code: "EXCESSIVE_ACCESS", since: 1 });
  const reply = await within(m.syncNow(), 500);
  assertEquals(m.calls.lift, 1);
  assertEquals(m.restriction, null);
  assertEquals(m.calls.refresh, 1);
  assertEquals((reply as { ok?: boolean }).ok, true);
});

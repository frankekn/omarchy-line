import { assert, assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";
// summaryMessageIsCurrent moved out of the pushsummary block into its own
// module; its assertions import it there directly.
import { summaryMessageIsCurrent } from "./chatsummary.ts";

interface SummaryModule {
  chatSummaryChanged(
    previous: { lastText: string; lastTime: number; lastFrom: string },
    next: { lastText: string; lastTime: number; lastFrom: string },
  ): boolean;
  provisionalChatName(
    chat: string,
    sender: string,
    senderName: string,
    cachedName?: string,
  ): string;
}

Deno.test("duplicate push summary does not report a chat-list change", async () => {
  const module = await loadBlock<SummaryModule>(
    "pushsummary",
    `
interface PluginChat {
  lastText: string;
  lastTime: number;
  lastFrom: string;
}
export { chatSummaryChanged, provisionalChatName };
`,
  );
  const current = { lastText: "hello", lastTime: 123, lastFrom: "Mei" };
  assertEquals(module.chatSummaryChanged(current, { ...current }), false);
  assertEquals(
    module.chatSummaryChanged(current, { ...current, lastTime: 124 }),
    true,
  );
  assertEquals(
    module.chatSummaryChanged(current, {
      lastText: "older",
      lastTime: 122,
      lastFrom: "Old",
    }),
    false,
  );
  assertEquals(summaryMessageIsCurrent(10, 10, "200", "100"), false);
  assertEquals(summaryMessageIsCurrent(10, 10, "100", "200"), true);
  assertEquals(
    summaryMessageIsCurrent(10, 10, "opaque", "older"),
    false,
  );
  assertEquals(summaryMessageIsCurrent(10, 11, "200", "100"), true);
  assertEquals(
    module.provisionalChatName("c-group", "u-sender", "Mei"),
    "c-group",
  );
  assertEquals(
    module.provisionalChatName("u-peer", "u-me", "Me", undefined),
    "u-peer",
  );
  assertEquals(
    module.provisionalChatName("u-peer", "u-peer", "Mei"),
    "Mei",
  );
  assertEquals(
    module.provisionalChatName("c-group", "u-sender", "Mei", "Team"),
    "Team",
  );
});

Deno.test("message conversion starts before ordered publication", async () => {
  const source = [
    await Deno.readTextFile(
      new URL("./modules/messages.ts", import.meta.url),
    ),
    await Deno.readTextFile(new URL("./modules/login.ts", import.meta.url)),
  ].join("\n");
  const queue = source.indexOf("let incomingPublication = Promise.resolve();");
  const listener = source.indexOf('c.on("message", (msg: TalkMsg) => {');
  const prepare = source.indexOf(
    "const prepared = prepareIncomingMessage(msg, c, generation)",
    listener,
  );
  const chained = source.indexOf(
    "incomingPublication = incomingPublication.then(() =>",
    listener,
  );
  const publish = source.indexOf(
    "onIncomingMessage(incomingId, prepared, c, generation)",
    chained,
  );
  assert(queue >= 0 && queue < listener);
  assert(listener >= 0 && listener < prepare);
  assert(prepare < chained);
  assert(chained >= 0 && chained < publish);
  const mentionBatch = source.indexOf(
    "await Promise.all(mentions.map(async (m) =>",
  );
  assert(mentionBatch >= 0, "mention lookups must share one request window");

  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const started: string[] = [];
  const published: string[] = [];
  let publication = Promise.resolve();
  const receive = (id: string, gate: Promise<void>) => {
    const preparedWork = (async () => {
      started.push(id);
      await gate;
      return id;
    })();
    publication = publication.then(async () => {
      published.push(await preparedWork);
    });
  };
  receive("first", firstGate);
  receive("second", Promise.resolve());
  await Promise.resolve();
  assertEquals(started, ["first", "second"]);
  assertEquals(published, []);
  releaseFirst();
  await publication;
  assertEquals(published, ["first", "second"]);
});

Deno.test("a pushed edit joins the same publication chain after its message", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const listener = source.indexOf('c.on("message:edit", (msg: TalkMsg) => {');
  assert(listener >= 0, "the message:edit event must be subscribed");
  const chained = source.indexOf(
    "incomingPublication = incomingPublication.then(() =>",
    listener,
  );
  const publish = source.indexOf(
    "onEditedMessage(prepared, c, generation)",
    listener,
  );
  assert(
    listener < chained && chained < publish,
    "an edit converting while its message is still in flight must apply after it",
  );
});

Deno.test("a recall tombstone suppresses a queued message publication", async () => {
  // finishIncomingMessage and friends moved into modules/caches.ts; the
  // ordering pins span both files, so read them joined (caches first, the
  // order the sections had in daemon.ts).
  const source = [
    await Deno.readTextFile(new URL("./modules/caches.ts", import.meta.url)),
    await Deno.readTextFile(new URL("./modules/push.ts", import.meta.url)),
    await Deno.readTextFile(new URL("./modules/login.ts", import.meta.url)),
  ].join("\n");
  const remember = source.indexOf(
    "unsentBeforePublication.set(ev.messageId, true)",
  );
  const cursorLookup = source.indexOf(
    "const cursor = cursors.get(ev.messageId)",
    remember,
  );
  const suppress = source.indexOf(
    "if (unsentBeforePublication.has(message.id))",
  );
  const publish = source.indexOf('kind: "message",', suppress);
  const protect = source.indexOf("!pendingIncomingMessages.has(id)");
  const track = source.indexOf("trackIncomingMessage(incomingId)");
  const drain = source.indexOf(
    "finishIncomingMessage(incomingId, owner, generation)",
  );
  assert(remember >= 0 && remember < cursorLookup);
  assert(suppress >= 0 && suppress < publish);
  assertEquals(
    source.slice(suppress, publish).includes(
      "unsentBeforePublication.delete(message.id)",
    ),
    false,
  );
  assert(protect >= 0 && track >= 0 && drain >= 0);
});

Deno.test("marking a chat read rechecks session ownership around both awaits", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/socket.ts", import.meta.url),
  );
  // Both `history markRead` and the `markRead` command go through the one
  // shared helper, so the ordering is pinned there and the callers are pinned
  // to the helper (and to turning its null into 尚未登入).
  const mark = source.indexOf("async function markChatRead(");
  const entry = source.indexOf("sessionIsCurrent(owner, generation)", mark);
  const seq = source.indexOf("await owner.base.getReqseq()", mark);
  const send = source.indexOf("await owner.base.talk.sendChatChecked", seq);
  const done = source.indexOf("// enil:markread-end", send);
  const between = source.slice(seq, send);
  const after = source.slice(send, done);
  assert(mark >= 0 && entry > mark && seq > entry && send > seq && done > send);
  assert(between.includes("sessionIsCurrent(owner, generation)"));
  assert(after.includes("sessionIsCurrent(owner, generation)"));
  // The cursor is recorded only once the session is proven current again.
  assert(
    after.indexOf("sessionIsCurrent(owner, generation)") <
      after.indexOf("ranges.set(myMid, id)"),
  );
  for (const cmd of ['if (cmd === "history")', 'if (cmd === "markRead")']) {
    const at = source.indexOf(cmd);
    const call = source.indexOf("await markChatRead(owner, generation", at);
    const stale = source.indexOf(
      'if (marked === null) return { ok: false, error: "尚未登入" }',
      call,
    );
    const next = source.indexOf("\n  if (cmd === ", at + cmd.length);
    assert(at >= 0 && call > at && stale > call && stale < next, cmd);
  }
});

Deno.test("retired message tasks cannot clean replacement-session state", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/caches.ts", import.meta.url),
  );
  const start = source.indexOf("function finishIncomingMessage(");
  const end = source.indexOf("function capUnsentBeforePublication", start);
  const cleanup = source.slice(start, end);
  assert(start >= 0 && end > start);
  // indexOf would answer -1 for a deleted guard and -1 < n is true, so the
  // generation guard itself must be proven present before ordering matters.
  const guard = cleanup.indexOf("sessionIsCurrent(owner, generation)");
  const del = cleanup.indexOf("pendingIncomingMessages.delete(id)");
  assert(guard >= 0, "the retired-session guard is gone");
  assert(del >= 0, "the pending-incoming cleanup is gone");
  assert(guard < del);
  assert(cleanup.includes("remaining > 0"));
  assert(cleanup.includes("reactionsBeforePublication.delete(id)"));
});

Deno.test("reaction operations survive an ordered message publication queue", async () => {
  const source = [
    await Deno.readTextFile(
      new URL("./modules/messages.ts", import.meta.url),
    ),
    await Deno.readTextFile(new URL("./modules/push.ts", import.meta.url)),
  ].join("\n");
  const record = source.indexOf(
    "reactionsBeforePublication.set(ev.messageId, queued)",
  );
  const raw = source.indexOf("const reacted = reactionsFromRaw(raw.reactions)");
  const merge = source.indexOf(
    "applyQueuedReactions(reacted, reactionsBeforePublication.get(out.id))",
    raw,
  );
  const incoming = source.indexOf("async function onIncomingMessage");
  const finalize = source.indexOf(
    "finalizeMessageState(message, raw, chat)",
    incoming,
  );
  const publish = source.indexOf('kind: "message",', finalize);
  const cleanup = source.indexOf(
    "finishIncomingMessage(incomingId, owner, generation)",
    publish,
  );
  assert(record >= 0 && raw >= 0 && merge > raw);
  assert(finalize > incoming && publish > finalize);
  assert(cleanup > publish);
  assertEquals(
    source.slice(merge, publish).includes(
      "reactionsBeforePublication.delete",
    ),
    false,
  );
  const finalizeBody = source.slice(
    source.indexOf("function finalizeMessageState("),
    source.indexOf("function collectFlexImages("),
  );
  assert(finalizeBody.includes("delete out.reactions"));
  assert(finalizeBody.includes("delete out.readBy"));
  assert(finalizeBody.includes("replySources.get(id)"));
  assert(
    finalizeBody.indexOf("replySources.get(id)") <
      finalizeBody.indexOf("replySources.set(out.id"),
  );
});

Deno.test("a recall protects the current pushed chat summary", async () => {
  const source = [
    await Deno.readTextFile(
      new URL("./modules/messages.ts", import.meta.url),
    ),
    await Deno.readTextFile(new URL("./modules/push.ts", import.meta.url)),
  ].join("\n");
  const remember = source.indexOf(
    "chatSummaryMessageIds.set(chat, message.id)",
  );
  // The gate's if is fmt-wrapped over two lines now, so the pin is the
  // condition itself.
  const recall = source.indexOf(
    "chatSummaryMessageIds.get(ev.chat) === ev.messageId",
  );
  const tombstone = source.indexOf("lastText: UNSENT_TEXT", recall);
  const version = source.indexOf("chatSummaryVersions.set(ev.chat", recall);
  const refresh = source.indexOf("scheduleRefresh();", recall);
  assert(remember >= 0);
  assert(recall > remember);
  assert(tombstone > recall && version > tombstone && refresh > version);
});

Deno.test("a push publishes a provisional row for a newly encountered chat", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/push.ts", import.meta.url),
  );
  const incoming = source.indexOf("async function onIncomingMessage");
  const missing = source.indexOf(
    "} else {",
    source.indexOf("if (at >= 0)", incoming),
  );
  const insert = source.indexOf("setChats([row,", missing);
  const version = source.indexOf("chatSummaryVersions.delete(chat)", insert);
  assert(incoming >= 0 && missing > incoming);
  assert(insert > missing && version > insert);
  assertEquals(
    source.slice(missing, insert).includes("await "),
    false,
    "recall and refresh cannot overtake provisional publication",
  );
  const cursor = source.indexOf(
    "rememberBoxCursor(chat, pushedCursor)",
    incoming,
  );
  assert(cursor > incoming && cursor < missing);
});

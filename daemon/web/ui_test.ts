// Browser-independent protocol, text, storage and connection tests.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  acceptEvent,
  applyChatPush,
  applyChatState,
  applyEvent,
  firstUnreadIndex,
  mergeHistory,
  mergeMessage,
  reconcilePending,
  resetBoot,
  visibleChats,
} from "./public/js/protocol.js";
import { splitText } from "./public/js/text.js";
import { createDraftStore } from "./public/js/drafts.js";
import { createConnection } from "./public/js/connection.js";
import { createModel } from "./public/js/model.js";
import { makeRegistry } from "./public/js/registry.js";
import { createTranslator, isEnglish } from "./public/js/i18n.js";

Deno.test("unread position counts only incoming messages", () => {
  const rows = [
    { id: "1", from: "peer" },
    { id: "2", from: "me" },
    { id: "3", from: "peer", contentType: "CHATEVENT" },
    { id: "4", from: "peer", pending: true },
    { id: "5", from: "other" },
    { id: "6", from: "peer", contentType: "POSTNOTIFICATION" },
  ];
  assertEquals(firstUnreadIndex(rows, 1, "me"), 4);
  assertEquals(firstUnreadIndex(rows, 2, "me"), 0);
  assertEquals(firstUnreadIndex(rows, 3, "me"), -1);
  assertEquals(firstUnreadIndex(rows, 0, "me"), -1);
  assertEquals(firstUnreadIndex(null, 1, "me"), -1);
});

Deno.test("chat search uses the displayed name, sender and preview", () => {
  const chats = [
    { mid: "first-id", name: "Alice", lastFrom: "Bob", lastText: "Hello" },
    { mid: "fallback-id", lastText: "Other" },
    { mid: "hidden", name: "Alice", hidden: true, unread: 2 },
  ];
  const ids = (query: string) =>
    visibleChats(chats, query).map((chat: { mid: string }) => chat.mid);
  assertEquals(ids(" bob "), ["first-id"]);
  assertEquals(ids("HELLO"), ["first-id"]);
  assertEquals(ids("fallback-id"), ["fallback-id"]);
  assertEquals(ids("first-id"), []);
  assertEquals(ids("alice"), ["first-id", "hidden"]);
});

Deno.test("message deduplication and requestId sender boundary", () => {
  const pending = {
    id: "local",
    pending: true,
    from: "me",
    requestId: "r1",
    time: 2,
    text: "pending",
  };
  const sent = {
    id: "20",
    from: "me",
    requestId: "r1",
    time: 2,
    text: "delivered",
  };
  const other = {
    id: "21",
    from: "peer",
    requestId: "r1",
    time: 3,
    text: "other",
  };
  const withOther = mergeMessage([pending], other, "me");
  assertEquals(withOther.length, 2);
  assertEquals(reconcilePending([pending], [other], "me"), [pending]);
  const delivered = mergeMessage(withOther, sent, "me");
  assertEquals(delivered.map((m: { id: string }) => m.id), ["20", "21"]);
  assertEquals(reconcilePending([pending], [sent], "me"), []);
  const updated = applyEvent(
    delivered,
    { kind: "message", message: { ...sent, text: "updated" } },
    "me",
    1,
  );
  assertEquals(updated.length, 2);
  assertEquals(updated[0].text, "updated");
  assertEquals(sent.text, "delivered");
});
Deno.test("edit, reaction, read and unsend events", () => {
  const original = [{
    id: "1",
    from: "me",
    time: 1,
    text: "old",
    stickerUrl: "https://example.com/1.png",
    hasMedia: true,
  }, { id: "2", from: "peer", time: 2, text: "incoming" }];
  const edited = applyEvent(
    original,
    { kind: "edit", message: { ...original[0], text: "edited" } },
    "me",
    2,
  );
  assertEquals(edited[0].text, "edited");
  assertEquals(
    applyEvent(edited, { kind: "edit", message: { id: "missing" } }, "me", 2)
      .length,
    2,
  );
  const reaction = applyEvent(
    edited,
    {
      kind: "reaction",
      messageId: "1",
      reactions: [{ type: "LOVE", count: 1, mine: true }],
    },
    "me",
    2,
  );
  assertEquals(reaction[0].reactions, [{ type: "LOVE", count: 1, mine: true }]);
  const read = applyEvent(
    reaction,
    { kind: "read", by: "peer", upTo: "2" },
    "me",
    2,
  );
  assertEquals(read[0].readBy, { count: 1, all: false });
  assertEquals(
    applyEvent(read, { kind: "read", by: "peer", upTo: "2" }, "me", 2)[0].readBy
      .count,
    1,
  );
  assertEquals(
    applyEvent(read, { kind: "read", by: "me", upTo: "2" }, "me", 2)[0].readBy
      .count,
    1,
  );
  const unsent = applyEvent(read, { kind: "unsend", messageId: "1" }, "me", 2);
  assertEquals(unsent[0].unsent, true);
  assertEquals(unsent[0].stickerUrl, undefined);
  assertEquals(unsent[0].reactions, undefined);
  assertEquals(original[0].text, "old");
  assertEquals(original[0].hasMedia, true);
});
Deno.test("history revalidates the page and preserves older and pending rows", () => {
  const older = { id: "1", from: "peer", time: 1, text: "older" },
    stale = { id: "2", from: "peer", time: 2, text: "stale" };
  const pending = {
    id: "local",
    from: "me",
    time: 4,
    pending: true,
    requestId: "r",
  };
  const fresh = [{ ...stale, text: "fresh" }, {
    id: "3",
    from: "peer",
    time: 3,
    text: "new",
  }];
  const merged = applyEvent(
    [older, stale, pending],
    { kind: "history", messages: fresh },
    "me",
    0,
  );
  assertEquals(merged.map((m: { id: string }) => m.id), [
    "1",
    "2",
    "3",
    "local",
  ]);
  assertEquals(merged[1].text, "fresh");
  assertEquals(mergeHistory([older, stale], fresh, "me")[1].text, "fresh");
  const page = applyEvent(
    [older, stale],
    {
      kind: "history",
      messages: [{ ...older, text: "newer 1" }, { ...stale, text: "newer 2" }],
    },
    "me",
    0,
  );
  assertEquals(page.map((m: { text: string }) => m.text), [
    "newer 1",
    "newer 2",
  ]);
});
Deno.test("boot resets seq, and duplicate and old events are ignored", () => {
  const mark = { boot: "first", seq: 7, eventsSeen: true };
  assertEquals(acceptEvent(mark, { seq: 7 }, "first").accepted, false);
  assertEquals(acceptEvent(mark, { seq: 6 }, "first").accepted, false);
  const next = acceptEvent(mark, { seq: 8 }, "first");
  assert(next.accepted);
  assertEquals(next.watermark.seq, 8);
  const restarted = acceptEvent(next.watermark, { seq: 1 }, "second");
  assert(restarted.changed);
  assert(restarted.accepted);
  assertEquals(restarted.watermark.seq, 1);
  assertEquals(resetBoot(restarted.watermark, "third").watermark, {
    boot: "third",
    seq: 0,
    eventsSeen: false,
  });
});
Deno.test("chat revision protects pushes against older states", () => {
  const initial = {
    chats: [{ mid: "c", name: "old", unread: 0 }],
    chatList: { complete: true },
    chatBoot: "b",
    chatRevision: 1,
  };
  const push = applyChatPush(
    initial,
    { mid: "c", name: "new", unread: 3 },
    4,
    "b",
  );
  const stale = applyChatState(push, {
    bootId: "b",
    chatsRevision: 3,
    chats: initial.chats,
    chatList: { complete: false },
  });
  assertEquals(stale.chats[0].name, "new");
  assertEquals(stale.chatList.complete, true);
  assertEquals(applyChatPush(stale, { mid: "c", name: "old" }, 3, "b"), stale);
  const restarted = applyChatState(stale, {
    bootId: "c",
    chatsRevision: 1,
    chats: initial.chats,
  });
  assertEquals(restarted.chats[0].name, "old");
  assertEquals(restarted.chatRevision, 1);
  assertEquals(
    visibleChats([{ mid: "x", name: "Hidden", hidden: true, unread: 9 }, {
      mid: "y",
      name: "Unread",
      unread: 2,
    }, { mid: "z", name: "Recent", lastTime: 100 }], "").map((
      c: { mid: string },
    ) => c.mid),
    ["y", "z"],
  );
  assertEquals(
    visibleChats([{ mid: "x", name: "Hidden", hidden: true }], "hidden").length,
    1,
  );
});
Deno.test("safe link splitting, trailing punctuation and UTF-16 mention", () => {
  const text = "😀 @Alice see https://example.com/path). javascript:alert(1)",
    start = text.indexOf("@Alice");
  assertEquals(start, 3);
  const segments = splitText(text, [{ start, end: start + 6 }]);
  assertEquals(segments.map((s: { text: string }) => s.text).join(""), text);
  assertEquals(
    segments.find((s: { mention: boolean }) => s.mention)?.text,
    "@Alice",
  );
  assertEquals(
    segments.filter((s: { url: string }) => s.url).map((s: { text: string }) =>
      s.text
    ),
    ["https://example.com/path"],
  );
  assert(
    segments.some((s: { text: string; url: string }) =>
      s.text.includes("javascript:alert(1)") && !s.url
    ),
  );
  assertEquals(
    splitText("javascript:alert(1)", []).some((s: { url: string }) => !!s.url),
    false,
  );
});
class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
Deno.test("storage failures preserve the in-memory draft and report once", () => {
  const storage = {
    getItem(_key: string): string | null {
      throw new Error("unavailable");
    },
    setItem(_key: string, _value: string): void {
      throw new Error("unavailable");
    },
    removeItem(_key: string): void {
      throw new Error("unavailable");
    },
  };
  let failures = 0;
  const store = createDraftStore(createModel(), storage, () => failures++);
  store.chatDraft("a", "one").text = "kept";
  store.saveStorage();
  store.saveStorage();
  assertEquals(failures, 1);
  assertEquals(store.chatDraft("a", "one").text, "kept");
});
Deno.test("drafts and pending sends remain isolated by account and chat", () => {
  const storage = new MemoryStorage(),
    model = createModel(),
    store = createDraftStore(model, storage);
  store.chatDraft("a", "one").text = "first";
  store.chatDraft("a", "two").text = "second";
  store.chatDraft("b", "one").text = "other";
  store.writePending("one", [{ requestId: "r" }], "a");
  const restored = createDraftStore(createModel(), storage);
  assertEquals(restored.chatDraft("a", "one").text, "first");
  assertEquals(restored.chatDraft("a", "two").text, "second");
  assertEquals(restored.chatDraft("b", "one").text, "other");
  assertEquals(restored.pendingFor("one", "a"), [{ requestId: "r" }]);
  assertEquals(restored.pendingFor("one", "b"), []);
  restored.forgetPending("one", "r", "a");
  assertEquals(restored.pendingFor("one", "a"), []);
  assertEquals(restored.chatDraft("b", "one").text, "other");
});
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  constructor(_url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data !== "string") throw new Error("expected a text frame");
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  emit(type: string, data?: string) {
    this.dispatchEvent(
      type === "message" ? new MessageEvent(type, { data }) : new Event(type),
    );
  }
}
Deno.test("connection matches IDs and rejects pending commands on disconnect", async () => {
  FakeSocket.instances = [];
  const model = createModel();
  model.signedIn = true;
  const delays: number[] = [], callbacks: (() => void)[] = [];
  const connection = createConnection({
    model,
    url: "ws://test",
    WebSocketClass: FakeSocket,
    schedule: (callback: () => void, delay: number) => {
      callbacks.push(callback);
      delays.push(delay);
      return delays.length;
    },
    cancel: () => {},
    offlineMessage: () => "offline",
  });
  connection.start();
  const socket = FakeSocket.instances[0];
  socket.emit("message", JSON.stringify({ web: "state", state: {} }));
  const first = connection.command("history", { chat: "a" }),
    second = connection.command("stickers");
  const frames = socket.sent.map((s) => JSON.parse(s));
  socket.emit(
    "message",
    JSON.stringify({ id: frames[1].id, ok: true, data: "second" }),
  );
  socket.emit(
    "message",
    JSON.stringify({ id: frames[0].id, ok: true, data: "first" }),
  );
  assertEquals(await first, "first");
  assertEquals(await second, "second");
  const pending = connection.command("send", { text: "pending" });
  socket.close();
  const error = await assertRejects(() => pending, Error, "offline");
  assertEquals((error as Error & { ambiguous?: boolean }).ambiguous, true);
  assertEquals(delays, [1000]);
});
Deno.test("connection backs off 1, 2, 4, 8, 15 seconds then resets on a frame", () => {
  FakeSocket.instances = [];
  const model = createModel();
  model.signedIn = true;
  const delays: number[] = [], callbacks: (() => void)[] = [];
  const connection = createConnection({
    model,
    url: "ws://test",
    WebSocketClass: FakeSocket,
    schedule: (callback: () => void, delay: number) => {
      callbacks.push(callback);
      delays.push(delay);
      return delays.length;
    },
    cancel: () => {},
  });
  connection.start();
  for (let i = 0; i < 6; i++) {
    FakeSocket.instances[i].close();
    callbacks.shift()?.();
  }
  assertEquals(delays, [1000, 2000, 4000, 8000, 15000, 15000]);
  FakeSocket.instances[6].emit(
    "message",
    JSON.stringify({ web: "state", state: {} }),
  );
  FakeSocket.instances[6].close();
  assertEquals(delays.at(-1), 1000);
});
Deno.test("language defaults to Traditional Chinese except English tags", () => {
  assert(isEnglish("en-US"));
  assertEquals(isEnglish("fr-FR"), false);
  assertEquals(createTranslator("en-US")("send"), "Send");
  assertEquals(createTranslator("fr-FR")("send"), "送出");
});

type ContextSource = { name: string; text: string };
type ContextContract = {
  references: Map<string, Set<string>>;
  missing: string[];
  duplicate: string[];
  unused: string[];
  invalid: string[];
};

// Factories return shorthand names in a two-space-indented object. The app
// registers every factory and initial context value with provide(...).
function inspectContext(sources: ContextSource[]): ContextContract {
  const references = new Map<string, Set<string>>();
  const factories = new Map<string, { file: string; keys: string[] | null }>();
  const providers = new Map<string, string>();
  const duplicate: string[] = [], invalid: string[] = [];
  const assembly = sources.find((source) => source.name === "app.js")?.text ||
    "";
  const add = (key: string, origin: string) => {
    const previous = providers.get(key);
    if (previous !== undefined) {
      duplicate.push(`${key}: ${previous}, ${origin}`);
    } else providers.set(key, origin);
  };
  const keysOf = (text: string, origin: string): string[] => {
    const keys = text.split(",").map((key) => key.trim()).filter(Boolean);
    for (const key of keys) {
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
        invalid.push(`${origin}: unsupported key ${key}`);
      }
    }
    return keys;
  };
  for (const source of sources) {
    const names = new Set<string>();
    for (
      const match of source.text.matchAll(/\bctx\.((?!\$\{)[A-Za-z_$][\w$]*)/g)
    ) names.add(match[1]);
    references.set(source.name, names);
    if (
      /\bctx\s*(?:\[|\?\.)/.test(source.text) ||
      /\b(?:const|let|var)\s*(?:\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=\s*ctx\s*(?:[;,]|$)/m
        .test(source.text)
    ) {
      invalid.push(`${source.name}: untracked ctx access`);
    }
    for (
      const match of source.text.matchAll(/^export function (create\w+)\s*\(/gm)
    ) {
      const end = source.text.indexOf("\n}", match.index);
      if (end < 0) {
        invalid.push(`${source.name}: ${match[1]} has no closing brace`);
        continue;
      }
      const body = source.text.slice(match.index, end);
      const returned = body.match(/^ {2}return \{([^{}]*)\};/m);
      if (factories.has(match[1])) {
        invalid.push(`duplicate factory ${match[1]}`);
      }
      factories.set(match[1], {
        file: source.name,
        keys: returned ? keysOf(returned[1], match[1]) : null,
      });
    }
  }
  let parsedProviders = 0;
  for (
    const match of assembly.matchAll(
      /\bprovide\(\s*["']([^"']+)["']\s*,\s*\{([^{}]*)\}\s*\)/g,
    )
  ) {
    parsedProviders++;
    for (const key of keysOf(match[2], match[1])) add(key, match[1]);
  }
  const registered = new Set<string>();
  for (
    const match of assembly.matchAll(
      /\bprovide\(\s*["']([^"']+)["']\s*,\s*(create\w+)\s*\(/g,
    )
  ) {
    parsedProviders++;
    const factory = factories.get(match[2]);
    if (!factory || factory.keys === null) {
      invalid.push(`${match[1]}: unknown or unsupported factory ${match[2]}`);
      continue;
    }
    registered.add(match[2]);
    for (const key of factory.keys) add(key, `${match[1]} (${factory.file})`);
  }
  const calls = [...assembly.matchAll(/\bprovide\s*\(/g)].length;
  if (calls !== parsedProviders) {
    invalid.push(`app.js: ${calls - parsedProviders} unparsed provide call(s)`);
  }
  const directFactories = new Set<string>();
  for (
    const match of assembly.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*=\s*(create\w+)\s*\(/g,
    )
  ) {
    if (providers.has(match[1])) directFactories.add(match[2]);
  }
  for (const [name, factory] of factories) {
    if (!registered.has(name) && !directFactories.has(name)) {
      invalid.push(`${factory.file}: unregistered ${name}`);
    }
  }
  const used = new Set([...references.values()].flatMap((names) => [...names]));
  const missing = [...used].filter((key) => !providers.has(key)).map((key) => {
    const files = [...references].filter(([, names]) => names.has(key)).map((
      [name],
    ) => name);
    return `${key}: ${files.join(", ")}`;
  }).sort();
  const unused = [...providers].filter(([key]) => !used.has(key)).map((
    [key, origin],
  ) => `${key}: ${origin}`).sort();
  return {
    references,
    missing,
    duplicate: duplicate.sort(),
    unused,
    invalid: invalid.sort(),
  };
}

Deno.test("context uses exactly the names provided by the assembled factories", async () => {
  const dir = new URL("./public/js/", import.meta.url),
    sources: ContextSource[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".js")) {
      sources.push({
        name: entry.name,
        text: await Deno.readTextFile(new URL(entry.name, dir)),
      });
    }
  }
  assert(sources.some((source) => source.name === "app.js"));
  const result = inspectContext(sources);
  assertEquals(result.invalid, [], "Unsupported or missing declarations");
  assertEquals(result.duplicate, [], "Duplicate context providers");
  assertEquals(result.missing, [], "Missing context providers");
  assertEquals(result.unused, [], "Unused context providers");
  const dependencies = [...result.references].filter(([, names]) => names.size)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, names]) => `${file}: ${[...names].sort().join(", ")}`);
  console.log(`Context dependencies:\n${dependencies.join("\n")}`);
});

Deno.test("context inspection detects missing, duplicate and unused names", () => {
  const sources = [
    {
      name: "app.js",
      text:
        'provide("app", { model });\nprovide("one", createOne(ctx));\nprovide("two", createTwo(ctx));\nctx.model;',
    },
    {
      name: "one.js",
      text:
        "export function createOne(ctx) {\n  ctx.missing();\n  return { shared, unused };\n}",
    },
    {
      name: "two.js",
      text:
        "export function createTwo(ctx) {\n  ctx.shared();\n  return { shared };\n}",
    },
  ];
  const result = inspectContext(sources);
  assertEquals(result.invalid, []);
  assertEquals(result.missing, ["missing: one.js"]);
  assertEquals(result.duplicate, ["shared: one (one.js), two (two.js)"]);
  assertEquals(result.unused, ["unused: one (one.js)"]);
});

Deno.test("context inspection rejects untracked access and hidden factory APIs", () => {
  const sources = [
    {
      name: "app.js",
      text:
        'provide("app", { model });\nprovide("broken", createBroken(ctx));\nctx.model;',
    },
    {
      name: "broken.js",
      text:
        'export function createBroken(ctx) {\n  const { mystery } = ctx;\n  ctx["other"]();\n  const api = { mystery };\n  return api;\n}',
    },
  ];
  const result = inspectContext(sources);
  assert(result.invalid.includes("broken.js: untracked ctx access"));
  assert(
    result.invalid.includes(
      "broken: unknown or unsupported factory createBroken",
    ),
  );
});

Deno.test("registry rejects collisions and unknown reads and freezes context", () => {
  const registry = makeRegistry();
  registry.provide("first", { value: 1 });
  assertEquals(Reflect.get(registry.assembling, "value"), 1);
  assertThrows(
    () => registry.provide("second", { other: 2, value: 3 }),
    Error,
    "duplicate ctx.value from first and second",
  );
  assertThrows(
    () => Reflect.get(registry.assembling, "other"),
    Error,
    "unknown ctx.other",
  );
  const ctx = registry.finish();
  assert(Object.isFrozen(ctx));
  assert(Object.isFrozen(registry.assembling));
  assertEquals(Reflect.get(ctx, "value"), 1);
  assertThrows(() => Reflect.get(ctx, "missing"), Error, "unknown ctx.missing");
  assertThrows(
    () => Reflect.get(registry.assembling, "missing"),
    Error,
    "unknown ctx.missing",
  );
  assertThrows(
    () => Reflect.set(ctx, "value", 4),
    TypeError,
    "ctx is read-only",
  );
  assertThrows(() => registry.provide("late", { extra: 1 }), TypeError);
});

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
import { avatarInitial, splitText } from "./public/js/text.js";
import { createDraftStore } from "./public/js/drafts.js";
import { createConnection } from "./public/js/connection.js";
import { createModel } from "./public/js/model.js";
import { makeRegistry } from "./public/js/registry.js";
import { createTranslator, isEnglish } from "./public/js/i18n.js";
import { mediaKind, sizeRefusal } from "./public/js/media-kind.js";
import { uploadName } from "./files.ts";
import { loadBlocks } from "../slice_test.ts";
import { planKeyChanges } from "./public/js/keyed.js";
import { createChatController } from "./public/js/controller-chat.js";
import { createStateController } from "./public/js/controller-state.js";
import { createSendController } from "./public/js/controller-send.js";
import { createComposerController } from "./public/js/controller-composer.js";

Deno.test("keyed changes keep the largest ordered set of existing rows", () => {
  const examples = [
    {
      before: [],
      after: ["a", "b"],
      added: ["a", "b"],
      removed: [],
      moved: [],
    },
    {
      before: ["a", "b"],
      after: ["x", "a", "b"],
      added: ["x"],
      removed: [],
      moved: [],
    },
    {
      before: ["a", "b", "c"],
      after: ["b", "c", "a"],
      added: [],
      removed: [],
      moved: ["a"],
    },
    {
      before: ["a", "b", "c"],
      after: ["c", "x", "a"],
      added: ["x"],
      removed: ["b"],
      moved: ["c"],
    },
    {
      before: ["local", "b"],
      after: ["sent", "b"],
      added: ["sent"],
      removed: ["local"],
      moved: [],
    },
    {
      before: ["a", "b"],
      after: [],
      added: [],
      removed: ["a", "b"],
      moved: [],
    },
  ];
  for (const { before, after, added, removed, moved } of examples) {
    const plan = planKeyChanges(before, after);
    assertEquals(plan, { removed, added, moved });
    const nodes = before.filter((key) => !removed.includes(key));
    const placements = new Set([...added, ...moved]);
    for (let i = after.length - 1; i >= 0; i--) {
      if (!placements.has(after[i])) continue;
      const at = nodes.indexOf(after[i]);
      if (at >= 0) nodes.splice(at, 1);
      const next = i + 1 < after.length
        ? nodes.indexOf(after[i + 1])
        : nodes.length;
      nodes.splice(next, 0, after[i]);
    }
    assertEquals(nodes, after);
  }
});

Deno.test("keyed plans produce every short insertion, removal and reorder", () => {
  function sequences(remaining: string[], prefix: string[] = []): string[][] {
    return [
      prefix,
      ...remaining.flatMap((key, index) =>
        sequences(remaining.filter((_, i) => i !== index), [...prefix, key])
      ),
    ];
  }
  const cases = sequences(["a", "b", "c", "d"]);
  for (const before of cases) {
    for (const after of cases) {
      const { removed, added, moved } = planKeyChanges(before, after);
      const nodes = before.filter((key) => !removed.includes(key));
      const placements = new Set([...added, ...moved]);
      for (let i = after.length - 1; i >= 0; i--) {
        if (!placements.has(after[i])) continue;
        const at = nodes.indexOf(after[i]);
        if (at >= 0) nodes.splice(at, 1);
        const next = i + 1 < after.length
          ? nodes.indexOf(after[i + 1])
          : nodes.length;
        nodes.splice(next, 0, after[i]);
      }
      assertEquals(nodes, after, `${before.join(",")} -> ${after.join(",")}`);
    }
  }
});

type MediaKind = "image" | "gif" | "video" | "file";
interface MediaSendBlock {
  KIND_BY_EXT: Record<string, MediaKind | undefined>;
  IMAGE_BRANDS: string[];
  AUDIO_BRANDS: string[];
  SEND_MAX_BYTES: Record<MediaKind, number>;
  mediaKindOf(path: string, head: Uint8Array): MediaKind;
  sizeRefusalText(kind: MediaKind, size: number): string | null;
}

Deno.test("browser media classification and refusals match daemon blocks", async () => {
  const video = new URL("../modules/video.ts", import.meta.url).href;
  const daemon = await loadBlocks<MediaSendBlock>(
    ["mediakind", "sendcap"],
    `import { tagAt } from "${video}";
     export { KIND_BY_EXT, IMAGE_BRANDS, AUDIO_BRANDS, SEND_MAX_BYTES,
       mediaKindOf, sizeRefusalText };`,
  );
  const bytes = (text: string) => new TextEncoder().encode(text);
  const signatures = [
    new Uint8Array(),
    new Uint8Array([0xff, 0xd8, 0xff]),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
    bytes("GIF87a"),
    bytes("GIF89a"),
    bytes("RIFF....WEBP"),
    bytes("RIFF....AVI "),
    bytes("RIFF....WAVE"),
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
    bytes("....ftyp"),
    bytes("....ftypiso"),
    ...Array.from(
      new Set([
        ...daemon.IMAGE_BRANDS,
        ...daemon.AUDIO_BRANDS,
        "heic",
        "heix",
        "hevc",
        "hevx",
        "heim",
        "heis",
        "mif1",
        "msf1",
        "avif",
        "avis",
        "M4A ",
        "M4B ",
        "M4P ",
        "F4A ",
        "F4B ",
        "isom",
        "mp42",
        "avc1",
        "qt  ",
        "3gp4",
      ]),
    ).map((brand) => bytes(`....ftyp${brand}`)),
  ];
  const names = [
    ...Array.from(
      new Set([
        ...Object.keys(daemon.KIND_BY_EXT),
        "jpg",
        "jpeg",
        "png",
        "webp",
        "heic",
        "heif",
        "avif",
        "gif",
        "mp4",
        "m4v",
        "mov",
        "webm",
        "mkv",
        "avi",
      ]),
    ).flatMap((extension) => [
      `picked.${extension}`,
      `picked.${extension.toUpperCase()}`,
    ]),
    "picked.pdf",
    "README",
    ".hidden",
    "dir/shot.png",
    "dir\\clip.mp4",
    " padded.JPG ",
    `${"a".repeat(200)}.png`,
    ".",
    "..",
    "",
  ];
  for (const name of names) {
    for (const head of signatures) {
      assertEquals(
        mediaKind(name, head),
        daemon.mediaKindOf(uploadName(name || "image.png"), head),
        `${JSON.stringify(name)} with ${Array.from(head).join(",")}`,
      );
    }
  }

  const zh = createTranslator("zh-TW"), en = createTranslator("en-US");
  for (const kind of ["image", "gif", "video", "file"] as MediaKind[]) {
    const cap = daemon.SEND_MAX_BYTES[kind];
    for (const size of [0, cap - 1, cap, cap + 1, 2 * 1024 ** 3]) {
      const key = sizeRefusal(kind, size);
      assertEquals(
        key ? zh(key) : null,
        daemon.sizeRefusalText(kind, size),
        `${kind} ${size}`,
      );
      if (key) {
        assertEquals(
          en(key),
          kind === "video"
            ? "Video too large (over 1 GB)"
            : kind === "file"
            ? "File too large (over 1 GB)"
            : "Image too large (over 20 MB)",
        );
      }
    }
  }
});

Deno.test("upload kind and limits follow magic before extension", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  assertEquals(mediaKind("photo.txt", png), "image");
  assertEquals(mediaKind("photo.jpg", bytes("....ftypmp42")), "video");
  assertEquals(mediaKind("x.mov", bytes("....ftypM4A ")), "file");
  assertEquals(mediaKind("x.mp4", bytes("....ftypheic")), "image");
  assertEquals(mediaKind("x.dat", bytes("GIF89a")), "gif");
  assertEquals(mediaKind("x.dat", bytes("RIFF....WEBP")), "image");
  assertEquals(mediaKind("x.dat", bytes("RIFF....AVI ")), "video");
  assertEquals(mediaKind("x.JPG", bytes("unknown")), "image");
  assertEquals(mediaKind("x.constructor", bytes("unknown")), "file");
  assertEquals(mediaKind("x.gif", bytes("....ftyp")), "gif");
  assertEquals(
    mediaKind("x", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
    "video",
  );
  assertEquals(sizeRefusal("image", 20 * 1024 * 1024), "");
  assertEquals(sizeRefusal("gif", 20 * 1024 * 1024 + 1), "imageTooLarge");
  assertEquals(sizeRefusal("video", 1024 ** 3 + 1), "videoTooLarge");
  assertEquals(sizeRefusal("file", 1024 ** 3 + 1), "fileTooLarge");
});

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

Deno.test("events received during an older page update that page too", async () => {
  type Row = { id: string; from: string; text: string; unsent?: boolean };
  const model: Omit<ReturnType<typeof createModel>, "messages"> & {
    messages: Row[];
  } = { ...createModel(), messages: [] };
  model.account = "me";
  model.active = "c";
  model.boot = "boot";
  model.messages = [{ id: "500", from: "peer", text: "existing" }];
  let resolvePage: (rows: object[]) => void = () => {};
  let state: ReturnType<typeof createStateController>;
  const ctx = {
    model,
    command: () => new Promise<object[]>((resolve) => resolvePage = resolve),
    reconcilePending: () => {},
    renderMessages: () => {},
    isViewingChat: () => false,
    applyEvent: (event: object, render: boolean) =>
      state.applyEvent(event, render),
  };
  state = createStateController(ctx);
  const chat = createChatController(ctx);
  const loading = chat.loadOlder();
  state.onFrame({
    boot: "boot",
    event: { seq: 1, kind: "unsend", chat: "c", messageId: "499" },
  });
  state.onFrame({
    boot: "boot",
    event: {
      seq: 2,
      kind: "edit",
      chat: "c",
      message: { id: "500", from: "peer", text: "edited" },
    },
  });
  assertEquals(model.messages[0].text, "edited", "live changes stay immediate");
  resolvePage([{ id: "499", from: "peer", text: "revoked" }]);
  await loading;
  const older = model.messages.find((m: { id: string }) => m.id === "499");
  assertEquals(older?.unsent, true);
  assertEquals(older?.text, "");
  assertEquals(model.historyEvents, []);
});

Deno.test("replacement history retains older-page events without duplicate reads", async () => {
  type Row = { id: string; from: string; text: string; unsent?: boolean };
  const model: Omit<ReturnType<typeof createModel>, "messages"> & {
    messages: Row[];
  } = { ...createModel(), messages: [] };
  model.account = "me";
  model.active = "c";
  model.boot = "boot";
  model.messages = [{ id: "500", from: "peer", text: "original" }];
  const requests: ((rows: Row[]) => void)[] = [];
  let reads = 0;
  const ctx = {
    model,
    command: (cmd: string) => {
      if (cmd === "markRead") {
        reads++;
        return Promise.resolve([]);
      }
      return new Promise<Row[]>((resolve) => requests.push(resolve));
    },
    reconcilePending: () => {},
    renderMessages: () => {},
    displayError: (error: Error) => {
      throw error;
    },
    isViewingChat: () => true,
    applyEvent: (event: object, render: boolean) =>
      state.applyEvent(event, render),
  };
  const state = createStateController(ctx), chat = createChatController(ctx);
  const older = chat.loadOlder();
  state.onFrame({
    boot: "boot",
    event: { seq: 1, kind: "unsend", chat: "c", messageId: "500" },
  });
  state.onFrame({
    boot: "boot",
    event: {
      seq: 2,
      kind: "message",
      chat: "c",
      message: { id: "501", from: "peer", text: "before sync" },
    },
  });
  assertEquals(reads, 1);
  const firstRefresh = chat.loadHistory("c", false, true);
  state.onFrame({
    boot: "boot",
    event: {
      seq: 3,
      kind: "message",
      chat: "c",
      message: { id: "502", from: "peer", text: "during sync" },
    },
  });
  const secondRefresh = chat.loadHistory("c", false, true);
  assertEquals(requests.length, 3);
  requests[1]([{ id: "stale", from: "peer", text: "stale refresh" }]);
  await firstRefresh;
  requests[2]([{ id: "500", from: "peer", text: "original" }]);
  await secondRefresh;
  assertEquals(model.messages.find((row) => row.id === "500")?.unsent, true);
  assertEquals(model.messages.filter((row) => row.id === "501").length, 1);
  assertEquals(model.messages.filter((row) => row.id === "502").length, 1);
  assertEquals(reads, 2);
  requests[0]([{ id: "499", from: "peer", text: "stale older" }]);
  await older;
  assertEquals(model.messages.some((row) => row.id === "499"), false);
  assertEquals(model.messages.some((row) => row.id === "stale"), false);
  assertEquals(model.historyEvents, []);
});

Deno.test("a reopened chat ignores an older members response", async () => {
  const model = createModel();
  model.account = "me";
  const responses: ((rows: object[]) => void)[] = [];
  const ctx = {
    model,
    command: (cmd: string) =>
      cmd === "members"
        ? new Promise<object[]>((resolve) => responses.push(resolve))
        : Promise.resolve([]),
    saveComposer: () => {},
    closeStickerPicker: () => {},
    showChat: () => {},
    restoreComposer: () => {},
    renderActiveHeader: () => {},
    renderChats: () => {},
    renderMessages: () => {},
    focusComposer: () => {},
    updateMentionPicker: () => {},
    reconcilePending: () => {},
    displayError: () => {},
  };
  const chat = createChatController(ctx);
  chat.openChat("c1");
  chat.openChat("u2");
  chat.openChat("c1");
  assertEquals(responses.length, 2);
  responses[1]([{ mid: "new", name: "New" }]);
  await Promise.resolve();
  responses[0]([{ mid: "old", name: "Old" }]);
  await Promise.resolve();
  assertEquals(model.members, [{ mid: "new", name: "New" }]);
});

Deno.test("background markRead failures only write a debug line", async () => {
  const model = createModel();
  model.account = "me";
  model.active = "c";
  model.boot = "boot";
  const lines: string[] = [], original = console.debug;
  console.debug = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    const ctx = {
      model,
      isViewingChat: () => true,
      command: () => Promise.reject(new Error("read failure")),
      renderMessages: () => {},
    };
    const state = createStateController(ctx), chat = createChatController(ctx);
    state.onFrame({
      boot: "boot",
      event: {
        seq: 1,
        kind: "message",
        chat: "c",
        message: { id: "1", from: "peer", text: "hello" },
      },
    });
    await Promise.resolve();
    chat.markCurrentRead();
    await Promise.resolve();
    assertEquals(lines, ["[markRead] failed", "[markRead] failed"]);
  } finally {
    console.debug = original;
  }
});

Deno.test("member errors keep the mention picker visible without matches", () => {
  const model = createModel();
  model.active = "c";
  model.membersError = "members unavailable";
  let visible = false;
  const composer = createComposerController({
    model,
    readComposer: () => ({ text: "@nobody", cursor: 7, end: 7 }),
    renderMentionChoices: () => {},
    setMentionVisibility: (value: boolean) => visible = value,
  });
  composer.updateMentionPicker();
  assertEquals(model.mentionChoices, []);
  assertEquals(visible, true);
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
Deno.test("avatar initials preserve graphemes or a complete code point", () => {
  assertEquals(avatarInitial("👩‍👩‍👧‍👦 Family"), "👩‍👩‍👧‍👦");
  assertEquals(avatarInitial("😀 Family", null), "😀");
  assertEquals(avatarInitial(" alpha"), "A");
  assertEquals(avatarInitial("  "), "?");
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
Deno.test("acknowledged sends stay visible until their own echo", async () => {
  for (const echoFirst of [false, true]) {
    const model = createModel();
    model.account = "me";
    model.active = "chat";
    model.boot = "boot";
    const store = createDraftStore(model, new MemoryStorage());
    let acknowledge = () => {};
    const ctx = {
      model,
      t: (key: string) => key,
      ...store,
      renderMessages: () => {},
      isViewingChat: () => false,
      displayError: () => {},
      toast: () => {},
      sendFiles: () => {},
      command: () => new Promise<void>((resolve) => acknowledge = resolve),
    };
    const send = createSendController(ctx), state = createStateController(ctx);
    const message = send.optimistic("chat", "send", { text: "hello" }, {
      text: "hello",
    });
    send.sendOptimistic("chat", message);
    const echo = () =>
      state.onFrame({
        boot: "boot",
        event: {
          seq: 1,
          kind: "message",
          chat: "chat",
          message: { id: "1", from: "me", requestId: message.requestId },
        },
      });
    if (echoFirst) echo();
    acknowledge();
    await Promise.resolve();
    assertEquals(store.pendingFor("chat", "me"), []);
    assertEquals(model.sent.size, echoFirst ? 0 : 1);
    if (!echoFirst) {
      assertEquals(model.sent.get(message.requestId)?.status, "sent");
      state.reconcilePending("other", [{
        from: "me",
        requestId: message.requestId,
      }]);
      state.reconcilePending("chat", [{
        from: "peer",
        requestId: message.requestId,
      }]);
      assertEquals(model.sent.size, 1);
      echo();
    }
    assertEquals(model.sent.size, 0);
    assertEquals(model.messages, [{
      id: "1",
      from: "me",
      requestId: message.requestId,
    }]);
  }
});
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
Deno.test("retained files are released with their pending rows or account", () => {
  const model = createModel(),
    store = createDraftStore(model, new MemoryStorage());
  model.files.set("a1", new File(["a"], "a.txt"));
  model.files.set("a2", new File(["a"], "b.txt"));
  model.files.set("b1", new File(["b"], "c.txt"));
  store.writePending("one", [{ requestId: "a1" }, { requestId: "a2" }], "a");
  store.writePending("one", [{ requestId: "b1" }], "b");
  store.writePending("one", [{ requestId: "a2" }], "a");
  assertEquals([...model.files.keys()].sort(), ["a2", "b1"]);
  store.clearLastAccount("a");
  assertEquals([...model.files.keys()], ["b1"]);
  assertEquals(store.pendingFor("one", "b"), [{ requestId: "b1" }]);
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
      /(?:^|[^\w$.])\(\s*ctx\s*\)/m.test(source.text) ||
      /\b(?:const|let|var)\s*(?:\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=\s*ctx\b(?!\s*\.)/m
        .test(source.text) ||
      /\b[A-Za-z_$][\w$]*\s*=\s*ctx\b(?!\s*\.)/m.test(source.text)
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

Deno.test("context inspection rejects parenthesized access and aliases", () => {
  for (
    const statement of [
      "(ctx).missing();",
      'ctx["missing"]();',
      "const alias = ctx || {}; alias.missing();",
      "let alias; alias = ctx; alias.missing();",
    ]
  ) {
    const result = inspectContext([{
      name: "app.js",
      text:
        'provide("app", { model });\nprovide("one", createOne(ctx));\nctx.model;\nctx.run;',
    }, {
      name: "one.js",
      text:
        `export function createOne(ctx) {\n  ${statement}\n  return { run };\n}`,
    }]);
    assert(
      result.invalid.includes("one.js: untracked ctx access"),
      `untracked expression accepted: ${statement}`,
    );
  }
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

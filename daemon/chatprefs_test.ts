/**
 * Pinned and muted chats: the two daemon-side preference files, the flags
 * they put on the state.json rows, and the places the rest of the daemon
 * reaches them from.
 *
 *   deno test -A chatprefs_test.ts
 *
 * The block is driven for real against a temp directory on top of the real
 * hidden block (it needs isChatMid() and hiddenStamped()) and the real
 * writeAtomic(). The last tests read the sources and pin the call sites: a
 * command that is not routed, a boot that does not load the files, or a
 * notify() that still fires would leave every other test here green.
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlocks } from "./slice_test.ts";

const PRELUDE = `
import { writeAtomic } from ${
  JSON.stringify(new URL("./atomicfile.ts", import.meta.url).href)
};
// Unwritable defaults: a missed path argument fails rather than touching a
// state dir.
const HIDDEN_PATH = "/nonexistent/enil-hidden.json";
const PINNED_PATH = "/nonexistent/enil-pinned.json";
const MUTED_PATH = "/nonexistent/enil-muted.json";
function errorLine(e: unknown): string { return String(e); }
export {
  CHAT_PREF_MAX,
  chatsStamped,
  isMuted,
  mutedChats,
  pinnedChats,
  setHidden,
};
`;

interface ChatPref {
  readonly mids: Set<string>;
  has(mid: string): boolean;
  set(mid: string, on: boolean): boolean;
  save(path?: string): Promise<void>;
  load(path?: string): Promise<void>;
}
interface PrefsModule {
  CHAT_PREF_MAX: number;
  chatsStamped<T extends { mid: string }>(list: T[]): Array<
    T & { hidden?: true; pinned?: true; muted?: true }
  >;
  isMuted(mid: string): boolean;
  mutedChats: ChatPref;
  pinnedChats: ChatPref;
  setHidden(mid: string, on: boolean): boolean;
}

/** A fresh module each time: the sets are module state. */
function mod(): Promise<PrefsModule> {
  return loadBlocks<PrefsModule>(["hidden", "chatprefs"], PRELUDE);
}

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "enil-chatprefs-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("pinned and muted chats survive a restart in their own files", async () => {
  await inTempDir(async (dir) => {
    const m = await mod();
    m.pinnedChats.set("cgroup", true);
    m.pinnedChats.set("umom", true);
    m.mutedChats.set("cnoisy", true);
    await m.pinnedChats.save(`${dir}/pinned.json`);
    await m.mutedChats.save(`${dir}/muted.json`);
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/pinned.json`)), {
      mids: ["cgroup", "umom"],
    });
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/muted.json`)), {
      mids: ["cnoisy"],
    });
    const mode = (await Deno.stat(`${dir}/pinned.json`)).mode ?? 0;
    assertEquals(mode & 0o777, 0o600);

    const next = await mod();
    assertEquals(next.pinnedChats.has("cgroup"), false, "fresh boot is empty");
    await next.pinnedChats.load(`${dir}/pinned.json`);
    await next.mutedChats.load(`${dir}/muted.json`);
    assertEquals([...next.pinnedChats.mids], ["cgroup", "umom"]);
    assertEquals(next.isMuted("cnoisy"), true);
    assertEquals(next.isMuted("cgroup"), false);
  });
});

Deno.test("unpin and unmute take the mid out of the file", async () => {
  await inTempDir(async (dir) => {
    const m = await mod();
    m.mutedChats.set("cgroup", true);
    m.mutedChats.set("umom", true);
    m.mutedChats.set("cgroup", false);
    await m.mutedChats.save(`${dir}/muted.json`);
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/muted.json`)), {
      mids: ["umom"],
    });
  });
});

Deno.test("setting twice is setting once, both ways", async () => {
  const m = await mod();
  for (const pref of [m.pinnedChats, m.mutedChats]) {
    assertEquals(pref.set("cgroup", true), true);
    assertEquals(pref.set("cgroup", true), false);
    assertEquals(pref.set("cgroup", false), true);
    assertEquals(pref.set("cgroup", false), false);
    assertEquals(pref.set("unever", false), false);
    assertEquals(pref.mids.size, 0);
  }
});

Deno.test("the two preferences do not share a set", async () => {
  const m = await mod();
  m.pinnedChats.set("cgroup", true);
  assertEquals(m.mutedChats.has("cgroup"), false);
  m.mutedChats.set("umom", true);
  assertEquals(m.pinnedChats.has("umom"), false);
});

Deno.test("a bad file loads as nothing, and bad entries are dropped", async () => {
  await inTempDir(async (dir) => {
    const path = `${dir}/pinned.json`;
    for (
      const bad of ["", "{", "null", "42", "[]", '{"mids":"cgroup"}']
    ) {
      await Deno.writeTextFile(path, bad);
      const m = await mod();
      await m.pinnedChats.load(path);
      assertEquals(m.pinnedChats.mids.size, 0, bad);
    }
    const huge = "u" + "x".repeat(200);
    await Deno.writeTextFile(
      path,
      JSON.stringify({ mids: ["cgroup", 7, "", null, huge, "../c", "umom"] }),
    );
    const m = await mod();
    await m.pinnedChats.load(path);
    assertEquals([...m.pinnedChats.mids], ["cgroup", "umom"]);
    // A missing file is the first boot, not an error.
    await Deno.remove(path);
    const fresh = await mod();
    await fresh.pinnedChats.load(path);
    assertEquals(fresh.pinnedChats.mids.size, 0);
  });
});

Deno.test("a failed write keeps the old file and the next one recovers", async () => {
  await inTempDir(async (dir) => {
    const path = `${dir}/muted.json`;
    const m = await mod();
    m.mutedChats.set("old", true);
    await m.mutedChats.save(path);
    m.mutedChats.set("new", true);
    const rename = Deno.rename;
    Deno.rename = () => Promise.reject(new Error("disk full"));
    try {
      // Logged, not thrown: the command still answers.
      await m.mutedChats.save(path);
    } finally {
      Deno.rename = rename;
    }
    assertEquals(JSON.parse(await Deno.readTextFile(path)), { mids: ["old"] });
    await m.mutedChats.save(path);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      mids: ["old", "new"],
    });
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
      ["muted.json"],
      "no temp file is left behind",
    );
  });
});

Deno.test("a queued write carries the set as it is when it runs", async () => {
  await inTempDir(async (dir) => {
    const path = `${dir}/pinned.json`;
    const m = await mod();
    m.pinnedChats.set("cgroup", true);
    const first = m.pinnedChats.save(path);
    m.pinnedChats.set("umom", true);
    const second = m.pinnedChats.save(path);
    await first;
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      mids: ["cgroup", "umom"],
    });
    await second;
  });
});

Deno.test("each list has a bound", async () => {
  const m = await mod();
  for (let i = 0; i < m.CHAT_PREF_MAX + 5; i++) {
    m.pinnedChats.set(`c${i}`, true);
  }
  assertEquals(m.pinnedChats.mids.size, m.CHAT_PREF_MAX);
  assertEquals(m.pinnedChats.has("c4"), false);
  assertEquals(m.pinnedChats.has("c5"), true);
});

Deno.test("state rows carry pinned and muted only when true, on copies", async () => {
  const m = await mod();
  const chats = [
    { mid: "cgroup", name: "a", unread: 3 },
    { mid: "umom", name: "b", unread: 0 },
    { mid: "cwork", name: "c", unread: 1 },
  ];
  // Nothing set: the same array back, so the common case allocates nothing.
  assert(m.chatsStamped(chats) === chats);

  m.pinnedChats.set("cgroup", true);
  m.mutedChats.set("cgroup", true);
  m.mutedChats.set("cwork", true);
  m.setHidden("umom", true);
  const out = m.chatsStamped(chats);
  assertEquals(out[0], {
    mid: "cgroup",
    name: "a",
    unread: 3,
    pinned: true,
    muted: true,
  });
  // The hidden flag still comes through the same call.
  assertEquals(out[1], { mid: "umom", name: "b", unread: 0, hidden: true });
  assertEquals(out[2], { mid: "cwork", name: "c", unread: 1, muted: true });
  assert(!("pinned" in out[2]), "absent, not false");
  // The stored rows are untouched.
  assert(!("pinned" in chats[0]) && !("muted" in chats[0]));
});

Deno.test("commands, boot, notify and state are wired up", async () => {
  const read = (path: string) =>
    Deno.readTextFile(new URL(path, import.meta.url));
  const state = await read("./modules/state.ts");
  const socket = await read("./modules/socket.ts");
  const notify = await read("./modules/notify.ts");
  const daemon = await read("./daemon.ts");
  const panel = await read("./panelserver.ts");
  const bridge = await read("./web/bridge.ts");
  assert(state.includes("chats: chatsStamped(stateSnapshot.chats),"));
  assert(state.includes("chatSink?.(chatsStamped([changed])[0]"));
  // Before the first write, or one refresh publishes every row unflagged.
  const order = [
    "await loadHidden();",
    "await pinnedChats.load();",
    "await mutedChats.load();",
    "await writeState();",
  ].map((text) => daemon.indexOf(text));
  assert(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    "main() must load pinned.json and muted.json before the first write",
  );
  assert(
    /if \(isHidden\(chatMid\)\) return;(?:\s*\/\/[^\n]*\n)*\s*if \(isMuted\(chatMid\)\) return;/
      .test(notify),
    "notify() must return early for a muted chat",
  );
  // Before the login gate, like hide.
  const gate = socket.indexOf(
    'if (!client) return { ok: false, error: "尚未登入" };',
  );
  const pin = socket.indexOf('cmd === "pin" || cmd === "unpin"');
  assert(pin > 0 && pin < gate, "pin/mute must sit before the login gate");
  for (const cmd of ["pin", "unpin", "mute", "unmute"]) {
    assert(bridge.includes(`"${cmd}",`), `bridge must allow ${cmd}`);
    assertEquals(
      panel.split(`"${cmd}",`).length - 1,
      2,
      `${cmd} must be session independent and always admitted`,
    );
  }
});

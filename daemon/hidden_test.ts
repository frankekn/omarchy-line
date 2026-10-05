/**
 * 隱藏聊天: the file the hidden list lives in, and the three places the rest
 * of the daemon has to reach it from.
 *
 *   deno test -A hidden_test.ts
 *
 * The block itself is driven for real against a temp directory -- it is only
 * a Set and two files' worth of JSON, so there is nothing to stub. What the
 * slicing cannot see is the wiring, and the wiring is the whole feature: a
 * `hidden` that state.json never carries, a notify() that still fires, or a
 * boot that forgets to read the file would all leave every test below green.
 * So the last test reads daemon.ts and pins those four call sites, the way
 * tests/qml/run.js pins the panel's bindings.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

// The default argument of loadHidden()/saveHidden(); every call below passes a
// real path instead, and this one is unwritable so a missed argument fails
// loudly rather than touching a state dir.
const PRELUDE = `
const HIDDEN_PATH = "/nonexistent/enil-hidden.json";
function errorLine(e: unknown): string { return String(e); }
export {
  HIDDEN_MAX,
  capHidden,
  hiddenMids,
  hiddenStamped,
  isHidden,
  loadHidden,
  saveHidden,
  setHidden,
};
`;

interface HiddenModule {
  HIDDEN_MAX: number;
  hiddenMids: Set<string>;
  hiddenStamped<T extends { mid: string }>(
    list: T[],
  ): Array<T & { hidden?: true }>;
  isHidden(mid: string): boolean;
  loadHidden(path?: string): Promise<void>;
  saveHidden(path?: string): Promise<void>;
  setHidden(mid: string, hidden: boolean): boolean;
}
async function mod(): Promise<HiddenModule> {
  // Not memoised, unlike the other suites: hiddenMids is module state, and a
  // test that inherited the previous one's hidden rows would prove nothing.
  return await loadBlock<HiddenModule>("hidden", PRELUDE);
}

async function inTempDir(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "enil-hidden-" });
  try {
    await fn(`${dir}/hidden.json`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("what was hidden is still hidden after a restart", async () => {
  await inTempDir(async (path) => {
    const m = await mod();
    m.setHidden("cgroup", true);
    m.setHidden("umom", true);
    await m.saveHidden(path);
    // The shape is the contract with nobody but ourselves, but it is on disk
    // in the user's state dir, so it is pinned like every other file we own.
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      mids: ["cgroup", "umom"],
    });

    const next = await mod();
    assertEquals(next.isHidden("cgroup"), false, "a fresh boot starts empty");
    await next.loadHidden(path);
    assertEquals(next.isHidden("cgroup"), true);
    assertEquals(next.isHidden("umom"), true);
    assertEquals(next.isHidden("uneverhidden"), false);
  });
});

for (const failure of ["none", "error", "zero"] as const) {
  Deno.test(`hidden preferences survive short writes with ${failure}`, async () => {
    await inTempDir(async (path) => {
      const m = await mod();
      m.setHidden("old", true);
      await m.saveHidden(path);
      const before = await Deno.readTextFile(path);
      m.setHidden("新🔑", true);
      const write = Deno.FsFile.prototype.write;
      let calls = 0;
      Deno.FsFile.prototype.write = function (bytes: Uint8Array) {
        if (calls++ > 0 && failure !== "none") {
          return failure === "zero"
            ? Promise.resolve(0)
            : Promise.reject(new Error("disk full"));
        }
        return write.call(this, bytes.subarray(0, 3));
      };
      try {
        await m.saveHidden(path);
      } finally {
        Deno.FsFile.prototype.write = write;
      }
      const saved = await Deno.readTextFile(path);
      if (failure === "none") {
        assertEquals(JSON.parse(saved), { mids: ["old", "新🔑"] });
      } else {
        assertEquals(saved, before);
        await m.saveHidden(path);
        assertEquals(JSON.parse(await Deno.readTextFile(path)), {
          mids: ["old", "新🔑"],
        });
      }
    });
  });
}

Deno.test("unhiding takes the mid out of the file, not just the set", async () => {
  await inTempDir(async (path) => {
    const m = await mod();
    m.setHidden("cgroup", true);
    m.setHidden("umom", true);
    m.setHidden("cgroup", false);
    await m.saveHidden(path);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), { mids: ["umom"] });
  });
});

Deno.test("a file we cannot read leaves the daemon running with nothing hidden", async () => {
  await inTempDir(async (path) => {
    for (
      const bad of [
        "",
        "{",
        "null",
        "42",
        '"cgroup"',
        "[]",
        '["cgroup"]', // the array, but not under `mids`
        '{"mids":null}',
        '{"mids":"cgroup"}',
        '{"mids":[1,null,{},""]}', // right shape, wrong contents
      ]
    ) {
      await Deno.writeTextFile(path, bad);
      const m = await mod();
      // No throw is the point: main() awaits this before it writes the first
      // state.json, so a parse error here would take the chat list with it.
      await m.loadHidden(path);
      assertEquals(m.hiddenMids.size, 0, bad);
    }
    // A file that is not there at all is the first-ever boot, not an error.
    await Deno.remove(path);
    const m = await mod();
    await m.loadHidden(path);
    assertEquals(m.hiddenMids.size, 0);
  });
});

Deno.test("a good file survives one bad entry inside it", async () => {
  await inTempDir(async (path) => {
    await Deno.writeTextFile(path, '{"mids":["cgroup",7,"",null,"umom"]}');
    const m = await mod();
    await m.loadHidden(path);
    // Dropping the whole list over one bad row would un-hide everything the
    // user ever hid; dropping the row costs them nothing.
    assertEquals([...m.hiddenMids], ["cgroup", "umom"]);
  });
});

Deno.test("hiding twice is hiding once, and so is unhiding twice", async () => {
  const m = await mod();
  assertEquals(m.setHidden("cgroup", true), true, "the first one moves");
  assertEquals(m.setHidden("cgroup", true), false, "the second one does not");
  assertEquals(m.hiddenMids.size, 1);
  assertEquals(m.setHidden("cgroup", false), true);
  assertEquals(m.setHidden("cgroup", false), false);
  assertEquals(m.hiddenMids.size, 0);
  // The answer is what handle() spends a disk write on, so "nothing moved"
  // has to be distinguishable from "done" -- both are {ok:true} to the panel.
  assertEquals(m.setHidden("unever", false), false);
});

Deno.test("the list cannot grow without a bound", async () => {
  const m = await mod();
  for (let i = 0; i < m.HIDDEN_MAX + 10; i++) m.setHidden(`c${i}`, true);
  assertEquals(m.hiddenMids.size, m.HIDDEN_MAX);
  // Insertion order is age order, so it is the ten oldest that went.
  assertEquals(m.isHidden("c0"), false);
  assertEquals(m.isHidden("c9"), false);
  assertEquals(m.isHidden("c10"), true);
  assertEquals(m.isHidden(`c${m.HIDDEN_MAX + 9}`), true);
});

Deno.test("a queued write never puts a set older than the current one on disk", async () => {
  await inTempDir(async (path) => {
    const m = await mod();
    // Two clicks close enough together that the second lands while the first
    // write is still queued. saveHidden() serialises them, and what is on
    // disk after each one has to be the set as it was by then -- a write that
    // carried a snapshot taken before the queue would publish the first
    // click's set after the second click had already happened, so a kill
    // between the two writes would leave hidden.json a click behind.
    m.setHidden("cgroup", true);
    const first = m.saveHidden(path);
    m.setHidden("umom", true);
    const second = m.saveHidden(path);

    await first;
    assertEquals(
      JSON.parse(await Deno.readTextFile(path)),
      { mids: ["cgroup", "umom"] },
      "the first write published a stale set",
    );
    await second;
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      mids: ["cgroup", "umom"],
    });
    // And the caller's await still means "on disk": handle() answers the
    // panel {ok:true} only after this resolves.
    const m2 = await mod();
    await m2.loadHidden(path);
    assertEquals([...m2.hiddenMids], ["cgroup", "umom"]);
  });
});

Deno.test("only the hidden rows carry the flag, and never the originals", async () => {
  const m = await mod();
  const chats = [
    { mid: "cgroup", name: "a", unread: 3 },
    { mid: "umom", name: "b", unread: 0 },
  ];
  // Nothing hidden: the same array back, so the common case allocates nothing.
  assertEquals(m.hiddenStamped(chats), chats);
  assert(m.hiddenStamped(chats) === chats);

  m.setHidden("cgroup", true);
  const out = m.hiddenStamped(chats);
  assertNotEquals(out, chats);
  assertEquals(out[0], { mid: "cgroup", name: "a", unread: 3, hidden: true });
  // Absent, not false: an older panel build must not have to know the key.
  assert(!("hidden" in out[1]), JSON.stringify(out[1]));
  // The originals are untouched, which is what lets summaryCache hand the
  // same PluginChat object back on the next refresh.
  assert(!("hidden" in chats[0]));
  assertEquals(chats[0].name, "a");
});

Deno.test("the four call sites in daemon.ts are still wired up", async () => {
  // writeState() moved into modules/state.ts; the other three call sites are
  // still in daemon.ts (main, notify, handle). One joined source, same pins.
  const src = [
    await Deno.readTextFile(
      new URL("./modules/state.ts", import.meta.url),
    ),
    await Deno.readTextFile(new URL("./modules/notify.ts", import.meta.url)),
    await Deno.readTextFile(new URL("./modules/socket.ts", import.meta.url)),
    await Deno.readTextFile(new URL("./daemon.ts", import.meta.url)),
  ].join("\n");
  // state.json is the only way the panel learns a row is hidden.
  assert(
    src.includes("chats: hiddenStamped(stateSnapshot.chats),"),
    "writeState() no longer stamps the chat rows",
  );
  // Read before the first writeState(), or one refresh publishes every hidden
  // row as visible.
  assert(
    /await loadAvatarIndex\(\);(?:\s*\/\/[^\n]*\n)*\s*await loadHidden\(\);/
      .test(src),
    "main() no longer loads hidden.json before the first state write",
  );
  // Frank's ruling: a new message must not raise a toast for a hidden chat.
  assert(
    /if \(!chatMid\) return;(?:\s*\/\/[^\n]*\n)*\s*if \(isHidden\(chatMid\)\) return;/
      .test(src),
    "notify() no longer returns early for a hidden chat",
  );
  // The panel sends the mid; an empty one is a bug on its side, and silently
  // hiding "" would put a row nobody can unhide in the file.
  assert(
    src.includes(
      'if (!mid) return { ok: false, error: "沒有指定是哪一間聊天室" };',
    ),
    "the hide/unhide command no longer refuses an empty mid",
  );
});

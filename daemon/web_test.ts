// State snapshots and their recovery across the web bridge.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { notifyStateWritten, StateFeed } from "./web/bridge.ts";
import { makeStateDecoder } from "./web/public/js/state-wire.js";
import { applyChatPush, applyChatState } from "./web/public/js/protocol.js";
import { createConnection } from "./web/public/js/connection.js";
import { createModel } from "./web/public/js/model.js";

type Chat = { mid: string; name: string; lastTime: number };
type State = {
  bootId: string;
  me: { mid: string };
  chatsRevision: number;
  chats: Chat[];
  updatedAt: number;
  wanted?: { chat: string };
};

function largeState(): State {
  return {
    bootId: "boot-a",
    me: { mid: "account-a" },
    chatsRevision: 1,
    chats: Array.from({ length: 500 }, (_, i) => ({
      mid: `c${i}`,
      name: `chat ${i} ${"preview ".repeat(10)}`,
      lastTime: 500 - i,
    })),
    updatedAt: 1,
    wanted: { chat: "c3" },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("state feed timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

Deno.test("state notifications are immediate and coalesce a same-turn burst", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-notify-" });
  const path = `${dir}/state.json`, tmp = `${path}.tmp`;
  const initial = largeState();
  const write = (state: State) => {
    Deno.writeTextFileSync(tmp, JSON.stringify(state));
    Deno.renameSync(tmp, path);
  };
  write(initial);
  const feed = new StateFeed(path), frames: string[] = [];
  let wake: (() => void) | undefined;
  const waitFrame = () => new Promise<void>((resolve) => wake = resolve);
  const send = (frame: string) => {
    frames.push(frame);
    wake?.();
    wake = undefined;
  };
  try {
    await feed.add(send, true);
    const first = JSON.parse(frames[0]);
    const next = structuredClone(initial);
    next.chats[0].name = "immediate";
    next.chatsRevision++;
    next.updatedAt++;
    write(next);
    const delivered = waitFrame();
    const started = performance.now();
    notifyStateWritten(path);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivered,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("notification timed out")),
            50,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    assert(performance.now() - started < 50, "notification took 50 ms or more");
    const immediate = JSON.parse(frames[1]);
    assertEquals(immediate.generation, first.generation);
    assertEquals(immediate.base, first.version);
    assertEquals(immediate.version, first.version + 1);

    let last = next;
    for (let i = 0; i < 3; i++) {
      last = structuredClone(last);
      last.chats[0].name = `burst ${i}`;
      last.chatsRevision++;
      last.updatedAt++;
      write(last);
      notifyStateWritten(path);
    }
    await until(() => frames.length === 3);
    const result = JSON.parse(frames[2]);
    const decode = makeStateDecoder();
    decode(first);
    decode(immediate);
    assertEquals(decode(result).frame.state, last);
    assertEquals(result.generation, first.generation);
    assertEquals(result.base, immediate.version);
    assertEquals(result.version, immediate.version + 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assertEquals(frames.length, 3);
  } finally {
    feed.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a notification during an older read is not lost", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-notify-race-" });
  const path = `${dir}/state.json`, tmp = `${path}.tmp`;
  const original = largeState(), updated = { ...original, updatedAt: 2 };
  await Deno.writeTextFile(path, JSON.stringify(original));
  const feed = new StateFeed(path), frames: string[] = [];
  const read = Deno.readTextFile;
  let release!: () => void, blocked = false;
  const gate = new Promise<void>((resolve) => release = resolve);
  Deno.readTextFile = async (file, options) => {
    const text = await read(file, options);
    if (file === path && !blocked) {
      blocked = true;
      await gate;
    }
    return text;
  };
  try {
    const adding = feed.add((frame) => frames.push(frame), true);
    await until(() => blocked);
    await Deno.writeTextFile(tmp, JSON.stringify(updated));
    await Deno.rename(tmp, path);
    notifyStateWritten(path);
    await Promise.resolve();
    release();
    await adding;
    await until(() => frames.length === 2);
    const decode = makeStateDecoder();
    assertEquals(decode(JSON.parse(frames[0])).frame.state, original);
    assertEquals(decode(JSON.parse(frames[1])).frame.state, updated);
  } finally {
    release();
    Deno.readTextFile = read;
    feed.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("state feed polls external changes and seeds late pages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-wire-" });
  const path = `${dir}/state.json`;
  let stamp = Date.now();
  async function write(state: State) {
    const temp = `${path}.tmp`;
    await Deno.writeTextFile(temp, JSON.stringify(state, null, 2));
    const time = new Date(stamp += 1000);
    await Deno.utime(temp, time, time);
    await Deno.rename(temp, path);
  }
  const initial = largeState();
  await write(initial);
  const feed = new StateFeed(path), first: string[] = [], second: string[] = [];
  const legacy: string[] = [];
  const decode = makeStateDecoder();
  try {
    // Simultaneous first subscribers both receive a complete snapshot.
    await Promise.all([
      feed.add((x) => first.push(x), true),
      feed.add((x) => second.push(x), true),
    ]);
    assertEquals(first.length, 1);
    assertEquals(second.length, 1);
    const full = JSON.parse(first[0]);
    assertEquals(full.web, "state");
    assertEquals(decode(full).frame.state, initial);
    await feed.add((x) => legacy.push(x));
    assertEquals(JSON.parse(legacy[0]), { web: "state", state: initial });

    // A changed row moves, another disappears, one is added, and a metadata
    // key disappears. The reconstructed value must equal the file exactly.
    const next = structuredClone(initial);
    const moved = next.chats.splice(100, 1)[0];
    moved.name = "changed";
    next.chats.unshift(moved);
    next.chats.splice(20, 1);
    next.chats.splice(200, 0, { mid: "new", name: "new", lastTime: 1 });
    next.chatsRevision++;
    next.updatedAt++;
    delete next.wanted;
    await write(next);
    await until(() => first.length === 2 && second.length === 2);
    const delta = JSON.parse(first[1]);
    assertEquals(delta.web, "state-delta");
    assertEquals(delta.base, full.version);
    assert(first[1].length < first[0].length / 10);
    assertEquals(decode(delta).frame.state, next);
    assertEquals(first[1], second[1]);
    assertEquals(JSON.parse(legacy[1]), { web: "state", state: next });

    // A new subscriber always starts at the current full snapshot.
    const late: string[] = [];
    await feed.add((x) => late.push(x), true);
    assertEquals(JSON.parse(late[0]).web, "state");
    assertEquals(JSON.parse(late[0]).state, next);
    assertEquals(JSON.parse(late[0]).version, delta.version);

    // A heartbeat still conveys its timestamp without resending the list.
    const heartbeat = { ...next, updatedAt: 3 };
    await write(heartbeat);
    await until(() => first.length === 3);
    const beat = JSON.parse(first[2]);
    assertEquals(beat.web, "state-delta");
    assertEquals(beat.remove, []);
    assertEquals(beat.put, []);
    assertEquals(decode(beat).frame.state, heartbeat);

    // Arbitrary reordering of unchanged rows and account/boot changes use a
    // full snapshot, so neither can reuse an incompatible base.
    const reordered = structuredClone(heartbeat);
    [reordered.chats[0], reordered.chats[1]] = [
      reordered.chats[1],
      reordered.chats[0],
    ];
    await write(reordered);
    await until(() => first.length === 4);
    assertEquals(JSON.parse(first[3]).web, "state");
    assertEquals(decode(JSON.parse(first[3])).frame.state, reordered);
    const account = { ...reordered, me: { mid: "account-b" } };
    await write(account);
    await until(() => first.length === 5);
    assertEquals(JSON.parse(first[4]).web, "state");
    assertEquals(decode(JSON.parse(first[4])).frame.state, account);
    const boot = { ...account, bootId: "boot-b" };
    await write(boot);
    await until(() => first.length === 6);
    assertEquals(JSON.parse(first[5]).web, "state");
    assertEquals(decode(JSON.parse(first[5])).frame.state, boot);

    // A rewrite with exactly the same bytes does not create a new version.
    await write(boot);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assertEquals(first.length, 6);
  } finally {
    feed.close();
    await Deno.remove(dir, { recursive: true });
  }
});

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  constructor(_url: string, readonly protocol?: string | string[]) {
    super();
    Socket.instances.push(this);
  }
  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}
  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  receive(data: object): void {
    this.readyState = 1;
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}

Deno.test("failed connections always retry the state delta subprotocol", () => {
  Socket.instances = [];
  const model = createModel(), callbacks: (() => void)[] = [];
  const delays: number[] = [];
  const connection = createConnection({
    model,
    url: "ws://test",
    WebSocketClass: Socket,
    schedule: (callback: () => void, delay: number) => {
      callbacks.push(callback);
      delays.push(delay);
      return callbacks.length;
    },
    cancel: () => {},
  });
  connection.start();
  assertEquals(Socket.instances[0].protocol, "enil-state-delta-v1");
  Socket.instances[0].close();
  callbacks.shift()?.();
  assertEquals(Socket.instances[1].protocol, "enil-state-delta-v1");
  Socket.instances[1].close();
  callbacks.shift()?.();
  assertEquals(Socket.instances[2].protocol, "enil-state-delta-v1");
  assertEquals(delays, [1000, 2000]);
  connection.stop();
});

Deno.test("a bad delta reconnects immediately without a false offline status", async () => {
  Socket.instances = [];
  const model = createModel(), statuses: string[] = [], delays: number[] = [];
  let ready = 0;
  const connection = createConnection({
    model,
    url: "ws://test",
    WebSocketClass: Socket,
    schedule: (_callback: () => void, delay: number) => {
      delays.push(delay);
      return delays.length;
    },
    cancel: () => {},
    onStatus: (status: string) => statuses.push(status),
    onReady: () => ready++,
  });
  connection.start();
  const full = {
    web: "state",
    generation: "g",
    version: 1,
    state: largeState(),
  };
  Socket.instances[0].receive(full);
  model.active = "chat-a";
  const outstanding = connection.command("send", { text: "pending" });
  const rejected = assertRejects(() => outstanding, Error);
  const history = connection.command("history", { chat: "chat-a" });
  const historyRejected = assertRejects(() => history, Error);
  const older = connection.command("history", { chat: "chat-a", before: "1" });
  const olderRejected = assertRejects(() => older, Error);
  const gap = {
    web: "state-delta",
    generation: "g",
    base: 2,
    version: 3,
    state: {},
    remove: [],
    put: [],
  };
  Socket.instances[0].receive(gap);
  assertEquals(Socket.instances.length, 2);
  assertEquals(Socket.instances[1].protocol, "enil-state-delta-v1");
  assertEquals(model.connected, true);
  assertEquals(statuses, ["connecting", "connected"]);
  assertEquals(delays, []);
  const error = await rejected;
  assertEquals((error as Error & { ambiguous?: boolean }).ambiguous, true);
  const historyError = await historyRejected;
  assertEquals((historyError as Error & { resync?: boolean }).resync, true);
  const olderError = await olderRejected;
  assertEquals((olderError as Error & { resync?: boolean }).resync, undefined);
  const unsent = await assertRejects(() => connection.command("sync"), Error);
  assertEquals((unsent as Error & { unsent?: boolean }).unsent, true);
  Socket.instances[1].receive(full);
  assertEquals(ready, 1);
  assertEquals(statuses.includes("reconnecting"), false);

  // Repeated invalid snapshots must return to ordinary backoff, not spin.
  Socket.instances[1].receive(gap);
  assertEquals(Socket.instances.length, 3);
  Socket.instances[2].receive(gap);
  assertEquals(statuses.at(-1), "reconnecting");
  assertEquals(delays, [1000]);
  assertEquals(model.connected, false);
  connection.stop();
});

Deno.test("a subscriber added after a poll's send loop gets its snapshot before add resolves", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-wire-poll-race-" });
  const path = `${dir}/state.json`;
  await Deno.writeTextFile(path, JSON.stringify(largeState()));
  const feed = new StateFeed(path), late: string[] = [];
  let second: Promise<void> | undefined;
  try {
    await feed.add(() => {
      // This microtask runs after #read's subscriber loop, but before the
      // in-flight #poll promise settles and clears itself.
      queueMicrotask(() =>
        second = feed.add((frame) => late.push(frame), true)
      );
    }, true);
    assert(second);
    await second;
    assertEquals(late.length, 1);
    assertEquals(JSON.parse(late[0]).web, "state");
  } finally {
    feed.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reconnecting pages receive the current account before any delta", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-wire-reconnect-" });
  const path = `${dir}/state.json`;
  let stamp = Date.now();
  async function write(state: State, advance = true) {
    const temp = `${path}.tmp`;
    await Deno.writeTextFile(temp, JSON.stringify(state));
    if (advance) stamp += 1000;
    const time = new Date(stamp);
    await Deno.utime(temp, time, time);
    await Deno.rename(temp, path);
  }
  const original = largeState(),
    switched = {
      ...original,
      me: { mid: "account-b" },
      chatsRevision: 2,
    };
  await write(original);
  const feed = new StateFeed(path), old: string[] = [], current: string[] = [];
  const first = (frame: string) => old.push(frame);
  const second = (frame: string) => current.push(frame);
  try {
    await feed.add(first, true);
    feed.delete(first);
    // Both files have the same size and millisecond mtime, but the daemon's
    // atomic rename gives the new account a different file identity.
    const before = await Deno.stat(path);
    await write(switched, false);
    const after = await Deno.stat(path);
    assertEquals(after.size, before.size);
    assertEquals(after.mtime?.getTime(), before.mtime?.getTime());
    assert(after.ino !== before.ino);
    await feed.add(second, true);
    assertEquals(current.length, 1);
    assertEquals(JSON.parse(current[0]).web, "state");
    assertEquals(JSON.parse(current[0]).state, switched);

    // A missing state file must not seed a new page from the previous cache.
    feed.delete(second);
    await Deno.remove(path);
    const waiting: string[] = [];
    const waitingSend = (frame: string) => waiting.push(frame);
    await feed.add(waitingSend, true);
    assertEquals(waiting, []);
    const next = { ...switched, me: { mid: "account-c" }, chatsRevision: 3 };
    await write(next);
    await until(() => waiting.length === 1);
    assertEquals(JSON.parse(waiting[0]).web, "state");
    assertEquals(JSON.parse(waiting[0]).state, next);

    // An invalid replacement must not seed a subscriber from the old cache.
    feed.delete(waitingSend);
    await Deno.writeTextFile(`${path}.tmp`, "{");
    await Deno.rename(`${path}.tmp`, path);
    const invalid: string[] = [];
    await feed.add((frame) => invalid.push(frame), true);
    assertEquals(invalid, []);
    const restored = { ...next, me: { mid: "account-d" }, chatsRevision: 4 };
    await write(restored);
    await until(() => invalid.length === 1);
    assertEquals(JSON.parse(invalid[0]).state, restored);
  } finally {
    feed.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("state decoder rejects gaps and malformed or foreign patches", () => {
  const state = largeState();
  const full = { web: "state", generation: "g", version: 1, state };
  const delta = {
    web: "state-delta",
    generation: "g",
    base: 1,
    version: 2,
    state: { bootId: "boot-a", me: { mid: "account-a" }, chatsRevision: 2 },
    remove: [],
    put: [{ index: 0, chat: { mid: "c1", name: "new", lastTime: 9 } }],
  };
  const decode = makeStateDecoder();
  assertEquals(decode(full).frame.state, state);
  const next = decode(delta).frame.state;
  assertEquals(next.chats[0].name, "new");
  assertEquals(decode(delta), {}); // replay cannot undo a newer state
  assertEquals(decode(full), {}); // nor can an older full frame
  assertEquals(decode({ ...full, version: 2 }), {});
  assertEquals(decode({ ...delta, base: 3, version: 4 }).resync, true);
  assertEquals(
    decode({ ...delta, generation: "old", base: 2, version: 3 }).resync,
    true,
  );
  assertEquals(
    decode({ ...delta, base: 2, version: 3, remove: ["absent"] }).resync,
    true,
  );
  assertEquals(
    decode({
      ...delta,
      base: 2,
      version: 3,
      put: [{ index: 9999, chat: { mid: "c1" } }],
    }).resync,
    true,
  );
  assertEquals(
    decode({
      ...delta,
      base: 2,
      version: 3,
      state: { ...delta.state, me: { mid: "other" } },
    }).resync,
    true,
  );
  // A new connection has no base and must request a new full snapshot.
  assertEquals(makeStateDecoder()(delta).resync, true);
  assertEquals(makeStateDecoder()(full).frame.state, state);
});

Deno.test("snapshot deltas do not roll back a newer live chat push", () => {
  const state = largeState(), decode = makeStateDecoder();
  const initial = decode({ web: "state", generation: "g", version: 1, state })
    .frame.state;
  let model = applyChatState({
    chats: [],
    chatList: null,
    chatBoot: "",
    chatRevision: -1,
  }, initial);
  const pushed = { ...state.chats[0], name: "live" };
  model = applyChatPush(model, pushed, 3, state.bootId);
  const delta = decode({
    web: "state-delta",
    generation: "g",
    base: 1,
    version: 2,
    state: {
      bootId: state.bootId,
      me: state.me,
      chatsRevision: 2,
      updatedAt: 2,
    },
    remove: [],
    put: [{ index: 0, chat: { ...pushed, name: "older" } }],
  }).frame.state;
  model = applyChatState(model, delta);
  assertEquals(model.chats[0].name, "live");
});

// Session rechecks must not let stale results cancel a newer connection.
import assert from "node:assert/strict";
import { createConnection } from "../../daemon/web/public/js/connection.js";
import { createModel } from "../../daemon/web/public/js/model.js";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  constructor() {
    super();
    Socket.instances.push(this);
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  frame() {
    this.dispatchEvent(
      new MessageEvent("message", { data: '{"web":"state"}' }),
    );
  }
}

function fixture(onRejected) {
  Socket.instances = [];
  const model = createModel(), timers = new Map(), delays = [];
  let next = 0, expired = 0;
  const connection = createConnection({
    model,
    url: "ws://test",
    WebSocketClass: Socket,
    schedule(callback, delay) {
      const id = ++next;
      timers.set(id, callback);
      delays.push(delay);
      return id;
    },
    cancel: (id) => timers.delete(id),
    onRejected,
    onExpired: () => expired++,
  });
  return {
    model,
    connection,
    timers,
    delays,
    expired: () => expired,
    retry() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("overlapping failures share one check and a new frame cancels it", async () => {
  let resolveCheck, signal, checks = 0;
  const pending = new Promise((resolve) => resolveCheck = resolve);
  const f = fixture((value) => {
    checks++;
    signal = value;
    return pending;
  });
  f.connection.start();
  Socket.instances[0].close();
  await tick();
  f.retry();
  Socket.instances[1].close();
  await tick();
  assert.equal(checks, 1);
  f.retry();
  Socket.instances[2].frame();
  assert.equal(signal.aborted, true);
  resolveCheck(true);
  await tick();
  assert.equal(f.expired(), 0);
  assert.equal(f.model.signedIn, true);
  assert.equal(f.model.connected, true);
  f.connection.stop();
});

Deno.test("a failed session check leaves reconnect backoff running", async () => {
  let checks = 0;
  const f = fixture(() => {
    checks++;
    return Promise.reject(new TypeError("offline"));
  });
  f.connection.start();
  for (let index = 0; index < 3; index++) {
    Socket.instances[index].close();
    await tick();
    if (index < 2) f.retry();
  }
  assert.equal(checks, 3);
  assert.deepEqual(f.delays, [1000, 2000, 4000]);
  assert.equal(f.expired(), 0);
  assert.equal(f.model.signedIn, true);
  f.connection.stop();
});

Deno.test("an expired session stops retries and invalidates old checks", async () => {
  let resolveOld, signal;
  const pending = new Promise((resolve) => resolveOld = resolve);
  let checks = 0;
  const f = fixture((value) => {
    signal = value;
    return ++checks === 1 ? pending : Promise.resolve(true);
  });
  f.connection.start();
  Socket.instances[0].close();
  await tick();
  f.connection.stop();
  assert.equal(signal.aborted, true);
  f.connection.start();
  Socket.instances[1].close();
  await tick();
  assert.equal(f.expired(), 1);
  assert.equal(f.model.signedIn, false);
  assert.equal(f.timers.size, 0);
  resolveOld(true);
  await tick();
  assert.equal(f.expired(), 1);
});

Deno.test("a timed-out session check does not block a later check", async () => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const deadlines = new Map();
  let nextDeadline = 100000, checks = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 10000) return originalSet(callback, delay, ...args);
    const id = ++nextDeadline;
    deadlines.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (!deadlines.delete(id)) originalClear(id);
  };
  try {
    const f = fixture(() => {
      checks++;
      return new Promise(() => {});
    });
    f.connection.start();
    Socket.instances[0].close();
    await Promise.resolve();
    assert.equal(checks, 1);
    const [id, deadline] = deadlines.entries().next().value;
    deadlines.delete(id);
    deadline();
    f.retry();
    Socket.instances[1].close();
    await Promise.resolve();
    assert.equal(checks, 2);
    f.connection.stop();
    assert.equal(deadlines.size, 0);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

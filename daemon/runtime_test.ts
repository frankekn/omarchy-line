import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { LatencyTracker, SizeTracker, WorkLane } from "./runtime.ts";

Deno.test("WorkLane bounds concurrency and starts queued work in order", async () => {
  const lane = new WorkLane(2);
  const starts: number[] = [];
  const releases: (() => void)[] = [];
  const jobs = [0, 1, 2, 3].map((id) =>
    lane.run(async () => {
      starts.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return id;
    })
  );
  await Promise.resolve();
  assertEquals(starts, [0, 1]);
  assertEquals({ active: lane.active, pending: lane.pending }, {
    active: 2,
    pending: 2,
  });
  releases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(starts, [0, 1, 2]);
  releases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(starts, [0, 1, 2, 3]);
  while (releases.length) releases.shift()!();
  assertEquals(await Promise.all(jobs), [0, 1, 2, 3]);
  assertEquals({ active: lane.active, pending: lane.pending }, {
    active: 0,
    pending: 0,
  });
});

Deno.test("WorkLane releases a slot when work rejects", async () => {
  const lane = new WorkLane(1);
  await assertRejects(() => lane.run(() => Promise.reject(new Error("boom"))));
  assertEquals(await lane.run(() => Promise.resolve("next")), "next");
  assertEquals(lane.active, 0);
});

Deno.test("WorkLane transfers slots when active jobs finish together", async () => {
  const lane = new WorkLane(2);
  let releaseInitial!: () => void;
  const initialGate = new Promise<void>((resolve) => releaseInitial = resolve);
  let releaseLater!: () => void;
  const laterGate = new Promise<void>((resolve) => releaseLater = resolve);
  let running = 0;
  let peak = 0;
  const starts: number[] = [];
  const job = (id: number) =>
    lane.run(async () => {
      running++;
      peak = Math.max(peak, running);
      starts.push(id);
      try {
        await (id < 2 ? initialGate : laterGate);
      } finally {
        running--;
      }
    });

  const first = job(0);
  const second = job(1);
  const handedOff = job(2);
  await Promise.resolve();
  releaseInitial();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newlyAdmitted = job(3);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(starts, [0, 1, 2, 3]);
  assertEquals({ active: lane.active, running, peak }, {
    active: 2,
    running: 2,
    peak: 2,
  });
  releaseLater();
  await Promise.all([first, second, handedOff, newlyAdmitted]);
  assertEquals({ active: lane.active, pending: lane.pending }, {
    active: 0,
    pending: 0,
  });
});

Deno.test("WorkLane removes cancelled queued work without spending a slot", async () => {
  const lane = new WorkLane(1);
  let release!: () => void;
  const first = lane.run(() =>
    new Promise<void>((resolve) => release = resolve)
  );
  const ctrl = new AbortController();
  let ran = false;
  const queued = lane.run(() => {
    ran = true;
    return Promise.resolve();
  }, ctrl.signal);
  await Promise.resolve();
  assertEquals({ active: lane.active, pending: lane.pending }, {
    active: 1,
    pending: 1,
  });
  ctrl.abort();
  await assertRejects(() => queued, DOMException);
  assertEquals({ active: lane.active, pending: lane.pending, ran }, {
    active: 1,
    pending: 0,
    ran: false,
  });
  release();
  await first;
  assertEquals(lane.active, 0);
});

Deno.test("WorkLane refuses an unusable limit", () => {
  assertThrows(() => new WorkLane(0), RangeError);
  assertThrows(() => new WorkLane(1.5), RangeError);
  assertThrows(() => new WorkLane(1, -1), RangeError);
  assertThrows(() => new WorkLane(2, 1, -1), RangeError);
  assertThrows(() => new WorkLane(2, 1, 2), RangeError);
});

Deno.test("WorkLane refuses admission when its process-wide queue is full", async () => {
  const lane = new WorkLane(1, 1);
  let release!: () => void;
  const first = lane.run(() =>
    new Promise<void>((resolve) => release = resolve)
  );
  const second = lane.tryRun(() => Promise.resolve());
  const refused = lane.tryRun(() => Promise.resolve());
  assertEquals(refused, null);
  await assertRejects(
    () => lane.run(() => Promise.resolve()),
    RangeError,
    "work lane pending limit reached",
  );
  assertEquals(lane.pending, 1);
  if (!second) throw new Error("second job was not admitted");
  release();
  await Promise.all([first, second]);
});

Deno.test("WorkLane retirement cancels queued work without hiding active slots", async () => {
  const lane = new WorkLane(1, 2);
  let releaseOld!: () => void;
  const old = lane.run(() =>
    new Promise<void>((resolve) => releaseOld = resolve)
  );
  let queuedRan = false;
  const queued = lane.run(() => {
    queuedRan = true;
    return Promise.resolve();
  });
  await Promise.resolve();
  const retired = lane.retire();
  await assertRejects(() => queued, DOMException);
  assertEquals({ active: lane.active, pending: lane.pending, queuedRan }, {
    active: 1,
    pending: 0,
    queuedRan: false,
  });
  let replacementRan = false;
  const replacement = lane.tryRun(() => {
    replacementRan = true;
    return Promise.resolve("new");
  });
  if (!replacement) throw new Error("replacement job was not admitted");
  await retired;
  assertEquals({ active: lane.active, pending: lane.pending, replacementRan }, {
    active: 1,
    pending: 1,
    replacementRan: false,
  });
  releaseOld();
  assertEquals(await replacement, "new");
  await old;
  assertEquals(lane.active, 0);
});

Deno.test("WorkLane reserves capacity and queue priority for visible images", async () => {
  const lane = new WorkLane(4, 8, 1);
  const releases: (() => void)[] = [];
  const ordinary = Array.from(
    { length: 3 },
    () =>
      lane.run(() => new Promise<void>((resolve) => releases.push(resolve))),
  );
  await Promise.resolve();
  let fourthStarted = false;
  const fourth = lane.run(() => {
    fourthStarted = true;
    return Promise.resolve();
  });
  let releasePriority!: () => void;
  let priorityStarted = false;
  const priority = lane.run(
    () => {
      priorityStarted = true;
      return new Promise<void>((resolve) => releasePriority = resolve);
    },
    undefined,
    true,
  );
  await Promise.resolve();
  assertEquals({ active: lane.active, fourthStarted, priorityStarted }, {
    active: 4,
    fourthStarted: false,
    priorityStarted: true,
  });
  releasePriority();
  await priority;
  assertEquals(fourthStarted, false);
  releases.shift()?.();
  await fourth;
  assertEquals(fourthStarted, true);
  while (releases.length) releases.shift()?.();
  await Promise.all(ordinary);
  assertEquals({ active: lane.active, pending: lane.pending }, {
    active: 0,
    pending: 0,
  });
});

Deno.test("LatencyTracker reports a bounded rolling percentile window", () => {
  const tracker = new LatencyTracker(4);
  for (const value of [1, 2, 3, 4, 100]) tracker.record("refresh", value);
  assertEquals(tracker.snapshot(), {
    refresh: { samples: 4, lastMs: 100, p50Ms: 3, p95Ms: 100, maxMs: 100 },
  });
});

Deno.test("LatencyTracker reserves room for fixed diagnostics", () => {
  assertThrows(() => new LatencyTracker(64, 1), RangeError);
});

Deno.test("LatencyTracker bounds keys and ignores invalid measurements", () => {
  const tracker = new LatencyTracker(2, 2);
  tracker.record("first", 1.04);
  tracker.record("second", 2.06);
  tracker.record("", 4);
  tracker.record("bad", Number.NaN);
  tracker.record("third", 3);
  assertEquals(tracker.snapshot(), {
    second: { samples: 1, lastMs: 2.1, p50Ms: 2.1, p95Ms: 2.1, maxMs: 2.1 },
    third: { samples: 1, lastMs: 3, p50Ms: 3, p95Ms: 3, maxMs: 3 },
  });
});

Deno.test("LatencyTracker never evicts fixed daemon diagnostics", () => {
  const tracker = new LatencyTracker(2, 4);
  tracker.record("chats.refresh", 1);
  tracker.record("state.write", 2);
  for (let i = 0; i < 20; i++) tracker.record(`cmd.dynamic-${i}`, i + 3);
  const snapshot = tracker.snapshot();
  assertEquals(Object.keys(snapshot).length, 4);
  assertEquals(snapshot["chats.refresh"]?.lastMs, 1);
  assertEquals(snapshot["state.write"]?.lastMs, 2);
});

Deno.test("LatencyTracker serializes special keys as own metrics", () => {
  const tracker = new LatencyTracker();
  tracker.record("__proto__", 1);
  const snapshot = tracker.snapshot();
  assertEquals(Object.hasOwn(snapshot, "__proto__"), true);
  assertEquals(JSON.parse(JSON.stringify(snapshot))["__proto__"].lastMs, 1);
});

Deno.test("SizeTracker reports a bounded rolling window with unitless fields", () => {
  const tracker = new SizeTracker(4);
  for (const value of [1, 2, 3, 4, 100]) tracker.record(value);
  assertEquals(tracker.snapshot(), {
    samples: 4,
    last: 100,
    p50: 3,
    p95: 100,
    max: 100,
  });
});

Deno.test("SizeTracker is null before the first sample and ignores bad sizes", () => {
  const tracker = new SizeTracker(2);
  assertEquals(tracker.snapshot(), null);
  tracker.record(Number.NaN);
  tracker.record(-1);
  assertEquals(tracker.snapshot(), null);
  tracker.record(2048);
  assertEquals(tracker.snapshot(), {
    samples: 1,
    last: 2048,
    p50: 2048,
    p95: 2048,
    max: 2048,
  });
});

Deno.test("SizeTracker refuses an unusable limit", () => {
  assertThrows(() => new SizeTracker(0), RangeError);
  assertThrows(() => new SizeTracker(1.5), RangeError);
});

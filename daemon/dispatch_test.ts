/** Panel socket ordering and the bounded background lane. */
import { assert, assertEquals } from "@std/assert";
import {
  type JsonReply,
  PANEL_BACKGROUND_COMMANDS,
  PANEL_COMMAND_BUSY_TEXT,
  PANEL_MEDIA_BUSY_TEXT,
  PANEL_MEDIA_QUEUE_MAX,
  PANEL_MESSAGE_COMMANDS,
  PANEL_MUTATION_COMMANDS,
  PANEL_ORDINARY_QUEUE_MAX,
  PANEL_SESSION_INDEPENDENT_COMMANDS,
  type PanelConnection,
  servePanelConnection,
} from "./panelserver.ts";
import { LatencyTracker, WorkLane } from "./runtime.ts";

Deno.test("logout retires media slots before awaiting cleanup", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/login.ts", import.meta.url),
  );
  const logout = source.slice(
    source.indexOf("async function logoutClaimed"),
    source.indexOf(
      "// ------------------------------------------------------------ manual sync",
    ),
  );
  assert(
    logout.indexOf("const mediaRetired = retirePanelMediaLane();") <
        logout.indexOf("setClient(null);") &&
      logout.indexOf("await mediaRetired;") <
        logout.indexOf("await stateInvalidated;"),
  );
});

Deno.test("media commands take the dispatch signal down to the download", async () => {
  const source = [
    await Deno.readTextFile(
      new URL("./modules/messages.ts", import.meta.url),
    ),
    await Deno.readTextFile(new URL("./modules/socket.ts", import.meta.url)),
  ].join("\n");
  const panelServer = await Deno.readTextFile(
    new URL("./panelserver.ts", import.meta.url),
  );
  // The signal the lane's background job carries must reach the two media
  // entry points, so a panel disconnect or retirement aborts the download.
  assert(source.includes("getData(preview, signal)"));
  assert(
    source.includes("imageCache.get(url, req.invalidate === true, signal)"),
  );
  assert(
    panelServer.includes("await options.handle(req, signal)"),
  );
});

function controlledConnection(
  requests: string[],
  writeError?: Error,
  writeGate?: Promise<void> | (() => Promise<void>),
) {
  const encoder = new TextEncoder();
  const written: Uint8Array[] = [];
  let closed = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      for (const request of requests) {
        controller.enqueue(encoder.encode(request));
      }
    },
  });
  return {
    readable,
    async write(bytes: Uint8Array): Promise<number> {
      if (typeof writeGate === "function") await writeGate();
      else if (writeGate) await writeGate;
      if (closed) throw new Error("closed");
      if (writeError) throw writeError;
      written.push(bytes.slice());
      return bytes.byteLength;
    },
    close(): void {
      closed = true;
      controller.close();
    },
    finish(): void {
      try {
        controller.close();
      } catch {
        // close() or an earlier finish already ended the stream.
      }
    },
    isClosed(): boolean {
      return closed;
    },
    send(request: string): void {
      controller.enqueue(encoder.encode(request));
    },
    reset(): void {
      closed = true;
      controller.error(new Error("reset"));
    },
    replies(): JsonReply[] {
      const text = written.map((part) => new TextDecoder().decode(part)).join(
        "",
      );
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  } satisfies PanelConnection & {
    finish(): void;
    send(request: string): void;
    reset(): void;
    isClosed(): boolean;
    replies(): JsonReply[];
  };
}

function options(
  handle: (req: JsonReply, signal?: AbortSignal) => Promise<JsonReply>,
  lane: WorkLane = new WorkLane(4),
  failures: unknown[] = [],
) {
  const timings = new LatencyTracker();
  const samples: Array<{ key: string; elapsedMs: number }> = [];
  return {
    handle,
    lane,
    backgroundCommands: PANEL_BACKGROUND_COMMANDS,
    messageCommands: PANEL_MESSAGE_COMMANDS,
    mustAdmitRequest: (req: JsonReply) =>
      PANEL_MUTATION_COMMANDS.has(String(req.cmd ?? "")) ||
      (req.cmd === "history" && req.markRead === true),
    sessionIndependentCommands: PANEL_SESSION_INDEPENDENT_COMMANDS,
    encodeError: "encode",
    refusalText: (error: unknown) => String(error),
    reportFailure: (_cmd: string, error: unknown) => failures.push(error),
    reportEncodingFailure: (_cmd: string, error: unknown) =>
      failures.push(error),
    recordTiming: (key: string, elapsedMs: number) => {
      samples.push({ key, elapsedMs });
      timings.record(key, elapsedMs);
    },
    timings,
    samples,
  };
}

Deno.test("background handlers receive disconnect cancellation", async () => {
  let received: AbortSignal | undefined;
  const config = options(async (_req, signal) => {
    received = signal;
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true })
    );
    return { ok: true };
  });
  const conn = controlledConnection(['{"id":1,"cmd":"image"}\n']);
  const serving = servePanelConnection(conn, config).catch(() => {});
  await waitFor(() => received !== undefined, "handler received no signal");
  conn.reset();
  await serving;
  assertEquals(received?.aborted, true);
});

Deno.test("visible images can use the reserved media slot", async () => {
  const lane = new WorkLane(4, 16, 1);
  const starts: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = {
    ...options(async (req) => {
      starts.push(String(req.cmd));
      await gate;
      return { ok: true };
    }, lane),
    backgroundPriority: (cmd: string) => cmd === "image",
  };
  const conn = controlledConnection([
    '{"id":1,"cmd":"preview"}\n',
    '{"id":2,"cmd":"preview"}\n',
    '{"id":3,"cmd":"preview"}\n',
    '{"id":4,"cmd":"image"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => starts.length === 4, "image did not use reserved slot");
  assertEquals(starts.filter((cmd) => cmd === "image").length, 1);
  release();
  conn.finish();
  await serving;
});

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = performance.now() + 500;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

Deno.test("a stalled image does not hold a later send reply", async () => {
  let releaseImage: () => void = () => {};
  const imageGate = new Promise<void>((resolve) => releaseImage = resolve);
  const config = options(async (req) => {
    if (req.cmd === "image") await imageGate;
    return { ok: true, data: { cmd: req.cmd } };
  });
  const conn = controlledConnection([
    '{"id":1,"cmd":"image"}\n',
    '{"id":2,"cmd":"send"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => conn.replies().length === 1, "send reply was delayed");
  assertEquals(conn.replies(), [
    { ok: true, data: { cmd: "send" }, id: 2 },
  ]);
  releaseImage();
  await waitFor(() => conn.replies().length === 2, "image reply was missing");
  conn.finish();
  await serving;
  assertEquals(Object.keys(config.timings.snapshot()).sort(), [
    "cmd.image",
    "cmd.send",
  ]);
});

Deno.test("ordinary commands stay ordered and timing includes queue time", async () => {
  const starts: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const config = options(async (req) => {
    starts.push(String(req.cmd));
    if (req.cmd === "first") await firstGate;
    return { ok: true, data: req.cmd };
  });
  const conn = controlledConnection([
    '{"id":1,"cmd":"first"}\n',
    '{"id":2,"cmd":"second"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => starts.length === 1, "first command did not start");
  assertEquals(starts, ["first"]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseFirst();
  await waitFor(
    () => conn.replies().length === 2,
    "ordinary replies were missing",
  );
  conn.finish();
  await serving;
  assertEquals(starts, ["first", "second"]);
  assertEquals(conn.replies().map((reply) => reply.id), [1, 2]);
  const second = config.samples.find((sample) => sample.key === "cmd.second");
  assert(second && second.elapsedMs >= 25);
});

Deno.test("an ordinary overflow refusal stays behind accepted replies", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const handled: number[] = [];
  let closed = 0;
  const config = {
    ...options(async (req) => {
      const id = Number(req.id);
      handled.push(id);
      if (id === 0) await firstGate;
      return { ok: true };
    }),
    onClosed: () => closed++,
  };
  const conn = controlledConnection(Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX + 2 },
    (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
  ));
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => handled.length === 1,
    "first ordinary command did not start",
  );
  assertEquals(conn.replies(), []);
  releaseFirst();
  await waitFor(
    () => conn.replies().length === PANEL_ORDINARY_QUEUE_MAX + 2,
    "ordinary replies and overflow refusal were missing",
  );
  conn.finish();
  await serving;
  assertEquals(
    conn.replies().map((reply) => reply.id),
    Array.from({ length: PANEL_ORDINARY_QUEUE_MAX + 2 }, (_, id) => id),
  );
  assertEquals(
    handled,
    [
      ...Array.from({ length: PANEL_ORDINARY_QUEUE_MAX }, (_, id) => id),
      PANEL_ORDINARY_QUEUE_MAX + 1,
    ],
  );
  assertEquals(
    conn.replies()[PANEL_ORDINARY_QUEUE_MAX]?.error,
    PANEL_COMMAND_BUSY_TEXT,
  );
});

Deno.test("an overflowed message receives a recoverable refusal", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const handled: number[] = [];
  let closedCount = 0;
  const config = {
    ...options(async (req) => {
      const id = Number(req.id);
      handled.push(id);
      if (id === 0) await firstGate;
      return { ok: true };
    }),
    onClosed: () => closedCount++,
  };
  const requests = Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX },
    (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
  );
  requests.push(
    JSON.stringify({
      id: PANEL_ORDINARY_QUEUE_MAX,
      cmd: "send",
      requestId: "overflow-send",
    }) + "\n",
  );
  const conn = controlledConnection(requests);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => handled.length === 1, "first command did not start");
  await waitFor(
    () => conn.replies().some((reply) => reply.id === PANEL_ORDINARY_QUEUE_MAX),
    "overflow send received no refusal",
  );
  assertEquals(
    conn.replies().find((reply) => reply.id === PANEL_ORDINARY_QUEUE_MAX)
      ?.error,
    PANEL_COMMAND_BUSY_TEXT,
  );
  assertEquals(handled, [0]);
  conn.finish();
  await serving;
  releaseFirst();
  await waitFor(
    () => handled.length === PANEL_ORDINARY_QUEUE_MAX,
    "queue did not drain",
  );
});

Deno.test("ordinary overflow does not hide EOF behind a stalled handler", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const config = options(async (req) => {
    if (Number(req.id) === 0) await firstGate;
    return { ok: true };
  });
  const conn = controlledConnection(Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX + 1 },
    (_, id) => JSON.stringify({ id, cmd: "send" }) + "\n",
  ));
  const serving = servePanelConnection(conn, config);
  await new Promise((resolve) => setTimeout(resolve, 10));
  conn.finish();
  const result = await Promise.race([
    serving.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assertEquals(result, "returned");
  releaseFirst();
});

Deno.test("a stalled media refusal does not hide EOF", async () => {
  const lane = new WorkLane(1, 0);
  let releaseLane: () => void = () => {};
  const laneGate = new Promise<void>((resolve) => releaseLane = resolve);
  const occupying = lane.run(async () => await laneGate);
  let releaseWrite: () => void = () => {};
  const writeGate = new Promise<void>((resolve) => releaseWrite = resolve);
  const config = {
    ...options(() => Promise.resolve({ ok: true }), lane),
    writeTimeoutMs: 20,
    overloadWaitTimeoutMs: 20,
  };
  const conn = controlledConnection(
    ['{"id":1,"cmd":"image"}\n'],
    undefined,
    writeGate,
  );
  const serving = servePanelConnection(conn, config);
  await new Promise((resolve) => setTimeout(resolve, 10));
  conn.finish();
  const result = await Promise.race([
    serving.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assertEquals(result, "returned");
  releaseWrite();
  releaseLane();
  await occupying;
});

Deno.test("a stalled refusal write times out with buffered input", async () => {
  const lane = new WorkLane(1, 0);
  let releaseLane: () => void = () => {};
  const laneGate = new Promise<void>((resolve) => releaseLane = resolve);
  const occupying = lane.run(async () => await laneGate);
  let releaseWrite: () => void = () => {};
  const writeGate = new Promise<void>((resolve) => releaseWrite = resolve);
  const config = {
    ...options(() => Promise.resolve({ ok: true }), lane),
    writeTimeoutMs: 20,
    overloadWaitTimeoutMs: 20,
  };
  const conn = controlledConnection(
    [
      '{"id":1,"cmd":"image"}\n',
      '{"id":2,"cmd":"send"}\n',
    ],
    undefined,
    writeGate,
  );
  const result = await Promise.race([
    servePanelConnection(conn, config).then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assertEquals(result, "returned");
  releaseWrite();
  releaseLane();
  await occupying;
});

Deno.test("retained-frame budget spans repeated media refusal waits", async () => {
  const lane = new WorkLane(16);
  let releaseLane: () => void = () => {};
  const laneGate = new Promise<void>((resolve) => releaseLane = resolve);
  const writeReleases: Array<() => void> = [];
  const config = {
    ...options(async () => {
      await laneGate;
      return { ok: true };
    }, lane),
    writeTimeoutMs: 5_000,
    overloadWaitTimeoutMs: 5_000,
  };
  const initial = Array.from(
    { length: PANEL_MEDIA_QUEUE_MAX + 1 },
    (_, id) => JSON.stringify({ id, cmd: "image" }) + "\n",
  );
  const conn = controlledConnection(
    initial,
    undefined,
    () => new Promise<void>((resolve) => writeReleases.push(resolve)),
  );
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => writeReleases.length === 1,
    "first refusal did not block",
  );
  for (let id = 100; id < 100 + PANEL_ORDINARY_QUEUE_MAX - 1; id++) {
    conn.send(JSON.stringify({ id, cmd: "image" }) + "\n");
  }
  writeReleases.shift()?.();
  await waitFor(
    () => writeReleases.length === 1,
    "second refusal did not block",
  );
  for (let id = 200; id < 200 + PANEL_ORDINARY_QUEUE_MAX - 1; id++) {
    conn.send(JSON.stringify({ id, cmd: "image" }) + "\n");
  }
  const result = await Promise.race([
    serving.then(() => "returned"),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("unbounded"), 50)
    ),
  ]);
  assertEquals(result, "returned");
  for (const release of writeReleases.splice(0)) release();
  releaseLane();
});

Deno.test("overflowed message frames each receive a recoverable refusal", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const handled: number[] = [];
  const config = {
    ...options(async (req) => {
      const id = Number(req.id);
      handled.push(id);
      if (id === 0) await firstGate;
      return { ok: true };
    }),
    overloadWaitTimeoutMs: 20,
  };
  const requests = Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX },
    (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
  );
  requests.push(
    JSON.stringify({
      id: PANEL_ORDINARY_QUEUE_MAX,
      cmd: "send",
      requestId: "first-overflow-send",
    }) + "\n",
    JSON.stringify({
      id: PANEL_ORDINARY_QUEUE_MAX + 1,
      cmd: "send",
      requestId: "buffered-overflow-send",
    }) + "\n",
    JSON.stringify({
      id: PANEL_ORDINARY_QUEUE_MAX + 2,
      cmd: "send",
      requestId: "third-overflow-send",
    }) + "\n",
  );
  const conn = controlledConnection(requests);
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () =>
      conn.replies().filter((reply) =>
        Number(reply.id) >= PANEL_ORDINARY_QUEUE_MAX
      ).length === 3,
    "overflowed sends received no refusal",
  );
  assertEquals(handled, [0]);
  assertEquals(
    conn.replies().filter((reply) =>
      Number(reply.id) >= PANEL_ORDINARY_QUEUE_MAX
    )
      .map((reply) => [reply.id, reply.error]),
    [
      [PANEL_ORDINARY_QUEUE_MAX, PANEL_COMMAND_BUSY_TEXT],
      [PANEL_ORDINARY_QUEUE_MAX + 1, PANEL_COMMAND_BUSY_TEXT],
      [PANEL_ORDINARY_QUEUE_MAX + 2, PANEL_COMMAND_BUSY_TEXT],
    ],
  );
  releaseFirst();
  await waitFor(
    () => handled.length === PANEL_ORDINARY_QUEUE_MAX,
    "accepted messages did not drain",
  );
  conn.finish();
  await serving;
});

Deno.test("an overflow refusal does not delay a later preview", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const handled: Array<{ id: number; cmd: string }> = [];
  const config = {
    ...options(async (req) => {
      const row = { id: Number(req.id), cmd: String(req.cmd) };
      handled.push(row);
      if (row.id === 0) await firstGate;
      return { ok: true };
    }),
    overloadWaitTimeoutMs: 20,
  };
  const requests = Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX },
    (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
  );
  requests.push(
    JSON.stringify({ id: 64, cmd: "send", requestId: "overflow" }) + "\n",
    JSON.stringify({ id: 65, cmd: "preview" }) + "\n",
  );
  const conn = controlledConnection(requests);
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => conn.replies().some((reply) => reply.id === 65),
    "retained preview received no correlated reply",
  );
  assertEquals(
    conn.replies().find((reply) => reply.id === 64)?.error,
    PANEL_COMMAND_BUSY_TEXT,
  );
  assertEquals(handled.filter((row) => row.id === 65), [{
    id: 65,
    cmd: "preview",
  }]);
  releaseFirst();
  conn.finish();
  await serving;
});

Deno.test("overflow refusals still allow disconnect to cancel queued media", async () => {
  const lane = new WorkLane(1);
  let releaseMedia: () => void = () => {};
  const mediaGate = new Promise<void>((resolve) => releaseMedia = resolve);
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const handled: Array<{ id: number; cmd: string }> = [];
  let closed = 0;
  const config = {
    ...options(async (req) => {
      const row = { id: Number(req.id), cmd: String(req.cmd) };
      handled.push(row);
      if (row.id === 100) await mediaGate;
      if (row.id === 0) await firstGate;
      return { ok: true };
    }, lane),
    overloadWaitTimeoutMs: 20,
    onClosed: () => closed++,
  };
  const requests = [
    JSON.stringify({ id: 100, cmd: "image" }) + "\n",
    JSON.stringify({ id: 101, cmd: "preview" }) + "\n",
    ...Array.from(
      { length: PANEL_ORDINARY_QUEUE_MAX },
      (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
    ),
    JSON.stringify({ id: 200, cmd: "send", requestId: "overflow" }) + "\n",
  ];
  const conn = controlledConnection(requests);
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => lane.active === 1 && lane.pending === 1,
    "media was not queued",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  conn.finish();
  const result = await Promise.race([
    serving.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assertEquals(result, "returned");
  assertEquals(closed, 1);
  assertEquals(lane.pending, 0);
  assertEquals(
    conn.replies().find((reply) => reply.id === 200)?.error,
    PANEL_COMMAND_BUSY_TEXT,
  );
  assertEquals(handled.some((row) => row.id === 200), false);
  releaseFirst();
  releaseMedia();
});

Deno.test("disconnect remains observable after overflow refusals", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const handled: number[] = [];
  let closed = 0;
  const config = {
    ...options(async (req) => {
      const id = Number(req.id);
      handled.push(id);
      if (id === 0) await firstGate;
      return { ok: true };
    }),
    overloadWaitTimeoutMs: 20,
    onClosed: () => closed++,
  };
  const requests = Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX + 3 },
    (_, id) => JSON.stringify({ id, cmd: "send" }) + "\n",
  );
  const conn = controlledConnection(requests);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => handled.length === 1, "first command did not start");
  conn.finish();
  const result = await Promise.race([
    serving.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assertEquals(result, "returned");
  assertEquals(closed, 1);
  assertEquals(
    conn.replies().filter((reply) =>
      Number(reply.id) >= PANEL_ORDINARY_QUEUE_MAX
    )
      .map((reply) => reply.error),
    Array(3).fill(PANEL_COMMAND_BUSY_TEXT),
  );
  releaseFirst();
  await waitFor(
    () => handled.length === PANEL_ORDINARY_QUEUE_MAX,
    "accepted requests did not drain after disconnect",
  );
});

Deno.test("132 token-bearing sends each execute or receive a refusal", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const handled: number[] = [];
  let closedCount = 0;
  const config = {
    ...options(async (req) => {
      const id = Number(req.id);
      handled.push(id);
      if (id === 0) await firstGate;
      return { ok: true };
    }),
    onClosed: () => closedCount++,
  };
  const total = PANEL_ORDINARY_QUEUE_MAX * 2 + 4;
  const conn = controlledConnection(Array.from(
    { length: total },
    (_, id) => JSON.stringify({ id, cmd: "send" }) + "\n",
  ));
  const serving = servePanelConnection(conn, config);
  const saturated = await Promise.race([
    serving.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assertEquals(saturated, "blocked");
  assertEquals(closedCount, 0);
  assertEquals(handled, [0]);
  assertEquals(conn.replies().length, total - PANEL_ORDINARY_QUEUE_MAX);
  assertEquals(
    conn.replies().every((reply) => reply.error === PANEL_COMMAND_BUSY_TEXT),
    true,
  );
  releaseFirst();
  await waitFor(
    () => handled.length === PANEL_ORDINARY_QUEUE_MAX,
    "accepted sends did not drain",
  );
  await waitFor(
    () => conn.replies().length === total,
    "some sends had no outcome",
  );
  assertEquals(new Set(conn.replies().map((reply) => reply.id)).size, total);
  conn.finish();
  await serving;
});

Deno.test("overflowed ordinary mutations receive recoverable refusals", async () => {
  for (const cmd of ["logout", "hide", "react", "unsend"]) {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
    const handled: Array<{ id: number; cmd: string }> = [];
    const config = {
      ...options(async (req) => {
        const row = { id: Number(req.id), cmd: String(req.cmd) };
        handled.push(row);
        if (row.id === 0) await firstGate;
        return { ok: true };
      }),
      overloadWaitTimeoutMs: 20,
    };
    const requests = Array.from(
      { length: PANEL_ORDINARY_QUEUE_MAX },
      (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
    );
    requests.push(
      JSON.stringify({
        id: PANEL_ORDINARY_QUEUE_MAX,
        cmd,
      }) + "\n",
    );
    const conn = controlledConnection(requests);
    const serving = servePanelConnection(conn, config);
    await waitFor(
      () =>
        conn.replies().some((reply) => reply.id === PANEL_ORDINARY_QUEUE_MAX),
      `overflowed ${cmd} received no refusal`,
    );
    assertEquals(handled, [{ id: 0, cmd: "history" }]);
    assertEquals(
      conn.replies().find((reply) => reply.id === PANEL_ORDINARY_QUEUE_MAX)
        ?.error,
      PANEL_COMMAND_BUSY_TEXT,
    );
    releaseFirst();
    await waitFor(
      () => handled.length === PANEL_ORDINARY_QUEUE_MAX,
      "accepted requests did not drain",
    );
    assertEquals(
      handled.filter((row) => row.id === PANEL_ORDINARY_QUEUE_MAX),
      [],
    );
    conn.finish();
    await serving;
  }
});

Deno.test("a buffered message keeps the session captured when it arrived", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  let generation = 1;
  let captures = 0;
  const sends: number[] = [];
  const config = {
    ...options(async (req) => {
      if (Number(req.id) === 0) await firstGate;
      if (req.cmd === "send") sends.push(Number(req.id));
      return { ok: true };
    }),
    captureValidity() {
      captures++;
      const accepted = generation;
      return () => accepted === generation;
    },
    staleRequestError: "stale session",
  };
  const requests = Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX },
    (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
  );
  requests.push(
    JSON.stringify({ id: PANEL_ORDINARY_QUEUE_MAX, cmd: "send" }) + "\n",
    JSON.stringify({ id: PANEL_ORDINARY_QUEUE_MAX + 1, cmd: "send" }) + "\n",
  );
  const conn = controlledConnection(requests);
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => captures >= PANEL_ORDINARY_QUEUE_MAX + 2,
    "look-ahead message was not captured",
  );
  generation++;
  releaseFirst();
  await waitFor(
    () => conn.replies().length === PANEL_ORDINARY_QUEUE_MAX + 2,
    "stale buffered replies were missing",
  );
  conn.finish();
  await serving;
  assertEquals(sends, []);
  assertEquals(conn.replies().slice(-2).map((reply) => reply.error), [
    "stale session",
    "stale session",
  ]);
});

Deno.test("a send is admitted when its overload refusal cannot be delivered", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  const handled: number[] = [];
  const config = options(async (req) => {
    const id = Number(req.id);
    handled.push(id);
    if (id === 0) await firstGate;
    return { ok: true };
  });
  const requests = Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX },
    (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
  );
  requests.push(
    JSON.stringify({
      id: PANEL_ORDINARY_QUEUE_MAX,
      cmd: "send",
      requestId: "refusal-write-failed",
    }) + "\n",
  );
  const conn = controlledConnection(requests, new Error("broken pipe"));
  const serving = servePanelConnection(conn, config);
  await waitFor(() => handled.length === 1, "first command did not start");
  await serving;
  releaseFirst();
  await waitFor(
    () => handled.includes(PANEL_ORDINARY_QUEUE_MAX),
    "send with an unobservable refusal was not admitted",
  );
  assertEquals(
    handled.filter((id) => id === PANEL_ORDINARY_QUEUE_MAX),
    [PANEL_ORDINARY_QUEUE_MAX],
  );
});

Deno.test("a look-ahead reset is handled while an overload refusal waits", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  let releaseWrite: () => void = () => {};
  const writeGate = new Promise<void>((resolve) => releaseWrite = resolve);
  let markWriteStarted: () => void = () => {};
  const writeStarted = new Promise<void>((resolve) =>
    markWriteStarted = resolve
  );
  const handled: number[] = [];
  const config = {
    ...options(async (req) => {
      const id = Number(req.id);
      handled.push(id);
      if (id === 0) await firstGate;
      return { ok: true };
    }),
    writeTimeoutMs: 1_000,
  };
  const requests = Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX },
    (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
  );
  requests.push(
    JSON.stringify({
      id: PANEL_ORDINARY_QUEUE_MAX,
      cmd: "send",
      requestId: "reset-during-refusal",
    }) + "\n",
  );
  const conn = controlledConnection(requests, undefined, async () => {
    markWriteStarted();
    await writeGate;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const serving = servePanelConnection(conn, config);
    await writeStarted;
    conn.reset();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(unhandled, []);
    releaseWrite();
    await serving;
    releaseFirst();
    await waitFor(
      () => handled.includes(PANEL_ORDINARY_QUEUE_MAX),
      "send with a reset refusal was not admitted",
    );
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
    releaseWrite();
    releaseFirst();
  }
});

Deno.test("a failed refusal write still admits its buffered message", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
  let captures = 0;
  const handled: number[] = [];
  const config = {
    ...options(async (req) => {
      const id = Number(req.id);
      handled.push(id);
      if (id === 0) await firstGate;
      return { ok: true };
    }),
    captureValidity() {
      captures++;
      return () => true;
    },
  };
  const requests = Array.from(
    { length: PANEL_ORDINARY_QUEUE_MAX + 1 },
    (_, id) => JSON.stringify({ id, cmd: "history" }) + "\n",
  );
  requests.push(
    JSON.stringify({
      id: PANEL_ORDINARY_QUEUE_MAX + 1,
      cmd: "send",
      requestId: "held-after-write-failure",
    }) + "\n",
    JSON.stringify({
      id: PANEL_ORDINARY_QUEUE_MAX + 2,
      cmd: "send",
      requestId: "second-held-after-write-failure",
    }) + "\n",
  );
  const conn = controlledConnection(requests, new Error("broken pipe"));
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => captures >= PANEL_ORDINARY_QUEUE_MAX + 3,
    "look-ahead messages were not read",
  );
  releaseFirst();
  await serving;
  await waitFor(
    () => handled.includes(PANEL_ORDINARY_QUEUE_MAX + 2),
    "buffered messages disappeared after write failure",
  );
  assertEquals(
    handled.slice(-2),
    [PANEL_ORDINARY_QUEUE_MAX + 1, PANEL_ORDINARY_QUEUE_MAX + 2],
  );
});

Deno.test("error-only and empty refusals report their fallback text", async () => {
  const failures: unknown[] = [];
  const replies = [
    { ok: false, error: "plain refusal" },
    { ok: false },
  ];
  const config = options(
    () => Promise.resolve(replies.shift() ?? {}),
    new WorkLane(4),
    failures,
  );
  const conn = controlledConnection([
    '{"id":1,"cmd":"first"}\n',
    '{"id":2,"cmd":"second"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => conn.replies().length === 2, "refusal replies missing");
  conn.finish();
  await serving;
  assertEquals(failures, ["plain refusal", ""]);
  assertEquals(conn.replies(), [
    { ok: false, error: "plain refusal", id: 1 },
    { ok: false, id: 2 },
  ]);
});

Deno.test("invalid and empty request lines are ignored", async () => {
  let handled = 0;
  const config = options(() => {
    handled++;
    return Promise.resolve({ ok: true });
  });
  const conn = controlledConnection([
    "\n",
    "not-json\n",
    "null\n",
    "42\n",
    "[]\n",
    '{"id":3,"cmd":"send"}\n',
  ]);
  conn.finish();
  await servePanelConnection(conn, config);
  assertEquals(handled, 1);
  assertEquals(conn.replies(), [{ ok: true, id: 3 }]);
});

Deno.test("EOF cancels queued media without starting it", async () => {
  const lane = new WorkLane(1);
  const starts: number[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = options(async (req) => {
    starts.push(Number(req.id));
    await gate;
    return { ok: true };
  }, lane);
  const conn = controlledConnection([
    '{"id":1,"cmd":"download"}\n',
    '{"id":2,"cmd":"download"}\n',
    '{"id":3,"cmd":"download"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => lane.active === 1 && lane.pending === 2,
    "jobs not queued",
  );
  conn.finish();
  const result = await Promise.race([
    serving.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assertEquals(result, "returned");
  assertEquals(lane.pending, 0);
  assertEquals(starts, [1]);
  release();
  await waitFor(() => lane.active === 0, "running media job did not finish");
});

Deno.test("a reset cancels queued media without starting it", async () => {
  const lane = new WorkLane(1);
  const starts: number[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = options(async (req) => {
    starts.push(Number(req.id));
    await gate;
    return { ok: true };
  }, lane);
  const conn = controlledConnection([
    '{"id":1,"cmd":"download"}\n',
    '{"id":2,"cmd":"download"}\n',
    '{"id":3,"cmd":"download"}\n',
  ]);
  const serving = servePanelConnection(conn, config).catch(() => {});
  await waitFor(
    () => lane.active === 1 && lane.pending === 2,
    "jobs not queued",
  );
  conn.reset();
  await serving;
  assertEquals(lane.pending, 0);
  assertEquals(starts, [1]);
  release();
  await waitFor(() => lane.active === 0, "running media job did not finish");
});

Deno.test("a failed write cancels queued media without starting it", async () => {
  const lane = new WorkLane(1);
  const starts: number[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = options(async (req) => {
    starts.push(Number(req.id));
    await gate;
    return { ok: true };
  }, lane);
  const conn = controlledConnection([
    '{"id":1,"cmd":"download"}\n',
    '{"id":2,"cmd":"download"}\n',
    '{"id":3,"cmd":"download"}\n',
  ], new Error("broken pipe"));
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => lane.active === 1 && lane.pending === 2,
    "jobs not queued",
  );
  release();
  await waitFor(() => lane.pending === 0, "queued jobs were not cancelled");
  assertEquals(starts, [1]);
  await serving;
});

Deno.test("lane retirement refuses queued media on an open socket", async () => {
  const lane = new WorkLane(1);
  const starts: number[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = {
    ...options(async (req) => {
      starts.push(Number(req.id));
      await gate;
      return { ok: true };
    }, lane),
    staleRequestError: "stale session",
  };
  const conn = controlledConnection([
    '{"id":1,"cmd":"preview"}\n',
    '{"id":2,"cmd":"download"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => lane.active === 1 && lane.pending === 1,
    "second media request was not queued",
  );
  const retired = lane.retire();
  await waitFor(
    () => conn.replies().some((reply) => reply.id === 2),
    "retired media request received no reply",
  );
  assertEquals(conn.replies().find((reply) => reply.id === 2), {
    ok: false,
    error: "stale session",
    id: 2,
  });
  assertEquals(starts, [1]);
  release();
  await retired;
  await waitFor(() => conn.replies().length === 2, "active reply was missing");
  conn.finish();
  await serving;
});

Deno.test("session retirement suppresses a retired session's success", async () => {
  const lane = new WorkLane(1);
  const retirement = new AbortController();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = {
    ...options(async () => {
      await gate;
      return { ok: true };
    }, lane),
    backgroundSignal: () => retirement.signal,
  };
  const conn = controlledConnection(['{"id":1,"cmd":"download"}\n']);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => lane.active === 1, "media request did not start");
  retirement.abort();
  assertEquals(lane.active, 1);
  release();
  await waitFor(
    () => lane.active === 0,
    "retired media request did not settle",
  );
  // The download completed, but its session is gone: a late success must
  // not land on the still-open socket, because the panel's download path
  // delivers any reply that still finds an openWanted entry -- with no
  // stale-session check to stop a logged-out account's file.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(
    conn.replies(),
    [],
    "a retired session's successful reply was delivered",
  );
  conn.finish();
  await serving;
});

Deno.test("a mid-write retirement closes the socket on its success", async () => {
  const lane = new WorkLane(1);
  const retirement = new AbortController();
  let releaseWrite: () => void = () => {};
  const writeGate = new Promise<void>((resolve) => releaseWrite = resolve);
  const config = {
    ...options(() => Promise.resolve({ ok: true }), lane),
    backgroundSignal: () => retirement.signal,
  };
  const conn = controlledConnection(
    ['{"id":1,"cmd":"image"}\n'],
    undefined,
    writeGate,
  );
  const serving = servePanelConnection(conn, config);
  // The success is admitted and its socket write is parked in the gate;
  // the retirement lands after the admission check but before any byte.
  await new Promise((resolve) => setTimeout(resolve, 50));
  retirement.abort();
  await waitFor(
    () => conn.isClosed(),
    "mid-write retirement left the socket open",
  );
  releaseWrite();
  assertEquals(conn.replies(), []);
  conn.finish();
  await serving;
});

Deno.test("session retirement still answers a live socket's refusal", async () => {
  const lane = new WorkLane(1);
  const retirement = new AbortController();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = {
    ...options(async () => {
      await gate;
      throw new Error("retired before the fetch finished");
    }, lane),
    backgroundSignal: () => retirement.signal,
  };
  const conn = controlledConnection(['{"id":1,"cmd":"image"}\n']);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => lane.active === 1, "media request did not start");
  retirement.abort();
  assertEquals(lane.active, 1);
  release();
  await waitFor(
    () => lane.active === 0,
    "retired media request did not settle",
  );
  // The work failed under the retired session, but the socket is still
  // open: the request gets its refusal so the panel's in-flight dedup
  // entry clears and the image can be re-requested against the next session.
  await waitFor(
    () => conn.replies().length === 1,
    "retired media request left the request unanswered",
  );
  assertEquals(conn.replies()[0].id, 1);
  assertEquals(conn.replies()[0].ok, false);
  conn.finish();
  await serving;
});

Deno.test("an open socket uses the replacement media retirement signal", async () => {
  const lane = new WorkLane(1);
  let retirement = new AbortController();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const starts: number[] = [];
  const config = {
    ...options(async (req) => {
      starts.push(Number(req.id));
      if (req.id === 1) await gate;
      return { ok: true };
    }, lane),
    backgroundSignal: () => retirement.signal,
  };
  const conn = controlledConnection(['{"id":1,"cmd":"image"}\n']);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => starts.length === 1, "first media request did not start");
  retirement.abort();
  retirement = new AbortController();
  release();
  await waitFor(
    () => lane.active === 0,
    "retired media request did not settle",
  );
  conn.send('{"id":2,"cmd":"preview"}\n');
  await waitFor(() => starts.length === 2, "replacement signal stayed aborted");
  await waitFor(
    () => conn.replies().length === 1,
    "new media reply was missing",
  );
  assertEquals(starts, [1, 2]);
  // Only the replacement session's success lands; the retired one is dropped.
  assertEquals(conn.replies()[0].id, 2);
  conn.finish();
  await serving;
});

Deno.test("a failed write still drains admitted ordinary commands", async () => {
  const starts: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = options(async (req) => {
    starts.push(String(req.cmd));
    if (req.cmd === "send") await gate;
    return { ok: true };
  });
  const conn = controlledConnection([
    '{"id":1,"cmd":"send"}\n',
    '{"id":2,"cmd":"react"}\n',
    '{"id":3,"cmd":"logout"}\n',
  ], new Error("broken pipe"));
  const serving = servePanelConnection(conn, config);
  await waitFor(() => starts.length === 1, "first command did not start");
  release();
  await serving;
  await waitFor(() => starts.length === 3, "admitted commands did not drain");
  assertEquals(starts, ["send", "react", "logout"]);
});

Deno.test("a completed look-ahead send survives an earlier write failure", async () => {
  let releaseWrite: () => void = () => {};
  const writeGate = new Promise<void>((resolve) => releaseWrite = resolve);
  const handled: number[] = [];
  const config = options((req) => {
    handled.push(Number(req.id));
    return Promise.resolve({ ok: true });
  });
  const conn = controlledConnection(
    [
      '{"id":1,"cmd":"history"}\n',
      '{"id":2,"cmd":"send","requestId":"look-ahead-send"}\n',
    ],
    new Error("broken pipe"),
    writeGate,
  );
  const serving = servePanelConnection(conn, config);
  await waitFor(() => handled.length === 1, "first request did not start");
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseWrite();
  await serving;
  await waitFor(
    () => handled.includes(2),
    "completed look-ahead send was discarded during write cleanup",
  );
  assertEquals(handled.filter((id) => id === 2), [2]);
});

Deno.test("EOF returns before an active ordinary request finishes", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  let closed = 0;
  const config = {
    ...options(async () => {
      await gate;
      return { ok: true };
    }),
    onClosed: () => closed++,
  };
  const conn = controlledConnection(['{"id":1,"cmd":"history"}\n']);
  const serving = servePanelConnection(conn, config);
  await new Promise((resolve) => setTimeout(resolve, 10));
  conn.finish();
  const result = await Promise.race([
    serving.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assertEquals(result, "returned");
  assertEquals(closed, 1);
  release();
});

Deno.test("EOF returns but an admitted queued send still reaches the handler", async () => {
  const starts: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = options(async (req) => {
    starts.push(String(req.cmd));
    if (req.cmd === "history") await gate;
    return { ok: true };
  });
  const conn = controlledConnection([
    '{"id":1,"cmd":"history"}\n',
    '{"id":2,"cmd":"send","requestId":"request-2"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => starts.length === 1, "first command did not start");
  conn.finish();
  await serving;
  assertEquals(starts, ["history"]);
  release();
  await waitFor(() => starts.length === 2, "admitted send was discarded");
  assertEquals(starts, ["history", "send"]);
});

Deno.test("panel connections share one media concurrency limit", async () => {
  const lane = new WorkLane(2);
  const starts: string[] = [];
  let peak = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = options(async (req) => {
    starts.push(String(req.source));
    peak = Math.max(peak, lane.active);
    await gate;
    return { ok: true };
  }, lane);
  const first = controlledConnection([
    '{"id":1,"cmd":"image","source":"first"}\n',
    '{"id":2,"cmd":"image","source":"first"}\n',
    '{"id":3,"cmd":"image","source":"first"}\n',
  ]);
  const second = controlledConnection([
    '{"id":4,"cmd":"preview","source":"second"}\n',
    '{"id":5,"cmd":"preview","source":"second"}\n',
    '{"id":6,"cmd":"preview","source":"second"}\n',
  ]);
  const serving = [
    servePanelConnection(first, config),
    servePanelConnection(second, config),
  ];
  await waitFor(
    () => lane.active === 2 && lane.pending === 4,
    "shared queue missing",
  );
  assertEquals(peak, 2);
  release();
  await waitFor(() => starts.length === 6, "not all shared jobs started");
  assert(starts.includes("first"));
  assert(starts.includes("second"));
  first.finish();
  second.finish();
  await Promise.all(serving);
});

Deno.test("queued requests keep the session that accepted them", async () => {
  const lane = new WorkLane(4);
  const starts: number[] = [];
  let generation = 1;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = {
    ...options(async (req) => {
      starts.push(Number(req.id));
      await gate;
      return { ok: true };
    }, lane),
    captureValidity() {
      const accepted = generation;
      return () => accepted === generation;
    },
    staleRequestError: "stale session",
  };
  const conn = controlledConnection(Array.from(
    { length: 5 },
    (_, id) => JSON.stringify({ id, cmd: "preview" }) + "\n",
  ));
  const serving = servePanelConnection(conn, config);
  await waitFor(() => starts.length === 4, "four media jobs did not start");
  generation++;
  release();
  await waitFor(
    () => conn.replies().length === 5,
    "media replies were missing",
  );
  conn.finish();
  await serving;
  assertEquals(starts, [0, 1, 2, 3]);
  assertEquals(
    conn.replies().find((reply) => reply.id === 4)?.error,
    "stale session",
  );
});

Deno.test("queued ordinary requests keep the session that accepted them", async () => {
  const calls: string[] = [];
  let generation = 1;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = {
    ...options(async (req) => {
      calls.push(String(req.cmd));
      if (req.cmd === "history") await gate;
      return { ok: true };
    }),
    captureValidity() {
      const accepted = generation;
      return () => accepted === generation;
    },
    staleRequestError: "stale session",
  };
  const conn = controlledConnection([
    '{"id":1,"cmd":"history"}\n',
    '{"id":2,"cmd":"send","requestId":"old-account"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => calls.length === 1, "history did not start");
  generation++;
  release();
  await waitFor(() => conn.replies().length === 2, "ordinary replies missing");
  conn.finish();
  await serving;
  assertEquals(calls, ["history"]);
  assertEquals(conn.replies()[1], {
    ok: false,
    error: "stale session",
    id: 2,
  });
});

Deno.test("queued logout is idempotent but cannot end a replacement session", async () => {
  const calls: string[] = [];
  let generation = 1;
  let current: "old" | "new" | null = "old";
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = {
    ...options(async (req) => {
      const cmd = String(req.cmd);
      calls.push(cmd);
      if (cmd === "history") await gate;
      if (req.id === 2 && cmd === "logout") {
        current = "new";
        generation++;
      }
      return { ok: true };
    }),
    captureValidity() {
      const accepted = generation;
      return () => accepted === generation;
    },
    allowStaleCommand(cmd: string) {
      return cmd === "logout" && current === null;
    },
    staleRequestError: "stale session",
  };
  const conn = controlledConnection([
    '{"id":1,"cmd":"history"}\n',
    '{"id":2,"cmd":"logout"}\n',
    '{"id":3,"cmd":"logout"}\n',
    '{"id":4,"cmd":"login"}\n',
    '{"id":5,"cmd":"sync"}\n',
  ]);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => calls.length === 1, "history did not start");
  current = null;
  generation++;
  release();
  await waitFor(() => conn.replies().length === 5, "session replies missing");
  conn.finish();
  await serving;
  assertEquals(calls, ["history", "logout", "login", "sync"]);
  assertEquals(conn.replies().find((reply) => reply.id === 2)?.ok, true);
  assertEquals(
    conn.replies().find((reply) => reply.id === 3)?.error,
    "stale session",
  );
});

Deno.test("one panel cannot grow the shared media queue without a bound", async () => {
  const lane = new WorkLane(2);
  const starts: number[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = options(async (req) => {
    starts.push(Number(req.id));
    await gate;
    return { ok: true };
  }, lane);
  const conn = controlledConnection(Array.from(
    { length: 40 },
    (_, id) => JSON.stringify({ id, cmd: "image" }) + "\n",
  ));
  const serving = servePanelConnection(conn, config);
  await waitFor(
    () => lane.active === 2 && lane.pending === 14,
    "media queue did not stop at the per-panel cap",
  );
  await waitFor(
    () => conn.replies().length === 24,
    "overflow requests did not receive refusals",
  );
  assertEquals(
    new Set(conn.replies().map((reply) => reply.error)),
    new Set([PANEL_MEDIA_BUSY_TEXT]),
  );
  release();
  await waitFor(() => starts.length === 16, "admitted media did not finish");
  conn.finish();
  await serving;
  assertEquals(conn.replies().length, 40);
});

Deno.test("several panels share one bounded pending media queue", async () => {
  const lane = new WorkLane(2, 3);
  const starts: number[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const config = options(async (req) => {
    starts.push(Number(req.id));
    await gate;
    return { ok: true };
  }, lane);
  const clients = [0, 1, 2].map((group) =>
    controlledConnection(Array.from(
      { length: 16 },
      (_, index) =>
        JSON.stringify({ id: group * 16 + index, cmd: "image" }) + "\n",
    ))
  );
  const serving = clients.map((client) => servePanelConnection(client, config));
  await waitFor(
    () => lane.active === 2 && lane.pending === 3,
    "process-wide media queue exceeded its bound",
  );
  release();
  await waitFor(() => starts.length === 5, "admitted media did not finish");
  for (const client of clients) client.finish();
  await Promise.all(serving);
  assertEquals(starts.length, 5);
});

Deno.test("a push line rides the same serialized lane as replies", async () => {
  let push: ((line: string) => void) | undefined;
  const config = {
    ...options((req) => Promise.resolve({ ok: true, data: { cmd: req.cmd } })),
    attachPusher(send: (line: string) => void) {
      push = send;
    },
  };
  const conn = controlledConnection(['{"id":1,"cmd":"sync"}\n']);
  const serving = servePanelConnection(conn, config);
  await waitFor(() => conn.replies().length === 1, "reply never arrived");
  push?.('{"event":{"seq":7,"kind":"message","chat":"c1"},"boot":"b1"}');
  await waitFor(() => conn.replies().length === 2, "push was never written");
  assertEquals(conn.replies(), [
    { ok: true, data: { cmd: "sync" }, id: 1 },
    { event: { seq: 7, kind: "message", chat: "c1" }, boot: "b1" },
  ]);
  conn.finish();
  await serving;
});

Deno.test("a push that cannot be written closes the connection", async () => {
  let push: ((line: string) => void) | undefined;
  let closedReported = false;
  const config = {
    ...options(() => Promise.resolve({ ok: true })),
    attachPusher(send: (line: string) => void) {
      push = send;
    },
    onClosed() {
      closedReported = true;
    },
  };
  const conn = controlledConnection([], new Error("peer gone"));
  const serving = servePanelConnection(conn, config).catch(() => {});
  push?.('{"event":{"seq":1,"kind":"message","chat":"c1"},"boot":"b1"}');
  await waitFor(
    () => closedReported,
    "failed push did not close the connection",
  );
  conn.finish();
  await serving;
});

Deno.test("a push to a peer that stopped reading times out and closes", async () => {
  let push: ((line: string) => void) | undefined;
  let closedReported = false;
  const config = {
    ...options(() => Promise.resolve({ ok: true })),
    writeTimeoutMs: 20,
    attachPusher(send: (line: string) => void) {
      push = send;
    },
    onClosed() {
      closedReported = true;
    },
  };
  // A write that never completes: the socket buffer of a peer that is
  // connected but no longer reading.
  const conn = controlledConnection([], undefined, new Promise<void>(() => {}));
  const serving = servePanelConnection(conn, config).catch(() => {});
  push?.('{"event":{"seq":1,"kind":"message","chat":"c1"},"boot":"b1"}');
  await waitFor(
    () => closedReported && conn.isClosed(),
    "a stalled push held the connection open",
  );
  conn.finish();
  await serving;
});

Deno.test("chat row pushes ride the same sink the events do", async () => {
  // The single-row call sites are the wiring; a source pin is the only honest
  // check here, the same way the logout ordering above is pinned.
  const state = await Deno.readTextFile(
    new URL("./modules/state.ts", import.meta.url),
  );
  const socket = await Deno.readTextFile(
    new URL("./modules/socket.ts", import.meta.url),
  );
  const push = await Deno.readTextFile(
    new URL("./modules/push.ts", import.meta.url),
  );
  const avatars = await Deno.readTextFile(
    new URL("./modules/avatars.ts", import.meta.url),
  );
  // The row must be stamped before it leaves: hidden lives on the serialized
  // copy, and an unstamped push would un-hide a chat until the file lands.
  assert(state.includes("chatSink?.(hiddenStamped([changed])[0]"));
  assert(
    socket.includes("chat: row") &&
      socket.includes("chatsRevision: revision") &&
      socket.includes("boot: BOOT_ID"),
  );
  // Every repaint-of-one-row call site names its row; a bare bump means a
  // row changed without telling subscribed panels which one.
  const bumps = push.match(/bumpChatsRevision\(([^)]*)\)/g) ?? [];
  assert(
    bumps.length > 0 && bumps.every((b) => b !== "bumpChatsRevision()"),
    "push.ts must pass the changed row: " + bumps.join(", "),
  );
  assert(avatars.includes("bumpChatsRevision(next.find("));
});

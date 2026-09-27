/**
 * The one sentence a caught value turns into, and its trip to the wire.
 *
 *   deno test -A errortext_test.ts
 *
 * `stickerListRefusal` interpolated `(e as Error).message`, so anything that
 * was not an Error -- a `throw "boom"` under it, a rejected promise carrying a
 * bare bag, a thrown `undefined` -- reached the panel as
 * 「貼圖清單讀不到：undefined」. The same cast sat at the dispatcher, which is
 * every command's last catch, so the table is checked twice: once on the
 * helper, and once end to end through the real servePanel loop on a fake conn.
 * A helper that is right and a caller that does not use it look identical from
 * the outside, and the caller is the half the panel reads.
 */
import { assertEquals } from "@std/assert";
import { loadBlock, loadBlocks } from "./slice_test.ts";
import { type JsonReply, servePanelConnection } from "./panelserver.ts";
import { WorkLane } from "./runtime.ts";

const UNKNOWN_ERROR = "不明錯誤";
const ENCODE_ERROR = "回覆無法編碼";

const PRELUDE = `
export { errorText, UNKNOWN_ERROR };
`;

interface ErrorTextModule {
  errorText(value: unknown): string;
  UNKNOWN_ERROR: string;
}

let M: ErrorTextModule | undefined;
async function mod(): Promise<ErrorTextModule> {
  if (M) return M;
  const loaded = await loadBlock<ErrorTextModule>("errortext", PRELUDE);
  M = loaded;
  return loaded;
}

/** Every case in one table: the panel prints whatever comes out of here. */
const CASES: [unknown, string][] = [
  [new Error("shop said no"), "shop said no"],
  // The class is deliberately dropped: errorLine is what puts `TypeError:` in
  // front of a message, and that belongs in the journal, not on a bubble.
  [new TypeError("x is not a function"), "x is not a function"],
  [new Deno.errors.NotFound("no such file"), "no such file"],
  ["boom", "boom"],
  ["尚未登入", "尚未登入"],
  // linejs rejects with a bag of its own more than once.
  [{ message: "InternalError: ObsError" }, "InternalError: ObsError"],
  [{ message: 7 }, "[object Object]"],
  [{}, "[object Object]"],
  [{ toString: () => "自己會講話的東西" }, "自己會講話的東西"],
  [42, "42"],
  [false, "false"],
  // The bug itself: a cast turned each of these into the word "undefined".
  [undefined, UNKNOWN_ERROR],
  [null, UNKNOWN_ERROR],
  // A colon with nothing after it reads as a broken panel, not a failure.
  [new Error(""), UNKNOWN_ERROR],
  ["", UNKNOWN_ERROR],
  ["   ", UNKNOWN_ERROR],
  [{ message: " \n " }, UNKNOWN_ERROR],
];

Deno.test("anything at all comes out as the sentence the panel prints", async () => {
  const m = await mod();
  for (const [thrown, want] of CASES) {
    assertEquals(m.errorText(thrown), want, Deno.inspect(thrown));
  }
});

Deno.test("no thrown value ever produces an empty sentence", async () => {
  const m = await mod();
  for (const [thrown] of CASES) {
    const text: string = m.errorText(thrown);
    assertEquals(text.trim().length > 0, true, Deno.inspect(thrown));
  }
  assertEquals(m.UNKNOWN_ERROR, UNKNOWN_ERROR);
});

// ------------------------------------------------------- through the socket

/** The extracted server with the production refusal classifier and captured logs. */
async function dispatchMod(handle: () => Promise<JsonReply>) {
  const refusal = await loadBlocks<{
    refusalText(error: unknown): string;
  }>(
    ["errortext", "loginerror", "refusaltext"],
    "export { refusalText };",
  );
  const logged: string[] = [];
  return {
    logged,
    servePanel: (conn: ReturnType<typeof fakeConn>) =>
      servePanelConnection(conn, {
        handle,
        lane: new WorkLane(4),
        backgroundCommands: new Set(["image", "preview", "download"]),
        encodeError: ENCODE_ERROR,
        refusalText: refusal.refusalText,
        reportFailure(cmd, error, background) {
          logged.push(
            `[cmd] ${cmd}${background ? " background" : ""} failed: ${
              String(error)
            }`,
          );
        },
        reportEncodingFailure(cmd, error) {
          logged.push(`[cmd] ${cmd} reply unserializable: ${String(error)}`);
        },
        recordTiming() {},
      }),
  };
}

/** A socket the test writes requests into and reads replies out of. */
function fakeConn(requests: unknown[], keepOpen = false) {
  const encoder = new TextEncoder();
  const written: Uint8Array[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signalWrite: () => void = () => {};
  const replyWritten = new Promise<void>((resolve) => signalWrite = resolve);
  return {
    readable: new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        for (const request of requests) {
          value.enqueue(encoder.encode(JSON.stringify(request) + "\n"));
        }
        if (!keepOpen) value.close();
      },
    }),
    write(p: Uint8Array): Promise<number> {
      written.push(p.slice());
      signalWrite();
      return Promise.resolve(p.byteLength);
    },
    close(): void {
      controller?.close();
    },
    replyWritten,
    replies(): Record<string, unknown>[] {
      const text = written.map((p) => new TextDecoder().decode(p)).join("");
      return text.split("\n").filter((l) => l).map((l) => JSON.parse(l));
    },
  };
}

Deno.test("a handler that throws a string answers with that string", async () => {
  const m = await dispatchMod(() => Promise.reject("boom"));
  const conn = fakeConn([{ id: 7, cmd: "stickers" }]);
  await m.servePanel(conn);
  assertEquals(conn.replies(), [{ ok: false, error: "boom", id: 7 }]);
  // The command that failed still has to be traceable in the journal.
  assertEquals(m.logged, ["[cmd] stickers failed: boom"]);
});

Deno.test("a handler that throws undefined answers with a sentence", async () => {
  const m = await dispatchMod(() => Promise.reject(undefined));
  const conn = fakeConn([{ id: 1, cmd: "send" }]);
  await m.servePanel(conn);
  // Not the word "undefined": that is what the cast used to put on the panel.
  assertEquals(conn.replies(), [{ ok: false, error: UNKNOWN_ERROR, id: 1 }]);
});

// ------------------------------------------------- U74: the catch translates
// history/send/reply/react/unsend call LINE with no try of their own, so a
// talk call that dies on the wire surfaces here -- and during the 09-11
// outage the panel printed the DOMException's literal English for 18 minutes.

Deno.test("a talk timeout answers the network advice, not the DOMException's words", async () => {
  const m = await dispatchMod(
    // The exact shape linejs's AbortSignal.timeout rejects with: the
    // diagnostic rides in `name`, which is what classifyLoginError matches.
    () =>
      Promise.reject(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      ),
  );
  const conn = fakeConn([{ id: 3, cmd: "history" }]);
  await m.servePanel(conn);
  assertEquals(conn.replies(), [
    { ok: false, error: "連不上 LINE，稍後重試", id: 3 },
  ]);
  // The journal keeps the raw diagnostic -- advice is useless in a bug report.
  assertEquals(m.logged.length, 1);
  assertEquals(
    m.logged[0].includes("The operation was aborted due to timeout"),
    true,
    m.logged[0],
  );
});

Deno.test("a dead token answers the re-scan advice", async () => {
  const m = await dispatchMod(
    () => Promise.reject(new Error("RefreshError: no refresh token stored")),
  );
  const conn = fakeConn([{ id: 4, cmd: "send" }]);
  await m.servePanel(conn);
  assertEquals(conn.replies(), [
    { ok: false, error: "登入已過期，請重新掃描", id: 4 },
  ]);
});

Deno.test("a server refusal keeps its own words -- unknown is not translated", async () => {
  // The string stub_test.py pins for a download without a chat; LINE's own
  // refusals classify as "unknown" and must reach the panel verbatim.
  const m = await dispatchMod(() =>
    Promise.reject(new Error("Invalid messageBoxId"))
  );
  const conn = fakeConn([{ id: 5, cmd: "download" }], true);
  const serving = m.servePanel(conn);
  await conn.replyWritten;
  assertEquals(conn.replies(), [
    { ok: false, error: "Invalid messageBoxId", id: 5 },
  ]);
  conn.close();
  await serving;
});

Deno.test("a refusal keeps its own sentence and loses its journal one", async () => {
  const m = await dispatchMod(
    () =>
      Promise.resolve({
        ok: false,
        error: "找不到檔案: x.png",
        logText: "找不到檔案",
      }),
  );
  const conn = fakeConn([{ id: 2, cmd: "sendFile" }]);
  await m.servePanel(conn);
  // logText is internal to the choke point; the contract's reply is
  // {ok, data?, error?} and the panel must not have to know better.
  assertEquals(conn.replies(), [
    { ok: false, error: "找不到檔案: x.png", id: 2 },
  ]);
  assertEquals(m.logged, ["[cmd] sendFile failed: 找不到檔案"]);
});

/**
 * mediaState / unsent / expiresAt, the download error classifier, and the one
 * line a failed command leaves behind.
 *
 *   deno test -A mediastate_test.ts
 */
import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

const PRELUDE = `
type Json = Record<string, unknown>;
export {
  downloadErrorText,
  errorLine,
  expiresAtOf,
  mediaStateFrom,
  mediaStateOf,
  redactMids,
  refusal,
  unsentOf,
  UNSENT_TEXT,
};
`;

type MediaState = "ok" | "unsent" | "expired";
interface MediaStateModule {
  UNSENT_TEXT: string;
  unsentOf(meta: Record<string, unknown>): boolean;
  expiresAtOf(meta: Record<string, unknown>): number | undefined;
  mediaStateFrom(
    unsent: boolean,
    expiresAt: number | undefined,
    now: number,
  ): MediaState;
  mediaStateOf(
    meta: Record<string, unknown>,
    hasMedia: boolean,
    now: number,
  ): MediaState;
  downloadErrorText(error: Error): string;
  redactMids(text: string): string;
  refusal(error: string, logText: string): Record<string, unknown>;
  errorLine(error: unknown): string;
}
let M: MediaStateModule | undefined;
async function mod(): Promise<MediaStateModule> {
  if (!M) M = await loadBlock<MediaStateModule>("mediastate", PRELUDE);
  return M;
}

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** What linejs hands back for a recalled message: seconds, as a string. */
function expireMeta(atMs: number) {
  return { FILE_EXPIRE_TIMESTAMP: String(Math.floor(atMs / 1000)) };
}

Deno.test("either recall key marks a message unsent", async () => {
  const m = await mod();
  assertEquals(m.unsentOf({ UNSENT: "true" }), true);
  assertEquals(m.unsentOf({ SILENTLY_UNSENT: "true" }), true);
  assertEquals(m.unsentOf({ UNSENT: "1", SILENTLY_UNSENT: "false" }), true);
  assertEquals(m.unsentOf({}), false);
  assertEquals(m.unsentOf({ FILE_NAME: "a.txt" }), false);
});

Deno.test("active media replies consult the independent recall tombstone", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/socket.ts", import.meta.url),
  );
  const download = source.slice(
    source.indexOf('if (cmd === "download")'),
    source.indexOf('if (cmd === "preview")'),
  );
  const preview = source.slice(
    source.indexOf('if (cmd === "preview")'),
    source.indexOf("return { ok: false, error: `unknown cmd:"),
  );
  assertEquals(
    download.match(/unsentBeforePublication\.has\(id\)/g)?.length,
    2,
  );
  assertEquals(
    preview.match(/unsentBeforePublication\.has\(id\)/g)?.length,
    2,
  );
});

Deno.test("presence is the signal, and only a literal false denies it", async () => {
  const m = await mod();
  // The value LINE sends is not part of the contract, so anything that is not
  // an explicit denial has to count -- an attachment offered on a recalled
  // message cannot open, and that is the failure this replaced.
  assertEquals(m.unsentOf({ UNSENT: "" }), true);
  assertEquals(m.unsentOf({ UNSENT: 1 }), true);
  assertEquals(m.unsentOf({ SILENTLY_UNSENT: "whatever" }), true);
  assertEquals(m.unsentOf({ UNSENT: "false" }), false);
  assertEquals(m.unsentOf({ UNSENT: "FALSE" }), false);
  assertEquals(m.unsentOf({ SILENTLY_UNSENT: false }), false);
});

Deno.test("FILE_EXPIRE_TIMESTAMP is seconds, reported in ms", async () => {
  const m = await mod();
  assertEquals(m.expiresAtOf({ FILE_EXPIRE_TIMESTAMP: "1760000000" }), NOW);
  assertEquals(m.expiresAtOf({ FILE_EXPIRE_TIMESTAMP: 1760000000 }), NOW);
  assertEquals(m.expiresAtOf({}), undefined);
});

Deno.test("a timestamp that is not a number is ignored", async () => {
  const m = await mod();
  // Not clamped to now: a value we cannot read must not expire a live file.
  for (
    const bad of [
      "abc",
      "123abc",
      "",
      "  ",
      "0",
      "-1",
      null,
      undefined,
      true,
      {},
      [],
    ]
  ) {
    assertEquals(
      m.expiresAtOf({ FILE_EXPIRE_TIMESTAMP: bad }),
      undefined,
      `${JSON.stringify(bad)} was read as a date`,
    );
  }
});

Deno.test("a recall outranks an expiry, and both outrank ok", async () => {
  const m = await mod();
  const recalled = { UNSENT: "true", ...expireMeta(NOW - DAY) };
  assertEquals(m.mediaStateOf(recalled, true, NOW), "unsent");
  assertEquals(m.mediaStateOf({ UNSENT: "true" }, false, NOW), "unsent");
  assertEquals(m.mediaStateOf(expireMeta(NOW - 1000), true, NOW), "expired");
  assertEquals(m.mediaStateOf(expireMeta(NOW + DAY), true, NOW), "ok");
  assertEquals(m.mediaStateOf({}, true, NOW), "ok");
  assertEquals(m.mediaStateOf({}, false, NOW), "ok");
});

Deno.test("only a message with media can be expired", async () => {
  const m = await mod();
  // A stamp on something with nothing to download says nothing the user can
  // act on, and the panel would print 「已過期」 over a plain sentence.
  assertEquals(m.mediaStateOf(expireMeta(NOW - DAY), false, NOW), "ok");
});

Deno.test("the same three states come back from the cached fields", async () => {
  const m = await mod();
  // What `download` re-derives per press: a file open in the panel across the
  // 7-day line has to start refusing without a fresh history fetch.
  assertEquals(m.mediaStateFrom(true, undefined, NOW), "unsent");
  assertEquals(m.mediaStateFrom(true, NOW + DAY, NOW), "unsent");
  assertEquals(m.mediaStateFrom(false, NOW - 1, NOW), "expired");
  assertEquals(m.mediaStateFrom(false, NOW, NOW), "ok");
  assertEquals(m.mediaStateFrom(false, NOW + DAY, NOW), "ok");
  assertEquals(m.mediaStateFrom(false, undefined, NOW), "ok");
});

Deno.test("every way an object can be gone reads as gone", async () => {
  const m = await mod();
  const gone = [
    // The fork patch turns a non-2xx OBS answer into this.
    new (class extends Error {
      override name = "ObsError";
    })("download: HTTP 404"),
    Object.assign(new Error("fetch failed: HTTP 410"), { name: "HttpError" }),
    // Upstream linejs instead decrypts the empty body and fails there.
    Object.assign(
      new Error("encrypted data too short (0 bytes) to contain HMAC"),
      { name: "E2EEMediaError" },
    ),
    Object.assign(
      new Error(
        "HMAC verification failed: ciphertext was tampered with or keyMaterial is wrong",
      ),
      { name: "E2EEMediaError" },
    ),
  ];
  for (const e of gone) {
    assertEquals(m.downloadErrorText(e), "檔案已過期或已被刪除", e.message);
  }
});

Deno.test("anything else keeps the plain download failure", async () => {
  const m = await mod();
  assertEquals(
    m.downloadErrorText(new TypeError("message have no contents")),
    "下載失敗",
  );
  assertEquals(
    m.downloadErrorText(new Error("HTTP 500")),
    "下載失敗",
  );
  assertEquals(
    m.downloadErrorText(new Error("Timeout after 30000ms")),
    "下載失敗",
  );
});

Deno.test("a mid never reaches the log", async () => {
  const m = await mod();
  const mid = "u0123456789abcdef0123456789abcdef";
  assertEquals(m.redactMids(mid), "<mid>");
  assertEquals(
    m.redactMids(`Invalid messageBoxId: ${mid} and c${mid.slice(1)}`),
    "Invalid messageBoxId: <mid> and <mid>",
  );
  assertEquals(
    m.errorLine(new Error(`no such box ${mid}`)),
    "Error: no such box <mid>",
  );
  // Not a mid: too short, and a name that happens to look like one is left be.
  assertEquals(m.redactMids("u0123"), "u0123");
});

Deno.test("a log line carries the class and stays bounded", async () => {
  const m = await mod();
  assertEquals(m.errorLine(new TypeError("boom")), "TypeError: boom");
  const long = m.errorLine(new Error("x".repeat(500)));
  assertEquals(long, `Error: ${"x".repeat(120)}`);
  // The refusals the daemon writes itself are sentences, not thrown errors,
  // so labelling them "Error" would send a reader looking for a stack.
  assertEquals(m.errorLine("尚未登入"), "Refused: 尚未登入");
  assertEquals(m.errorLine(undefined), "Refused: undefined");
});

Deno.test("a refusal that quotes a path carries a safe journal sentence", async () => {
  const m = await mod();
  const res = m.refusal("找不到檔案: /home/x/secret.pdf", "找不到檔案");
  // The panel still gets the whole sentence: the user typed that path.
  assertEquals(res.error, "找不到檔案: /home/x/secret.pdf");
  assertEquals(res.ok, false);
  // The journal gets the fixed half and nothing else. A mid regex could never
  // have caught this, and one wide enough for a path would eat every URL.
  assertEquals(res.logText, "找不到檔案");
  assertEquals(m.errorLine(res.logText), "Refused: 找不到檔案");
  assertEquals(m.errorLine(res.logText).includes("/home"), false);
});

Deno.test("the marker the panel prints is LINE's own wording", async () => {
  const m = await mod();
  assertEquals(m.UNSENT_TEXT, "已收回訊息");
});

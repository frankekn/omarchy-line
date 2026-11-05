/**
 * previewText() / PREVIEW_LABEL: the one line the chat list prints per box.
 *
 *   deno test -A preview_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { loadBlock, sliceBlock } from "./slice_test.ts";

type Json = Record<string, unknown>;
interface FileClient {
  base: { e2ee: { decryptE2EEDataMessage(raw: unknown): Promise<unknown> } };
}

const PRELUDE = `
type Json = Record<string, unknown>;
type PluginPostEvent = { kind: "album"; album: string; count: number } | { kind: "note"; text: string };
export { applyPostNotification, fileNameOf, PREVIEW_LABEL, isSystemEventName, postNotificationText, previewText, pushedPreviewText };
`;

interface PreviewModule {
  PREVIEW_LABEL: Record<string, string>;
  fileNameOf(meta: Json, decrypted?: Json | null): string;
  isSystemEventName(text: string, contentType: string): boolean;
  postNotificationText(meta: Json): string;
  applyPostNotification(out: Json, meta: Json): void;
  previewText(text: string, raw: Json, decrypted?: Json | null): string;
  pushedPreviewText(
    message: {
      unsent: boolean;
      fileName?: string;
      altText?: string;
      text: string;
      chatEvent?: { kind: string };
    },
    raw: Json,
  ): string;
}
Deno.test("announcement previews agree between push and refresh", async () => {
  const m = await mod();
  const raw = {
    contentType: "CHATEVENT",
    contentMetadata: { LOC_KEY: "C_MA", LOC_ARGS: "u" + "a".repeat(32) },
  };
  const converted = {
    unsent: false,
    text: "小葵設定了公告",
    chatEvent: { kind: "announcement" },
  };
  assertEquals(m.pushedPreviewText(converted, raw), m.previewText("", raw));
  assertEquals(m.pushedPreviewText(converted, raw), "[系統事件]");
  assertEquals(
    m.pushedPreviewText({ ...converted, unsent: true }, raw),
    "已收回訊息",
  );
});

let M: PreviewModule | undefined;
async function mod() {
  // previewText calls unsentOf, so the real mediastate block goes in front of
  // it rather than a stub: a preview that stopped honouring a recall has to
  // fail here, not pass against a copy that agrees with it.
  if (!M) {
    M = await loadBlock<PreviewModule>(
      "preview",
      PRELUDE + await sliceBlock("mediastate"),
    );
  }
  return M;
}

Deno.test("plain text is printed verbatim", async () => {
  const m = await mod();
  assertEquals(m.previewText("你好", { contentType: "NONE" }), "你好");
  assertEquals(m.previewText("hi", {}), "hi");
});

Deno.test("no ContentType code ever reaches the chat list", async () => {
  const m = await mod();
  for (
    const t of [
      "STICKER",
      "IMAGE",
      "EXIMAGE",
      "VIDEO",
      "AUDIO",
      "CHATEVENT",
      "LOCATION",
      "CONTACT",
      "CALL",
      "LINK",
      "APPLINK",
      "GIFT",
      "MUSIC",
      "PAYMENT",
      "PDF",
    ]
  ) {
    const out = m.previewText("", { contentType: t });
    assertEquals(out, m.PREVIEW_LABEL[t]);
    assertEquals(out.includes(t), false, `${t} leaked into "${out}"`);
  }
});

Deno.test("a PDF takes the file name branch, then the label", async () => {
  const m = await mod();
  assertEquals(
    m.previewText("", {
      contentType: "PDF",
      contentMetadata: { FILE_NAME: "簡報.pdf" },
    }),
    "簡報.pdf",
  );
  assertEquals(m.previewText("", { contentType: "PDF" }), "[檔案]");
});

Deno.test("a system event named after its own type gets the label, not the code", async () => {
  const m = await mod();
  // LINE really does deliver text === "POSTNOTIFICATION" for these.
  assertEquals(
    m.previewText("POSTNOTIFICATION", { contentType: "POSTNOTIFICATION" }),
    "[貼文通知]",
  );
  assertEquals(m.previewText("", { contentType: "CHATEVENT" }), "[系統事件]");
  assertEquals(
    m.isSystemEventName("postnotification", "POSTNOTIFICATION"),
    true,
    "the comparison is case-insensitive",
  );
});

Deno.test("a system event carrying real prose keeps the prose", async () => {
  const m = await mod();
  assertEquals(
    m.previewText("Frank 加入了聊天", { contentType: "CHATEVENT" }),
    "Frank 加入了聊天",
  );
  assertEquals(m.isSystemEventName("Frank 加入了聊天", "CHATEVENT"), false);
});

Deno.test("only CHATEVENT / POSTNOTIFICATION are treated as system events", async () => {
  const m = await mod();
  assertEquals(m.isSystemEventName("", "STICKER"), false);
  assertEquals(m.isSystemEventName("IMAGE", "IMAGE"), false);
  // A sticker whose text happens to equal its type is still a sticker.
  assertEquals(m.previewText("STICKER", { contentType: "STICKER" }), "STICKER");
});

Deno.test("FILE prefers the file name and falls back to a label", async () => {
  const m = await mod();
  assertEquals(
    m.previewText("", {
      contentType: "FILE",
      contentMetadata: { FILE_NAME: "a.pdf" },
    }),
    "a.pdf",
  );
  assertEquals(m.previewText("", { contentType: "FILE" }), "[檔案]");
  assertEquals(
    m.previewText("", {
      contentType: "FILE",
      contentMetadata: { FILE_NAME: "" },
    }),
    "[檔案]",
    "an empty FILE_NAME must not print as a blank line",
  );
});

Deno.test("a Letter-Sealed FILE is named from the decrypted payload", async () => {
  const m = await mod();
  // The shape that reached us in the field: SID/OID/FILE_SIZE and no name,
  // with `fileName` sitting next to keyMaterial inside the E2EE payload.
  const raw = {
    contentType: "FILE",
    contentMetadata: {
      SID: "m",
      OID: "1",
      FILE_SIZE: "33532",
      e2eeVersion: "2",
    },
  };
  assertEquals(m.previewText("", raw), "[檔案]");
  assertEquals(
    m.previewText("", raw, { keyMaterial: "…", fileName: "報表.xlsx" }),
    "報表.xlsx",
  );
});

Deno.test("fileNameOf takes the metadata name over the decrypted one", async () => {
  const m = await mod();
  assertEquals(
    m.fileNameOf({ FILE_NAME: "a.pdf" }, { fileName: "b.pdf" }),
    "a.pdf",
  );
  assertEquals(m.fileNameOf({}, { fileName: "b.pdf" }), "b.pdf");
  assertEquals(m.fileNameOf({}, { FILENAME: "c.pdf" }), "c.pdf");
  // Nothing usable anywhere: the caller's label has to win.
  assertEquals(m.fileNameOf({}, null), "");
  assertEquals(m.fileNameOf({}, undefined), "");
  assertEquals(m.fileNameOf({ FILE_NAME: "" }, { fileName: "" }), "");
  // linejs hands back whatever JSON.parse produced; a non-string is not a name.
  assertEquals(m.fileNameOf({}, { fileName: 42 }), "");
});

Deno.test("FLEX / RICH use LINE's own ALT_TEXT fallback", async () => {
  const m = await mod();
  for (const t of ["FLEX", "RICH"]) {
    assertEquals(
      m.previewText("", {
        contentType: t,
        contentMetadata: { ALT_TEXT: "優惠券" },
      }),
      "優惠券",
    );
    // No ALT_TEXT: there is no label for FLEX/RICH, so the generic form is used.
    assertEquals(m.previewText("", { contentType: t }), `[${t}]`);
  }
});

Deno.test("an unknown or missing contentType degrades to 非文字", async () => {
  const m = await mod();
  assertEquals(m.previewText("", {}), "[非文字]");
  assertEquals(m.previewText("", { contentType: "" }), "[非文字]");
  assertEquals(m.previewText("", { contentType: "WEIRD" }), "[WEIRD]");
});

Deno.test("a recalled message takes the marker over what it left behind", async () => {
  const m = await mod();
  // The file name and the contentType outlive the recall, so without this the
  // list would go on advertising an attachment nobody can open.
  assertEquals(
    m.previewText("", {
      contentType: "FILE",
      contentMetadata: { UNSENT: "true", FILE_NAME: "budget.xlsx" },
    }),
    "已收回訊息",
  );
  assertEquals(
    m.previewText("原本說的話", {
      contentType: "NONE",
      contentMetadata: { SILENTLY_UNSENT: "true" },
    }),
    "已收回訊息",
  );
});

Deno.test("a recalled pushed file takes the marker over its decrypted name", async () => {
  const m = await mod();
  assertEquals(
    m.pushedPreviewText(
      {
        unsent: true,
        fileName: "budget.xlsx",
        altText: "[檔案]",
        text: "",
      },
      {
        contentType: "FILE",
        contentMetadata: { UNSENT: "true", FILE_NAME: "budget.xlsx" },
      },
    ),
    "已收回訊息",
  );
});

Deno.test("a raw payload with no contentMetadata never throws", async () => {
  const m = await mod();
  assertEquals(
    m.previewText("", { contentType: "FLEX", contentMetadata: null }),
    "[FLEX]",
  );
});

/**
 * e2eeFilePayload() sits outside the preview block but is loaded on top of it,
 * because the only thing it is allowed to hand back is what fileNameOf() reads.
 */
async function fileMod() {
  const prelude = `
type Json = Record<string, unknown>;
interface FileClient {
  base: {
    e2ee: {
      decryptE2EEDataMessage(raw: unknown): Promise<unknown>;
    };
  };
}
export let client: FileClient | null = null;
export function setClient(c: FileClient) { client = c; }
let sessionGeneration = 0;
function sessionIsCurrent(c: FileClient, generation: number) {
  return client === c && sessionGeneration === generation;
}
const realError = console.error;
console.error = () => {};
addEventListener("unload", () => { console.error = realError; });
export { e2eeFilePayload };
` + (await sliceBlock("mediastate")) + (await sliceBlock("preview"));
  return await loadBlock<{
    setClient(c: FileClient): void;
    e2eeFilePayload(raw: unknown): Promise<{ fileName: string } | null>;
  }>("filepayload", prelude);
}

const SEALED_FILE = {
  contentType: "FILE",
  chunks: ["…"],
  contentMetadata: { SID: "m", OID: "1", FILE_SIZE: "33532" },
};

Deno.test("e2eeFilePayload hands back the name and never the key", async () => {
  const m = await fileMod();
  // The payload linejs decrypts carries the key next to the name; letting it
  // out of the function would put keyMaterial into state.json via fileName's
  // callers, so the returned object must have the one key.
  m.setClient({
    base: {
      e2ee: {
        decryptE2EEDataMessage: () =>
          Promise.resolve({ keyMaterial: "…", fileName: "報表.xlsx" }),
      },
    },
  });
  const out = await m.e2eeFilePayload(SEALED_FILE);
  assert(out);
  assertEquals(out, { fileName: "報表.xlsx" });
  assertEquals(Object.keys(out), ["fileName"]);
  assert(!("keyMaterial" in out!), "keyMaterial must not leave the function");
});

Deno.test("e2eeFilePayload is null when there is no name to take", async () => {
  const m = await fileMod();
  m.setClient({
    base: {
      e2ee: {
        decryptE2EEDataMessage: () => Promise.resolve({ keyMaterial: "…" }),
      },
    },
  });
  assertEquals(await m.e2eeFilePayload(SEALED_FILE), null);
  // Not a FILE, no chunks, no client: each stops before decrypting at all.
  assertEquals(await m.e2eeFilePayload({ contentType: "NONE" }), null);
  assertEquals(
    await m.e2eeFilePayload({ contentType: "FILE", chunks: [] }),
    null,
  );
});

Deno.test("a payload that will not decrypt is not fatal", async () => {
  const m = await fileMod();
  m.setClient({
    base: {
      e2ee: {
        decryptE2EEDataMessage: () => Promise.reject(new Error("no key")),
      },
    },
  });
  assertEquals(await m.e2eeFilePayload(SEALED_FILE), null);
});

Deno.test("a long preview is cut to 200 code points", async () => {
  const m = await mod();
  const short = "字".repeat(200);
  assertEquals(m.previewText(short, { contentType: "NONE" }), short);
  const long = "字".repeat(150) + "😀".repeat(100);
  const cut = m.previewText(long, { contentType: "NONE" });
  assertEquals(Array.from(cut).length, 201);
  assertEquals(cut, "字".repeat(150) + "😀".repeat(50) + "…");
  // UTF-16 length over the cap but 200 code points or fewer: kept whole.
  const emoji = "😀".repeat(200);
  assertEquals(m.previewText(emoji, { contentType: "NONE" }), emoji);
  const named = m.pushedPreviewText(
    { unsent: false, fileName: "a".repeat(300), text: "" },
    { contentType: "FILE" },
  );
  assertEquals(named, "a".repeat(200) + "…");
  const alt = m.pushedPreviewText(
    { unsent: false, altText: "b".repeat(250), text: "" },
    { contentType: "FLEX" },
  );
  assertEquals(alt, "b".repeat(200) + "…");
});

Deno.test("a post notification says what happened, from LINE's own metadata", async () => {
  const m = await mod();
  // Shapes seen on the production store (values replaced).
  assertEquals(
    m.postNotificationText({
      serviceType: "AB",
      albumName: "畢業旅行",
      mediaCount: "12",
    }),
    "新增了 12 個項目到相簿「畢業旅行」",
  );
  assertEquals(
    m.postNotificationText({
      serviceType: "AB",
      albumName: "畢業旅行",
      mediaCount: "0",
    }),
    "更新了相簿「畢業旅行」",
  );
  assertEquals(
    m.postNotificationText({ serviceType: "GB", text: "明天\n九點集合" }),
    "記事本：明天 九點集合",
  );
  assertEquals(
    m.postNotificationText({ serviceType: "GB" }),
    "發佈了記事本貼文",
  );
  assertEquals(
    m.postNotificationText({ serviceType: "NT", text: "  " }),
    "發佈了記事本貼文",
  );
  assertEquals(m.postNotificationText({ serviceType: "AB" }), "");
  assertEquals(m.postNotificationText({}), "");
  assertEquals(
    [...m.postNotificationText({ serviceType: "GB", text: "長".repeat(300) })]
      .length,
    "記事本：".length + 200 + 1,
  );
});

Deno.test("the chat list previews a post notification the same way, from push or refresh", async () => {
  const m = await mod();
  const raw = {
    contentType: "POSTNOTIFICATION",
    contentMetadata: { serviceType: "AB", albumName: "家庭", mediaCount: "3" },
  };
  const said = "新增了 3 個項目到相簿「家庭」";
  assertEquals(m.previewText("POSTNOTIFICATION", raw), said);
  assertEquals(m.pushedPreviewText({ unsent: false, text: said }, raw), said);
  // Nothing to say: the generic label, both ways.
  const bare = { contentType: "POSTNOTIFICATION", contentMetadata: {} };
  assertEquals(m.previewText("POSTNOTIFICATION", bare), "[貼文通知]");
  assertEquals(
    m.pushedPreviewText({ unsent: false, text: "" }, bare),
    "[貼文通知]",
  );
});

Deno.test("a sender cannot flip the post line with bidi override characters", async () => {
  const m = await mod();
  assertEquals(
    m.postNotificationText({
      serviceType: "AB",
      albumName: "a\u202Eb\u2066c",
      mediaCount: "1",
    }),
    "新增了 1 個項目到相簿「a b c」",
  );
  // An emoji ZWJ sequence is not a control character and stays whole.
  assertEquals(
    m.postNotificationText({ serviceType: "GB", text: "👨\u200D👩" }),
    "記事本：👨\u200D👩",
  );
});

Deno.test("only a bare post notification is decoded onto the message", async () => {
  const m = await mod();
  const meta = { serviceType: "AB", albumName: "家庭", mediaCount: "2" };
  const bare: Json = {
    contentType: "POSTNOTIFICATION",
    text: "POSTNOTIFICATION",
  };
  m.applyPostNotification(bare, meta);
  assertEquals(bare.text, "新增了 2 個項目到相簿「家庭」");
  assertEquals(bare.postEvent, { kind: "album", album: "家庭", count: 2 });
  for (
    const kept of [
      { contentType: "POSTNOTIFICATION", text: "已收回訊息", unsent: true },
      { contentType: "POSTNOTIFICATION", text: "", decryptFailed: true },
      { contentType: "POSTNOTIFICATION", text: "LINE 給的真人話" },
      { contentType: "CHATEVENT", text: "CHATEVENT" },
    ] as Json[]
  ) {
    const before = JSON.stringify(kept);
    m.applyPostNotification(kept, meta);
    assertEquals(JSON.stringify(kept), before);
  }
  // Nothing usable: the message keeps the event name and the clients' label.
  const empty: Json = {
    contentType: "POSTNOTIFICATION",
    text: "POSTNOTIFICATION",
  };
  m.applyPostNotification(empty, {});
  assertEquals(empty, {
    contentType: "POSTNOTIFICATION",
    text: "POSTNOTIFICATION",
  });
});

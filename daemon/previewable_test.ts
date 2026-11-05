import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface PreviewableModule {
  previewableMessage(raw: unknown): boolean;
  postPreviewSource(
    meta: Record<string, unknown>,
  ): { svc: string; sid: string; oid: string } | null;
}

async function module(): Promise<PreviewableModule> {
  return await loadBlock(
    "previewable",
    "export { postPreviewSource, previewableMessage };",
  ) as unknown as PreviewableModule;
}

Deno.test("images and cheap video thumbnails are previewable", async () => {
  const m = await module();
  assertEquals(
    m.previewableMessage({ contentType: "IMAGE", chunks: [] }),
    true,
  );
  assertEquals(
    m.previewableMessage({
      contentType: "VIDEO",
      chunks: ["encrypted"],
      contentMetadata: { DOWNLOAD_URL: "d", PREVIEW_URL: "p" },
    }),
    true,
  );
  assertEquals(m.previewableMessage({ contentType: "VIDEO" }), true);
});

Deno.test("an encrypted video without a thumbnail stays an attachment", async () => {
  const m = await module();
  assertEquals(
    m.previewableMessage({
      contentType: "VIDEO",
      chunks: ["encrypted"],
      contentMetadata: {},
    }),
    false,
  );
  // getData() only honours PREVIEW_URL when DOWNLOAD_URL is set; a chunked
  // video with the preview alone would download the whole clip for a thumb.
  assertEquals(
    m.previewableMessage({
      contentType: "VIDEO",
      chunks: ["encrypted"],
      contentMetadata: { PREVIEW_URL: "p" },
    }),
    false,
  );
  assertEquals(m.previewableMessage({ contentType: "FILE" }), false);
  assertEquals(m.previewableMessage(null), false);
});

const OID = "cj0tNDYzNGM3c25hNmc0NCZzPWpwOCZ0PWQmdT0xbWg2OTVvcXM0MmcxJmk9MjE";
function post(medias: unknown, extra: Record<string, unknown> = {}) {
  return {
    contentType: "POSTNOTIFICATION",
    contentMetadata: { previewMedias: JSON.stringify(medias), ...extra },
  };
}

Deno.test("a note post's first picture is previewable; an album's is not", async () => {
  const m = await module();
  // Shapes seen on the production store; album objects answer 403 on OBS.
  for (const [svc, sid] of [["privnote", "post"], ["scrap", "s"]]) {
    assertEquals(
      m.previewableMessage(post([{ svc, sid, mediaOid: OID, mediaType: "I" }])),
      true,
      `${svc}/${sid}`,
    );
  }
  assertEquals(
    m.previewableMessage(
      post([{ svc: "album", sid: "a", mediaOid: OID, mediaType: "I" }]),
    ),
    false,
  );
  assertEquals(m.previewableMessage(post([])), false);
  assertEquals(
    m.previewableMessage({ contentType: "POSTNOTIFICATION" }),
    false,
  );
});

Deno.test("only a plain oid from an allowed service becomes an OBS path", async () => {
  const m = await module();
  const ok = { svc: "privnote", sid: "post", mediaType: "I" };
  assertEquals(
    m.postPreviewSource({
      previewMedias: JSON.stringify([{ ...ok, mediaOid: OID }]),
    }),
    { svc: "privnote", sid: "post", oid: OID },
  );
  for (
    const bad of [
      { ...ok, mediaOid: "../../talk/m/123" },
      { ...ok, mediaOid: "abc" },
      { ...ok, mediaOid: OID, mediaType: "V" },
      { ...ok, mediaOid: OID, sid: "a" },
      { svc: "talk", sid: "m", mediaType: "I", mediaOid: OID },
    ]
  ) {
    assertEquals(
      m.postPreviewSource({ previewMedias: JSON.stringify([bad]) }),
      null,
      JSON.stringify(bad),
    );
  }
  assertEquals(m.postPreviewSource({ previewMedias: "{not json" }), null);
});

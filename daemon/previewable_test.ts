import { assertEquals } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface PreviewableModule {
  previewableMessage(raw: unknown): boolean;
}

async function module(): Promise<PreviewableModule> {
  return await loadBlock(
    "previewable",
    "export { previewableMessage };",
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

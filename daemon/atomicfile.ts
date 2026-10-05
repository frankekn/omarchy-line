/**
 * The one way a daemon-owned file is replaced: a pid-suffixed temp file next
 * to the target, every byte written (a single write() may land only a
 * prefix), fsynced, then renamed over the name. A reader -- the panel's
 * FileView, an Image, the next boot -- sees the old file or the new one,
 * never half of either, and two processes never rename each other's
 * half-written temp. A failure removes the temp and rejects.
 *
 * Dependency direction: a leaf, imported by modules that own files and by
 * tests through a slice prelude.
 */

export async function writeAtomic(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const tmp = `${path}.${Deno.pid}.tmp`;
  try {
    const handle = await Deno.open(tmp, {
      write: true,
      create: true,
      truncate: true,
      mode,
    });
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await handle.write(bytes.subarray(offset));
        if (written <= 0) throw new Error(`${tmp} accepted no bytes`);
        offset += written;
      }
      await handle.sync();
    } finally {
      handle.close();
    }
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

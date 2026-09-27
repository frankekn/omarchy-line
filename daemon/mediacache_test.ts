import { assertEquals, assertRejects } from "@std/assert";
import { loadBlock } from "./slice_test.ts";

interface CacheResult {
  path?: string;
  error?: Error;
}

interface MediaCacheModule {
  cacheMedia(
    message: { getData(preview: boolean, signal?: AbortSignal): Promise<Blob> },
    id: string,
    preview: boolean,
    invalidate?: boolean,
    signal?: AbortSignal,
  ): Promise<CacheResult>;
}

async function moduleFor(dir: string): Promise<MediaCacheModule> {
  return await loadBlock<MediaCacheModule>(
    "mediacache",
    `
type TalkMsg = { getData(preview: boolean, signal?: AbortSignal): Promise<Blob> };
const MEDIA_DIR = ${JSON.stringify(dir)};
const console = { error(_line: string) {} };
function errorLine(error: unknown) { return String(error); }
function errorText(error: unknown) { return String(error); }
export { cacheMedia };
`,
  );
}

Deno.test("concurrent media misses share one download and publish atomically", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await moduleFor(dir);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    const message = {
      async getData(): Promise<Blob> {
        calls++;
        await gate;
        return new Blob([new Uint8Array([1, 2, 3])]);
      },
    };
    const first = m.cacheMedia(message, "m1", true);
    const second = m.cacheMedia(message, "m1", true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Deno.stat(`${dir}/m1-preview`).then(
      () => {
        throw new Error("final cache path became visible too early");
      },
      () => {},
    );
    release();
    assertEquals(await Promise.all([first, second]), [
      { path: `${dir}/m1-preview` },
      { path: `${dir}/m1-preview` },
    ]);
    assertEquals(calls, 1);
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, ["m1-preview"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("one panel cannot cancel another subscriber's media download", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await moduleFor(dir);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    const message = {
      async getData(_preview: boolean, signal?: AbortSignal): Promise<Blob> {
        calls++;
        await Promise.race([
          gate,
          new Promise<void>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
          ),
        ]);
        return new Blob([new Uint8Array([9, 8, 7])]);
      },
    };
    const first = new AbortController();
    const second = new AbortController();
    const one = m.cacheMedia(message, "shared", true, false, first.signal);
    const two = m.cacheMedia(message, "shared", true, false, second.signal);
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    first.abort();
    let cancelledSettled = false;
    void one.then(
      () => cancelledSettled = true,
      () => cancelledSettled = true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(cancelledSettled, false);
    release();
    await assertRejects(() => one, DOMException);
    assertEquals(await two, { path: `${dir}/shared-preview` });
    assertEquals(calls, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cancelled subscriber waits for abort-insensitive work to settle", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await moduleFor(dir);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    let started = false;
    const controller = new AbortController();
    const result = m.cacheMedia(
      {
        async getData(): Promise<Blob> {
          started = true;
          await gate;
          return new Blob([new Uint8Array([1])]);
        },
      },
      "abort-insensitive",
      true,
      false,
      controller.signal,
    );
    while (!started) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    let settled = false;
    void result.then(() => settled = true, () => settled = true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(settled, false);
    release();
    await assertRejects(() => result, DOMException);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an explicit preview retry replaces a corrupt cache entry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/m2-preview`;
    await Deno.writeTextFile(path, "broken");
    const m = await moduleFor(dir);
    let calls = 0;
    const result = await m.cacheMedia(
      {
        getData(): Promise<Blob> {
          calls++;
          return Promise.resolve(new Blob([new Uint8Array([4, 5, 6])]));
        },
      },
      "m2",
      true,
      true,
    );
    assertEquals(result, { path });
    assertEquals(calls, 1);
    assertEquals(await Deno.readFile(path), new Uint8Array([4, 5, 6]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failed invalidating refresh cannot expose corrupt media again", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/failed-preview`;
    await Deno.writeTextFile(path, "corrupt");
    const m = await moduleFor(dir);
    let calls = 0;
    const message = {
      getData(): Promise<Blob> {
        calls++;
        if (calls === 1) return Promise.reject(new Error("offline"));
        return Promise.resolve(new Blob([new Uint8Array([8, 9])]));
      },
    };
    assertEquals(
      "error" in await m.cacheMedia(
        message,
        "failed",
        true,
        true,
      ),
      true,
    );
    assertEquals(await m.cacheMedia(message, "failed", true), { path });
    assertEquals(calls, 2);
    assertEquals(await Deno.readFile(path), new Uint8Array([8, 9]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("concurrent invalidating retries share the active replacement", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await moduleFor(dir);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    const message = {
      async getData(): Promise<Blob> {
        calls++;
        await gate;
        return new Blob([new Uint8Array([7, 8, 9])]);
      },
    };
    const first = m.cacheMedia(message, "m3", true, true);
    const second = m.cacheMedia(message, "m3", true, true);
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    release();
    assertEquals(await Promise.all([first, second]), [
      { path: `${dir}/m3-preview` },
      { path: `${dir}/m3-preview` },
    ]);
    assertEquals(calls, 1);
    assertEquals(
      await Deno.readFile(`${dir}/m3-preview`),
      new Uint8Array([7, 8, 9]),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an invalidating retry does not join an ordinary active download", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await moduleFor(dir);
    let calls = 0;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
    const message = {
      async getData(): Promise<Blob> {
        calls++;
        if (calls === 1) await firstGate;
        return new Blob([new Uint8Array([calls])]);
      },
    };
    const ordinary = m.cacheMedia(message, "m4", true);
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const retry = m.cacheMedia(message, "m4", true, true);
    const joinedRetry = m.cacheMedia(message, "m4", true, true);
    releaseFirst();
    await Promise.all([ordinary, retry, joinedRetry]);
    assertEquals(calls, 2);
    assertEquals(
      await Deno.readFile(`${dir}/m4-preview`),
      new Uint8Array([2]),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a replacement keeps the ordinary result until its own failure", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await moduleFor(dir);
    let calls = 0;
    let releaseFirst: () => void = () => {};
    let releaseRetry: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
    const retryGate = new Promise<void>((resolve) => releaseRetry = resolve);
    const message = {
      async getData(): Promise<Blob> {
        calls++;
        if (calls === 1) {
          await firstGate;
          return new Blob([new Uint8Array([1])]);
        }
        await retryGate;
        throw new Error("offline");
      },
    };
    const ordinary = m.cacheMedia(message, "overlap", true);
    const retry = m.cacheMedia(message, "overlap", true, true);
    releaseFirst();
    const ordinaryResult = await ordinary;
    while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    assertEquals(
      await Deno.readFile(ordinaryResult.path!),
      new Uint8Array([1]),
    );
    releaseRetry();
    assertEquals("error" in await retry, true);
    await assertRejects(
      () => Deno.stat(ordinaryResult.path!),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cancelled queued retry cannot delete an ordinary media result", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await moduleFor(dir);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    const message = {
      async getData(): Promise<Blob> {
        calls++;
        if (calls === 1) await gate;
        return new Blob([new Uint8Array([calls])]);
      },
    };
    const ordinary = m.cacheMedia(message, "m5", true);
    const retry = new AbortController();
    const invalidating = m.cacheMedia(
      message,
      "m5",
      true,
      true,
      retry.signal,
    );
    retry.abort();
    let cancelledSettled = false;
    void invalidating.then(
      () => cancelledSettled = true,
      () => cancelledSettled = true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(cancelledSettled, false);
    const later = m.cacheMedia(message, "m5", true);
    release();
    await assertRejects(() => invalidating, DOMException);
    const result = await ordinary;
    assertEquals(await later, result);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(result, { path: `${dir}/m5-preview` });
    assertEquals(calls, 1);
    assertEquals(await Deno.readFile(`${dir}/m5-preview`), new Uint8Array([1]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a predecessor cancellation cannot reject a live invalidating retry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await moduleFor(dir);
    let calls = 0;
    const message = {
      getData(): Promise<Blob> {
        calls++;
        return Promise.resolve(new Blob([new Uint8Array([4, 2])]));
      },
    };
    const original = new AbortController();
    const replacement = new AbortController();
    const first = m.cacheMedia(
      message,
      "m6",
      true,
      false,
      original.signal,
    );
    const retry = m.cacheMedia(
      message,
      "m6",
      true,
      true,
      replacement.signal,
    );
    original.abort();
    await assertRejects(() => first, DOMException);
    assertEquals(await retry, { path: `${dir}/m6-preview` });
    assertEquals(calls, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

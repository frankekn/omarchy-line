import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ImageCache,
  nodeImageResponse,
  publicImageAddress,
} from "./imagecache.ts";
import { Readable } from "node:stream";
import { brotliCompressSync, gzipSync } from "node:zlib";

const publicDns = () => Promise.resolve(["93.184.216.34"]);

const image = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "image/png" },
  });

Deno.test("bodyless HTTP statuses never receive a stream body", () => {
  for (const status of [204, 205, 304]) {
    const response = nodeImageResponse(
      status,
      new Headers(),
      Readable.from([new Uint8Array([1])]),
    );
    assertEquals(response.status, status);
    assertEquals(response.body, null);
  }
});

Deno.test("node image responses decode compressed bodies", async () => {
  const original = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const headers = new Headers({
    "content-type": "image/png",
    "content-encoding": "gzip",
    "content-length": "99",
  });
  const response = nodeImageResponse(
    200,
    headers,
    Readable.from([gzipSync(original)]),
  );
  assertEquals(new Uint8Array(await response.arrayBuffer()), original);
  assertEquals(response.headers.has("content-encoding"), false);
  assertEquals(response.headers.has("content-length"), false);
});

Deno.test("stacked content encodings are decoded in reverse order", async () => {
  const original = new Uint8Array([137, 80, 78, 71, 9, 8, 7]);
  const encoded = brotliCompressSync(gzipSync(original));
  const response = nodeImageResponse(
    200,
    new Headers({
      "content-type": "image/png",
      "content-encoding": "gzip, br",
    }),
    Readable.from([encoded]),
  );
  assertEquals(new Uint8Array(await response.arrayBuffer()), original);
});

Deno.test("unsupported content encodings are rejected before caching", () => {
  assertThrows(() =>
    nodeImageResponse(
      200,
      new Headers({ "content-encoding": "compress" }),
      Readable.from([new Uint8Array([1, 2, 3])]),
    )
  );
});

Deno.test("discarded redirect bodies do not require a supported encoding", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    const cache = new ImageCache(
      dir,
      () => {
        calls++;
        if (calls === 1) {
          return Promise.resolve(nodeImageResponse(
            302,
            new Headers({
              location: "https://cdn.example/image.png",
              "content-encoding": "compress",
            }),
            Readable.from([new Uint8Array([1, 2, 3])]),
          ));
        }
        return Promise.resolve(image());
      },
      publicDns,
    );
    const path = await cache.get("https://example.com/image.png");
    assertEquals(
      new Uint8Array(await Deno.readFile(path)),
      new Uint8Array([1, 2, 3]),
    );
    assertEquals(calls, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compressed response source failures reject the decoded body", async () => {
  const compressed = gzipSync(new Uint8Array([1, 2, 3, 4]));
  const source = Readable.from((async function* () {
    yield compressed.subarray(0, 4);
    throw new Error("socket reset");
  })());
  const response = nodeImageResponse(
    200,
    new Headers({ "content-encoding": "gzip" }),
    source,
  );
  await assertRejects(() => response.arrayBuffer(), Error);
});

Deno.test("decoder failures destroy an unfinished compressed source", async () => {
  let destroyed = false;
  let sent = false;
  const source = new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(new TextEncoder().encode("not a gzip stream"));
      }
    },
    destroy(error, done) {
      destroyed = true;
      done(error);
    },
  });
  const response = nodeImageResponse(
    200,
    new Headers({ "content-encoding": "gzip" }),
    source,
  );
  await assertRejects(() => response.arrayBuffer(), Error);
  assertEquals(destroyed, true);
});

Deno.test("cancelling stacked decoding destroys the network source", async () => {
  let destroyed = false;
  let sent = false;
  const source = new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(brotliCompressSync(gzipSync(new Uint8Array([1, 2, 3]))));
      }
    },
    destroy(error, done) {
      destroyed = true;
      done(error);
    },
  });
  const response = nodeImageResponse(
    200,
    new Headers({ "content-encoding": "gzip, br" }),
    source,
  );
  await response.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(destroyed, true);
});

Deno.test("only globally routable image destinations are accepted", () => {
  for (
    const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:192.168.1.1",
      "::ffff:c0a8:101",
      "2001:db8::1",
      // 6to4 and Teredo embed an attacker-chosen IPv4: loopback here.
      "2002:7f00:1::",
      "2002:c0a8:1::",
      "2001:0::1",
      "2001::",
      "2001:2::1",
      "2001:0002::1",
      "2001:10::1",
      "2002::1",
      "3fff::1",
      "2606:not-an-address",
    ]
  ) assertEquals(publicImageAddress(address), false, address);
  for (
    const address of [
      "93.184.216.34",
      "1.1.1.1",
      "192.0.78.24",
      "::ffff:1.1.1.1",
      "::ffff:101:101",
      "2606:4700:4700::1111",
      "2001:1::1",
      "2001:1::2",
      "2001:1::3",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
    ]
  ) {
    assertEquals(publicImageAddress(address), true, address);
  }
});

Deno.test("every redirect is resolved before it can reach a private host", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    const cache = new ImageCache(
      dir,
      () => {
        calls++;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://metadata.internal/token" },
          }),
        );
      },
      (hostname) =>
        Promise.resolve([
          hostname === "metadata.internal"
            ? "169.254.169.254"
            : "93.184.216.34",
        ]),
    );
    await assertRejects(() => cache.get("https://example.com/image"));
    assertEquals(calls, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the fetch uses the addresses from the validation lookup", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const validated = ["93.184.216.34"];
    let connected: readonly string[] = [];
    const cache = new ImageCache(
      dir,
      (_url, addresses) => {
        connected = addresses;
        return Promise.resolve(image());
      },
      () => Promise.resolve(validated),
    );
    await cache.get("https://rebind.example/image.png");
    assertEquals(connected, validated);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("globally reachable IETF exceptions remain usable together", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const validated = ["93.184.216.34", "2001:3::1", "2001:4:112::1"];
    let connected: readonly string[] = [];
    const cache = new ImageCache(
      dir,
      (_url, addresses) => {
        connected = addresses;
        return Promise.resolve(image());
      },
      () => Promise.resolve(validated),
    );
    await cache.get("https://ietf-public.example/image.png");
    assertEquals(connected, validated);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a hexadecimal IPv4-mapped public address reaches the fetcher", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let connected: readonly string[] = [];
    const cache = new ImageCache(
      dir,
      (_url, addresses) => {
        connected = addresses;
        return Promise.resolve(image());
      },
      () => Promise.resolve(["::ffff:101:101"]),
    );
    await cache.get("https://mapped.example/image.png");
    assertEquals(connected, ["::ffff:101:101"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("DNS resolution shares the image download deadline", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let finishDns: (addresses: string[]) => void = () => {};
    let fetches = 0;
    const cache = new ImageCache(
      dir,
      () => {
        fetches++;
        return Promise.resolve(image());
      },
      () =>
        new Promise<string[]>((resolve) => {
          finishDns = resolve;
        }),
      Deno.remove,
      20,
    );
    await assertRejects(() => cache.get("https://slow-dns.example/image"));
    finishDns(["93.184.216.34"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(fetches, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an already-aborted resolution still observes its promise", async () => {
  const source = await Deno.readTextFile(
    new URL("./imagecache.ts", import.meta.url),
  );
  const aborted = source.indexOf("if (signal.aborted)");
  const observed = source.indexOf("void job.catch(() => {})", aborted);
  const rejected = source.indexOf("return Promise.reject(", aborted);
  assertEquals(aborted >= 0 && aborted < observed && observed < rejected, true);
});

Deno.test("the pinned transport retains every validated fallback address", async () => {
  const source = await Deno.readTextFile(
    new URL("./imagecache.ts", import.meta.url),
  );
  assertEquals(source.includes("const candidates = addresses.map"), true);
  assertEquals(
    source.includes("if (options.all) callback(null, candidates)"),
    true,
  );
  assertEquals(source.includes("autoSelectFamily: true"), true);
});

Deno.test("image cache coalesces downloads, persists bytes and reuses disk", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve(image());
    };
    const cache = new ImageCache(dir, fetcher, publicDns);
    const paths = await Promise.all(
      Array.from({ length: 10 }, () => cache.get("https://example.com/a")),
    );
    assertEquals(new Set(paths).size, 1);
    assertEquals(calls, 1);
    assertEquals(await Deno.readFile(paths[0]), new Uint8Array([1, 2, 3]));
    assertEquals(
      await new ImageCache(dir, fetcher, publicDns).get(
        "https://example.com/a",
      ),
      paths[0],
    );
    assertEquals(calls, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("one subscriber cannot cancel another panel's shared download", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let finish: (response: Response) => void = () => {};
    let calls = 0;
    const cache = new ImageCache(
      dir,
      () => {
        calls++;
        return new Promise<Response>((resolve) => finish = resolve);
      },
      publicDns,
    );
    const first = new AbortController();
    const second = new AbortController();
    const one = cache.get(
      "https://example.com/shared.png",
      false,
      first.signal,
    );
    const two = cache.get(
      "https://example.com/shared.png",
      false,
      second.signal,
    );
    for (let attempt = 0; calls === 0 && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertEquals(calls, 1);
    first.abort();
    await assertRejects(() => one, DOMException);
    finish(image());
    const path = await two;
    assertEquals(calls, 1);
    assertEquals((await Deno.stat(path)).isFile, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("image cache rejects invalid schemes, redirects and responses without leaving files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const cache = new ImageCache(
      dir,
      () => Promise.resolve(image()),
      publicDns,
    );
    await assertRejects(() => cache.get("file:///etc/passwd"));
    await assertRejects(() => cache.get("https://user:pass@example.com/a"));
    for (
      const response of [
        new Response("error", { status: 404 }),
        new Response("html", { headers: { "content-type": "text/html" } }),
        new Response(null, {
          status: 302,
          headers: { location: "http://example.com/a" },
        }),
        new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
          headers: { "content-type": "image/png" },
        }),
      ]
    ) {
      await assertRejects(() =>
        new ImageCache(dir, () => Promise.resolve(response), publicDns).get(
          "https://example.com/a",
        )
      );
    }
    assertEquals(Array.from(Deno.readDirSync(dir)).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a fragment is not part of the picture: one download, one file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    const cache = new ImageCache(dir, () => {
      calls++;
      return Promise.resolve(image());
    }, publicDns);
    const [one, two] = await Promise.all([
      cache.get("https://example.com/a.png#first"),
      cache.get("https://example.com/a.png#second"),
    ]);
    assertEquals(one, two);
    assertEquals(await cache.get("https://example.com/a.png"), one);
    assertEquals(calls, 1);
    assertEquals(Array.from(Deno.readDirSync(dir)).length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invalidating a corrupt cached image forces fresh bytes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    const cache = new ImageCache(dir, () => {
      calls++;
      return Promise.resolve(
        new Response(new Uint8Array([calls]), {
          headers: { "content-type": "image/png" },
        }),
      );
    }, publicDns);
    const url = "https://example.com/corrupt.png";
    const path = await cache.get(url);
    await Deno.writeTextFile(path, "corrupt");
    assertEquals(
      await Deno.readFile(await cache.get(url, true)),
      new Uint8Array([2]),
    );
    assertEquals(calls, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failed invalidation cannot expose the rejected cached bytes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    const cache = new ImageCache(dir, () => {
      calls++;
      if (calls === 2) return Promise.reject(new Error("offline"));
      return Promise.resolve(
        new Response(new Uint8Array([calls]), {
          headers: { "content-type": "image/png" },
        }),
      );
    }, publicDns);
    const url = "https://example.com/rejected.png";
    const path = await cache.get(url);
    await Deno.writeTextFile(path, "corrupt");
    await assertRejects(() => cache.get(url, true), Error, "offline");
    const recovered = await cache.get(url);
    assertEquals(calls, 3);
    assertEquals(await Deno.readFile(recovered), new Uint8Array([3]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an invalidating retry follows an ordinary active download", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
    const cache = new ImageCache(dir, async () => {
      calls++;
      if (calls === 1) await firstGate;
      return new Response(new Uint8Array([calls]), {
        headers: { "content-type": "image/png" },
      });
    }, publicDns);
    const url = "https://example.com/shared-retry.png";
    const first = cache.get(url);
    const second = cache.get(url, true);
    const third = cache.get(url, true);
    releaseFirst();
    await Promise.all([first, second, third]);
    assertEquals(calls, 2);
    assertEquals(await Deno.readFile(await second), new Uint8Array([2]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cancelled queued invalidation keeps the ordinary download", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    const cache = new ImageCache(dir, async () => {
      calls++;
      if (calls === 1) await gate;
      return new Response(new Uint8Array([calls]), {
        headers: { "content-type": "image/png" },
      });
    }, publicDns);
    const url = "https://example.com/cancelled-retry.png";
    const ordinary = cache.get(url);
    const retry = new AbortController();
    const invalidating = cache.get(url, true, retry.signal);
    retry.abort();
    await assertRejects(() => invalidating, DOMException);
    const later = cache.get(url);
    release();
    const path = await ordinary;
    assertEquals(await later, path);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 1);
    assertEquals(await Deno.readFile(path), new Uint8Array([1]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a warm public image remains available while DNS is offline", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const url = "https://example.com/offline.png";
    const path = await new ImageCache(
      dir,
      () => Promise.resolve(image()),
      publicDns,
    )
      .get(url);
    const offline = new ImageCache(
      dir,
      () => Promise.reject(new Error("fetch must not run")),
      () => Promise.reject(new Error("DNS offline")),
    );
    assertEquals(await offline.get(url), path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the image command honors an explicit cache invalidation", async () => {
  const source = await Deno.readTextFile(
    new URL("./modules/socket.ts", import.meta.url),
  );
  const imageBranch = source.slice(
    source.indexOf('if (cmd === "image")'),
    source.indexOf('if (cmd === "history")'),
  );
  assertEquals(
    imageBranch.includes(
      "imageCache.get(url, req.invalidate === true, signal)",
    ),
    true,
  );
});

Deno.test("a picture already on disk does not queue behind the download limit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let park = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const cache = new ImageCache(dir, async () => {
      if (park) await gate;
      return image();
    }, publicDns);
    const warm = await cache.get("https://example.com/warm");
    park = true;
    // Four downloads that never finish: every slot is taken for good.
    const stuck = Array.from(
      { length: 4 },
      (_, i) => cache.get(`https://example.com/cold-${i}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A sticker grid is mostly hits, and a hit is one stat. Behind the limit it
    // would wait here for a download it does not need -- so "blocked" is what a
    // limiter placed around the whole path returns.
    assertEquals(
      await Promise.race([
        cache.get("https://example.com/warm"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("blocked"), 500)
        ),
      ]),
      warm,
    );
    open();
    await Promise.all(stuck);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("image cache limits concurrency and retries a failed download", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let active = 0, peak = 0, calls = 0;
    const cache = new ImageCache(dir, async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (calls === 1) throw new Error("offline");
      return image();
    }, publicDns);
    await assertRejects(() => cache.get("https://example.com/retry"));
    await cache.get("https://example.com/retry");
    await Promise.all(
      Array.from(
        { length: 12 },
        (_, i) => cache.get(`https://example.com/${i}`),
      ),
    );
    assertEquals(peak, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

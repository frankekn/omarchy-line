import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const IMAGE_REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/**
 * A fragment never reaches the server, so two urls that differ only in one are
 * the same picture. Not a validator: a url this cannot parse is handed on
 * unchanged for the download to reject with the rest of them.
 */
function withoutFragment(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return raw;
  }
}

type HostResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<string[]>;
type ImageFetcher = (
  url: URL,
  addresses: readonly string[],
  signal: AbortSignal,
) => Promise<Response>;

export function nodeImageResponse(
  status: number,
  headers: Headers,
  incoming: Readable,
): Response {
  if (status === 204 || status === 205 || status === 304) {
    incoming.resume();
    return new Response(null, { status, headers });
  }
  if (IMAGE_REDIRECT_STATUSES.includes(status)) {
    return new Response(
      Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
      { status, headers },
    );
  }
  let body: Readable = incoming;
  const encodings = String(headers.get("content-encoding") ?? "")
    .toLowerCase().split(",").map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "identity");
  const decoders: Transform[] = encodings.reverse().map((encoding) => {
    if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
    if (encoding === "deflate") return createInflate();
    if (encoding === "br") return createBrotliDecompress();
    throw new Error(`Unsupported image content encoding: ${encoding}`);
  });
  if (decoders.length > 0) {
    const finalDecoder = decoders.pop()!;
    const streams: [Readable, ...Transform[], Transform] = [
      incoming,
      ...decoders,
      finalDecoder,
    ];
    body = finalDecoder;
    void pipeline(streams).catch(() => {});
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return new Response(
    Readable.toWeb(body) as ReadableStream<Uint8Array>,
    { status, headers },
  );
}

/**
 * Fetches through an address returned by the validation lookup. The URL keeps
 * the original hostname for SNI and certificate verification; only socket
 * lookup is replaced, so DNS cannot change between validation and connect.
 */
export function pinnedFetch(
  url: URL,
  addresses: readonly string[],
  signal: AbortSignal,
): Promise<Response> {
  if (!addresses.length) {
    return Promise.reject(new Error("Image host has no address"));
  }
  const candidates = addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
  return new Promise<Response>((resolve, reject) => {
    const requestOptions = {
      lookup,
      autoSelectFamily: true,
      signal,
      // Redirects are validated and followed by ImageCache itself.
      method: "GET",
      // Advertise only codings this client decodes reliably. deflate stays
      // in the answer-handling for leniency with non-compliant servers, but
      // createInflate cannot decode every stream a bare "deflate" answer
      // may carry, so promising it here would over-promise. An absent
      // header invites any coding (RFC 9110 §12.5.3), which we must not.
      headers: { "accept-encoding": "gzip, br" },
    } as import("node:https").RequestOptions & { autoSelectFamily: boolean };
    const req = request(url, requestOptions, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) headers.set(name, value);
      }
      const status = incoming.statusCode ?? 500;
      try {
        resolve(nodeImageResponse(status, headers, incoming));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    req.on("error", reject);
    req.end();
  });
}

function ipv4Parts(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map(Number);
  return bytes.every((part) =>
      Number.isInteger(part) && part >= 0 && part <= 255
    )
    ? bytes
    : null;
}

function ipv6Parts(value: string): number[] | null {
  if (!/^[0-9a-f:]+$/.test(value) || value.includes(":::")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) return null;
  if (halves.length === 2 && omitted < 1) return null;
  const words = [
    ...left,
    ...Array.from({ length: omitted }, () => "0"),
    ...right,
  ];
  if (
    words.length !== 8 ||
    words.some((word) => word.length < 1 || word.length > 4)
  ) {
    return null;
  }
  const parsed = words.map((word) => Number.parseInt(word, 16));
  return parsed.every((word) => Number.isInteger(word) && word <= 0xffff)
    ? parsed
    : null;
}

/** True only for an address the daemon may contact for message-owned images. */
export function publicImageAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b, c] = v4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (!address.includes(":")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return publicImageAddress(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return publicImageAddress(
      `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`,
    );
  }
  if (address === "::" || address === "::1") return false;
  const words = ipv6Parts(address);
  if (!words) return false;
  const [first, second] = words;
  if (!(first >= 0x2000 && first <= 0x3fff)) return false;
  // 2000::/3 is the global-unicast allocation, but it contains IANA
  // special-purpose blocks which are explicitly not globally reachable.
  // Reject their complete numeric prefixes so alternate zero padding cannot
  // bypass the policy.
  if (first === 0x2001 && second <= 0x01ff) {
    const ietfAnycast = second === 0x0001 &&
      words.slice(2, 7).every((word) => word === 0) &&
      words[7] >= 1 && words[7] <= 3;
    const globallyReachableException = ietfAnycast ||
      second === 0x0003 || // AMT 2001:3::/32
      (second === 0x0004 && words[2] === 0x0112) || // AS112-v6
      (second & 0xfff0) === 0x0020 || // ORCHIDv2
      (second & 0xfff0) === 0x0030; // Drone Remote ID
    if (!globallyReachableException) return false;
  }
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // deprecated 6to4
  if (first === 0x3fff && (second & 0xf000) === 0) return false; // documentation
  return true;
}

function abortable<T>(job: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return job;
  if (signal.aborted) {
    void job.catch(() => {});
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    job.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort)
    );
  });
}

async function resolveHost(
  hostname: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (ipv4Parts(literal) || literal.includes(":")) return [literal];
  const answers = await abortable(
    Promise.all([
      Deno.resolveDns(literal, "A").catch(() => []),
      Deno.resolveDns(literal, "AAAA").catch(() => []),
    ]),
    signal,
  );
  return answers.flat();
}

/** Public images are downloaded outside the shell's Qt TLS runtime. */
export class ImageCache {
  private pending = new Map<
    string,
    {
      job: Promise<string>;
      invalidating: boolean;
      controller: AbortController;
      subscribers: number;
      settled: boolean;
    }
  >();
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private dir: string,
    private fetcher: ImageFetcher = pinnedFetch,
    private resolver: HostResolver = resolveHost,
    private removeFile: (path: string) => Promise<void> = Deno.remove,
    private timeoutMs = 20_000,
  ) {}

  // The fragment comes off before anything keys on it, so one picture is one
  // in-flight download and one file however the panel spelled the url.
  get(
    url: string,
    invalidate = false,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = withoutFragment(url);
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.controller.signal.aborted) {
        const successor = {
          job: Promise.resolve(""),
          invalidating: invalidate,
          controller: new AbortController(),
          subscribers: 0,
          settled: false,
        };
        successor.job = existing.job.catch(() => "").then(() => {
          if (successor.controller.signal.aborted) {
            throw successor.controller.signal.reason ??
              new DOMException("Aborted", "AbortError");
          }
          return this.download(
            key,
            successor.controller.signal,
            invalidate,
          );
        }).finally(() => {
          successor.settled = true;
          if (this.pending.get(key) === successor) this.pending.delete(key);
        });
        this.pending.set(key, successor);
        return this.subscribe(successor, signal);
      }
      if (!invalidate || existing.invalidating) {
        return this.subscribe(existing, signal);
      }
      const replacement = {
        job: Promise.resolve(""),
        invalidating: true,
        controller: new AbortController(),
        subscribers: 0,
        settled: false,
      };
      replacement.job = existing.job.catch(() => "")
        .then(() => {
          if (replacement.controller.signal.aborted) {
            throw replacement.controller.signal.reason ??
              new DOMException("Aborted", "AbortError");
          }
          return this.download(key, replacement.controller.signal, true);
        })
        .finally(() => {
          replacement.settled = true;
          if (this.pending.get(key) === replacement) this.pending.delete(key);
        });
      // Reserve the invalidating generation now. If the old request and the
      // replacement both settle in one turn, later retries still join this job.
      this.pending.set(key, replacement);
      return this.subscribe(replacement, signal);
    }
    const entry = {
      job: Promise.resolve(""),
      invalidating: invalidate,
      controller: new AbortController(),
      subscribers: 0,
      settled: false,
    };
    const work = Promise.resolve().then(() => {
      if (entry.controller.signal.aborted) {
        throw entry.controller.signal.reason ??
          new DOMException("Aborted", "AbortError");
      }
      return this.download(key, entry.controller.signal, invalidate);
    });
    entry.job = work.finally(() => {
      entry.settled = true;
      if (this.pending.get(key) === entry) this.pending.delete(key);
    });
    this.pending.set(key, entry);
    return this.subscribe(entry, signal);
  }

  private subscribe(
    entry: {
      job: Promise<string>;
      controller: AbortController;
      subscribers: number;
      settled: boolean;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    entry.subscribers++;
    return abortable(entry.job, signal).finally(() => {
      entry.subscribers--;
      if (!entry.settled && entry.subscribers === 0) entry.controller.abort();
    });
  }

  private async removeCached(key: string): Promise<void> {
    const parsed = new URL(key);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return;
    }
    try {
      await this.removeFile(await this.cachePath(parsed));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  private async cachePath(url: URL): Promise<string> {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(url.href),
    );
    const key = Array.from(
      new Uint8Array(hash),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    return `${this.dir}/${key}`;
  }

  private async publicAddresses(
    url: URL,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Only public HTTPS images are supported");
    }
    const addresses = await abortable(
      this.resolver(url.hostname, signal),
      signal,
    );
    if (
      !addresses.length ||
      addresses.some((address) => !publicImageAddress(address))
    ) {
      throw new Error("Only public HTTPS images are supported");
    }
    return addresses;
  }

  private async download(
    raw: string,
    callerSignal?: AbortSignal,
    force = false,
  ): Promise<string> {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Only public HTTPS images are supported");
    }
    const path = await this.cachePath(url);
    if (!force) {
      try {
        const stat = await Deno.stat(path);
        if (stat.isFile && stat.size > 0) return path;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
    // The limit is on the network, not on the disk: a warm sticker grid is a
    // hundred stats and no fetches, and taking a slot for those would hold the
    // whole grid behind a limit that is protecting nothing.
    await this.acquire();
    let temp: string | undefined;
    try {
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? new DOMException("Aborted", "AbortError");
      }
      // Once this invalidating generation owns a network slot, every previous
      // generation for the same URL has settled. Remove the bytes Qt rejected
      // before retrying so a failed refresh cannot expose them as a warm hit.
      // The abort check must stay before removal: a queued retry whose last
      // subscriber disappeared does not own the predecessor's good output.
      if (force) await this.removeCached(raw);
      let target = url;
      let response: Response | undefined;
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, timeout])
        : timeout;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const addresses = await this.publicAddresses(target, signal);
        response = await this.fetcher(target, addresses, signal);
        if (!IMAGE_REDIRECT_STATUSES.includes(response.status)) break;
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 5) {
          throw new Error("Invalid image redirect");
        }
        target = new URL(location, target);
      }
      if (
        !response?.ok || !response.body ||
        !response.headers.get("content-type")?.toLowerCase().startsWith(
          "image/",
        )
      ) {
        await response?.body?.cancel();
        throw new Error("Image download failed");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 10 * 1024 * 1024) throw new Error("Image too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      if (!size) throw new Error("Empty image");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      await Deno.mkdir(this.dir, { recursive: true, mode: 0o700 });
      temp = await Deno.makeTempFile({ dir: this.dir, prefix: ".download-" });
      await Deno.writeFile(temp, bytes, { mode: 0o600 });
      await Deno.rename(temp, path);
      temp = undefined;
      return path;
    } finally {
      if (temp) await Deno.remove(temp).catch(() => {});
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < 4) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  // The slot goes straight to the next waiter instead of being given back and
  // taken again, so a burst can never squeeze a fifth download through the gap.
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

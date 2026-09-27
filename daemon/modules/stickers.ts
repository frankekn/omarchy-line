/**
 * The sticker picker and sender: the owned-package cache (one hour, one load
 * at a time), the shop page walker (enil:shoppage block, ShopService reached
 * where it lives because the fork never wires it onto BaseClient), the public
 * product-JSON fetcher, and the send payload builder + refusal vocabulary
 * (enil:sticker block).
 *
 * Dependency direction: imports from below -- session (client, generation),
 * caches (limiter), avatars (readCapped), text (errorText). socket.ts calls
 * stickerPackages/sendSticker/stickerListRefusal; login.ts resets the cache
 * on logout through resetStickerCache.
 */
import { limiter } from "./caches.ts";
import { readCapped } from "./avatars.ts";
import { client, sessionGeneration, sessionIsCurrent } from "./session.ts";
import { errorText } from "./text.ts";
import { ShopService } from "./shopsvc.ts";
import type { Client } from "@evex/linejs";
import type { Json } from "./types.ts";

// The block between the enil:sticker markers is sliced out verbatim by
// daemon/sticker_test.ts, so it must stay self-contained: nothing in here may
// reach for module state a stub prelude cannot provide.
// enil:sticker-begin
/** One sticker: what to draw, and what `sendSticker` takes back. */
interface PluginSticker {
  id: string;
  url: string;
  animated: boolean;
}

/** One owned package, in the order the shop listed it. */
interface PluginStickerPackage {
  id: string;
  name: string;
  version: number;
  stickers: PluginSticker[];
}

const STICKER_CDN = "https://stickershop.line-scdn.net/stickershop/v1";
// A package the panel shows but nobody has scrolled to costs a request all
// the same, so the picker is bounded rather than however many the account has
// collected since 2011.
const STICKER_PACKAGE_LIMIT = 100;
const STICKERS_TTL_MS = 60 * 60_000;
// STKVER when neither the shop summary nor the product JSON says: the old free
// packages carry no version anywhere (package 1's productInfo.meta has the
// field missing entirely), and LINE resolves the picture from STKPKGID+STKID.
const STICKER_VERSION_FALLBACK = 1;

/**
 * LINE's package and sticker ids are decimal counters, and both end up
 * interpolated into a CDN path and into contentMetadata. A leading zero or a
 * stray character is a panel bug either way, but an unchecked one is a bug
 * that reaches the other person: sendMessage takes the metadata verbatim, so
 * a malformed sticker arrives as an empty bubble that cannot be recalled.
 */
function isStickerId(v: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(v);
}

/**
 * Where the sticker shop keeps one sticker's picture.
 *
 * The same path linejs builds for an incoming sticker (vendor/linejs
 * client/features/message/talk.ts getStickerURL), which is what the panel
 * already draws `stickerUrl` from -- so a sent sticker and a received one
 * resolve to the same file. Rebuilt here rather than reused because that
 * builder needs a received message, and a package we merely own has none.
 */
function stickerImageUrl(stickerId: string, animated: boolean): string {
  const file = animated ? "sticker_animation.png" : "sticker.png";
  return `${STICKER_CDN}/sticker/${stickerId}/android/${file}`;
}

/** The public product JSON. No session: the shop serves it to anyone. */
function productInfoUrl(packageId: string): string {
  return `${STICKER_CDN}/product/${packageId}/android/productInfo.meta`;
}

/**
 * The package title to print, out of the localised map the product JSON
 * carries (`{"en": …, "ja": …, "zh_TW": …}`). The panel is Traditional
 * Chinese, so zh_TW first -- but a package published in one language only
 * still has to get a name rather than a blank row in the picker.
 */
function productTitle(raw: unknown): string {
  const t = (raw ?? {}) as Record<string, unknown>;
  for (const key of ["zh_TW", "zh_CN", "en", "ja", "ko"]) {
    const v = t[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(t)) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * One package's sticker ids, out of the public product JSON.
 *
 * This file is where the ids come from because the shop's own summaries do
 * not carry them: ProductSummary is id/name/version/attributes and no sticker
 * list at all. Everything but `stickers[].id` is treated as optional on
 * purpose -- the old free packages carry nothing else (package 1 answers with
 * author/onSale/packageId/price/stickers/title/validDays and no `version`,
 * no `hasAnimation`, no `stickerResourceType`), so a parser that insisted on
 * the newer fields would drop exactly the packages everybody owns.
 *
 * `animated` is a property of the package rather than of a sticker: the JSON
 * has no per-sticker flag, and neither does the STKOPT the panel already
 * renders incoming stickers from.
 */
function parseProductInfo(
  packageId: string,
  raw: unknown,
): PluginStickerPackage | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.stickers)) return null;
  const animated = o.hasAnimation === true ||
    /ANIMATION|POPUP/.test(String(o.stickerResourceType ?? ""));
  const stickers: PluginSticker[] = [];
  for (const s of o.stickers) {
    const id = String((s as Record<string, unknown>)?.id ?? "");
    // An id we cannot build a URL from is a 404 in the picker, which reads as
    // "the daemon is broken" rather than "this one sticker is odd".
    if (!isStickerId(id)) continue;
    stickers.push({ id, url: stickerImageUrl(id, animated), animated });
  }
  if (!stickers.length) return null;
  const version = o.version;
  return {
    id: packageId,
    name: productTitle(o.title),
    version: shopVersion(version),
    stickers,
  };
}

/**
 * Whether the cached package list still counts. `at` starts at 0, which is
 * older than any TTL, so a cold cache needs no case of its own.
 */
function stickersFresh(at: number, now: number): boolean {
  return now - at < STICKERS_TTL_MS;
}

/**
 * The sendMessage payload for one sticker, out of the package it belongs to.
 *
 * `e2ee` is deliberately absent, unlike sendArgs above: a sticker's content is
 * the metadata, and contentMetadata is never encrypted (only the text is).
 * Asking for E2EE would set e2eeVersion on a message whose text is empty, so
 * the other client would look for chunks that describe nothing -- and the
 * picture it needs is the one field encryption cannot cover.
 *
 * The package rather than three loose ids because STKOPT is decided from it:
 * the animation flag belongs to the whole package (parseProductInfo reads one
 * hasAnimation for all of its stickers), so an id that package never listed
 * still follows it -- which is what stub.py's sendSticker does too.
 * `e2ee` is absent here for a reason of its own, not just the one sendArgs
 * has: a sticker's content is the metadata, and contentMetadata is never
 * encrypted (only the text is). Asking for E2EE would set e2eeVersion on a
 * message whose text is empty, so the other client would look for chunks that
 * describe nothing -- and the picture it needs is the one field encryption
 * cannot cover.
 */
function stickerArgs(
  to: string,
  pkg: PluginStickerPackage,
  stickerId: string,
  requestId = "",
): {
  to: string;
  text: string;
  contentType: "STICKER";
  contentMetadata: Record<string, string>;
} {
  const animated = pkg.stickers.some((s) => s.animated);
  return {
    to,
    text: "",
    contentType: "STICKER",
    // Strings, not numbers: contentMetadata is a map<string,string> on the
    // wire, and the incoming metadata the panel already reads is spelled the
    // same way.
    contentMetadata: {
      ...(requestId ? { ENIL_REQUEST_ID: requestId } : {}),
      STKPKGID: pkg.id,
      STKID: stickerId,
      STKVER: String(pkg.version > 0 ? pkg.version : STICKER_VERSION_FALLBACK),
      // Without this an animated sticker arrives as its still frame, here and
      // on the other person's phone: getStickerURL() picks
      // sticker_animation.png only for STKOPT === "A" (vendor/linejs
      // client/features/message/talk.ts:175, same line in square.ts), and our
      // own copy comes back down the push stream through that very call. Left
      // out entirely for a still package, the way StickerMetadata declares it
      // (internal-types.ts:6, `STKOPT?`) -- anything but "A" reads as still.
      ...(animated ? { STKOPT: "A" } : {}),
    },
  };
}

/**
 * The shop answered something that is not a package list at all.
 *
 * Its own class rather than a flag on the reply because it has to survive the
 * whole ownedSummaries -> loadStickerPackages -> stickerPackages chain and
 * come out the far end still distinguishable from "the shop said no": the two
 * are different sentences to the user, and matching on a message string is a
 * thing that goes quietly wrong the day somebody rewords one.
 */
class StickerShapeError extends Error {
  constructor() {
    super("貼圖清單格式不對");
    this.name = "StickerShapeError";
  }
}

/**
 * What the panel is told when the owned list could not be produced.
 *
 * One function for both callers -- `stickers` and `sendSticker` -- because the
 * picker and the send fail for exactly the same reasons and must not describe
 * them differently. A shape we do not recognise says so plainly: prefixing it
 * with 讀不到 would blame the network for a payload that arrived intact.
 */
function stickerListRefusal(e: unknown): Json {
  if (e instanceof StickerShapeError) return { ok: false, error: e.message };
  return { ok: false, error: `貼圖清單讀不到：${errorText(e)}` };
}

/**
 * One `sendSticker` request: the refusals the panel prints, and otherwise the
 * send.
 *
 * The owned list and the send are parameters rather than the module's
 * `stickerPackages` and `client`, so that sticker_test.ts can watch the order
 * -- which file the other person sees is decided from the package, so the
 * list has to be in hand *before* anything goes out, and a cold cache means
 * loading it first rather than guessing the flag from the id.
 */
async function sendSticker(
  req: Json,
  owned: (refresh: boolean) => Promise<PluginStickerPackage[]>,
  send: (args: ReturnType<typeof stickerArgs>) => Promise<unknown>,
  requestId = "",
): Promise<Json> {
  const to = String(req.chat ?? "");
  const packageId = String(req.packageId ?? "");
  const stickerId = String(req.stickerId ?? "");
  // sendMessage takes contentMetadata verbatim, so a malformed id is not a
  // failed send -- it is an empty bubble on the other person's phone.
  if (!isStickerId(packageId) || !isStickerId(stickerId)) {
    return { ok: false, error: "貼圖編號不對" };
  }
  let packages: PluginStickerPackage[];
  try {
    // Not a refresh: a cache that has nothing in it loads here anyway, and one
    // that does is an hour old at worst -- a package cannot stop animating.
    packages = await owned(false);
  } catch (e) {
    return stickerListRefusal(e);
  }
  const pkg = packages.find((p) => p.id === packageId);
  // A package the account does not own arrives the same way: LINE relays the
  // metadata and the other client has nothing to draw. Refuse here, where
  // there is somebody to tell. The sticker id inside the package is *not*
  // checked -- a package whose product JSON could not be read has an empty
  // `stickers`, and refusing every send into it would be this daemon's bug
  // charged to the user.
  if (!pkg) return { ok: false, error: "這個貼圖包不在你的貼圖清單裡" };
  const asked = Number(req.version);
  // The panel may pin a version (README 契約); the list decides otherwise.
  const version = Number.isInteger(asked) && asked > 0 ? asked : pkg.version;
  await send(stickerArgs(
    to,
    { ...pkg, version },
    stickerId,
    requestId,
  ));
  return { ok: true };
}
/** One row of the shop's owned-package list, reduced to what the panel needs. */
interface ShopSummary {
  id: string;
  name: string;
  version: number;
}

/**
 * latestVersion is an i64, and the Thrift reader hands an i64 back as a
 * big-integer object rather than a number (base/thrift/readwrite/read.ts:65,
 * `bigInt(input.readI64().buffer)`). Number() on that object happens to work
 * today through valueOf; its own text is what it actually promises.
 */
function shopVersion(v: unknown): number {
  const n = Number(typeof v === "object" && v !== null ? String(v) : v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The rows out of one getOwnedProductSummaries reply, or null when the reply
 * is not a package list at all.
 *
 * The three shapes that count as one: a bare array, `productList`, and the
 * numeric field id `1`. Absent is *not* one of the failures -- Thrift omits a
 * field it has nothing to put in, so an account that owns no packages, and the
 * page after the last full one, both arrive as an object with neither key.
 * Reporting those as a broken shop would put an error in front of the one user
 * who has nothing to see anyway.
 *
 * A key that is there but is not a list is the opposite case, and so is a
 * reply that is not a container at all: something answered, and we cannot read
 * it. That used to come out as an empty picker cached for an hour, with
 * nothing said anywhere.
 */
function ownedList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  for (const key of ["productList", "1"]) {
    const v = o[key];
    if (Array.isArray(v)) return v;
    if (v !== undefined) return null;
  }
  return [];
}

/**
 * The owned packages out of getOwnedProductSummaries' reply, or null when
 * ownedList could not find one.
 *
 * Read by Thrift field id as well as by name, because the fork cannot name
 * these fields: the result declares success as `struct: "YN0_Ob1_N0"`
 * (@evex/linejs-types thrift.ts getOwnedProductSummaries_result) and no struct
 * by that name is defined anywhere in the schema, so
 * ThriftRenameParser.rename_thrift falls through to `newObject[name] = value`
 * (base/thrift/rename/parser.ts:123) and hands the reply back with its numeric
 * ids intact -- ProductSummaryList's 1/2/3 around ProductSummary's 1 (id),
 * 11 (name) and 21 (latestVersion). The named shape is accepted too, so the
 * day that struct gets defined this keeps working rather than going quietly
 * empty.
 */
function parseOwnedSummaries(raw: unknown): ShopSummary[] | null {
  const list = ownedList(raw);
  if (list === null) return null;
  const out: ShopSummary[] = [];
  for (const row of list) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = String(r.id ?? r["1"] ?? "");
    // A row whose id is not a counter is a row we cannot ask the CDN about.
    if (!isStickerId(id)) continue;
    const name = r.name ?? r["11"];
    out.push({
      id,
      name: typeof name === "string" ? name.trim() : "",
      version: shopVersion(r.latestVersion ?? r["21"]),
    });
  }
  return out;
}
// enil:sticker-end

// How much of the sticker CDN we are willing to have in flight at once, and
// how long one product JSON may take before it is not worth waiting for --
// the same shape as the avatar fetcher, and for the same reason: a cold
// picker asks for one file per owned package.
const STICKER_MAX_INFLIGHT = 4;
const STICKER_TIMEOUT_MS = 15_000;
// A product JSON is a few kilobytes (package 1, with 88 stickers, is under
// 4 KB); anything this size is an error page or worse.
const STICKER_MAX_JSON_BYTES = 1024 * 1024;

const stickerLimit = limiter(STICKER_MAX_INFLIGHT);
let stickerPacks: { at: number; packages: PluginStickerPackage[] } = {
  at: 0,
  packages: [],
};
/** One load at a time; see stickerPackages(). */
let stickerLoad: Promise<PluginStickerPackage[]> | null = null;
let stickerLoadGeneration = -1;

// The block between the enil:shoppage markers is sliced out verbatim by
// daemon/sticker_test.ts on top of the sticker block and a prelude holding a
// stub client and a stub ShopService, so it must reach for nothing else.
// enil:shoppage-begin
// Stickers, themes and sticons are separate shops on the same service.
const STICKER_SHOP_ID = "stickershop";
/**
 * The locale only decides which language the *shop* labels a package in. The
 * name the panel shows comes from the product JSON, which carries every
 * language at once, so this is the fallback's fallback -- and the panel is
 * Traditional Chinese throughout, so that is what it asks for.
 */
const STICKER_SHOP_LOCALE = { language: "zh-Hant", country: "TW" };
const STICKER_SHOP_PAGE = 50;

/**
 * The packages this account owns, in shop order.
 *
 * ShopService is generated but never wired onto BaseClient -- the constructor
 * builds auth/call/channel/liff/livetalk/relation/square/talk and stops
 * (vendor/linejs base/core/mod.ts:204-211) -- so `client.base.shop` is
 * undefined. The class carries no state of its own beyond the client it is
 * handed (base/service/shop/mod.ts:17-19), so it is constructed here rather
 * than patched into the fork, where every submodule bump would have to carry
 * the patch forward.
 */
async function ownedSummaries(owner: Client = client!): Promise<ShopSummary[]> {
  if (!owner) throw new Error("尚未登入");
  const shop = new ShopService(owner.base);
  const out: ShopSummary[] = [];
  const seen = new Set<string>();
  let offset = 0;
  // Bounded by rounds, not by progress: a shop that ignored `offset` would
  // answer the same page for ever, and every row of it is already in `seen`.
  for (
    let round = 0;
    round * STICKER_SHOP_PAGE < STICKER_PACKAGE_LIMIT;
    round++
  ) {
    const page = parseOwnedSummaries(
      await shop.getOwnedProductSummaries({
        shopId: STICKER_SHOP_ID,
        offset,
        limit: STICKER_SHOP_PAGE,
        locale: STICKER_SHOP_LOCALE,
      }),
    );
    // A shape nobody here can read is not something to page past: every later
    // round would answer the same way, and the picker would open empty and
    // stay that way for the hour the cache holds it.
    if (page === null) throw new StickerShapeError();
    if (!page.length) break;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
      if (out.length >= STICKER_PACKAGE_LIMIT) return out;
    }
    // A short page is the last page.
    if (page.length < STICKER_SHOP_PAGE) break;
    offset += page.length;
  }
  return out;
}
// enil:shoppage-end

/**
 * One package's stickers, off the public product JSON.
 *
 * Null rather than a throw: a package whose list could not be read still
 * belongs in the picker -- the account owns it -- and the panel is told so by
 * an empty `stickers`, which is a shape it has to draw anyway.
 */
async function fetchProductInfo(
  packageId: string,
): Promise<PluginStickerPackage | null> {
  return await stickerLimit(async () => {
    try {
      const res = await fetch(productInfoUrl(packageId), {
        signal: AbortSignal.timeout(STICKER_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const bytes = await readCapped(res, STICKER_MAX_JSON_BYTES);
      if (!bytes) return null;
      return parseProductInfo(
        packageId,
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    } catch {
      // A miss, a timeout, or the HTML error page the CDN answers one with.
      return null;
    }
  });
}

/** The shop list and the product JSONs, merged into what the panel gets. */
async function loadStickerPackages(): Promise<PluginStickerPackage[]> {
  const owner = client;
  const generation = sessionGeneration;
  if (!owner) throw new Error("尚未登入");
  const summaries = await ownedSummaries(owner);
  if (!sessionIsCurrent(owner, generation)) throw new Error("尚未登入");
  const details = await Promise.all(
    summaries.map((s) => fetchProductInfo(s.id)),
  );
  if (!sessionIsCurrent(owner, generation)) throw new Error("尚未登入");
  const out = summaries.map((s, i) => {
    const d = details[i];
    return {
      id: s.id,
      // The product JSON's zh_TW title beats the shop's label: the shop
      // answers in whichever locale we asked with, the JSON carries them all.
      name: d?.name || s.name || s.id,
      // The shop is the authority on the version -- the old free packages
      // publish none at all in their product JSON.
      version: s.version || d?.version || 0,
      stickers: d?.stickers ?? [],
    };
  });
  const empty = out.filter((p) => !p.stickers.length).length;
  // Counts only -- which packages somebody owns is theirs -- and logged on
  // every load rather than only on a miss: a cold one is seconds of shop and
  // CDN traffic, and this is the line that says it happened at all.
  console.log(`[stickers] ${out.length} packages, ${empty} without a list`);
  return out;
}

/**
 * The owned packages, at most an hour old.
 *
 * One load at a time. A second panel -- or a double click on the picker --
 * would otherwise start another shop call per page and another CDN fetch per
 * package; the avatar fetcher calls that a fetch storm and it is the same
 * storm here. A `refresh` that lands on a load already in flight joins it
 * instead of queueing behind it: that load is seconds old, which is what the
 * button was asking for.
 */
function stickerPackages(refresh: boolean): Promise<PluginStickerPackage[]> {
  if (!refresh && stickersFresh(stickerPacks.at, Date.now())) {
    return Promise.resolve(stickerPacks.packages);
  }
  const generation = sessionGeneration;
  if (!stickerLoad || stickerLoadGeneration !== generation) {
    const load = loadStickerPackages()
      .then((packages) => {
        if (!client || sessionGeneration !== generation) {
          throw new Error("尚未登入");
        }
        stickerPacks = { at: Date.now(), packages };
        return packages;
      })
      .finally(() => {
        if (stickerLoad === load) {
          stickerLoad = null;
          stickerLoadGeneration = -1;
        }
      });
    stickerLoad = load;
    stickerLoadGeneration = generation;
  }
  return stickerLoad;
}

/** Logout clears the owned list: a different account owns different
 * packages. Wraps the three reassignments logoutClaimed made. */
export function resetStickerCache(): void {
  stickerPacks = { at: 0, packages: [] };
  stickerLoad = null;
  stickerLoadGeneration = -1;
}

export {
  fetchProductInfo,
  sendSticker,
  stickerArgs,
  stickerListRefusal,
  stickerPackages,
};

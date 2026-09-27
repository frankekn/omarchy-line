/**
 * The sticker picker's pure half: the CDN URLs, the product-JSON parser, the
 * cache TTL and the sendMessage payload.
 *
 *   deno test -A sticker_test.ts
 *
 * PACKAGE_1 below is the real answer from
 * https://stickershop.line-scdn.net/stickershop/v1/product/1/android/productInfo.meta
 * (fetched once, 2026-09-07), trimmed to three of its 88 stickers and three of
 * its price rows. It is here because it is the *poor* case: the oldest free
 * packages carry no `version`, no `hasAnimation` and no `stickerResourceType`
 * at all, and a parser written against a modern package's JSON would drop
 * every one of them.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadBlocks } from "./slice_test.ts";

const PRELUDE = `
type Json = Record<string, unknown>;
export {
  isStickerId,
  parseOwnedSummaries,
  parseProductInfo,
  productInfoUrl,
  productTitle,
  sendSticker,
  stickerArgs,
  stickerImageUrl,
  stickerListRefusal,
  stickersFresh,
  shopVersion,
  StickerShapeError,
  STICKERS_TTL_MS,
  STICKER_PACKAGE_LIMIT,
};
`;

const PACKAGE_1 = {
  packageId: 1,
  onSale: true,
  validDays: 0,
  title: {
    en: "Moon & James",
    ja: "ムーン・ジェームズ",
    ko: "문 & 제임스",
    zh_CN: "馒头人&詹姆士",
    zh_TW: "饅頭人&詹姆士",
  },
  author: { en: "LINE", ja: "LINE", ko: "LINE", zh_TW: "LINE" },
  price: [
    { price: 0.0, symbol: "NLC", currency: "NLC", country: "@@" },
    { price: 0.0, symbol: "￥", currency: "JPY", country: "JP" },
    { price: 0.0, symbol: "NT$", currency: "TWD", country: "TW" },
  ],
  stickers: [
    { id: 4, height: 155, width: 179 },
    { id: 13, height: 181, width: 158 },
    { id: 401, height: 221, width: 213 },
  ],
};

const GROUP = "c" + "f".repeat(32);

interface StickerItem {
  id: string;
  url: string;
  animated: boolean;
}
interface StickerPackage {
  id: string;
  name: string;
  version: number;
  stickers: StickerItem[];
}
interface ShopSummary {
  id: string;
  name: string;
  version: number;
}
interface StickerModule {
  STICKERS_TTL_MS: number;
  STICKER_PACKAGE_LIMIT: number;
  StickerShapeError: new () => Error;
  isStickerId(value: string): boolean;
  parseOwnedSummaries(raw: unknown): ShopSummary[];
  parseProductInfo(id: string, raw: unknown): StickerPackage;
  productInfoUrl(id: string): string;
  productTitle(raw: unknown): string;
  sendSticker(
    req: Record<string, unknown>,
    owned: (refresh: boolean) => Promise<unknown[]>,
    send: (args: Record<string, unknown>) => Promise<unknown>,
  ): Promise<Record<string, unknown>>;
  shopVersion(raw: unknown): number;
  stickerArgs(
    to: string,
    pkg: Record<string, unknown>,
    stickerId: string,
    requestId?: string,
  ): Record<string, unknown>;
  stickerImageUrl(id: string, animated: boolean): string;
  stickerListRefusal(error: unknown): Record<string, unknown>;
  stickersFresh(at: number, now: number): boolean;
}
let M: StickerModule | undefined;
async function mod(): Promise<StickerModule> {
  // errortext first: stickerListRefusal calls errorText, and stubbing it here
  // would leave the sentence the panel prints untested.
  if (!M) {
    M = await loadBlocks<StickerModule>(["errortext", "sticker"], PRELUDE);
  }
  return M;
}

Deno.test("a sticker URL is the file the panel already draws incoming ones from", async () => {
  const m = await mod();
  assertEquals(
    m.stickerImageUrl("52002734", false),
    "https://stickershop.line-scdn.net/stickershop/v1/sticker/52002734/android/sticker.png",
  );
});

Deno.test("an animated package points at the other file, same id", async () => {
  const m = await mod();
  // STKOPT === "A" is what picks this one for an incoming sticker; for an
  // owned package the flag is on the package, so both variants exist per id.
  assertEquals(
    m.stickerImageUrl("52002734", true),
    "https://stickershop.line-scdn.net/stickershop/v1/sticker/52002734/android/sticker_animation.png",
  );
});

Deno.test("the product JSON is asked for by package id", async () => {
  const m = await mod();
  assertEquals(
    m.productInfoUrl("1"),
    "https://stickershop.line-scdn.net/stickershop/v1/product/1/android/productInfo.meta",
  );
});

Deno.test("only decimal counters are ids", async () => {
  const m = await mod();
  for (const good of ["1", "13", "52002734", "9".repeat(20)]) {
    assert(m.isStickerId(good), `${good} should be an id`);
  }
  // A leading zero and a float both build a URL the CDN answers 404 to; the
  // rest would either escape the path or reach LINE as metadata it cannot use.
  for (
    const bad of [
      "",
      "0",
      "01",
      "1.5",
      "-1",
      "1 ",
      "1/x",
      "abc",
      "١٢٣",
      "1".repeat(21),
    ]
  ) {
    assertEquals(m.isStickerId(bad), false, `${bad} should not be an id`);
  }
});

Deno.test("the oldest free package parses: ids, zh_TW title, no version", async () => {
  const m = await mod();
  const pkg = m.parseProductInfo("1", PACKAGE_1);
  assertEquals(pkg.id, "1");
  assertEquals(pkg.name, "饅頭人&詹姆士");
  // The field is missing from this JSON entirely -- 0 is "the product JSON
  // did not say", which is what makes the shop summary the version's source.
  assertEquals(pkg.version, 0);
  assertEquals(pkg.stickers, [
    {
      id: "4",
      url:
        "https://stickershop.line-scdn.net/stickershop/v1/sticker/4/android/sticker.png",
      animated: false,
    },
    {
      id: "13",
      url:
        "https://stickershop.line-scdn.net/stickershop/v1/sticker/13/android/sticker.png",
      animated: false,
    },
    {
      id: "401",
      url:
        "https://stickershop.line-scdn.net/stickershop/v1/sticker/401/android/sticker.png",
      animated: false,
    },
  ]);
});

Deno.test("sticker order is the order the shop gave, not sorted", async () => {
  const m = await mod();
  const pkg = m.parseProductInfo("1", PACKAGE_1);
  assertEquals(pkg.stickers.map((s: { id: string }) => s.id), [
    "4",
    "13",
    "401",
  ]);
});

Deno.test("hasAnimation and stickerResourceType each mark the whole package", async () => {
  const m = await mod();
  const base = { title: { en: "x" }, stickers: [{ id: 7 }] };
  assertEquals(
    m.parseProductInfo("2", { ...base, hasAnimation: true }).stickers[0]
      .animated,
    true,
  );
  assertEquals(
    m.parseProductInfo("2", { ...base, stickerResourceType: "ANIMATION" })
      .stickers[0].animated,
    true,
  );
  assertEquals(
    m.parseProductInfo("2", { ...base, stickerResourceType: "POPUP_SOUND" })
      .stickers[0].animated,
    true,
  );
  // A sound-only package is still a still picture.
  assertEquals(
    m.parseProductInfo("2", {
      ...base,
      hasSound: true,
      stickerResourceType: "STATIC",
    }).stickers[0].animated,
    false,
  );
  assertEquals(
    m.parseProductInfo("2", base).stickers[0].url.endsWith("sticker.png"),
    true,
  );
  assertEquals(
    m.parseProductInfo("2", { ...base, hasAnimation: true }).stickers[0].url
      .endsWith("sticker_animation.png"),
    true,
  );
});

Deno.test("a version the JSON does state is kept", async () => {
  const m = await mod();
  const pkg = m.parseProductInfo("2", {
    version: 12,
    title: { en: "x" },
    stickers: [{ id: 7 }],
  });
  assertEquals(pkg.version, 12);
  // One rule for a version, shared with the shop summary's: a package that
  // spells its version as text still has one, and only a version nobody could
  // read means "the summary decides instead".
  assertEquals(
    m.parseProductInfo("2", {
      version: "12",
      title: { en: "x" },
      stickers: [{ id: 7 }],
    }).version,
    12,
  );
  for (const bad of [0, -3, 1.5, "x", null, {}]) {
    assertEquals(
      m.parseProductInfo("2", {
        version: bad,
        title: { en: "x" },
        stickers: [{ id: 7 }],
      }).version,
      0,
    );
  }
});

Deno.test("nothing usable comes back as null, not as an empty package", async () => {
  const m = await mod();
  // The CDN answers a miss with an HTML error page, which JSON.parse either
  // refuses or turns into something with no `stickers` array at all.
  assertEquals(m.parseProductInfo("1", null), null);
  assertEquals(m.parseProductInfo("1", {}), null);
  assertEquals(m.parseProductInfo("1", "<html>"), null);
  assertEquals(m.parseProductInfo("1", { stickers: [] }), null);
  assertEquals(m.parseProductInfo("1", { stickers: [{ id: 0 }] }), null);
});

Deno.test("one unusable sticker costs only itself", async () => {
  const m = await mod();
  const pkg = m.parseProductInfo("1", {
    title: { en: "x" },
    stickers: [{ id: 7 }, { id: "0x1" }, null, { id: 9 }],
  });
  assertEquals(pkg.stickers.map((s: { id: string }) => s.id), ["7", "9"]);
});

Deno.test("the title falls back through the languages, then to anything", async () => {
  const m = await mod();
  assertEquals(m.productTitle({ zh_TW: "繁", zh_CN: "简", en: "en" }), "繁");
  assertEquals(m.productTitle({ zh_CN: "简", en: "en" }), "简");
  assertEquals(m.productTitle({ en: "en", ja: "ja" }), "en");
  assertEquals(m.productTitle({ ja: "ja" }), "ja");
  // A language nobody listed still beats a blank row in the picker.
  assertEquals(m.productTitle({ th: "ไทย" }), "ไทย");
  assertEquals(m.productTitle({ zh_TW: "   ", en: "en" }), "en");
  assertEquals(m.productTitle({}), "");
  assertEquals(m.productTitle(undefined), "");
  assertEquals(m.productTitle({ en: 5 }), "");
});

Deno.test("the list is an hour old before it is refetched", async () => {
  const m = await mod();
  assertEquals(m.STICKERS_TTL_MS, 60 * 60_000);
  const now = 1_700_000_000_000;
  assertEquals(m.stickersFresh(now, now), true);
  assertEquals(m.stickersFresh(now - m.STICKERS_TTL_MS + 1, now), true);
  assertEquals(m.stickersFresh(now - m.STICKERS_TTL_MS, now), false);
  // A cache nobody has filled: `at` is 0, which is older than any TTL, so the
  // cold start needs no case of its own.
  assertEquals(m.stickersFresh(0, now), false);
});

Deno.test("the picker is capped at 100 packages", async () => {
  const m = await mod();
  assertEquals(m.STICKER_PACKAGE_LIMIT, 100);
});

// ------------------------------------------------------- what goes out

const CDN = "https://stickershop.line-scdn.net/stickershop/v1/sticker";

/** A package shaped the way loadStickerPackages hands one to sendSticker. */
function pack(
  id: string,
  version: number,
  ids: string[],
  animated: boolean,
): Record<string, unknown> {
  const file = animated ? "sticker_animation.png" : "sticker.png";
  return {
    id,
    name: `pkg ${id}`,
    version,
    stickers: ids.map((s) => ({
      id: s,
      url: `${CDN}/${s}/android/${file}`,
      animated,
    })),
  };
}

const STILL = pack("1", 5, ["4", "13", "401"], false);
const MOVING = pack("11537", 7, ["52002734", "52002735"], true);

function meta(args: Record<string, unknown>): Record<string, unknown> {
  return args.contentMetadata as Record<string, unknown>;
}

Deno.test("a sticker is sent as metadata, with no text and no e2ee", async () => {
  const m = await mod();
  assertEquals(m.stickerArgs(GROUP, STILL, "13"), {
    to: GROUP,
    text: "",
    contentType: "STICKER",
    contentMetadata: { STKPKGID: "1", STKID: "13", STKVER: "5" },
  });
  // Not `e2ee: false` -- absent. The picture is resolved from the metadata,
  // which is never encrypted, so asking would only mark an empty text sealed.
  assertEquals("e2ee" in m.stickerArgs(GROUP, STILL, "13"), false);
  // And no STKOPT at all for a still package: the field is optional in the
  // metadata LINE's own clients send, and anything but "A" reads as still.
  assertEquals("STKOPT" in meta(m.stickerArgs(GROUP, STILL, "13")), false);
});

Deno.test("an animated package sends STKOPT, or it arrives frozen", async () => {
  const m = await mod();
  // The one field that picks sticker_animation.png in getStickerURL() -- for
  // the other person and for our own copy, which comes back down the push
  // stream and through that same call.
  assertEquals(meta(m.stickerArgs(GROUP, MOVING, "52002734")).STKOPT, "A");
  assertEquals(meta(m.stickerArgs(GROUP, MOVING, "52002734")), {
    STKPKGID: "11537",
    STKID: "52002734",
    STKVER: "7",
    STKOPT: "A",
  });
});

Deno.test("a sticker carries the panel request token", async () => {
  const m = await mod();
  assertEquals(meta(m.stickerArgs(GROUP, STILL, "13", "panel-request-9")), {
    ENIL_REQUEST_ID: "panel-request-9",
    STKPKGID: "1",
    STKID: "13",
    STKVER: "5",
  });
});

Deno.test("a sticker the package never listed follows the package", async () => {
  const m = await mod();
  // stub.py's sendSticker says the same: the flag is read once for the whole
  // package, so an id that is not in the list -- a package whose product JSON
  // could not be read has no list at all -- cannot have one of its own.
  assertEquals(meta(m.stickerArgs(GROUP, MOVING, "88888")).STKOPT, "A");
  assertEquals("STKOPT" in meta(m.stickerArgs(GROUP, STILL, "88888")), false);
});

Deno.test("a package with no list of its own is sent as a still one", async () => {
  const m = await mod();
  // Not a guess in the other direction: an id says nothing about animation,
  // and a still sticker that should have moved beats a moving URL that 404s.
  const blank = pack("22", 3, [], false);
  assertEquals("STKOPT" in meta(m.stickerArgs(GROUP, blank, "7")), false);
});

Deno.test("a package with no known version still sends a STKVER", async () => {
  const m = await mod();
  // LINE resolves the picture from STKPKGID+STKID; the old free packages
  // publish no version anywhere, and an empty STKVER is not a version.
  assertEquals(
    meta(m.stickerArgs(GROUP, pack("1", 0, ["13"], false), "13")).STKVER,
    "1",
  );
});

Deno.test("the metadata is strings, because the wire map is", async () => {
  const m = await mod();
  const both = meta(m.stickerArgs(GROUP, MOVING, "52002734"));
  for (const k of ["STKPKGID", "STKID", "STKVER", "STKOPT"]) {
    assertEquals(typeof both[k], "string", k);
  }
});

// ------------------------------------------------- the sendSticker command

/**
 * The owned list and the send, as sendSticker() takes them, plus the log that
 * says in which order it used them.
 */
function spy(packages: unknown[] | Error) {
  const log: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const asked: boolean[] = [];
  return {
    log,
    sent,
    asked,
    owned: async (refresh: boolean) => {
      asked.push(refresh);
      // A cold cache is a load rather than a value already sitting there, so
      // this yields: an implementation that sent first would show up here.
      await Promise.resolve();
      log.push("load");
      if (packages instanceof Error) throw packages;
      return packages;
    },
    send: (args: Record<string, unknown>) => {
      log.push("send");
      sent.push(args);
      return Promise.resolve({});
    },
  };
}

Deno.test("an uncached package is loaded before anything goes out", async () => {
  const m = await mod();
  const s = spy([STILL, MOVING]);
  assertEquals(
    await m.sendSticker(
      { chat: GROUP, packageId: "11537", stickerId: "52002734" },
      s.owned,
      s.send,
    ),
    { ok: true },
  );
  // Which file the other person sees comes out of the package, so the list
  // cannot be read after the send -- and it is asked for without `refresh`,
  // because a cold cache loads here anyway and a warm one is an hour old at
  // worst, while a refresh is a shop call plus a fetch per package.
  assertEquals(s.log, ["load", "send"]);
  assertEquals(s.asked, [false]);
  assertEquals(meta(s.sent[0]), {
    STKPKGID: "11537",
    STKID: "52002734",
    STKVER: "7",
    STKOPT: "A",
  });
});

Deno.test("the still package sends the same message, without STKOPT", async () => {
  const m = await mod();
  const s = spy([STILL, MOVING]);
  await m.sendSticker(
    { chat: GROUP, packageId: "1", stickerId: "13" },
    s.owned,
    s.send,
  );
  assertEquals(s.sent[0].to, GROUP);
  assertEquals(meta(s.sent[0]), {
    STKPKGID: "1",
    STKID: "13",
    STKVER: "5",
  });
});

Deno.test("an id the package does not list is sent on its flag", async () => {
  const m = await mod();
  const s = spy([STILL, MOVING]);
  // stub_test.py drives this same case against stub.py: the send is not
  // refused, and it is the animated file, because the package animates.
  assertEquals(
    await m.sendSticker(
      { chat: GROUP, packageId: "11537", stickerId: "88888" },
      s.owned,
      s.send,
    ),
    { ok: true },
  );
  assertEquals(meta(s.sent[0]).STKID, "88888");
  assertEquals(meta(s.sent[0]).STKOPT, "A");
});

Deno.test("a version the panel pins wins, otherwise the list's", async () => {
  const m = await mod();
  const s = spy([STILL]);
  await m.sendSticker(
    { chat: GROUP, packageId: "1", stickerId: "13", version: 9 },
    s.owned,
    s.send,
  );
  assertEquals(meta(s.sent[0]).STKVER, "9");
  // Same rule as shopVersion's: a version spelled as text is still one.
  const text = spy([STILL]);
  await m.sendSticker(
    { chat: GROUP, packageId: "1", stickerId: "13", version: "9" },
    text.owned,
    text.send,
  );
  assertEquals(meta(text.sent[0]).STKVER, "9");
  // A version nobody could read is not a version: the list decides instead,
  // and the flag never comes from the request at all.
  for (const bad of [0, -1, 1.5, "x", null, {}]) {
    const t = spy([STILL]);
    await m.sendSticker(
      { chat: GROUP, packageId: "1", stickerId: "13", version: bad },
      t.owned,
      t.send,
    );
    assertEquals(meta(t.sent[0]).STKVER, "5", String(bad));
  }
});

Deno.test("a malformed id never reaches the list, let alone LINE", async () => {
  const m = await mod();
  for (
    const bad of [
      { packageId: "", stickerId: "13" },
      { packageId: "1", stickerId: "0" },
      { packageId: "01", stickerId: "13" },
      { packageId: "1", stickerId: "1.5" },
      { packageId: "abc", stickerId: "13" },
      {},
    ]
  ) {
    const s = spy([STILL]);
    assertEquals(
      await m.sendSticker({ chat: GROUP, ...bad }, s.owned, s.send),
      { ok: false, error: "貼圖編號不對" },
    );
    // Not even asked for: the refusal is about the request, and a cold cache
    // would be seconds of shop and CDN traffic to reach the same answer.
    assertEquals(s.asked, []);
    assertEquals(s.sent, []);
  }
});

Deno.test("a package the account does not own is refused", async () => {
  const m = await mod();
  const s = spy([STILL, MOVING]);
  assertEquals(
    await m.sendSticker(
      { chat: GROUP, packageId: "999999", stickerId: "13" },
      s.owned,
      s.send,
    ),
    { ok: false, error: "這個貼圖包不在你的貼圖清單裡" },
  );
  assertEquals(s.sent, []);
});

Deno.test("a list that cannot be read is a refusal in words", async () => {
  const m = await mod();
  const s = spy(new Error("shop said no"));
  assertEquals(
    await m.sendSticker(
      { chat: GROUP, packageId: "1", stickerId: "13" },
      s.owned,
      s.send,
    ),
    { ok: false, error: "貼圖清單讀不到：shop said no" },
  );
  // Nothing goes out on a guess: without the package there is no flag, and a
  // sticker sent with the wrong one cannot be recalled.
  assertEquals(s.sent, []);
});

// ------------------------------------------------- the shop's owned list

const NAMED = {
  productList: [
    { id: "1", name: "Moon & James", latestVersion: 3 },
    { id: "12345", name: "  spaced  ", latestVersion: 0 },
  ],
  offset: 0,
  totalSize: 2,
};

// What the fork actually hands back: getOwnedProductSummaries_result declares
// success as struct "YN0_Ob1_N0", which the schema never defines, so nothing
// renames the fields. ProductSummaryList is 1/2/3, ProductSummary is 1 (id),
// 11 (name), 21 (latestVersion).
const RAW = {
  "1": [
    { "1": "1", "11": "Moon & James", "21": 3 },
    { "1": "12345", "11": "貼圖包", "21": 7 },
  ],
  "2": 0,
  "3": 2,
};

Deno.test("the renamed shape parses", async () => {
  const m = await mod();
  assertEquals(m.parseOwnedSummaries(NAMED), [
    { id: "1", name: "Moon & James", version: 3 },
    { id: "12345", name: "spaced", version: 0 },
  ]);
});

Deno.test("the numeric-fid shape parses to the same thing", async () => {
  const m = await mod();
  assertEquals(m.parseOwnedSummaries(RAW), [
    { id: "1", name: "Moon & James", version: 3 },
    { id: "12345", name: "貼圖包", version: 7 },
  ]);
});

Deno.test("a bare array is accepted", async () => {
  const m = await mod();
  assertEquals(
    m.parseOwnedSummaries([{ id: "9", name: "x", latestVersion: 1 }]),
    [
      { id: "9", name: "x", version: 1 },
    ],
  );
});

Deno.test("a reply with no list in it is a page, not a failure", async () => {
  const m = await mod();
  // Thrift omits a field it has nothing to put in, so both an account that
  // owns no packages and the page after the last full one look like this.
  // Calling either a broken shop would put an error in front of the one user
  // with nothing to see anyway.
  for (const empty of [{}, { productList: [] }, { "1": [] }, [], { "2": 0 }]) {
    assertEquals(m.parseOwnedSummaries(empty), [], JSON.stringify(empty));
  }
});

Deno.test("a shape nothing here can read is null, not an empty picker", async () => {
  const m = await mod();
  // Something answered and we cannot read it: that used to come out as an
  // empty picker cached for an hour with nothing said anywhere.
  for (
    const junk of [
      null,
      undefined,
      "",
      "productList",
      5,
      { productList: "no" },
      { productList: { 0: { id: "1" } } },
      { "1": 7 },
    ]
  ) {
    assertEquals(m.parseOwnedSummaries(junk), null, JSON.stringify(junk));
  }
});

Deno.test("a broken shape and a shop that said no are different sentences", async () => {
  const m = await mod();
  // The panel prints these: "讀不到" blames the network, and using it for a
  // payload that arrived intact sends the user to look at their Wi-Fi.
  assertEquals(m.stickerListRefusal(new Error("shop said no")), {
    ok: false,
    error: "貼圖清單讀不到：shop said no",
  });
  assertEquals(m.stickerListRefusal(new m.StickerShapeError()), {
    ok: false,
    error: "貼圖清單格式不對",
  });
  // Not every rejection under the shop call is an Error: the cast this used to
  // do printed 「貼圖清單讀不到：undefined」 for a thrown string, which reads
  // as a broken panel rather than a shop that would not answer.
  assertEquals(m.stickerListRefusal("shop timed out"), {
    ok: false,
    error: "貼圖清單讀不到：shop timed out",
  });
  assertEquals(m.stickerListRefusal(undefined), {
    ok: false,
    error: "貼圖清單讀不到：不明錯誤",
  });
});

Deno.test("a send refuses on the shape too, and sends nothing", async () => {
  const m = await mod();
  const s = spy(new m.StickerShapeError());
  assertEquals(
    await m.sendSticker(
      { chat: GROUP, packageId: "1", stickerId: "13" },
      s.owned,
      s.send,
    ),
    { ok: false, error: "貼圖清單格式不對" },
  );
  // Without the package there is no animation flag, and a sticker sent with
  // the wrong one cannot be recalled.
  assertEquals(s.sent, []);
});

Deno.test("a row we cannot ask the CDN about is dropped, not kept blank", async () => {
  const m = await mod();
  assertEquals(
    m.parseOwnedSummaries({
      productList: [
        { id: "", name: "a" },
        { id: "0", name: "b" },
        { name: "c" },
        null,
        { id: "7", name: "d" },
      ],
    }).map((s: { id: string }) => s.id),
    ["7"],
  );
});

Deno.test("an i64 version survives whatever the thrift reader wrapped it in", async () => {
  const m = await mod();
  // base/thrift/readwrite/read.ts hands an i64 back as a big-integer object,
  // not a number; all it promises is its own text.
  const big = { toString: () => "42" };
  assertEquals(m.shopVersion(big), 42);
  assertEquals(m.shopVersion(42), 42);
  assertEquals(m.shopVersion("42"), 42);
  assertEquals(m.shopVersion(42n), 42);
  for (const bad of [undefined, null, "", "x", 0, -1, 1.5, {}]) {
    assertEquals(m.shopVersion(bad), 0, String(bad));
  }
});

// ------------------------------------------------------------- paging

/**
 * The shop paging loop on a stub shop. The pages are baked into the prelude
 * rather than reached for through a global, because loadBlocks writes a fresh
 * module per call -- so each test gets its own shop and its own `asked` log.
 */
async function pagingMod(pages: unknown[]) {
  return await loadBlocks<{
    ownedSummaries(): Promise<ShopSummary[]>;
    STICKER_SHOP_LOCALE: { language: string; country: string };
    StickerShapeError: new () => Error;
    asked: Array<{ shopId: string; offset: number; limit: number }>;
  }>(
    ["errortext", "sticker", "shoppage"],
    `
type Json = Record<string, unknown>;
const PAGES: unknown[] = ${JSON.stringify(pages)};
export const asked: { shopId: string; offset: number; limit: number }[] = [];
let served = 0;
class ShopService {
  constructor(_client: unknown) {}
  getOwnedProductSummaries(
    args: { shopId: string; offset: number; limit: number; locale: unknown },
  ): Promise<unknown> {
    asked.push({
      shopId: args.shopId,
      offset: args.offset,
      limit: args.limit,
    });
    return Promise.resolve(PAGES[served++] ?? { productList: [] });
  }
}
const client = { base: {} };
export { ownedSummaries, STICKER_SHOP_LOCALE, StickerShapeError };
`,
  );
}

/** …and the loop actually run, which is what most of these are about. */
async function paging(pages: unknown[]) {
  const mod = await pagingMod(pages);
  return { mod, packages: await mod.ownedSummaries(), asked: mod.asked };
}

function rows(from: number, count: number) {
  return {
    productList: Array.from({ length: count }, (_, i) => ({
      id: String(from + i),
      name: `p${from + i}`,
      latestVersion: 1,
    })),
  };
}

Deno.test("one short page is one shop call", async () => {
  const { packages, asked } = await paging([rows(1, 3)]);
  assertEquals(packages.map((p: { id: string }) => p.id), ["1", "2", "3"]);
  assertEquals(asked, [{ shopId: "stickershop", offset: 0, limit: 50 }]);
});

Deno.test("a full page is followed by the next one, at the right offset", async () => {
  const { packages, asked } = await paging([rows(1, 50), rows(51, 10)]);
  assertEquals(packages.length, 60);
  assertEquals(packages[59].id, "60");
  assertEquals(asked, [
    { shopId: "stickershop", offset: 0, limit: 50 },
    { shopId: "stickershop", offset: 50, limit: 50 },
  ]);
});

Deno.test("the picker stops at 100 packages, mid-page", async () => {
  const { packages, asked } = await paging([
    rows(1, 50),
    rows(51, 50),
    rows(101, 50),
  ]);
  assertEquals(packages.length, 100);
  assertEquals(packages[99].id, "100");
  // The third page is never asked for: the cap is reached inside the second.
  assertEquals(asked.length, 2);
});

Deno.test("a shop that ignores the offset cannot loop for ever", async () => {
  // Every row of page two is already in the list, so `out` stops growing --
  // which is why the loop is bounded by rounds rather than by progress.
  const { packages, asked } = await paging([rows(1, 50), rows(1, 50)]);
  assertEquals(packages.length, 50);
  assertEquals(asked.length, 2);
});

Deno.test("an empty first page is not an error, just no packages", async () => {
  const { packages, asked } = await paging([{ productList: [] }]);
  assertEquals(packages, []);
  assertEquals(asked.length, 1);
});

Deno.test("a shop reply nobody can read stops the loop and says so", async () => {
  const m = await pagingMod([{ productList: "not a list" }]);
  await assertRejects(
    () => m.ownedSummaries(),
    m.StickerShapeError,
    "貼圖清單格式不對",
  );
  // Not paged past: every later round would answer the same way, and the
  // picker would open empty and stay that way for the hour the cache holds it.
  assertEquals(m.asked.length, 1);
});

Deno.test("a page that goes wrong mid-list is not reported as the whole list", async () => {
  const m = await pagingMod([rows(1, 50), { "1": 0 }]);
  await assertRejects(() => m.ownedSummaries(), m.StickerShapeError);
  assertEquals(m.asked.length, 2);
});

Deno.test("the shop is asked in the panel's own language", async () => {
  const { mod } = await paging([{ productList: [] }]);
  assertEquals(mod.STICKER_SHOP_LOCALE, {
    language: "zh-Hant",
    country: "TW",
  });
});

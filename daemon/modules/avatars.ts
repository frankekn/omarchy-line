/**
 * Profile pictures: the candidate-URL probe over LINE's two CDN hosts, the
 * SHA-1-keyed file cache under AVATAR_DIR, the in-flight deduplication, and
 * the persisted miss index (avatars.json) that keeps a picture-less contact
 * from being re-probed on every start. Pure module state plus fetch/Deno --
 * no LINE session beyond the generation guard.
 *
 * Dependency direction: imports env (AVATAR_DIR, AVATAR_INDEX_PATH), caches
 * (capMap, midKind, limiter), state (setChats, bumpChatsRevision,
 * scheduleStateWrite) and session (sessionIsCurrent). messages.ts and
 * notify.ts read avatarNow/avatarTokens from here; avatars.ts never reaches
 * back up.
 */
import { capMap, limiter, midKind, sweepMedia } from "./caches.ts";
import { AVATAR_DIR, AVATAR_INDEX_PATH } from "./env.ts";
import {
  bumpChatsRevision,
  chats,
  scheduleStateWrite,
  setChats,
} from "./state.ts";
import { sessionIsCurrent } from "./session.ts";
import { errorLine } from "./text.ts";
import type { Client } from "@evex/linejs";
import type { Json } from "./types.ts";

// The block between the enil:avatar markers is sliced out verbatim by
// daemon/avatar_test.ts on top of a stub AVATAR_DIR, so it must stay pure:
// no module state, no network, no client.
// enil:avatar-begin
/** A user picture and a group picture are not fetched from the same place. */
type AvatarKind = "user" | "chat";

/**
 * The two hosts LINE serves profile objects from. `profile` is what a
 * contact's picturePath is relative to; `obs` is the generic object store the
 * same bytes also sit in. Which one answers for which kind is documented
 * nowhere we can read, and a real picture token only exists inside a live
 * session -- so this is a probe, not a table: every candidate is tried in
 * order and the pair that answered is remembered per kind.
 */
const AVATAR_PROFILE_HOST = "https://profile.line-scdn.net";
const AVATAR_OBS_HOST = "https://obs.line-scdn.net";
/**
 * A list row is 32px and a notification icon 48, so the small square is what
 * we actually want; the bare object is the original upload, and the fallback
 * for the objects that were stored without a variant.
 */
const AVATAR_SUFFIXES = ["/preview", ""];

/** One thing to try: the URL, and the `<host>|<suffix>` pair to remember. */
interface AvatarCandidate {
  shape: string;
  url: string;
}

/**
 * Where a picture could be, most likely first.
 *
 * `token` is whichever field the contact carried: `thumbnailUrl` is already a
 * whole URL, `picturePath` is `/0h...` and `pictureStatus` is the bare object
 * id. The first needs no guessing at all and yields exactly one candidate;
 * the other two are joined to each host in turn. `preferred` is the shape
 * that answered last time, so the probe costs one round of misses per daemon
 * rather than one per contact.
 */
function avatarUrlCandidates(
  kind: AvatarKind,
  token: string,
  preferred = "",
): AvatarCandidate[] {
  const t = token.trim();
  if (!t) return [];
  // LINE handed over the whole URL, so there is nothing left to decide -- and
  // no shape worth remembering, because it says nothing about the next one.
  if (/^https?:\/\//i.test(t)) return [{ shape: "", url: t }];
  const path = t.replace(/^\/+/, "");
  if (!path) return [];
  const hosts = kind === "chat"
    ? [AVATAR_OBS_HOST, AVATAR_PROFILE_HOST]
    : [AVATAR_PROFILE_HOST, AVATAR_OBS_HOST];
  const shapes: string[] = [];
  for (const host of hosts) {
    for (const suffix of AVATAR_SUFFIXES) shapes.push(`${host}|${suffix}`);
  }
  const at = shapes.indexOf(preferred);
  if (at > 0) shapes.unshift(...shapes.splice(at, 1));
  return shapes.map((shape) => {
    const bar = shape.indexOf("|");
    return {
      shape,
      url: `${shape.slice(0, bar)}/${path}${shape.slice(bar + 1)}`,
    };
  });
}

/**
 * Where a picture is cached. Keyed on the picture token as well as the mid:
 * without it, somebody who changed their photo would keep the old one on
 * screen until the sweep happened to take the file. The `.jpg` is decoration
 * -- both the panel's Image and the notification server sniff the content --
 * but a cache directory of extensionless hashes is unreadable when something
 * has to be looked at by hand.
 */
async function avatarFileFor(
  mid: string,
  token: string,
  dir: string = AVATAR_DIR,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(`${mid} ${token}`),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${dir}/${hex}.jpg`;
}

/**
 * The picture token on a contact-shaped object, best first. Every source LINE
 * answers a name lookup with -- Contact, Profile, TargetProfileDetail, Chat --
 * carries some subset of these three, and they are not equally useful:
 * `thumbnailUrl` is a whole URL when it is set at all, so it skips the probe
 * entirely; `pictureStatus` is last because on many accounts it is a
 * cache-busting stamp rather than an object id.
 */
function pictureTokenOf(src: unknown): string {
  const o = (src ?? {}) as Record<string, unknown>;
  for (const key of ["thumbnailUrl", "picturePath", "pictureStatus"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * The whole body, or nothing at all once it goes past `max`.
 *
 * `content-length` cannot carry this: a chunked response has none at all, and
 * a header is a claim about the body rather than the body. Reading through the
 * reader and cancelling on the first chunk that crosses the line is what makes
 * the bytes stop arriving -- `arrayBuffer()` would have to receive the whole
 * oversized thing before anyone could measure it, which is the cost this cap
 * exists to refuse. Null rather than a short buffer, because half a picture is
 * not a smaller picture.
 */
async function readCapped(
  res: Response,
  max: number,
): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // A body that died mid-stream leaves the connection to be let go of too.
    await reader.cancel().catch(() => {});
    return null;
  }
  if (!total) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
// enil:avatar-end

// How much of the CDN we are willing to have in flight at once, and how long
// one picture may take before it is not worth waiting for.
const AVATAR_MAX_INFLIGHT = 4;
const AVATAR_TIMEOUT_MS = 15_000;
// A profile picture is tens of kilobytes; anything this size is not one, and
// reading it into memory to find that out is the part worth refusing.
const AVATAR_MAX_FILE_BYTES = 2 * 1024 * 1024;
// Pictures never age out -- the contact you have not heard from in a month is
// exactly the one whose face makes the list readable -- so the cache is capped
// by size alone.
const AVATAR_MAX_BYTES = 20 * 1024 * 1024;
// Mid plus token, one line of JSON each: the ceiling on avatars.json.
const AVATAR_INDEX_MAX = 5000;
const AVATAR_INDEX_SAVE_MS = 5_000;

const avatarLimit = limiter(AVATAR_MAX_INFLIGHT);
/** mid -> the picture token LINE last reported, filled by the name lookups. */
const avatarTokens = new Map<string, string>();
/** mid -> what that token settled on. No `path` means "there is no picture". */
const avatars = new Map<string, { token: string; path?: string }>();
/** In flight, keyed by mid and token, so one picture is fetched once. */
const avatarPending = new Map<string, Promise<string | undefined>>();
/** The `<host>|<suffix>` that answered, per kind. Persisted. */
const avatarShape = new Map<AvatarKind, string>();
/**
 * Every mid+token this daemon has already settled, earlier boots included.
 * Its whole job is the misses: a contact with no picture, or a token that is
 * not an object id, would otherwise be re-probed on every single start.
 */
const avatarIndex = new Map<string, string>();
let avatarIndexDirty = false;
let avatarIndexTimer: ReturnType<typeof setTimeout> | null = null;

/** Remembers the picture LINE reports for a mid; the fetch is lazy. */
function noteAvatar(mid: string, src: unknown): void {
  if (!mid) return;
  const token = pictureTokenOf(src);
  if (token) avatarTokens.set(mid, token);
  else avatarTokens.delete(mid);
}

/**
 * The cached picture for a mid, or nothing yet.
 *
 * Never waits: a chat summary or a page of history must not hang on a CDN
 * round trip. What it starts instead lands in `chats` and in the next state
 * write, so the first refresh after a cold start is the only one without
 * pictures.
 */
function avatarNow(
  mid: string,
  owner: Client,
  generation: number,
): string | undefined {
  const token = avatarTokens.get(mid);
  if (!token) return undefined;
  const hit = avatars.get(mid);
  if (hit && hit.token === token) return hit.path;
  void resolveAvatar(mid, token, owner, generation).catch(() => {});
  return undefined;
}

function resolveAvatar(
  mid: string,
  token: string,
  owner: Client,
  generation: number,
): Promise<string | undefined> {
  const key = `${generation} ${mid} ${token}`;
  let inFlight = avatarPending.get(key);
  if (!inFlight) {
    inFlight = fetchAvatar(mid, token, owner, generation)
      // Settled either way, because avatarNow() asks again for anything that
      // has no entry -- and a picture that keeps throwing (a full disk, a
      // read-only cache) would otherwise be retried once per rendered bubble.
      .catch(() => settleAvatar(mid, token, undefined, owner, generation))
      .finally(() => avatarPending.delete(key));
    avatarPending.set(key, inFlight);
  }
  return inFlight;
}

/** Memoises the answer and, when it is new, publishes it to the chat list. */
function settleAvatar(
  mid: string,
  token: string,
  path: string | undefined,
  owner: Client,
  generation: number,
): string | undefined {
  if (!sessionIsCurrent(owner, generation) || avatarTokens.get(mid) !== token) {
    return undefined;
  }
  avatars.set(mid, { token, path });
  if (!path) return undefined;
  let touched = false;
  const next = chats.map((c) => {
    if (c.mid === mid && c.avatarPath !== path) {
      touched = true;
      return { ...c, avatarPath: path };
    }
    return c;
  });
  // The list was built before this picture arrived, so nothing else is going
  // to tell the panel about it until the next refresh.
  if (touched) {
    setChats(next);
    bumpChatsRevision();
    scheduleStateWrite();
  }
  return path;
}

async function fetchAvatar(
  mid: string,
  token: string,
  owner: Client,
  generation: number,
): Promise<string | undefined> {
  const path = await avatarFileFor(mid, token);
  try {
    const st = await Deno.stat(path);
    // On disk from an earlier boot: the file is the cache, and this is also
    // what lets a swept picture come back instead of staying missing.
    if (st.isFile && st.size > 0) {
      return settleAvatar(mid, token, path, owner, generation);
    }
  } catch { /* not cached yet */ }
  if (avatarIndex.get(mid) === token) {
    // Settled before and it produced no file, and the token has not moved
    // since, so the answer cannot have changed either.
    return settleAvatar(mid, token, undefined, owner, generation);
  }
  const got = await avatarLimit(() =>
    downloadAvatar(midKind(mid), token, path)
  );
  if (!sessionIsCurrent(owner, generation) || avatarTokens.get(mid) !== token) {
    return undefined;
  }
  avatarIndex.set(mid, token);
  capMap(avatarIndex, AVATAR_INDEX_MAX);
  avatarIndexDirty = true;
  scheduleAvatarIndexSave();
  return settleAvatar(mid, token, got ? path : undefined, owner, generation);
}

// The block between the enil:avatarfetch markers is sliced out verbatim by
// daemon/avatar_test.ts on top of the avatar block and a prelude holding the
// two constants, the remembered-shape map and the index flag, so it must not
// reach for any other module state.
// enil:avatarfetch-begin
/** Tries the candidates in order; true when one of them left a file behind. */
async function downloadAvatar(
  kind: AvatarKind,
  token: string,
  path: string,
): Promise<boolean> {
  for (const c of avatarUrlCandidates(kind, token, avatarShape.get(kind))) {
    try {
      const res = await fetch(c.url, {
        signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
      });
      const type = res.headers.get("content-type") ?? "";
      // A CDN that answers a miss with an HTML page answers it 200, so the
      // content type decides here, not the status on its own.
      if (!res.ok || !type.startsWith("image/")) {
        await res.body?.cancel();
        continue;
      }
      // The size cap lives here and nowhere else: content-length is absent on
      // a chunked response and is only ever a claim about what follows.
      const bytes = await readCapped(res, AVATAR_MAX_FILE_BYTES);
      if (!bytes) continue;
      await Deno.writeFile(path, bytes);
      if (c.shape && avatarShape.get(kind) !== c.shape) {
        avatarShape.set(kind, c.shape);
        avatarIndexDirty = true;
        scheduleAvatarIndexSave();
        // The host is the thing nobody could look up; the path after it is
        // somebody's picture and never goes in the journal.
        console.log(`[avatar] ${kind}: ${c.shape.split("|")[0]}`);
      }
      return true;
    } catch { /* try the next candidate */ }
  }
  return false;
}
// enil:avatarfetch-end

function scheduleAvatarIndexSave(): void {
  if (avatarIndexTimer !== null) return;
  avatarIndexTimer = setTimeout(() => {
    avatarIndexTimer = null;
    void saveAvatarIndex();
  }, AVATAR_INDEX_SAVE_MS);
}

async function saveAvatarIndex(): Promise<void> {
  if (!avatarIndexDirty) return;
  avatarIndexDirty = false;
  const blob = JSON.stringify({
    shapes: Object.fromEntries(avatarShape),
    pics: Object.fromEntries(avatarIndex),
  });
  try {
    const tmp = `${AVATAR_INDEX_PATH}.tmp`;
    await Deno.writeTextFile(tmp, blob);
    await Deno.rename(tmp, AVATAR_INDEX_PATH);
  } catch (e) {
    // Losing the index costs one round of refetching, never a message. The
    // text goes through errorLine like every other log: a Deno write error
    // quotes the path it failed on.
    console.error("[avatar] index:", errorLine(e));
  }
}

async function loadAvatarIndex(): Promise<void> {
  let parsed: Json;
  try {
    parsed = JSON.parse(await Deno.readTextFile(AVATAR_INDEX_PATH)) as Json;
  } catch {
    return; // no index yet, or one we cannot read: refetching is the only cost
  }
  const shapes = (parsed.shapes ?? {}) as Json;
  for (const kind of ["user", "chat"] as AvatarKind[]) {
    const s = shapes[kind];
    if (typeof s === "string" && s) avatarShape.set(kind, s);
  }
  const pics = (parsed.pics ?? {}) as Json;
  for (const [mid, token] of Object.entries(pics)) {
    if (typeof token === "string") avatarIndex.set(mid, token);
  }
  capMap(avatarIndex, AVATAR_INDEX_MAX);
}

/** The size cap on the picture cache; pictures have no age limit. */
async function sweepAvatars(): Promise<void> {
  const r = await sweepMedia(
    AVATAR_DIR,
    Date.now(),
    Infinity,
    AVATAR_MAX_BYTES,
    "avatars",
  );
  if (!r.removed) return;
  // A file name is a hash, so there is no way back from what was deleted to
  // whose picture it was. Dropping the whole index is what makes those
  // pictures fetchable again; the ones still on disk are found by stat.
  avatarIndex.clear();
  avatars.clear();
  avatarIndexDirty = true;
  scheduleAvatarIndexSave();
}

export {
  avatarFileFor,
  avatarNow,
  avatarPending,
  avatars,
  avatarTokens,
  avatarUrlCandidates,
  loadAvatarIndex,
  noteAvatar,
  pictureTokenOf,
  readCapped,
  resolveAvatar,
  sweepAvatars,
};

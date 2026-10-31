/**
 * Display-name resolution: the per-mid cache-aside lookup over LINE's two
 * contact APIs, the bulk warm-up for group member lists, and the epoch
 * invalidation a rename operation triggers. The name cache itself lives in
 * caches.ts; this module owns the wire calls that fill it.
 *
 * Dependency direction: imports session (client/generation), caches (cache
 * maps, midKind, isMe, capMap), avatars (noteAvatar) and state (me). Nothing
 * below names.ts imports it except upward (messages, push, notify, refresh,
 * socket), so the graph stays one-way.
 */
import { classifyLoginError, errorLine } from "./text.ts";
import { NAMES_PATH } from "./env.ts";
import { createNameStore, type KeptName } from "./namestore.ts";
import { haltForRestriction, restriction } from "./restriction.ts";
import {
  capMap,
  CONTACT_BATCH,
  isMe,
  midKind,
  NAME_CACHE_MAX,
  nameCache,
  nameCacheEpoch,
} from "./caches.ts";
import { avatarTokens, noteAvatar } from "./avatars.ts";
import { me } from "./state.ts";
import { client, sessionGeneration, sessionIsCurrent } from "./session.ts";
import type { Client } from "@evex/linejs";

// The block between the enil:keptnames markers is sliced out verbatim by
// keptnames_test.ts.
// enil:keptnames-begin
const keptNames = createNameStore(NAMES_PATH);
/** When LINE answered each cached name; only these reach names.json. */
const nameSavedAt = new Map<string, number>();
const NAMES_SAVE_MS = 5_000;
let namesSaveTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The account the kept names belong to, from its login until its logout.
 * Not me.mid: logout clears that before it gets here, and the last changes
 * of the session still have to be written under the account that made them.
 */
let namesOwner = "";
/** Saves run one at a time: they share writeAtomic's temp file. */
let namesWriting: Promise<void> = Promise.resolve();

/**
 * Every name LINE answered goes through here: into the cache, and -- unless
 * the lookup failed and left only the bare mid -- into names.json shortly.
 */
export function rememberName(mid: string, name: string): void {
  unconfirmed.delete(mid); // LINE just answered for it
  nameCache.set(mid, name);
  capMap(nameCache, NAME_CACHE_MAX);
  if (name && name !== mid) nameSavedAt.set(mid, Date.now());
  else nameSavedAt.delete(mid);
  capMap(nameSavedAt, NAME_CACHE_MAX);
  scheduleNamesSave();
}

function scheduleNamesSave(): void {
  if (!namesOwner || namesSaveTimer !== null) return;
  namesSaveTimer = setTimeout(() => {
    namesSaveTimer = null;
    queueNamesSave();
  }, NAMES_SAVE_MS);
}

/** Snapshot now, write after whatever save is already on the disk. */
function queueNamesSave(): void {
  const owner = namesOwner;
  if (!owner) return;
  const rows = new Map<string, KeptName>();
  for (const [mid, at] of nameSavedAt) {
    const name = nameCache.get(mid);
    if (!name) continue;
    const token = avatarTokens.get(mid);
    rows.set(mid, token ? { name, at, token } : { name, at });
  }
  namesWriting = namesWriting.then(() => keptNames.save(owner, rows));
}

/**
 * After login, before the first round names anything: the names this account
 * resolved on earlier runs, where they are still fresh, with the picture
 * tokens their lookups carried. A name already in the cache (this session's
 * own answer) wins.
 */
export async function loadKeptNames(owner: string): Promise<void> {
  namesOwner = owner;
  // A logout's last save may still be on its way to disk; reading before it
  // lands would bring back the names that save was there to drop.
  await namesWriting;
  if (namesOwner !== owner) return;
  const kept = await keptNames.load(owner);
  if (namesOwner !== owner || String(me.mid ?? "") !== owner) return;
  for (const [mid, { name, at, token }] of kept) {
    if (nameCache.has(mid)) continue;
    nameCache.set(mid, name);
    nameSavedAt.set(mid, at);
    unconfirmed.add(mid);
    if (token && !avatarTokens.has(mid)) avatarTokens.set(mid, token);
  }
  capMap(nameCache, NAME_CACHE_MAX);
  capMap(nameSavedAt, NAME_CACHE_MAX);
}

/**
 * Logout: what the session changed and has not written yet goes to disk
 * first -- a rename it invalidated must not come back on the next login --
 * then the in-memory names go. The file stays for the next login.
 */
export function forgetNames(): void {
  if (namesSaveTimer !== null) {
    clearTimeout(namesSaveTimer);
    namesSaveTimer = null;
    queueNamesSave();
  }
  nameCache.clear();
  nameSavedAt.clear();
  unconfirmed.clear();
  toConfirm.clear();
  if (confirmTimer !== null) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
  namesOwner = "";
}

/** Settles once every queued save is on disk (tests, shutdown). */
export function namesSaved(): Promise<void> {
  return namesWriting;
}

/**
 * Kept names are served at once and confirmed behind the page, the way the
 * app trusts its contact store and lets sync correct it: the daemon keeps no
 * op revision across restarts, so a rename or a new picture made while it was
 * not running can only be learned by asking. Each kept name is asked about at
 * most once per session, and only when something actually shows it -- in one
 * getContactsV2 / getChats batch per hundred, the same requests a cold start
 * made anyway, just no longer in front of the page.
 */
const unconfirmed = new Set<string>();
const toConfirm = new Set<string>();
const CONFIRM_MS = 1_500;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let nameChangedListener: ((mids: string[]) => void) | null = null;

/** push.ts refreshes the chat list when a confirmation finds a change. */
export function onNameChanged(listener: (mids: string[]) => void): void {
  nameChangedListener = listener;
}

/** A name from names.json was just shown: have LINE confirm it soon. */
export function noteKeptNameUsed(mid: string): void {
  if (!unconfirmed.delete(mid)) return;
  toConfirm.add(mid);
  if (confirmTimer !== null) return;
  confirmTimer = setTimeout(() => {
    confirmTimer = null;
    void confirmKeptNames().catch((e) =>
      console.error("[name] confirm:", errorLine(e))
    );
  }, CONFIRM_MS);
}

async function confirmKeptNames(): Promise<void> {
  const owner = client;
  const generation = sessionGeneration;
  const mids = [...toConfirm];
  toConfirm.clear();
  if (!owner || !namesOwner || restriction || !mids.length) return;
  const live = () => sessionIsCurrent(owner, generation) && !restriction;
  const changed: string[] = [];
  const settle = (mid: string, name: string, src: unknown, epoch: number) => {
    // A rename operation that landed meanwhile owns this mid now.
    if ((nameCacheEpoch.get(mid) ?? 0) !== epoch) return;
    const before = nameCache.get(mid);
    const tokenBefore = avatarTokens.get(mid);
    noteAvatar(mid, src);
    rememberName(mid, name);
    if (before !== name || avatarTokens.get(mid) !== tokenBefore) {
      changed.push(mid);
    }
  };
  const users = mids.filter((m) => midKind(m) === "user" && !isMe(m));
  const chats = mids.filter((m) => midKind(m) !== "user");
  for (let i = 0; i < users.length && live(); i += CONTACT_BATCH) {
    const batch = users.slice(i, i + CONTACT_BATCH);
    const epochs = batch.map((mid) => nameCacheEpoch.get(mid) ?? 0);
    try {
      const res = await owner.base.talk.getContactsV2({ mids: batch });
      if (!live()) return;
      batch.forEach((mid, j) => {
        const entry = res?.contacts?.[mid];
        const names: {
          contact?: { displayNameOverridden?: unknown; displayName?: unknown };
          displayName?: unknown;
        } | undefined = entry;
        const name = names?.contact?.displayNameOverridden ||
          names?.contact?.displayName || names?.displayName;
        if (name) settle(mid, String(name), entry?.contact, epochs[j]);
      });
    } catch (e) {
      console.error("[name] confirm:", errorLine(e));
      noteNameFailure(e, owner, generation);
    }
  }
  for (let i = 0; i < chats.length && live(); i += CONTACT_BATCH) {
    const batch = chats.slice(i, i + CONTACT_BATCH);
    const epochs = new Map(
      batch.map((mid) => [mid, nameCacheEpoch.get(mid) ?? 0]),
    );
    try {
      const res = await owner.base.talk.getChats({
        chatMids: batch,
        withMembers: false,
        withInvitees: false,
      });
      if (!live()) return;
      for (const chat of res?.chats ?? []) {
        const mid = String(chat?.chatMid ?? "");
        // An unnamed room is labelled elsewhere; nothing here to confirm.
        if (!epochs.has(mid) || !chat.chatName) continue;
        settle(mid, String(chat.chatName), chat, epochs.get(mid)!);
      }
    } catch (e) {
      console.error("[name] confirm:", errorLine(e));
      noteNameFailure(e, owner, generation);
    }
  }
  if (changed.length && live()) nameChangedListener?.(changed);
}
// enil:keptnames-end

/**
 * A name lookup is cosmetic, so its failures are only logged -- except LINE
 * refusing the account: that stops automatic traffic here exactly as it does
 * for a refresh (SAFETY.md), instead of letting the next lookups keep asking.
 */
function noteNameFailure(
  e: unknown,
  owner: Client,
  generation: number,
): void {
  // A previous session's late refusal says nothing about the current one,
  // and haltForRestriction acts on the global client.
  if (!sessionIsCurrent(owner, generation)) return;
  if (classifyLoginError(e) === "restricted") haltForRestriction(e);
}

/**
 * `User` exposes only `mid` and the raw Thrift response -- there is no
 * `displayName` property. The name lives at targetProfileDetail.profileName,
 * with the nickname you set for them (overriddenName) taking precedence.
 * Group members are often not friends, so V3 can come back empty; getContactsV2
 * still answers for those.
 */
export async function resolveUserName(
  mid: string,
  owner: Client,
  generation: number,
): Promise<string> {
  if (!sessionIsCurrent(owner, generation)) return mid;
  try {
    const user = await owner.getUser(mid);
    if (!sessionIsCurrent(owner, generation)) return mid;
    const raw = user?.raw;
    // The picture is picked up here rather than by a lookup of its own: this
    // is the only round trip that already asks for it, and the answer is
    // thrown away the moment the name is read out of it.
    noteAvatar(mid, raw.targetProfileDetail);
    // GetContactV3Response declares both fields; the annotation keeps them
    // optional the way the read guards expect, with no assertion.
    const rawNames: {
      friendDetail?: { user?: { overriddenName?: unknown } };
      targetProfileDetail?: { profileName?: unknown };
    } = raw;
    const name = rawNames.friendDetail?.user?.overriddenName ||
      rawNames.targetProfileDetail?.profileName;
    if (name) return String(name);
  } catch (e) {
    console.error("[name] v3:", errorLine(e));
    noteNameFailure(e, owner, generation);
  }
  if (!sessionIsCurrent(owner, generation) || restriction) return mid;
  try {
    const res = await owner.base.talk.getContactsV2({ mids: [mid] });
    if (!sessionIsCurrent(owner, generation)) return mid;
    const entry = res?.contacts?.[mid];
    noteAvatar(mid, entry?.contact);
    // ContactEntry declares contact with both name fields; the wire sometimes
    // adds a top-level displayName the generated type omits, so the
    // annotation names it as optional instead of asserting the whole entry.
    const names: {
      contact?: { displayNameOverridden?: unknown; displayName?: unknown };
      displayName?: unknown;
    } | undefined = entry;
    const name = names?.contact?.displayNameOverridden ||
      names?.contact?.displayName || names?.displayName;
    if (name) return String(name);
  } catch (e) {
    console.error("[name] v2:", errorLine(e));
    noteNameFailure(e, owner, generation);
  }
  return mid;
}

export async function resolveName(
  mid: string,
  owner: Client | null = client,
  generation: number = sessionGeneration,
): Promise<string> {
  if (!owner || !sessionIsCurrent(owner, generation)) return mid;
  for (;;) {
    const hit = nameCache.get(mid);
    if (hit) {
      noteKeptNameUsed(mid);
      return hit;
    }
    // Restricted: no lookup goes out, and the bare mid is not cached as if it
    // were the name -- the first lookup after the halt lifts gets the real one.
    if (restriction) return mid;
    const metadataEpoch = nameCacheEpoch.get(mid) ?? 0;
    let name = mid;
    try {
      if (midKind(mid) === "user") {
        if (mid === me.mid) {
          name = String(me.displayName ?? "我");
        } else {
          name = await resolveUserName(mid, owner, generation);
        }
      } else {
        const chat = await owner.getChat(mid);
        if (!sessionIsCurrent(owner, generation)) return mid;
        noteAvatar(mid, chat.raw);
        // Chat.name is just raw.chatName (client/features/chat/mod.ts:26), and
        // unnamed rooms carry "" rather than null -- `??` would keep the blank.
        name = chat.name || chat.raw?.chatName || mid;
      }
    } catch (e) {
      // A name we cannot resolve is cosmetic; never fail the whole refresh.
      console.error("[name]", errorLine(e));
      noteNameFailure(e, owner, generation);
    }
    if (!sessionIsCurrent(owner, generation)) return mid;
    // A rename/profile operation may have invalidated this mid while its
    // lookup was on the wire. Resolve the new epoch before returning so
    // callers cannot cache the raw mid as a successful member label.
    if ((nameCacheEpoch.get(mid) ?? 0) !== metadataEpoch) continue;
    rememberName(mid, name);
    return name;
  }
}

/**
 * Fills nameCache for a whole member list in one call per batch. resolveName
 * would do them one at a time -- a getUser round trip each, so twenty seconds
 * of them for a big group -- and the picker has to be there by the time the
 * user has finished typing the name. Members are usually not friends, which is
 * exactly the case getContactsV2 answers and getUser's V3 path does not.
 */
export async function warmNames(mids: string[]): Promise<void> {
  const owner = client;
  const generation = sessionGeneration;
  if (!owner || restriction) return;
  const cold = mids.filter((m) => !nameCache.has(m) && !isMe(m));
  for (let i = 0; i < cold.length; i += CONTACT_BATCH) {
    const batch = cold.slice(i, i + CONTACT_BATCH);
    const epochs = new Map(
      batch.map((mid) => [mid, nameCacheEpoch.get(mid) ?? 0]),
    );
    try {
      const res = await owner.base.talk.getContactsV2({ mids: batch });
      if (!sessionIsCurrent(owner, generation)) return;
      for (const mid of batch) {
        if ((nameCacheEpoch.get(mid) ?? 0) !== epochs.get(mid)) continue;
        const entry = res?.contacts?.[mid];
        noteAvatar(mid, entry?.contact);
        // Same annotated view as resolveUserName: ContactEntry plus the
        // sometimes-present top-level displayName, no assertion.
        const names: {
          contact?: { displayNameOverridden?: unknown; displayName?: unknown };
          displayName?: unknown;
        } | undefined = entry;
        const name = names?.contact?.displayNameOverridden ||
          names?.contact?.displayName || names?.displayName;
        if (name) rememberName(mid, String(name));
      }
    } catch (e) {
      if (!sessionIsCurrent(owner, generation)) return;
      // Cosmetic: resolveName still answers for every mid this missed, just
      // one round trip at a time.
      console.error("[name] bulk:", errorLine(e));
      noteNameFailure(e, owner, generation);
      if (restriction) return;
    }
  }
}

export function invalidateName(mid: string): void {
  nameCache.delete(mid);
  // A rename seen live must not come back from names.json on the next start.
  if (nameSavedAt.delete(mid)) scheduleNamesSave();
  nameCacheEpoch.set(mid, (nameCacheEpoch.get(mid) ?? 0) + 1);
  capMap(nameCacheEpoch, NAME_CACHE_MAX);
}

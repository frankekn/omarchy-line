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
import {
  capMap,
  CONTACT_BATCH,
  isMe,
  midKind,
  NAME_CACHE_MAX,
  nameCache,
  nameCacheEpoch,
} from "./caches.ts";
import { noteAvatar } from "./avatars.ts";
import { me } from "./state.ts";
import { client, sessionGeneration, sessionIsCurrent } from "./session.ts";
import type { Client } from "@evex/linejs";

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
    console.error(`[name] v3 ${mid}:`, (e as Error).message);
  }
  if (!sessionIsCurrent(owner, generation)) return mid;
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
    console.error(`[name] v2 ${mid}:`, (e as Error).message);
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
    if (hit) return hit;
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
      console.error(`[name] ${mid}:`, (e as Error).message);
    }
    if (!sessionIsCurrent(owner, generation)) return mid;
    // A rename/profile operation may have invalidated this mid while its
    // lookup was on the wire. Resolve the new epoch before returning so
    // callers cannot cache the raw mid as a successful member label.
    if ((nameCacheEpoch.get(mid) ?? 0) !== metadataEpoch) continue;
    nameCache.set(mid, name);
    capMap(nameCache, NAME_CACHE_MAX);
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
  if (!owner) return;
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
        if (name) {
          nameCache.set(mid, String(name));
          capMap(nameCache, NAME_CACHE_MAX);
        }
      }
    } catch (e) {
      if (!sessionIsCurrent(owner, generation)) return;
      // Cosmetic: resolveName still answers for every mid this missed, just
      // one round trip at a time.
      console.error("[name] bulk:", (e as Error).message);
    }
  }
}

export function invalidateName(mid: string): void {
  nameCache.delete(mid);
  nameCacheEpoch.set(mid, (nameCacheEpoch.get(mid) ?? 0) + 1);
  capMap(nameCacheEpoch, NAME_CACHE_MAX);
}

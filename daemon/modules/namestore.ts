/**
 * names.json: the display names this daemon has looked up, kept across
 * restarts the way LINE's own app keeps its contacts. Without it, the first
 * open of a group after a daemon start asked LINE for every sender's name
 * before the page could go out.
 *
 *   {"v": 1, "owner": "<your mid>",
 *    "names": {"<mid>": ["<name>", <savedAt ms>, "<picture token>"?]}}
 *
 * The picture token rides along because it only ever arrives with a name
 * lookup (avatars.ts noteAvatar): a name served from here makes no lookup,
 * and without its token the avatar already on disk could not be shown.
 *
 * Scoped to the account that resolved them: a name can be the nickname you
 * gave someone, so another account's login never reads this one's file.
 * Entries age out after NAME_TTL_MS -- a rename while the daemon was not
 * running shows for at most that long; one while it runs arrives as an
 * operation and invalidates the entry straight away (names.ts).
 *
 * Pure apart from the file: names.ts owns the in-memory cache and decides
 * when to save. Nothing here imports session or state, so tests drive a real
 * instance at a temp path.
 */
import { writeAtomic } from "../atomicfile.ts";
import { errorLine } from "./text.ts";

/** How long a kept name is trusted before it is looked up again. */
export const NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface KeptName {
  name: string;
  /** When LINE last answered with this name, epoch ms. */
  at: number;
  /** The profile picture token that answer carried, if any. */
  token?: string;
}

export interface NameStoreOptions {
  ttlMs?: number;
  /** Most entries kept; the most recently answered win. */
  max?: number;
  now?: () => number;
}

export function createNameStore(path: string, opts: NameStoreOptions = {}) {
  const ttlMs = opts.ttlMs ?? NAME_TTL_MS;
  const max = opts.max ?? 5_000;
  const now = opts.now ?? Date.now;

  /** The kept names for `owner` that are still fresh; empty on any doubt. */
  async function load(owner: string): Promise<Map<string, KeptName>> {
    const out = new Map<string, KeptName>();
    if (!owner) return out;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(path));
    } catch {
      return out; // none yet, or unreadable: looking names up is the only cost
    }
    const file = parsed as { v?: unknown; owner?: unknown; names?: unknown };
    if (file?.v !== 1 || file.owner !== owner) return out;
    if (!file.names || typeof file.names !== "object") return out;
    const t = now();
    const rows: Array<[string, KeptName]> = [];
    for (const [mid, entry] of Object.entries(file.names)) {
      if (!Array.isArray(entry)) continue;
      const [name, at, token] = entry;
      if (typeof name !== "string" || !name || name === mid) continue;
      if (typeof at !== "number" || !(t - at < ttlMs) || at > t) continue;
      rows.push([
        mid,
        typeof token === "string" && token ? { name, at, token } : { name, at },
      ]);
    }
    rows.sort((a, b) => b[1].at - a[1].at);
    for (const [mid, kept] of rows.slice(0, max)) out.set(mid, kept);
    return out;
  }

  /** Replace the file with `names`, owned by `owner`. Never throws. */
  async function save(
    owner: string,
    names: Map<string, KeptName>,
  ): Promise<void> {
    if (!owner) return;
    const rows = [...names].filter(([mid, k]) =>
      k.name && k.name !== mid && Number.isFinite(k.at)
    ).sort((a, b) => b[1].at - a[1].at).slice(0, max);
    const blob = JSON.stringify({
      v: 1,
      owner,
      names: Object.fromEntries(
        rows.map((
          [mid, k],
        ) => [mid, k.token ? [k.name, k.at, k.token] : [k.name, k.at]]),
      ),
    });
    try {
      await writeAtomic(path, blob, 0o600);
    } catch (e) {
      console.error("[name] keep:", errorLine(e));
    }
  }

  return { load, save };
}

// Rebuild the bridge's snapshots independently of live daemon chat pushes.
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function rowsById(rows) {
  if (!Array.isArray(rows)) return null;
  const ids = new Set();
  for (const row of rows) {
    if (!object(row) || typeof row.mid !== "string" || !row.mid) return null;
    if (ids.has(row.mid)) return null;
    ids.add(row.mid);
  }
  return ids;
}

export function makeStateDecoder() {
  let generation = "", version = 0, state = null;
  return function decode(frame) {
    if (frame.web === "state") {
      // Older bridges have no sequence and never send deltas.
      if (frame.generation === undefined && frame.version === undefined) {
        generation = "";
        version = 0;
        state = null;
        return { frame };
      }
      if (
        typeof frame.generation !== "string" || !frame.generation ||
        !Number.isSafeInteger(frame.version) || frame.version < 1
      ) return { resync: true };
      if (generation && generation !== frame.generation) {
        return { resync: true };
      }
      if (generation && frame.version <= version) return {};
      generation = frame.generation;
      version = frame.version;
      state = frame.state;
      return { frame };
    }
    if (frame.web !== "state-delta") return { frame };
    if (
      !generation || frame.generation !== generation ||
      !Number.isSafeInteger(frame.version) || frame.version < 1
    ) return { resync: true };
    if (frame.version <= version) return {};
    if (frame.base !== version || frame.version !== version + 1) {
      return { resync: true };
    }
    const before = object(state), metadata = object(frame.state);
    const ids = rowsById(before?.chats);
    if (
      !before || !metadata || !ids || Object.hasOwn(metadata, "chats") ||
      !Array.isArray(frame.remove) || !Array.isArray(frame.put) ||
      !before.bootId || before.bootId !== metadata.bootId ||
      !object(before.me)?.mid ||
      object(before.me)?.mid !== object(metadata.me)?.mid
    ) return { resync: true };
    const removed = new Set(), changed = new Set();
    for (const id of frame.remove) {
      if (typeof id !== "string" || !ids.has(id) || removed.has(id)) {
        return { resync: true };
      }
      removed.add(id);
    }
    let previousIndex = -1;
    for (const entry of frame.put) {
      const row = object(entry?.chat), id = row?.mid;
      if (
        !Number.isSafeInteger(entry?.index) || entry.index <= previousIndex ||
        typeof id !== "string" || !id || removed.has(id) || changed.has(id)
      ) return { resync: true };
      previousIndex = entry.index;
      changed.add(id);
    }
    const chats = before.chats.filter((row) =>
      !removed.has(row.mid) && !changed.has(row.mid)
    );
    for (const { index, chat } of frame.put) {
      if (index > chats.length) return { resync: true };
      chats.splice(index, 0, chat);
    }
    state = { ...metadata, chats };
    version = frame.version;
    return { frame: { web: "state", state } };
  };
}

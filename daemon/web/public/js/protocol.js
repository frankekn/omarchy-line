// Pure projections for chat snapshots, event watermarks, messages and pending
// sends.
// No browser or application dependencies.

export function resetBoot(watermark, boot) {
  if (!boot || boot === watermark.boot) return { watermark, changed: false };
  return {
    watermark: { boot, seq: 0, eventsSeen: false },
    changed: Boolean(watermark.boot),
  };
}

export function acceptEvent(watermark, event, boot) {
  if (!event || !Number.isFinite(event.seq)) {
    return { watermark, accepted: false, changed: false };
  }
  const reset = resetBoot(watermark, String(boot || ""));
  if (event.seq <= reset.watermark.seq) {
    return { ...reset, accepted: false };
  }
  return {
    changed: reset.changed,
    accepted: true,
    watermark: { ...reset.watermark, seq: event.seq, eventsSeen: true },
  };
}

export function applyChatState(snapshot, state) {
  const boot = String(state.bootId || "");
  let { chats, chatList, chatBoot, chatRevision } = snapshot;
  if (boot !== chatBoot) {
    chatBoot = boot;
    chatRevision = -1;
  }
  const revision = Number(state.chatsRevision);
  if (!Number.isFinite(revision) || revision >= chatRevision) {
    if (Array.isArray(state.chats)) chats = state.chats.slice();
    chatList = state.chatList || null;
    if (Number.isFinite(revision)) chatRevision = revision;
  }
  return { chats, chatList, chatBoot, chatRevision };
}

export function applyChatPush(snapshot, row, revision, boot) {
  if (
    !row || !row.mid || !snapshot.chatBoot ||
    (boot && String(boot) !== snapshot.chatBoot)
  ) return snapshot;
  const rev = Number(revision);
  if (Number.isFinite(rev) && rev <= snapshot.chatRevision) return snapshot;
  const chats = snapshot.chats.slice();
  const index = chats.findIndex((chat) => String(chat.mid) === String(row.mid));
  if (index < 0) chats.push(row);
  else chats[index] = row;
  chats.sort((a, b) => (Number(b.lastTime) || 0) - (Number(a.lastTime) || 0));
  return {
    ...snapshot,
    chats,
    chatRevision: Number.isFinite(rev) ? rev : snapshot.chatRevision,
  };
}

export function visibleChats(chats, query) {
  const search = String(query || "").trim().toLowerCase();
  const unread = [], rest = [], hidden = [];
  for (const chat of chats) {
    if (search) {
      const haystack = `${chat.name || chat.mid} ${chat.lastFrom || ""} ${
        chat.lastText || ""
      }`.toLowerCase();
      if (!haystack.includes(search)) continue;
    }
    if (chat.hidden) hidden.push(chat);
    else if (Number(chat.unread || 0) > 0) unread.push(chat);
    else rest.push(chat);
  }
  return search ? unread.concat(rest, hidden) : unread.concat(rest);
}

export function compareMessages(a, b) {
  const time = Number(a.time || 0) - Number(b.time || 0);
  if (time) return time;
  const x = String(a.id || ""), y = String(b.id || "");
  return x.length - y.length || x.localeCompare(y);
}

// The count is captured when the chat opens, before history marks it read.
export function firstUnreadIndex(messages, unread, myMid) {
  const rows = Array.isArray(messages) ? messages : [];
  let left = Number(unread) || 0;
  if (left <= 0) return -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const message = rows[i];
    if (
      !message || message.pending ||
      ["CHATEVENT", "POSTNOTIFICATION"].includes(message.contentType) ||
      String(message.from || "") === myMid
    ) continue;
    if (--left === 0) return i;
  }
  return -1;
}

export function mergeMessage(rows, message, myMid) {
  if (!message?.id) return rows;
  const id = String(message.id), requestId = String(message.requestId || "");
  const next = rows.filter((m) =>
    String(m.id) !== id &&
    !(message.from === myMid && requestId && m.pending &&
      m.requestId === requestId)
  );
  next.push(message);
  return next.sort(compareMessages);
}

export function mergeHistory(rows, fresh, myMid) {
  let result = rows.slice();
  for (const message of fresh) result = mergeMessage(result, message, myMid);
  return result;
}

// Keep a contiguous suffix of server messages. Pending rows cannot be fetched
// with a history cursor and therefore remain outside the limit.
/**
 * @template {{ id?: string | number, pending?: boolean }} T
 * @param {T[]} rows
 * @param {number} limit
 * @param {Set<string>} protectedIds
 * @returns {T[]}
 */
export function trimHistory(rows, limit, protectedIds) {
  // The daemon pages by numeric LINE id, while the view sorts by time first.
  // Only cut when those orders agree, so `before` cannot skip a removed row.
  let previous = "", count = 0;
  for (const row of rows) {
    if (row.pending) continue;
    const id = String(row.id || "");
    if (!/^(0|[1-9]\d*)$/.test(id)) return rows;
    if (
      previous && (id.length < previous.length ||
        (id.length === previous.length && id <= previous))
    ) return rows;
    previous = id;
    if (!protectedIds.has(id)) count++;
  }
  let excess = count - limit, cut = 0;
  if (excess <= 0) return rows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.pending) continue;
    const id = String(row.id || "");
    // Crossing a protected row would leave a gap that `before` cannot fill.
    if (!id || protectedIds.has(id)) return rows;
    if (--excess === 0) {
      cut = i + 1;
      break;
    }
  }
  return rows.filter((row, index) => index >= cut || row.pending);
}

export function reconcilePending(pending, rows, myMid) {
  const delivered = new Set(
    rows.filter((m) => m?.from === myMid && m.requestId)
      .map((m) => String(m.requestId)),
  );
  return delivered.size
    ? pending.filter((m) => !delivered.has(m.requestId))
    : pending;
}

export function applyEvent(rows, event, myMid, readerCount = 0) {
  if (event.kind === "message" && event.message) {
    return mergeMessage(rows, event.message, myMid);
  }
  if (event.kind === "history" && Array.isArray(event.messages)) {
    return mergeHistory(rows, event.messages, myMid);
  }
  if (event.kind === "edit" && event.message) {
    const index = rows.findIndex((m) =>
      String(m.id) === String(event.message.id)
    );
    if (index < 0) return rows;
    const next = rows.slice();
    next[index] = event.message;
    return next;
  }
  if (event.kind === "reaction") {
    return rows.map((m) =>
      String(m.id) === String(event.messageId)
        ? {
          ...m,
          reactions: Array.isArray(event.reactions) ? event.reactions : [],
        }
        : m
    );
  }
  if (event.kind === "unsend") {
    return rows.map((m) =>
      String(m.id) === String(event.messageId)
        ? {
          ...m,
          text: "",
          unsent: true,
          hasMedia: false,
          mediaState: "unsent",
          stickerUrl: undefined,
          flexImages: undefined,
          altText: undefined,
          mentions: undefined,
          reactions: undefined,
          readBy: undefined,
        }
        : m
    );
  }
  if (event.kind === "read" && event.by !== myMid) {
    const index = rows.findIndex((m) => String(m.id) === String(event.upTo));
    if (index < 0 || !event.by) return rows;
    return rows.map((m, i) => {
      if (i > index || m.from !== myMid || m.pending) return m;
      const seen = Array.isArray(m.readSeen) ? m.readSeen : [];
      if (seen.includes(event.by)) return m;
      const readSeen = [...seen, event.by];
      const count = Math.max(Number(m.readBy?.count || 0), readSeen.length);
      return {
        ...m,
        readSeen,
        readBy: { count, all: readerCount > 0 && count >= readerCount },
      };
    });
  }
  return rows;
}

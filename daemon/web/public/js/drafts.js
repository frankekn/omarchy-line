// Account-scoped draft and pending storage. The storage and shared model are
// injected.
const browserStorage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  removeItem: (key) => globalThis.localStorage.removeItem(key),
};
/**
 * @param {ReturnType<typeof import("./model.js").createModel>} model
 * @param {Pick<Storage, "getItem" | "setItem" | "removeItem">} [storage]
 * @param {() => void} [onError]
 */
export function createDraftStore(
  model,
  storage = browserStorage,
  onError = () => {},
) {
  const key = "enil.web.drafts.v1", lastKey = "enil.web.lastAccount";
  model.drafts = Object.create(null);
  let loaded = false;
  try {
    const saved = JSON.parse(storage.getItem(key) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [account, chats] of Object.entries(saved)) {
        if (chats && typeof chats === "object" && !Array.isArray(chats)) {
          model.drafts[account] = Object.assign(Object.create(null), chats);
        }
      }
      loaded = true;
    }
  } catch { /* A missing or malformed store starts empty. */ }
  // The UI registry is still assembling while this store is constructed.
  if (loaded && pruneEmptyDrafts()) saveStorage(true);
  function emptyDraft(draft) {
    return draft && typeof draft === "object" && !Array.isArray(draft) &&
      (draft.text === "" || draft.text == null) && draft.reply == null &&
      (draft.pending == null ||
        (Array.isArray(draft.pending) && draft.pending.length === 0));
  }
  function pruneEmptyDrafts() {
    let changed = false;
    for (const [account, chats] of Object.entries(model.drafts)) {
      for (const [chat, draft] of Object.entries(chats)) {
        if (!emptyDraft(draft)) continue;
        delete chats[chat];
        changed = true;
      }
      if (Object.keys(chats).length === 0) {
        delete model.drafts[account];
        changed = true;
      }
    }
    return changed;
  }
  function saveStorage(deferWarning = false) {
    pruneEmptyDrafts();
    try {
      if (Object.keys(model.drafts).length) {
        storage.setItem(key, JSON.stringify(model.drafts));
      } else storage.removeItem(key);
    } catch {
      if (!model.storageWarningShown) {
        model.storageWarningShown = true;
        if (deferWarning) queueMicrotask(onError);
        else onError();
      }
    }
  }
  function chatDraft(
    account = model.account,
    chat = model.active,
    create = true,
  ) {
    if (!account || !chat) return null;
    if (!model.drafts[account] && create) {
      model.drafts[account] = Object.create(null);
    }
    const chats = model.drafts[account];
    if (!chats || typeof chats !== "object") return null;
    if (!chats[chat] && create) {
      chats[chat] = { text: "", reply: null, pending: [] };
    }
    return chats[chat] || null;
  }
  function pendingFor(chat = model.active, account = model.account) {
    const pending = chatDraft(account, chat, false)?.pending;
    return Array.isArray(pending) ? pending : [];
  }
  function writePending(chat, rows, account = model.account) {
    const draft = chatDraft(account, chat);
    if (!draft) return;
    const kept = new Set(rows.map((row) => row.requestId));
    for (const old of Array.isArray(draft.pending) ? draft.pending : []) {
      if (old?.requestId && !kept.has(old.requestId)) {
        model.files.delete(old.requestId);
      }
    }
    draft.pending = rows;
    saveStorage();
  }
  function forgetPending(chat, requestId, account = model.account) {
    model.files.delete(requestId);
    const rows = pendingFor(chat, account);
    if (rows.some((m) => m.requestId === requestId)) {
      writePending(
        chat,
        rows.filter((m) => m.requestId !== requestId),
        account,
      );
    }
  }
  function setLastAccount(account) {
    try {
      storage.setItem(lastKey, account);
    } catch { /* saveStorage reports unavailable storage. */ }
  }
  function clearLastAccount(previous) {
    let account = previous;
    try {
      account ||= storage.getItem(lastKey) || "";
    } catch { /* no durable account */ }
    if (account && model.drafts[account]) {
      for (const chat of Object.keys(model.drafts[account])) {
        for (const row of pendingFor(chat, account)) {
          if (row?.requestId) model.files.delete(row.requestId);
        }
      }
      delete model.drafts[account];
      saveStorage();
    }
    try {
      storage.removeItem(lastKey);
    } catch { /* storage is unavailable */ }
  }
  return {
    saveStorage,
    chatDraft,
    pendingFor,
    writePending,
    forgetPending,
    setLastAccount,
    clearLastAccount,
  };
}

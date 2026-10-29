// A 401 is the normal signed-out state. Check it in a worker so the browser
// does not report the expected response as a page console error.
if (typeof document === "undefined") {
  fetch("/api/session", { cache: "no-store" })
    .then((response) => globalThis.postMessage(response.status))
    .catch(() => globalThis.postMessage(0));
} else {
  runApp();
}
function runApp() {
  const english = /^en(?:-|$)/i.test(navigator.language || "");
  const strings = {
    signinTitle: ["連接你的 LINE", "Connect to LINE"],
    signinIntro: [
      "輸入 web key，從這個裝置開啟你的對話。",
      "Enter your web key to open your conversations on this device.",
    ],
    webKey: ["Web key", "Web key"],
    signin: ["登入", "Sign in"],
    signinFoot: [
      "你的對話，留在自己的網路裡。",
      "Your conversations stay on your own network.",
    ],
    invalidKey: ["Web key 不正確。", "Incorrect web key."],
    rateLimited: [
      "嘗試次數過多，請稍後再試。",
      "Too many attempts. Try again later.",
    ],
    signinFailed: [
      "無法登入，請檢查連線。",
      "Sign-in failed. Check your connection.",
    ],
    webSignout: ["離開網頁", "Sign out"],
    connected: ["已連線", "Connected"],
    connecting: ["連線中", "Connecting"],
    reconnecting: ["連線中斷，準備重連", "Disconnected, reconnecting"],
    daemonOffline: [
      "daemon 離線或無法連線。",
      "The daemon is offline or unavailable.",
    ],
    pushDown: ["LINE 即時連線中斷。", "The LINE push connection is down."],
    restricted: ["LINE 帳號受到限制", "The LINE account is restricted"],
    stale: ["聊天清單可能已過時。", "The chat list may be stale."],
    incomplete: [
      "清單不完整；搜尋只包含已載入的聊天。",
      "The list is incomplete; search only covers loaded chats.",
    ],
    lineTitle: ["登入 LINE", "Sign in to LINE"],
    lineLogin: ["登入 LINE", "Sign in to LINE"],
    lineRetry: ["重試", "Try again"],
    lineIdle: [
      "登入後就能在這裡查看你的聊天。",
      "Sign in to see your chats here.",
    ],
    lineStarting: ["正在準備登入…", "Preparing sign-in…"],
    lineQr: ["用 LINE 掃描 QR code。", "Scan the QR code with LINE."],
    linePin: ["在 LINE 輸入這組 PIN。", "Enter this PIN in LINE."],
    lineError: ["登入失敗。", "Sign-in failed."],
    lineLogout: ["登出 LINE", "Sign out of LINE"],
    confirmLogout: ["確定要登出 LINE？", "Sign out of LINE?"],
    inboxEyebrow: ["YOUR SPACE", "YOUR SPACE"],
    chats: ["聊天", "Chats"],
    search: ["搜尋聊天", "Search chats"],
    lineAccount: ["LINE 帳號", "LINE account"],
    emptyTitle: ["選擇一個聊天室", "Choose a conversation"],
    emptyDescription: [
      "從左側選擇對話，繼續聊下去。",
      "Select a chat to continue the conversation.",
    ],
    noChats: ["沒有符合的聊天室。", "No chats found."],
    hidden: ["已隱藏", "Hidden"],
    hide: ["隱藏", "Hide"],
    unhide: ["取消隱藏", "Unhide"],
    back: ["返回", "Back"],
    group: ["群組聊天", "Group conversation"],
    direct: ["聊天室", "Conversation"],
    loading: ["載入中…", "Loading…"],
    noMessages: ["還沒有訊息。", "No messages yet."],
    older: ["載入更早的訊息", "Load older messages"],
    messageLabel: ["訊息", "Message"],
    mention: ["提及成員", "Mention members"],
    messagePlaceholder: ["輸入訊息…", "Write a message…"],
    send: ["送出", "Send"],
    composerHint: [
      "Enter 送出 · Shift + Enter 換行",
      "Enter to send · Shift + Enter for a new line",
    ],
    attach: ["附加檔案", "Attach files"],
    dropFiles: ["放開以上傳檔案", "Drop files to upload"],
    uploading: ["上傳中", "Uploading"],
    uploadFailed: ["上傳失敗", "Upload failed"],
    reselectFile: [
      "請重新選擇要重送的檔案。",
      "Select the file again to retry.",
    ],
    tooLarge: ["檔案超過 1 GiB。", "The file exceeds 1 GiB."],
    stickers: ["貼圖", "Stickers"],
    refresh: ["重新整理", "Refresh"],
    close: ["關閉", "Close"],
    noStickers: ["沒有可用的貼圖。", "No stickers available."],
    reply: ["回覆", "Reply"],
    cancelReply: ["取消回覆", "Cancel reply"],
    reaction: ["表情", "React"],
    undoReaction: ["取消表情", "Remove reaction"],
    unsend: ["收回", "Unsend"],
    confirmUnsend: ["確定要收回這則訊息？", "Unsend this message?"],
    unsent: ["已收回訊息", "Message unsent"],
    decryptFailed: ["無法解密這則訊息", "Unable to decrypt this message"],
    message: ["訊息", "Message"],
    systemEvent: ["聊天動態", "Chat activity"],
    postEvent: ["貼文動態", "Post activity"],
    read: ["已讀", "Read"],
    sending: ["傳送中", "Sending"],
    sent: ["已送出", "Sent"],
    failed: ["傳送失敗", "Failed"],
    uncertain: ["尚未確認送達", "Delivery unconfirmed"],
    retry: ["重送", "Retry"],
    confirmRetry: [
      "這則訊息的送達狀態尚未確認。重送可能造成重複，確定要繼續？",
      "Delivery is unconfirmed. Retrying may send a duplicate. Continue?",
    ],
    offlineAction: [
      "連線中斷，請稍後再試。",
      "Disconnected. Try again when connected.",
    ],
    download: ["下載", "Download"],
    downloadOriginal: ["下載原圖", "Download original"],
    mediaExpired: ["附件已無法使用", "Attachment unavailable"],
    image: ["圖片", "Image"],
    video: ["影片", "Video"],
    file: ["檔案", "File"],
    mediaFailed: ["無法載入附件", "Could not load attachment"],
    storageFailed: [
      "無法儲存草稿；重新整理後可能遺失。",
      "Drafts could not be saved and may be lost on reload.",
    ],
    genericError: ["操作失敗。", "The action failed."],
  };
  const t = (key) => (strings[key] || [key, key])[english ? 1 : 0];
  document.documentElement.lang = english ? "en" : "zh-Hant";
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-placeholder]")) {
    node.placeholder = t(node.dataset.placeholder);
  }
  for (const node of document.querySelectorAll("[data-i18n-title]")) {
    node.title = t(node.dataset.i18nTitle);
    node.setAttribute("aria-label", t(node.dataset.i18nTitle));
  }
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const fileUrl = (path, download = false) =>
    `/api/file?path=${encodeURIComponent(String(path))}${
      download ? "&download=1" : ""
    }`;
  const httpsUrl = (value) => {
    try {
      const url = new URL(String(value));
      return url.protocol === "https:" && !url.username && !url.password
        ? url.href
        : "";
    } catch {
      return "";
    }
  };
  const uuid = () => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
      hex.slice(16, 20)
    }-${hex.slice(20)}`;
  };
  const model = {
    signedIn: false,
    socket: null,
    connected: false,
    everConnected: false,
    retryDelay: 1000,
    retryTimer: null,
    state: null,
    chats: [],
    chatList: null,
    chatBoot: "",
    chatRevision: -1,
    boot: "",
    seq: 0,
    eventsSeen: false,
    active: "",
    messages: [],
    loading: false,
    loadingOlder: false,
    noOlder: false,
    historyGeneration: 0,
    historyEvents: [],
    requestNumber: 0,
    requests: new Map(),
    drafts: {},
    account: "",
    reply: null,
    members: [],
    mentions: [],
    mentionText: "",
    mentionChoices: [],
    mentionStart: 0,
    mentionIndex: 0,
    stickerPacks: null,
    previews: new Map(),
    previewPending: new Set(),
    readerCount: 0,
    files: new Map(),
    retryFile: null,
    uploadCount: 0,
    toastTimer: null,
    dragDepth: 0,
  };
  const storageKey = "enil.web.drafts.v1";
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      model.drafts = saved;
    }
  } catch {
    model.drafts = {};
  }
  let storageWarningShown = false;
  function saveStorage() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(model.drafts));
    } catch {
      if (!storageWarningShown) {
        storageWarningShown = true;
        toast(t("storageFailed"));
      }
    }
  }
  function chatDraft(
    account = model.account,
    chat = model.active,
    create = true,
  ) {
    if (!account || !chat) return null;
    if (!model.drafts[account] && create) model.drafts[account] = {};
    const chats = model.drafts[account];
    if (!chats || typeof chats !== "object") return null;
    if (!chats[chat] && create) {
      chats[chat] = { text: "", reply: null, pending: [] };
    }
    return chats[chat] || null;
  }
  function saveComposer() {
    const draft = chatDraft();
    if (!draft) return;
    draft.text = $("message-input").value;
    draft.reply = model.reply;
    draft.mentions = model.mentions;
    draft.cursor = $("message-input").selectionStart;
    saveStorage();
  }
  function restoreComposer() {
    const draft = chatDraft();
    $("message-input").value = draft?.text || "";
    model.reply = draft?.reply || null;
    model.mentionText = $("message-input").value;
    model.mentions = Array.isArray(draft?.mentions)
      ? draft.mentions.filter((item) =>
        Number.isInteger(item.start) && Number.isInteger(item.end) &&
        item.start >= 0 && item.end > item.start &&
        model.mentionText.slice(item.start, item.end) === item.label
      )
      : [];
    updateReply();
    resizeComposer();
    const pos = Math.min(
      Number(draft?.cursor ?? $("message-input").value.length),
      $("message-input").value.length,
    );
    $("message-input").setSelectionRange(pos, pos);
    updateMentionPicker();
  }
  function pendingFor(chat = model.active, account = model.account) {
    const pending = chatDraft(account, chat, false)?.pending;
    return Array.isArray(pending) ? pending : [];
  }
  function writePending(chat, rows, account = model.account) {
    const draft = chatDraft(account, chat);
    if (!draft) return;
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
  function toast(message) {
    $("toast").textContent = String(message || t("genericError"));
    $("toast").hidden = false;
    clearTimeout(model.toastTimer);
    model.toastTimer = setTimeout(() => {
      $("toast").hidden = true;
    }, 6000);
  }
  function displayError(error) {
    toast(error?.message || t("genericError"));
  }
  function command(cmd, args = {}) {
    return new Promise((resolve, reject) => {
      if (!model.connected || model.socket?.readyState !== WebSocket.OPEN) {
        reject(Object.assign(new Error(t("offlineAction")), { unsent: true }));
        return;
      }
      const id = ++model.requestNumber;
      model.requests.set(id, { resolve, reject });
      try {
        model.socket.send(JSON.stringify({ id, cmd, ...args }));
      } catch {
        model.requests.delete(id);
        reject(Object.assign(new Error(t("offlineAction")), { unsent: true }));
      }
    });
  }
  function resetBoot(boot) {
    if (!boot || boot === model.boot) return false;
    const changed = !!model.boot;
    model.boot = boot;
    model.seq = 0;
    model.eventsSeen = false;
    return changed;
  }
  function connect() {
    if (!model.signedIn) return;
    clearTimeout(model.retryTimer);
    $("connection-text").textContent = model.everConnected
      ? t("reconnecting")
      : t("connecting");
    $("connection").classList.remove("connected");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/ws`);
    model.socket = socket;
    const reconnect = model.everConnected;
    socket.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      const firstFrame = !model.connected;
      if (firstFrame) {
        model.connected = true;
        model.everConnected = true;
        model.retryDelay = 1000;
        $("connection-text").textContent = t("connected");
        $("connection").classList.add("connected");
        renderNotices();
      }
      if (frame.web === "state") applyState(frame.state);
      else if (frame.web === "events") consumeEvents(frame.events);
      else if (frame.event) consumeEvent(frame.event, frame.boot);
      else if (frame.chat) {
        applyChatPatch(frame.chat, frame.chatsRevision, frame.boot);
      } else if (typeof frame.id === "number" && model.requests.has(frame.id)) {
        const request = model.requests.get(frame.id);
        model.requests.delete(frame.id);
        if (frame.ok) request.resolve(frame.data);
        else {request.reject(
            Object.assign(new Error(String(frame.error || t("genericError"))), {
              refused: true,
            }),
          );}
      }
      if (firstFrame && reconnect && model.active) {
        loadHistory(model.active, isViewingChat());
      }
    });
    socket.addEventListener("close", () => {
      if (model.socket !== socket) return;
      model.connected = false;
      for (const request of model.requests.values()) {
        request.reject(
          Object.assign(new Error(t("offlineAction")), { ambiguous: true }),
        );
      }
      model.requests.clear();
      $("connection").classList.remove("connected");
      $("connection-text").textContent = t("reconnecting");
      renderNotices();
      if (model.signedIn) {
        model.retryTimer = setTimeout(connect, model.retryDelay);
        model.retryDelay = Math.min(model.retryDelay * 2, 15000);
      }
    });
  }
  async function beginSession() {
    try {
      const status = await new Promise((resolve, reject) => {
        const worker = new Worker("/app.js?session-check", { type: "module" });
        worker.onmessage = (event) => {
          worker.terminate();
          resolve(event.data);
        };
        worker.onerror = (event) => {
          event.preventDefault();
          worker.terminate();
          reject(new Error("session check failed"));
        };
      });
      if (status === 204) {
        showApp();
        return;
      }
    } catch { /* The sign-in screen also reports connection failures. */ }
    $("signin-screen").hidden = false;
  }
  function showApp() {
    model.signedIn = true;
    $("signin-screen").hidden = true;
    $("app").hidden = false;
    connect();
  }
  $("signin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    $("signin-error").hidden = true;
    try {
      const response = await fetch("/api/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: $("web-key").value }),
      });
      if (response.status !== 204) {
        $("signin-error").textContent = response.status === 401
          ? t("invalidKey")
          : response.status === 429
          ? t("rateLimited")
          : t("signinFailed");
        $("signin-error").hidden = false;
        return;
      }
      $("web-key").value = "";
      showApp();
    } catch {
      $("signin-error").textContent = t("signinFailed");
      $("signin-error").hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  $("web-signout").addEventListener("click", async () => {
    try {
      const response = await fetch("/api/signout", { method: "POST" });
      if (!response.ok) throw new Error(t("genericError"));
      model.signedIn = false;
      clearTimeout(model.retryTimer);
      model.socket?.close();
      location.href = "/";
    } catch (error) {
      displayError(error);
    }
  });
  function renderNotices() {
    const notices = [];
    const state = model.state;
    if (
      !model.connected ||
      (state?.updatedAt && Date.now() - Number(state.updatedAt) > 180000)
    ) notices.push(t("daemonOffline"));
    if (state?.link?.reason === "restricted") {
      notices.push(`${t("restricted")} (${String(state.link.code || "?")})`);
    } else if (state?.link?.push === "down") notices.push(t("pushDown"));
    if (Number(state?.refresh?.failures || 0) >= 2) notices.push(t("stale"));
    $("notices").replaceChildren(...notices.map((s) => el("div", "notice", s)));
    $("notices").hidden = notices.length === 0;
  }
  function applyState(state) {
    if (!state || typeof state !== "object") return;
    const boot = String(state.bootId || "");
    const changedBoot = resetBoot(boot);
    if (boot !== model.chatBoot) {
      model.chatBoot = boot;
      model.chatRevision = -1;
    }
    const revision = Number(state.chatsRevision);
    if (!Number.isFinite(revision) || revision >= model.chatRevision) {
      if (Array.isArray(state.chats)) model.chats = state.chats.slice();
      model.chatList = state.chatList || null;
      if (Number.isFinite(revision)) model.chatRevision = revision;
    }
    const previousAccount = model.account;
    model.state = state;
    const account = String(state.me?.mid || "");
    if (account) {
      if (previousAccount && previousAccount !== account) {
        saveComposer();
        closeChat();
        model.stickerPacks = null;
      }
      model.account = account;
      try {
        localStorage.setItem("enil.web.lastAccount", account);
      } catch { /* saveStorage reports unavailable storage. */ }
    } else if (
      state.login?.status === "idle" ||
      (state.login?.status === "error" && state.login?.settled === true)
    ) {
      let lastAccount = previousAccount;
      try {
        lastAccount ||= localStorage.getItem("enil.web.lastAccount") || "";
      } catch { /* no durable account to clear */ }
      if (lastAccount && model.drafts[lastAccount]) {
        delete model.drafts[lastAccount];
        saveStorage();
      }
      try {
        localStorage.removeItem("enil.web.lastAccount");
      } catch { /* storage is unavailable */ }
      model.account = "";
      closeChat();
      model.stickerPacks = null;
    }
    const login = state.login || { status: "idle" };
    const loggedIn = login.status === "ok";
    $("workspace").hidden = !loggedIn;
    $("line-login").hidden = loggedIn;
    if (!loggedIn) {
      const text = login.status === "qr"
        ? t("lineQr")
        : login.status === "pin"
        ? t("linePin")
        : login.status === "error"
        ? `${t("lineError")} ${String(login.error || "")}`
        : login.status === "starting"
        ? t("lineStarting")
        : t("lineIdle");
      $("line-login-message").textContent = text;
      $("line-login-button").hidden = !["idle", "error"].includes(login.status);
      $("line-login-button").textContent = login.status === "error"
        ? t("lineRetry")
        : t("lineLogin");
      $("qr-image").hidden = login.status !== "qr" || !login.qrPng;
      if (!$("qr-image").hidden) $("qr-image").src = fileUrl(login.qrPng);
      $("login-pin").hidden = login.status !== "pin";
      $("login-pin").textContent = String(login.pin || "");
    }
    $("account-name").textContent = String(state.me?.displayName || account);
    setAvatar($("account-avatar"), "", state.me?.displayName || account);
    renderNotices();
    renderChats();
    if (model.active) renderActiveHeader();
    // Older stub versions keep the event ring in state.json.
    if (Array.isArray(state.events)) {
      consumeEvents({ bootId: boot, events: state.events });
    }
    if (changedBoot && model.active && model.connected) {
      loadHistory(model.active, isViewingChat());
    }
  }
  function applyChatPatch(row, revision, boot) {
    if (
      !row || !row.mid || !model.chatBoot ||
      (boot && String(boot) !== model.chatBoot)
    ) return;
    const rev = Number(revision);
    if (Number.isFinite(rev) && rev <= model.chatRevision) return;
    const index = model.chats.findIndex((c) =>
      String(c.mid) === String(row.mid)
    );
    if (index < 0) model.chats.push(row);
    else model.chats[index] = row;
    if (Number.isFinite(rev)) model.chatRevision = rev;
    renderChats();
    if (model.active === String(row.mid)) renderActiveHeader();
  }
  function consumeEvents(payload) {
    if (!payload || typeof payload !== "object") return;
    const boot = String(payload.bootId || "");
    const changed = resetBoot(boot);
    const events = Array.isArray(payload.events)
      ? payload.events.filter((event) => Number.isFinite(event?.seq)).sort((
        a,
        b,
      ) => a.seq - b.seq)
      : [];
    const gap = model.eventsSeen && model.seq > 0 && events.length > 0 &&
      events[0].seq > model.seq + 1;
    if ((changed || gap) && model.active && model.connected) {
      loadHistory(model.active, isViewingChat());
    }
    for (const event of events) consumeEvent(event, boot);
    model.eventsSeen = true;
  }
  function consumeEvent(event, boot) {
    if (!event || !Number.isFinite(event.seq)) return;
    const changed = resetBoot(String(boot || ""));
    if (changed && model.active && model.connected) {
      loadHistory(model.active, isViewingChat());
    }
    if (event.seq <= model.seq) return;
    model.seq = event.seq;
    model.eventsSeen = true;
    const chat = String(event.chat || "");
    if (
      event.kind === "message" && event.message?.requestId &&
      event.message.from === model.account
    ) forgetPending(chat, String(event.message.requestId));
    if (event.kind === "history" && Array.isArray(event.messages)) {
      reconcilePending(chat, event.messages);
    }
    if (chat !== model.active) return;
    if (model.loading) {
      model.historyEvents.push(event);
      return;
    }
    applyEvent(event);
  }
  function compareMessages(a, b) {
    const time = Number(a.time || 0) - Number(b.time || 0);
    if (time) return time;
    const x = String(a.id || ""), y = String(b.id || "");
    return x.length - y.length || x.localeCompare(y);
  }
  function mergeMessage(rows, message) {
    if (!message?.id) return rows;
    const id = String(message.id), requestId = String(message.requestId || "");
    const next = rows.filter((m) =>
      String(m.id) !== id &&
      !(message.from === model.account && requestId && m.pending &&
        m.requestId === requestId)
    );
    next.push(message);
    return next.sort(compareMessages);
  }
  function mergeHistory(rows, fresh) {
    let result = rows.slice();
    for (const message of fresh) result = mergeMessage(result, message);
    return result;
  }
  function reconcilePending(chat, rows) {
    const delivered = new Set(
      rows.filter((m) => m?.from === model.account && m.requestId).map((m) =>
        String(m.requestId)
      ),
    );
    if (delivered.size) {
      writePending(
        chat,
        pendingFor(chat).filter((m) => !delivered.has(m.requestId)),
      );
    }
  }
  function applyEvent(event, render = true) {
    let rows = model.messages.slice();
    if (event.kind === "message" && event.message) {
      rows = mergeMessage(rows, event.message);
      if (
        event.message.from !== model.account && event.message.id &&
        isViewingChat()
      ) {
        command("markRead", {
          chat: model.active,
          upTo: String(event.message.id),
        }).catch(() => {});
      }
    } else if (event.kind === "history" && Array.isArray(event.messages)) {
      rows = mergeHistory(rows, event.messages);
    } else if (event.kind === "edit" && event.message) {
      const index = rows.findIndex((m) =>
        String(m.id) === String(event.message.id)
      );
      if (index >= 0) rows[index] = event.message;
    } else if (event.kind === "reaction") {
      rows = rows.map((m) =>
        String(m.id) === String(event.messageId)
          ? {
            ...m,
            reactions: Array.isArray(event.reactions) ? event.reactions : [],
          }
          : m
      );
    } else if (event.kind === "unsend") {
      rows = rows.map((m) =>
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
    } else if (event.kind === "read" && event.by !== model.account) {
      const index = rows.findIndex((m) => String(m.id) === String(event.upTo));
      if (index >= 0 && event.by) {
        rows = rows.map((m, i) => {
          if (i > index || m.from !== model.account || m.pending) return m;
          const seen = Array.isArray(m.readSeen) ? m.readSeen : [];
          if (seen.includes(event.by)) return m;
          const readSeen = [...seen, event.by],
            count = Math.max(Number(m.readBy?.count || 0), readSeen.length);
          return {
            ...m,
            readSeen,
            readBy: {
              count,
              all: model.readerCount > 0 && count >= model.readerCount,
            },
          };
        });
      }
    }
    model.messages = rows;
    if (render) renderMessages("follow");
  }
  function setAvatar(node, path, name) {
    node.replaceChildren();
    if (path) {
      const image = el("img");
      image.alt = "";
      image.src = fileUrl(path);
      image.addEventListener("error", () => {
        node.replaceChildren(
          document.createTextNode(
            String(name || "?").trim().slice(0, 1).toUpperCase() || "?",
          ),
        );
      }, { once: true });
      node.append(image);
    } else {node.textContent =
        String(name || "?").trim().slice(0, 1).toUpperCase() || "?";}
  }
  function formatTime(ms) {
    if (!Number(ms)) return "";
    const date = new Date(Number(ms)), now = new Date();
    if (Number.isNaN(date.getTime())) return "";
    return date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString(english ? "en" : "zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
      })
      : date.toLocaleDateString(english ? "en" : "zh-TW", {
        month: "short",
        day: "numeric",
      });
  }
  function renderChats() {
    const search = $("search").value.trim().toLocaleLowerCase();
    const rows = model.chats.filter((chat) =>
      (search || !chat.hidden) &&
      (!search ||
        String(chat.name || "").toLocaleLowerCase().includes(search) ||
        String(chat.mid || "").toLocaleLowerCase().includes(search))
    );
    rows.sort((a, b) =>
      Number(Number(b.unread || 0) > 0) - Number(Number(a.unread || 0) > 0) ||
      Number(b.lastTime || 0) - Number(a.lastTime || 0)
    );
    const nodes = rows.map((chat) => {
      const button = el(
        "button",
        `chat-row${String(chat.mid) === model.active ? " active" : ""}`,
      );
      button.type = "button";
      const avatar = el("span", "avatar");
      setAvatar(avatar, chat.avatarPath, chat.name);
      const content = el("span", "row-content"),
        top = el("span", "row-top"),
        bottom = el("span", "row-bottom");
      const name = el(
        "span",
        "row-name",
        `${chat.name || chat.mid}${chat.hidden ? ` · ${t("hidden")}` : ""}`,
      );
      top.append(name, el("time", "row-time", formatTime(chat.lastTime)));
      bottom.append(el("span", "row-preview", chat.lastText || ""));
      if (Number(chat.unread) > 0) {
        bottom.append(
          el("span", "badge", Number(chat.unread) > 99 ? "99+" : chat.unread),
        );
      }
      content.append(top, bottom);
      button.append(avatar, content);
      button.addEventListener("click", () => openChat(String(chat.mid)));
      return button;
    });
    $("chat-list").replaceChildren(
      ...(nodes.length ? nodes : [el("div", "empty-list", t("noChats"))]),
    );
    $("chat-count").textContent = String(rows.length).padStart(2, "0");
    const incomplete = model.chatList?.complete === false;
    $("list-warning").hidden = !incomplete;
    $("list-warning").textContent = incomplete ? t("incomplete") : "";
    const unread = model.chats.filter((c) => !c.hidden).reduce(
      (sum, c) => sum + Math.max(0, Number(c.unread) || 0),
      0,
    );
    document.title = unread ? `(${unread}) enil` : "enil";
  }
  function renderActiveHeader() {
    const chat = model.chats.find((row) => String(row.mid) === model.active);
    if (!chat) return;
    $("active-name").textContent = String(chat.name || chat.mid);
    $("active-subtitle").textContent =
      model.active.startsWith("c") || model.active.startsWith("r")
        ? t("group")
        : t("direct");
    setAvatar($("active-avatar"), chat.avatarPath, chat.name);
    $("hide-chat").textContent = chat.hidden ? t("unhide") : t("hide");
  }
  $("search").addEventListener("input", renderChats);
  $("line-login-button").addEventListener(
    "click",
    () => command("login").catch(displayError),
  );
  $("line-logout").addEventListener("click", () => {
    if (confirm(t("confirmLogout"))) command("logout").catch(displayError);
  });
  $("hide-chat").addEventListener("click", () => {
    const chat = model.chats.find((row) => String(row.mid) === model.active);
    if (chat) {
      command(chat.hidden ? "unhide" : "hide", { chat: model.active }).catch(
        displayError,
      );
    }
  });
  function isViewingChat() {
    return !!model.active && !document.hidden &&
      (globalThis.innerWidth > 700 ||
        $("workspace").classList.contains("chat-open"));
  }
  document.addEventListener("visibilitychange", () => {
    if (!isViewingChat()) return;
    const latest = [...model.messages].reverse().find((message) =>
      !message.pending && message.from !== model.account && message.id
    );
    if (latest) {
      command("markRead", { chat: model.active, upTo: String(latest.id) })
        .catch(
          () => {},
        );
    }
  });
  function closeChat() {
    model.historyGeneration++;
    model.active = "";
    model.messages = [];
    model.reply = null;
    model.loading = false;
    model.loadingOlder = false;
    model.historyEvents = [];
    $("workspace").classList.remove("chat-open");
    $("chat-view").hidden = true;
    $("empty-chat").hidden = false;
    $("sticker-picker").hidden = true;
    $("mention-picker").hidden = true;
  }
  function openChat(chat) {
    if (model.active) saveComposer();
    model.historyGeneration++;
    model.active = chat;
    model.messages = [];
    model.loading = false;
    model.loadingOlder = false;
    model.noOlder = false;
    model.historyEvents = [];
    model.previews.clear();
    model.previewPending.clear();
    model.members = [];
    model.readerCount = chat.startsWith("u") ? 1 : 0;
    $("workspace").classList.add("chat-open");
    $("empty-chat").hidden = true;
    $("chat-view").hidden = false;
    $("sticker-picker").hidden = true;
    restoreComposer();
    renderActiveHeader();
    renderChats();
    renderMessages("bottom");
    loadHistory(chat, true);
    if (chat.startsWith("c") || chat.startsWith("r")) {
      command("members", { chat }).then((members) => {
        if (model.active === chat && Array.isArray(members)) {
          model.readerCount = members.length;
          model.members = members;
          updateMentionPicker();
        }
      }).catch(() => {});
    }
    $("message-input").focus();
  }
  $("back").addEventListener("click", () => {
    saveComposer();
    $("workspace").classList.remove("chat-open");
    renderChats();
  });
  async function loadHistory(chat, markRead) {
    if (model.loading && model.active === chat) return;
    const generation = ++model.historyGeneration;
    model.loading = true;
    model.loadingOlder = false;
    model.noOlder = false;
    model.historyEvents = [];
    renderMessages("bottom");
    try {
      const rows = await command("history", {
        chat,
        count: 50,
        markRead: !!markRead,
      });
      if (generation !== model.historyGeneration || model.active !== chat) {
        return;
      }
      const fresh = Array.isArray(rows) ? rows : [];
      reconcilePending(chat, fresh);
      model.messages = mergeHistory(
        model.messages.filter((m) => !m.pending),
        fresh,
      );
      for (const event of model.historyEvents) applyEvent(event, false);
      model.historyEvents = [];
      model.noOlder = fresh.length < 50;
    } catch (error) {
      if (generation === model.historyGeneration && model.active === chat) {
        for (const event of model.historyEvents) applyEvent(event, false);
        model.historyEvents = [];
        displayError(error);
      }
    } finally {
      if (generation === model.historyGeneration && model.active === chat) {
        model.loading = false;
        renderMessages("bottom");
      }
    }
  }
  async function loadOlder() {
    if (model.loading || model.loadingOlder || model.noOlder || !model.active) {
      return;
    }
    const first = model.messages.find((m) => !m.pending && m.id);
    if (!first) return;
    const chat = model.active, generation = model.historyGeneration;
    model.loadingOlder = true;
    try {
      const rows = await command("history", {
        chat,
        count: 50,
        before: String(first.id),
        markRead: false,
      });
      if (generation !== model.historyGeneration || model.active !== chat) {
        return;
      }
      const fresh = Array.isArray(rows) ? rows : [];
      reconcilePending(chat, fresh);
      model.messages = mergeHistory(model.messages, fresh);
      model.noOlder = fresh.length < 50;
      renderMessages("anchor");
    } catch (error) {
      if (generation === model.historyGeneration && model.active === chat) {
        displayError(error);
      }
    } finally {
      if (generation === model.historyGeneration && model.active === chat) {
        model.loadingOlder = false;
      }
    }
  }
  $("messages").addEventListener("scroll", () => {
    const list = $("messages");
    if (list.scrollTop < 150 && list.scrollHeight > list.clientHeight + 10) {
      loadOlder();
    }
  });
  function richText(text, mentions) {
    text = String(text || "");
    const links = [];
    const regex = /https?:\/\/[^\s<>"']+/gi;
    for (const match of text.matchAll(regex)) {
      const raw = match[0].replace(/[.,!?;:)\]}]+$/, "");
      try {
        const url = new URL(raw);
        if (
          (url.protocol === "http:" || url.protocol === "https:") && raw.length
        ) {
          links.push({
            start: match.index,
            end: match.index + raw.length,
            url: url.href,
          });
        }
      } catch { /* leave malformed URLs as text */ }
    }
    const spans = (Array.isArray(mentions) ? mentions : []).filter((m) =>
      Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= 0 &&
      m.end > m.start && m.end <= text.length
    );
    const boundaries = new Set([0, text.length]);
    for (const range of [...links, ...spans]) {
      boundaries.add(range.start);
      boundaries.add(range.end);
    }
    const points = [...boundaries].sort((a, b) => a - b),
      fragment = document.createDocumentFragment();
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i],
        end = points[i + 1],
        value = text.slice(start, end);
      if (!value) continue;
      const link = links.find((item) => item.start <= start && item.end >= end);
      const mention = spans.some((item) =>
        item.start <= start && item.end >= end
      );
      let part = document.createTextNode(value);
      if (mention) {
        const strong = el("strong", "mention");
        strong.append(part);
        part = strong;
      }
      if (link) {
        const anchor = el("a");
        anchor.href = link.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.append(part);
        part = anchor;
      }
      fragment.append(part);
    }
    return fragment;
  }
  const reactionTypes = {
    NICE: "👍",
    LOVE: "❤️",
    FUN: "😆",
    AMAZING: "😲",
    SAD: "😢",
    OMG: "😱",
  };
  function safeImage(url, className, alt) {
    const image = el("img", className);
    image.alt = alt;
    image.loading = "lazy";
    image.src = url;
    return image;
  }
  function sizeText(size) {
    const n = Number(size);
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }
  async function downloadMessage(chat, message) {
    try {
      const data = await command("download", {
        chat,
        messageId: String(message.id),
      });
      if (!data?.path) throw new Error(t("mediaFailed"));
      const link = el("a");
      link.href = fileUrl(data.path, true);
      link.download = String(message.fileName || "");
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      displayError(error);
    }
  }
  function openLightbox(chat, message, url) {
    $("lightbox-name").textContent = String(message.fileName || t("image"));
    $("lightbox-image").src = url;
    $("lightbox-image").alt = String(message.fileName || t("image"));
    $("lightbox-download").onclick = () => downloadMessage(chat, message);
    if (!$("lightbox").open) $("lightbox").showModal();
  }
  $("lightbox-close").addEventListener("click", () => $("lightbox").close());
  $("lightbox").addEventListener("click", (event) => {
    if (event.target === $("lightbox")) $("lightbox").close();
  });
  const previewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      previewObserver.unobserve(entry.target);
      const id = entry.target.dataset.messageId,
        chat = entry.target.dataset.chat;
      if (!id || model.previewPending.has(id) || model.previews.has(id)) {
        continue;
      }
      model.previewPending.add(id);
      command("preview", { chat, messageId: id }).then((data) => {
        if (model.active !== chat) return;
        model.previews.set(id, data?.path ? String(data.path) : "");
        renderMessages("preserve");
      }).catch(() => {
        if (model.active === chat) {
          model.previews.set(id, "");
          renderMessages("preserve");
        }
      }).finally(() => model.previewPending.delete(id));
    }
  }, { root: $("messages"), rootMargin: "400px 0px" });
  function addMedia(bubble, message, chat) {
    const type = String(message.contentType || "");
    const state = message.mediaState || "ok";
    if (message.unsent) return;
    if (type === "STICKER") {
      const url = httpsUrl(message.stickerUrl);
      if (url) bubble.append(safeImage(url, "sticker-image", t("stickers")));
    }
    if (type === "FLEX" && Array.isArray(message.flexImages)) {
      for (const value of message.flexImages) {
        const url = httpsUrl(value);
        if (!url) {
          continue;
        }
        const img = safeImage(url, "media-image", t("image"));
        img.addEventListener("click", () => openLightbox(chat, message, url));
        bubble.append(img);
      }
    }
    if (message.pending) return;
    if (!["IMAGE", "VIDEO", "FILE"].includes(type)) return;
    if (state !== "ok") {
      bubble.append(el("div", "muted", t("mediaExpired")));
      return;
    }
    if (message.previewable) {
      const id = String(message.id),
        path = model.previews.get(id) || message.mediaPath;
      if (path) {
        const url = fileUrl(path),
          image = safeImage(
            url,
            "media-image",
            type === "VIDEO" ? t("video") : t("image"),
          );
        if (type === "IMAGE") {
          image.addEventListener(
            "click",
            () => openLightbox(chat, message, url),
          );
        }
        bubble.append(image);
      } else {
        const placeholder = el(
          "div",
          "media-placeholder",
          model.previews.has(id) ? t("mediaFailed") : t("loading"),
        );
        placeholder.dataset.messageId = id;
        placeholder.dataset.chat = chat;
        bubble.append(placeholder);
        if (!model.previews.has(id)) previewObserver.observe(placeholder);
      }
    }
    if (type === "FILE" || type === "VIDEO" || !message.previewable) {
      const card = el("div", "file-card"), info = el("span", "file-details");
      info.append(
        el(
          "strong",
          "",
          message.fileName ||
            (type === "VIDEO"
              ? t("video")
              : type === "IMAGE"
              ? t("image")
              : t("file")),
        ),
      );
      if (message.fileSize !== undefined) {
        info.append(el("small", "", sizeText(message.fileSize)));
      }
      const button = el("button", "download-button", t("download"));
      button.type = "button";
      button.addEventListener("click", () => downloadMessage(chat, message));
      card.append(
        el("span", "file-icon", type === "VIDEO" ? "▷" : "↓"),
        info,
        button,
      );
      bubble.append(card);
    }
  }
  function messageNode(message) {
    const chat = model.active,
      own = message.from === model.account,
      row = el("article", `message-row${own ? " own" : ""}`),
      column = el("div", "message-column");
    row.dataset.messageId = String(message.id || "");
    if (
      !own && (chat.startsWith("c") || chat.startsWith("r")) && message.fromName
    ) column.append(el("div", "sender", message.fromName));
    const system = message.unsent || message.decryptFailed ||
      ["CHATEVENT", "POSTNOTIFICATION"].includes(message.contentType);
    const bubble = el("div", `bubble${system ? " system" : ""}`);
    if (message.replyTo && !message.unsent) {
      const quote = message.replyTo,
        text = `${quote.fromName ? `${quote.fromName}: ` : ""}${
          quote.text || t("message")
        }`;
      bubble.append(el("div", "quote", text));
    }
    let body = message.unsent
      ? t("unsent")
      : message.decryptFailed
      ? t("decryptFailed")
      : String(message.text || "");
    if (message.contentType === "FLEX" && message.altText) {
      body = String(message.altText);
    }
    if (
      ["CHATEVENT", "POSTNOTIFICATION"].includes(message.contentType) &&
      (!body || body.toUpperCase() === message.contentType)
    ) {
      body = message.contentType === "CHATEVENT"
        ? t("systemEvent")
        : t("postEvent");
    }
    if (body) {
      const content = el("div", "message-text");
      content.append(richText(body, message.mentions));
      bubble.append(content);
    }
    addMedia(bubble, message, chat);
    column.append(bubble);
    if (
      !message.unsent && Array.isArray(message.reactions) &&
      message.reactions.length
    ) {
      const reactions = el("div", "reactions");
      for (const reaction of message.reactions) {
        const type = String(reaction.type || ""),
          button = el(
            "button",
            `reaction-pill${reaction.mine ? " mine" : ""}`,
            `${reactionTypes[type] || type} ${Number(reaction.count || 0)}`,
          );
        button.type = "button";
        button.title = reaction.mine ? t("undoReaction") : t("reaction");
        button.addEventListener(
          "click",
          () =>
            command("react", {
              chat,
              messageId: String(message.id),
              type: reaction.mine ? "UNDO" : type,
            }).catch(displayError),
        );
        reactions.append(button);
      }
      column.append(reactions);
    }
    const meta = el("div", "message-meta");
    if (
      own && message.readBy?.count > 0 && !message.pending && !message.unsent
    ) {
      meta.append(
        el(
          "span",
          "",
          message.readBy.all
            ? t("read")
            : `${t("read")} ${message.readBy.count}`,
        ),
      );
    }
    if (message.pending) {
      const status = message.status === "failed"
        ? t("failed")
        : message.status === "uncertain"
        ? t("uncertain")
        : message.status === "sent"
        ? t("sent")
        : t("sending");
      meta.append(
        el(
          "span",
          `message-state${message.status === "failed" ? " failed" : ""}`,
          status,
        ),
      );
      if (message.status === "failed" || message.status === "uncertain") {
        const retry = el("button", "retry-button", t("retry"));
        retry.type = "button";
        retry.addEventListener("click", () => retrySend(chat, message));
        meta.append(retry);
      }
    }
    meta.append(el("time", "", formatTime(message.time)));
    if (
      !message.pending && !message.unsent &&
      !["CHATEVENT", "POSTNOTIFICATION"].includes(message.contentType)
    ) {
      const actions = el("span", "message-actions");
      const reply = el("button", "", t("reply"));
      reply.type = "button";
      reply.addEventListener("click", () => {
        model.reply = {
          id: String(message.id),
          fromName: String(message.fromName || ""),
          text: String(message.text || message.altText || ""),
        };
        updateReply();
        saveComposer();
        $("message-input").focus();
      });
      actions.append(reply);
      const react = el("button", "", t("reaction"));
      react.type = "button";
      react.addEventListener("click", () => {
        const current = column.querySelector(".reaction-picker");
        if (current) {
          current.remove();
          return;
        }
        const picker = el("div", "reaction-picker");
        for (const [type, emoji] of Object.entries(reactionTypes)) {
          const button = el("button", "", emoji);
          button.type = "button";
          button.title = type;
          button.setAttribute("aria-label", type);
          button.addEventListener("click", () => {
            picker.remove();
            command("react", { chat, messageId: String(message.id), type })
              .catch(
                displayError,
              );
          });
          picker.append(button);
        }
        const undo = el("button", "", "×");
        undo.type = "button";
        undo.title = t("undoReaction");
        undo.setAttribute("aria-label", t("undoReaction"));
        undo.addEventListener("click", () => {
          picker.remove();
          command("react", {
            chat,
            messageId: String(message.id),
            type: "UNDO",
          })
            .catch(displayError);
        });
        picker.append(undo);
        column.append(picker);
      });
      actions.append(react);
      if (own) {
        const unsend = el("button", "", t("unsend"));
        unsend.type = "button";
        unsend.addEventListener("click", () => {
          if (confirm(t("confirmUnsend"))) {
            command("unsend", { chat, messageId: String(message.id) }).catch(
              displayError,
            );
          }
        });
        actions.append(unsend);
      }
      meta.append(actions);
    }
    column.append(meta);
    row.append(column);
    return row;
  }
  function renderMessages(mode = "preserve") {
    const list = $("messages"),
      oldHeight = list.scrollHeight,
      oldTop = list.scrollTop;
    const nearBottom = oldHeight - oldTop - list.clientHeight < 140;
    previewObserver.disconnect();
    const rows = model.messages.slice();
    for (const pending of pendingFor()) {
      if (
        !rows.some((m) =>
          m.from === model.account && m.requestId &&
          m.requestId === pending.requestId
        )
      ) {
        rows.push({
          ...pending,
          status: pending.status === "sending" ? "uncertain" : pending.status,
        });
      }
    }
    rows.sort(compareMessages);
    const nodes = [];
    if (!model.noOlder && rows.some((m) => !m.pending)) {
      const older = el("button", "text-button", t("older"));
      older.type = "button";
      older.addEventListener("click", loadOlder);
      nodes.push(older);
    }
    if (!rows.length) {
      nodes.push(
        el(
          "div",
          "loading-message",
          model.loading ? t("loading") : t("noMessages"),
        ),
      );
    }
    let previousDay = "";
    for (const message of rows) {
      const date = new Date(Number(message.time || 0)),
        day = Number.isNaN(date.getTime()) ? "" : date.toDateString();
      if (day && day !== previousDay) {
        nodes.push(
          el(
            "div",
            "day-divider",
            date.toLocaleDateString(english ? "en" : "zh-TW", {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
          ),
        );
        previousDay = day;
      }
      nodes.push(messageNode(message));
    }
    list.replaceChildren(...nodes);
    if (mode === "bottom" || (mode === "follow" && nearBottom)) {
      list.scrollTop = list.scrollHeight;
    } else if (mode === "anchor") {
      list.scrollTop = oldTop + list.scrollHeight - oldHeight;
    } else list.scrollTop = oldTop;
  }
  function updateReply() {
    $("reply-target").hidden = !model.reply;
    $("reply-label").textContent = model.reply
      ? `${t("reply")} · ${
        model.reply.fromName ? `${model.reply.fromName}: ` : ""
      }${model.reply.text || t("message")}`
      : "";
  }
  $("cancel-reply").addEventListener("click", () => {
    model.reply = null;
    updateReply();
    saveComposer();
  });
  function resizeComposer() {
    const input = $("message-input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  }
  function adjustMentions(previous, next) {
    let start = 0;
    while (
      start < previous.length && start < next.length &&
      previous[start] === next[start]
    ) start++;
    let suffix = 0;
    while (
      suffix < previous.length - start && suffix < next.length - start &&
      previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) suffix++;
    const oldEnd = previous.length - suffix,
      delta = next.length - previous.length;
    model.mentions = model.mentions.flatMap((item) => {
      if (oldEnd <= item.start) {
        return [{ ...item, start: item.start + delta, end: item.end + delta }];
      }
      if (start >= item.end) return [item];
      return [];
    });
    model.mentionText = next;
  }
  function updateMentionPicker() {
    const input = $("message-input"), picker = $("mention-picker");
    picker.setAttribute("aria-label", t("mention"));
    if (
      !(model.active.startsWith("c") || model.active.startsWith("r")) ||
      input.selectionStart !== input.selectionEnd
    ) {
      picker.hidden = true;
      return;
    }
    const cursor = input.selectionStart;
    const match = input.value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/u);
    const start = match ? cursor - match[1].length - 1 : -1;
    if (
      !match ||
      model.mentions.some((item) => start >= item.start && start < item.end)
    ) {
      picker.hidden = true;
      return;
    }
    const query = match[1].toLocaleLowerCase();
    const choices = [
      { name: "All", all: true },
      ...model.members.filter((item) =>
        /^u[0-9a-f]{32}$/.test(String(item.mid || "")) && item.name
      ),
    ].filter((item) => String(item.name).toLocaleLowerCase().includes(query))
      .slice(0, 20);
    model.mentionStart = start;
    model.mentionChoices = choices;
    model.mentionIndex = Math.min(
      model.mentionIndex,
      Math.max(0, choices.length - 1),
    );
    picker.replaceChildren(...choices.map((item, index) => {
      const button = el(
        "button",
        `mention-option${index === model.mentionIndex ? " selected" : ""}`,
        `@${item.name}`,
      );
      button.type = "button";
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => chooseMention(index));
      return button;
    }));
    picker.hidden = choices.length === 0;
  }
  function chooseMention(index) {
    const item = model.mentionChoices[index];
    if (!item) return;
    const input = $("message-input"),
      start = model.mentionStart,
      end = input.selectionStart;
    const label = `@${item.name}`, previous = input.value;
    input.setRangeText(`${label} `, start, end, "end");
    adjustMentions(previous, input.value);
    model.mentions.push({
      start,
      end: start + label.length,
      label,
      ...(item.all ? { all: true } : { mid: String(item.mid) }),
    });
    model.mentionIndex = 0;
    $("mention-picker").hidden = true;
    resizeComposer();
    saveComposer();
    input.focus();
  }
  $("message-input").addEventListener("input", () => {
    adjustMentions(model.mentionText, $("message-input").value);
    resizeComposer();
    saveComposer();
    updateMentionPicker();
  });
  $("message-input").addEventListener("click", () => {
    saveComposer();
    updateMentionPicker();
  });
  $("message-input").addEventListener("keyup", (event) => {
    saveComposer();
    if (event.key !== "Escape") updateMentionPicker();
  });
  $("message-input").addEventListener("keydown", (event) => {
    if (!$("mention-picker").hidden && !event.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const n = model.mentionChoices.length;
        model.mentionIndex =
          (model.mentionIndex + (event.key === "ArrowDown" ? 1 : n - 1)) % n;
        updateMentionPicker();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        chooseMention(model.mentionIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        $("mention-picker").hidden = true;
        return;
      }
    }
    if (
      event.key === "Enter" && !event.shiftKey && !event.isComposing &&
      globalThis.matchMedia("(min-width: 701px) and (pointer: fine)").matches
    ) {
      event.preventDefault();
      $("composer").requestSubmit();
    }
  });
  function optimistic(chat, cmd, payload, details) {
    const requestId = uuid();
    return {
      id: `pending-${requestId}`,
      chat,
      from: model.account,
      fromName: model.state?.me?.displayName || "",
      text: details.text || "",
      time: Date.now(),
      contentType: details.contentType || "NONE",
      pending: true,
      status: "sending",
      requestId,
      replyTo: details.replyTo || undefined,
      stickerUrl: details.stickerUrl || undefined,
      fileName: details.fileName || undefined,
      fileSize: details.fileSize,
      cmd,
      payload,
    };
  }
  function sendOptimistic(chat, message) {
    const account = message.from;
    writePending(chat, [
      ...pendingFor(chat, account).filter((m) =>
        m.requestId !== message.requestId
      ),
      message,
    ], account);
    if (model.account === account && model.active === chat) {
      model.messages = mergeMessage(model.messages, message);
      renderMessages("bottom");
    }
    command(message.cmd, {
      chat,
      ...message.payload,
      requestId: message.requestId,
    }).then(() => {
      forgetPending(chat, message.requestId, account);
      if (model.account === account && model.active === chat) {
        model.messages = model.messages.map((m) =>
          m.pending && m.requestId === message.requestId
            ? { ...m, status: "sent" }
            : m
        );
        renderMessages("preserve");
      }
    }).catch((error) => {
      const status = error.ambiguous ? "uncertain" : "failed";
      const rows = pendingFor(chat, account);
      // An echo can prove delivery before a failed socket reply arrives.
      if (!rows.some((m) => m.requestId === message.requestId)) return;
      writePending(
        chat,
        rows.map((m) =>
          m.requestId === message.requestId ? { ...m, status } : m
        ),
        account,
      );
      if (model.account === account && model.active === chat) {
        model.messages = model.messages.map((m) =>
          m.pending && m.requestId === message.requestId ? { ...m, status } : m
        );
        renderMessages("preserve");
      }
      if (model.account === account && (error.refused || error.unsent)) {
        displayError(error);
      }
    });
  }
  function retrySend(chat, message) {
    if (message.status === "uncertain" && !confirm(t("confirmRetry"))) return;
    if (!model.connected) {
      toast(t("offlineAction"));
      return;
    }
    if (message.cmd === "sendFile") {
      const retry = { chat, requestId: message.requestId };
      const file = model.files.get(message.requestId);
      if (file) sendFiles([file], retry);
      else {
        model.retryFile = retry;
        toast(t("reselectFile"));
        $("file-input").click();
      }
      return;
    }
    forgetPending(chat, message.requestId);
    if (model.active === chat) {
      model.messages = model.messages.filter((m) =>
        !(m.pending && m.requestId === message.requestId)
      );
    }
    const fresh = optimistic(chat, message.cmd, message.payload, message);
    sendOptimistic(chat, fresh);
  }
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const chat = model.active, text = $("message-input").value;
    if (!chat || !text.trim()) return;
    if (!model.connected) {
      toast(t("offlineAction"));
      return;
    }
    const reply = model.reply,
      cmd = reply ? "reply" : "send",
      payload = { text };
    if (reply) payload.replyTo = reply.id;
    const mentions = model.mentions.filter((item) =>
      text.slice(item.start, item.end) === item.label
    ).map((item) =>
      item.all
        ? { start: item.start, end: item.end, all: true }
        : { start: item.start, end: item.end, mid: item.mid }
    );
    if (mentions.length) payload.mentions = mentions;
    const message = optimistic(chat, cmd, payload, { text, replyTo: reply });
    sendOptimistic(chat, message);
    $("message-input").value = "";
    model.mentionText = "";
    model.mentions = [];
    $("mention-picker").hidden = true;
    model.reply = null;
    updateReply();
    resizeComposer();
    saveComposer();
    $("message-input").focus();
  });
  async function loadStickers(refresh = false) {
    const content = $("sticker-content");
    content.replaceChildren(el("div", "loading-message", t("loading")));
    try {
      const data = await command("stickers", refresh ? { refresh: true } : {});
      model.stickerPacks = Array.isArray(data?.packages) ? data.packages : [];
      renderStickers();
    } catch (error) {
      content.replaceChildren(
        el("div", "loading-message", error.message || t("genericError")),
      );
    }
  }
  function renderStickers() {
    const content = $("sticker-content"), nodes = [];
    for (const pack of model.stickerPacks || []) {
      nodes.push(el("div", "sticker-pack-title", pack.name || pack.id));
      const grid = el("div", "sticker-grid");
      for (const sticker of Array.isArray(pack.stickers) ? pack.stickers : []) {
        const url = httpsUrl(sticker.url);
        if (!url) continue;
        const button = el("button", "sticker-cell");
        button.type = "button";
        button.setAttribute(
          "aria-label",
          `${String(pack.name || t("stickers"))} ${String(sticker.id || "")}`,
        );
        button.append(safeImage(url, "", ""));
        button.addEventListener("click", () => {
          const chat = model.active;
          if (!chat || !model.connected) {
            toast(t("offlineAction"));
            return;
          }
          const payload = {
            packageId: String(pack.id),
            stickerId: String(sticker.id),
          };
          if (Number(pack.version) > 0) payload.version = Number(pack.version);
          sendOptimistic(
            chat,
            optimistic(chat, "sendSticker", payload, {
              contentType: "STICKER",
              stickerUrl: url,
            }),
          );
          $("sticker-picker").hidden = true;
        });
        grid.append(button);
      }
      nodes.push(grid);
    }
    content.replaceChildren(
      ...(nodes.length
        ? nodes
        : [el("div", "loading-message", t("noStickers"))]),
    );
  }
  $("stickers").addEventListener("click", () => {
    $("sticker-picker").hidden = !$("sticker-picker").hidden;
    if (!$("sticker-picker").hidden) {
      if (model.stickerPacks) renderStickers();
      else loadStickers();
    }
  });
  $("refresh-stickers").addEventListener("click", () => loadStickers(true));
  $("close-stickers").addEventListener("click", () => {
    $("sticker-picker").hidden = true;
  });
  function uploadFile(file, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        "POST",
        `/api/upload?name=${encodeURIComponent(file.name || "image.png")}`,
      );
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          progress(Math.floor(event.loaded / event.total * 100));
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`${t("uploadFailed")} (${xhr.status})`));
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText);
          if (!data.path) throw new Error();
          resolve(String(data.path));
        } catch {
          reject(new Error(t("uploadFailed")));
        }
      });
      xhr.addEventListener("error", () => reject(new Error(t("uploadFailed"))));
      xhr.addEventListener("abort", () => reject(new Error(t("uploadFailed"))));
      xhr.send(file);
    });
  }
  async function sendFiles(files, retry = null) {
    const chat = retry?.chat || model.active, account = model.account;
    if (!chat || !model.connected) {
      toast(t("offlineAction"));
      return;
    }
    for (const file of files) {
      if (file.size > 1073741824) {
        toast(`${file.name}: ${t("tooLarge")}`);
        continue;
      }
      model.uploadCount++;
      $("upload-status").hidden = false;
      $("upload-status").textContent = `${t("uploading")} · ${file.name}`;
      try {
        const path = await uploadFile(file, (percent) => {
          $("upload-status").textContent = `${
            t("uploading")
          } · ${file.name} ${percent}%`;
        });
        if (model.account !== account) throw new Error(t("offlineAction"));
        const type = file.type.startsWith("image/")
          ? "IMAGE"
          : file.type.startsWith("video/")
          ? "VIDEO"
          : "FILE";
        if (retry) {
          forgetPending(chat, retry.requestId);
          if (model.active === chat) {
            model.messages = model.messages.filter((m) =>
              !(m.pending && m.requestId === retry.requestId)
            );
          }
        }
        const message = optimistic(chat, "sendFile", { path }, {
          contentType: type,
          text: file.name,
          fileName: file.name,
          fileSize: file.size,
        });
        model.files.set(message.requestId, file);
        sendOptimistic(chat, message);
      } catch (error) {
        displayError(error);
      } finally {
        model.uploadCount--;
        if (!model.uploadCount) $("upload-status").hidden = true;
      }
    }
  }
  $("attach").addEventListener("click", () => {
    model.retryFile = null;
    $("file-input").click();
  });
  $("file-input").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    const retry = model.retryFile;
    model.retryFile = null;
    if (files.length) sendFiles(retry ? files.slice(0, 1) : files, retry);
  });
  $("file-input").addEventListener("cancel", () => {
    model.retryFile = null;
  });
  $("message-input").addEventListener("paste", (event) => {
    const images = [...(event.clipboardData?.items || [])].filter((item) =>
      item.kind === "file" && item.type.startsWith("image/")
    ).map((item) => item.getAsFile()).filter(Boolean);
    if (images.length) {
      event.preventDefault();
      sendFiles(images);
    }
  });
  $("conversation").addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files") || !model.active) return;
    event.preventDefault();
    model.dragDepth++;
    $("drop-overlay").hidden = false;
  });
  $("conversation").addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });
  $("conversation").addEventListener("dragleave", (event) => {
    event.preventDefault();
    model.dragDepth = Math.max(0, model.dragDepth - 1);
    if (!model.dragDepth) $("drop-overlay").hidden = true;
  });
  $("conversation").addEventListener("drop", (event) => {
    event.preventDefault();
    model.dragDepth = 0;
    $("drop-overlay").hidden = true;
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) sendFiles(files);
  });
  setInterval(renderNotices, 30000);
  beginSession();
}

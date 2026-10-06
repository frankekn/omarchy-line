// Strings.js — 面板的可見字串表：zh-TW 與 en 兩份，t()/fmt()/err() 純函式。
//
// 不用 .pragma library：Qt.include("Strings.js") 在 .pragma library 裡
// （PanelKit.js / EventLog.js）也載得動，node 測試 harness 走同一條路 ——
// pragma 檔不能 .import，所以這份刻意是普通 JS。
//
// 語言一律以參數傳入（"zh" / "en"），模組本身不記狀態：
// QML 端 `Strings.t("k", uiLang)` 的 binding 會在 uiLang 變動時重估，
// node 端直接帶 lang 測。
//
// err() 是 daemon 線上字串的顯示層翻譯：daemon 回的中文錯誤照樣比對原字串
// （wire 值不動），只有畫給使用者看時才換成英文。帶可變尾巴的
// （"同步失敗：…"）走 ERR_PREFIX 前綴表。

var STRINGS = {
  // 登入 / daemon 狀態
  "login.line":            { zh: "登入 LINE", en: "Log in to LINE" },
  "login.retry":           { zh: "再試一次", en: "Try again" },
  "login.qr":              { zh: "掃描登入", en: "Scan to log in" },
  "login.qr.detail":       { zh: "手機 LINE →「加入好友」→ 行動條碼",
                             en: "Phone: LINE → Add friend → QR code" },
  "login.qr.note":         { zh: "掃完會出現一組 PIN，要在手機上輸入。",
                             en: "A PIN appears after the scan — enter it on your phone." },
  "login.pin":             { zh: "手機輸入 PIN", en: "Enter the PIN on your phone" },
  "login.pin.detail":      { zh: "在手機上輸入這組數字", en: "Enter this number on your phone" },
  "login.error":           { zh: "登入失敗", en: "Login failed" },
  "login.idle":            { zh: "尚未登入", en: "Not logged in" },
  "login.starting":        { zh: "啟動中", en: "Starting" },
  "login.idle.detail":     { zh: "按下面的按鈕開始登入，手機要在手邊",
                             en: "Press the button below to log in — have your phone ready" },
  "login.starting.detail": { zh: "daemon 正在啟動…", en: "daemon is starting…" },
  "daemon.offline":        { zh: "DAEMON 離線", en: "DAEMON OFFLINE" },
  "daemon.notRunning":     { zh: "daemon 沒在跑", en: "daemon is not running" },
  "daemon.notRunningHint": { zh: "daemon 沒在跑——點「啟動 daemon」帶起來",
                             en: "daemon is not running — “start daemon” brings it up" },
  "daemon.starting":       { zh: "正在啟動 daemon…", en: "starting daemon…" },
  "daemon.startBtn":       { zh: "啟動 daemon", en: "start daemon" },
  "acc.daemonStart":       { zh: "啟動 LINE daemon", en: "start the LINE daemon" },

  // 清單摘要 / 搜尋
  "summary.unread":     { zh: "%1 個聊天共 %2 則未讀", en: "%1 chats, %2 unread" },
  "summary.quiet":      { zh: "%1 個聊天，沒有待處理", en: "%1 chats, nothing waiting" },
  "search.placeholder": { zh: "搜尋聊天室…", en: "Search chats…" },
  "chat.pick":          { zh: "選一個聊天室", en: "Pick a chat" },
  "chat.pickLeft":      { zh: "左邊選一個聊天室", en: "Pick a chat on the left" },
  "chat.loading":       { zh: "載入中…", en: "Loading…" },
  "chat.noHistory":     { zh: "這個聊天室讀不到歷史訊息", en: "Couldn't load this chat's history" },
  "chat.unreadDivider": { zh: "未讀訊息", en: "Unread" },

  // 訊息列
  "msg.edited":        { zh: "已編輯", en: "edited" },
  "msg.unsent":        { zh: "已收回訊息", en: "Message unsent" },
  "image":             { zh: "圖片", en: "Image" },
  "image.retry":       { zh: "[圖片載入失敗，點此重試]",
                         en: "[image failed to load — tap to retry]" },
  "reply":             { zh: "回覆", en: "Reply" },
  "reply.quote":       { zh: "回覆 %1", en: "Reply %1" },
  "reply.missOrigin":  { zh: "原訊息不在這一頁裡，往上捲可以載入更舊的",
                         en: "The original isn't in this page — scroll up to load older" },

  // 右鍵選單 / 複製 / 連結
  "ctx.copy":          { zh: "複製訊息", en: "Copy message" },
  "ctx.copyLink":      { zh: "複製連結", en: "Copy link" },
  "ctx.openLink":      { zh: "開啟連結", en: "Open link" },
  "ctx.unsend":        { zh: "收回", en: "Unsend" },
  "menu.hide":         { zh: "隱藏聊天", en: "Hide chat" },
  "menu.unhide":       { zh: "取消隱藏", en: "Unhide" },
  "copy.noWlcopy":     { zh: "複製失敗：系統裡找不到 wl-copy",
                         en: "Copy failed: wl-copy not found" },
  "link.bad":          { zh: "這個連結打不開", en: "Can't open this link" },

  // 輸入列 / 傳送
  "send.placeholder":  { zh: "回訊息，Enter 送出，Shift+Enter 換行",
                         en: "Reply — Enter sends, Shift+Enter newline" },
  "send.placeholder2": { zh: "（/file <路徑> 傳檔案，Ctrl+V 送剪貼簿的圖）",
                         en: " (/file <path> sends a file, Ctrl+V sends a clipboard image)" },
  "send.sending":      { zh: "傳送中…", en: "Sending…" },
  "send.failed":       { zh: "傳送失敗", en: "Send failed" },
  "send.failedKept":   { zh: "傳送失敗；內容保留在這裡", en: "Send failed; the text stays here" },
  "send.fileFailed":   { zh: "傳送檔案失敗", en: "File send failed" },
  "send.draftWait":    { zh: "前一則正在等待草稿載入",
                         en: "The previous send is waiting on its draft load" },
  "send.afterDraft":   { zh: "草稿載入後傳送", en: "Will send once drafts load" },
  "picker.afterDraft": { zh: "草稿載入後開啟選檔", en: "Will open the picker once drafts load" },
  "picker.title":      { zh: "選擇要傳送的檔案", en: "Choose a file to send" },
  "zenity.missing":    { zh: "找不到 zenity，請 sudo pacman -S zenity",
                         en: "zenity not found — sudo pacman -S zenity" },

  // 斷線 / 同步
  "drop.msg":   { zh: "連線中斷，請確認訊息是否送出",
                  en: "Connection dropped — check whether the message went out" },
  "drop.img":   { zh: "連線中斷，圖片尚未送出",
                  en: "Connection dropped — the image wasn't sent" },
  "sync":       { zh: "同步", en: "Sync" },
  "syncing":    { zh: "同步中…", en: "Syncing…" },
  "synced":     { zh: "已同步 %1", en: "Synced %1" },
  "logout":     { zh: "登出", en: "Log out" },

  // 草稿
  "draft.notSaved":   { zh: "草稿尚未保存：%1", en: "Draft not saved: %1" },
  "draft.unreadable": { zh: "草稿檔無法讀取；本次不會覆寫",
                        en: "Draft file unreadable; leaving it untouched this run" },
  "draft.verCap":     { zh: "草稿版本已達上限；本次不會覆寫",
                        en: "Draft version cap reached; leaving it untouched this run" },

  // 貼圖 / 燈箱 / 無障礙標籤
  "sticker.scrollL": { zh: "往左捲貼圖包分頁", en: "Scroll sticker packs left" },
  "sticker.scrollR": { zh: "往右捲貼圖包分頁", en: "Scroll sticker packs right" },
  "sticker.pack":    { zh: "貼圖包 %1", en: "Pack %1" },
  "loading":         { zh: "載入中…", en: "Loading…" },
  "draft.writeFail": { zh: "寫入失敗", en: "write failed" },
  "wire.clipExpired":{ zh: "剪貼簿暫存已失效", en: "Clipboard staging expired" },
  "sticker.loading": { zh: "載入中…", en: "Loading…" },
  "sticker.none":    { zh: "這個帳號沒有貼圖包", en: "This account has no sticker packs" },
  "sticker.packFail":{ zh: "這個貼圖包這次讀不到，按 ⟳ 再試一次",
                       en: "This pack couldn't be read this time — hit ⟳ to retry" },
  "lightbox.hint":   { zh: "滾輪縮放 · 拖曳平移 · ←/→ 換圖 · o 用外部程式開 · Esc 關閉",
                       en: "Wheel zooms · drag pans · ←/→ images · o opens externally · Esc closes" },
  "label.scroll":    { zh: "捲動 %1", en: "Scroll %1" },
  "label.history":   { zh: "讀取 %1", en: "Read %1" },
  "acc.scroll":      { zh: "捲動速度：%1", en: "Scroll speed: %1" },
  "acc.history":     { zh: "讀取筆數：%1", en: "History count: %1" },
  "acc.placement":   { zh: "面板位置：%1", en: "Panel position: %1" },
  "acc.sync":        { zh: "同步", en: "Sync" },
  "acc.logout":      { zh: "登出", en: "Log out" },
  "switch.to":       { zh: "切換到「%1」", en: "Switch to %1" },
  "sep.or":          { zh: " 或 ", en: " or " },
  "sep.semi":        { zh: "；", en: "; " },
  "sep.colon":       { zh: "：", en: ": " },
  "me":              { zh: "我", en: "me" },

  // PanelKit.js —— 面板 helper 的產出字
  "place.app":           { zh: "視窗", en: "Window" },
  "place.center":        { zh: "置中", en: "Centered" },
  "place.bar":           { zh: "貼齊 bar", en: "Below the bar" },
  "hidden.row":          { zh: "已隱藏 · %1", en: "Hidden · %1" },
  "hidden.only":         { zh: "已隱藏", en: "Hidden" },
  "media.expired":       { zh: "（已過期）", en: " (expired)" },
  "media.unsent":        { zh: "（已收回）", en: " (unsent)" },
  "ago.now":             { zh: "剛剛", en: "now" },
  "ago.min":             { zh: "%1 分", en: "%1 min" },
  "ago.hour":            { zh: "%1 時", en: "%1 h" },
  "ago.day":             { zh: "%1 天", en: "%1 d" },
  "ct.e2eeFail":         { zh: "[E2EE 解密失敗]", en: "[E2EE decryption failed]" },
  "ct.sticker":          { zh: "[貼圖]", en: "[Sticker]" },
  "ct.nonText":          { zh: "非文字", en: "non-text" },
  "mention.all":         { zh: "全部", en: "All" },
  "list.partial":        { zh: "目前顯示 %1 個聊天室，尚有聊天室未載入",
                           en: "Showing %1 loaded chats — more exist on the server" },
  "list.partialSearch":  { zh: "；搜尋範圍僅限已載入資料",
                           en: "; search covers loaded chats only" },
  "link.down":           { zh: "LINE 連線中斷，重連中", en: "LINE link down, reconnecting" },
  "link.downAgo":        { zh: "LINE 連線中斷，重連中（%1）",
                           en: "LINE link down, reconnecting (%1 ago)" },
  "link.reconnectHint":  { zh: "，點此立即重連", en: " — tap to reconnect now" },
  "link.restricted":     { zh: "LINE 限制了這個帳號（%1），已暫停連線",
                           en: "LINE restricted this account (%1); connection paused" },
  "link.restrictedHint": { zh: "，點此重試", en: " — tap to retry" },
  "list.stale":          { zh: "LINE 清單可能過期", en: "Chat list may be stale" },
  "list.staleAgo":       { zh: "LINE 清單可能過期（最後更新 %1前）",
                           en: "Chat list may be stale (last update %1 ago)" },
  "list.staleHint":      { zh: "，點此立即重連", en: " — tap to reconnect" },
  "login.tokenExpired":  { zh: "登入已過期，請重新掃描", en: "Login expired — scan again" },
  "login.network":       { zh: "連不上 LINE，稍後重試", en: "Can't reach LINE — try again later" },
  "login.restricted":    { zh: "LINE 限制了這個帳號，稍後再登入", en: "LINE restricted this account — log in later" },
  "members.none":        { zh: "讀不到成員名單", en: "Couldn't load the member list" },
  "err.stickers":        { zh: "貼圖清單讀不到", en: "Couldn't load stickers" },
  "err.sync":            { zh: "同步失敗", en: "Sync failed" },
  "err.download":        { zh: "下載失敗", en: "Download failed" },
  "err.hide":            { zh: "隱藏失敗", en: "Hide failed" },
  "err.unhide":          { zh: "取消隱藏失敗", en: "Unhide failed" },
  "err.generic":         { zh: "失敗", en: "Failed" },

  // EventLog.js
  "read.all":    { zh: "已讀", en: "Read" },
  "read.n":      { zh: "已讀 %1", en: "Read %1" },
  "sys.post":    { zh: "貼文通知", en: "Post notification" },
  "sys.event":   { zh: "系統事件", en: "System event" },
  "notif.msg":   { zh: "訊息", en: "message" },
  "day.today":   { zh: "今天", en: "Today" },
  "day.yesterday":{ zh: "昨天", en: "Yesterday" },
  "day.md":      { zh: "%1月%2日", en: "%1/%2" },
  "day.ymd":     { zh: "%1年%2月%3日", en: "%2/%3/%1" },
};

// daemon 線上（socket 錯誤、history 文字 fallback）的中文原字串 —— 英文介面
// 顯示時才翻，比對 wire 值時仍用原文。
var WIRE_EN = {
  "LINE 沒有回應，稍後再試": "LINE isn't responding — try again later",
  "下載失敗": "Download failed",
  "縮圖下載失敗": "Thumbnail download failed",
  "縮圖不可用": "Thumbnail unavailable",
  "不支援的聊天室": "Unsupported chat",
  "不支援的表情": "Unsupported reaction",
  "不明錯誤": "Unknown error",
  "[付款]": "[Payment]",
  "[位置]": "[Location]",
  "[連結]": "[Link]",
  "[音樂]": "[Music]",
  "[通話]": "[Call]",
  "[聯絡資訊]": "[Contact]",
  "[禮物]": "[Gift]",
  "[新訊息]": "[New message]",
  "[檔案]": "[File]",
  "檔案": "File",
  "[圖片]": "[Image]",
  "圖片": "Image",
  "[影片]": "[Video]",
  "影片": "Video",
  "[語音]": "[Voice]",
  "[貼圖]": "[Sticker]",
  "[貼文通知]": "[Post]",
  "[系統事件]": "[System event]",
  "[E2EE 解密失敗]": "[E2EE decryption failed]",
  "傳送失敗": "Send failed",
  "剪貼簿暫存已失效": "Clipboard staging expired",
  "剪貼簿裡沒有圖片": "No image on the clipboard",
  "剪貼簿的圖片太大（超過 20 MB）": "Clipboard image too large (over 20 MB)",
  "只能收回自己傳的訊息": "You can only unsend your own messages",
  "回覆無法編碼": "The reply couldn't be encoded",
  "圖片下載失敗": "Image download failed",
  "多人聊天室（room）拿不到成員名單": "Rooms don't expose a member list",
  "多人聊天室（room）暫不支援傳檔案": "Rooms can't take files",
  "尚未登入": "Not logged in",
  "已收回訊息": "Message unsent",
  "我": "me",
  "找不到檔案": "File not found",
  "不是一般檔案": "Not a regular file",
  "找不到訊息": "Message not found",
  "檔案已過期（LINE 只保留 7 天）": "File expired (LINE keeps files for 7 days)",
  "檔案已過期或已被刪除": "File expired or deleted",
  "沒有指定是哪一間聊天室": "No chat specified",
  "沒有指定要回覆哪一則訊息": "No message specified to reply to",
  "沒有這個聊天室的游標": "No cursor for this chat",
  "登入中，請稍候": "Logging in — hold on",
  "登入已過期，請重新掃描": "Login expired — scan again",
  "登入狀態已變更，請再試一次": "Login state changed — try again",
  "訊息 id 不對": "Bad message id",
  "訊息不在快取裡": "Message not in cache",
  "訊息不在這個聊天室": "Message not in this chat",
  "訊息已收回": "Message already unsent",
  "貼圖清單格式不對": "Sticker list malformed",
  "貼圖編號不對": "Bad sticker id",
  "這不是群組，沒有成員名單": "Not a group — no member list",
  "這個聊天室沒有成員名單": "This chat has no member list",
  "這個貼圖包不在你的貼圖清單裡": "That pack isn't in your sticker list",
  "連不上 LINE，稍後重試": "Can't reach LINE — try again later",
  "找不到 wl-paste，請 sudo pacman -S wl-clipboard":
    "wl-paste not found — sudo pacman -S wl-clipboard",
  "連不上 Wayland，請 systemctl --user restart enil":
    "Can't reach Wayland — systemctl --user restart enil",
  "讀不到剪貼簿": "Couldn't read the clipboard",
  "圖片太大（超過 20 MB）": "Image too large (over 20 MB)",
  "影片太大（超過 1 GB）": "Video too large (over 1 GB)",
  "檔案太大（超過 1 GB）": "File too large (over 1 GB)",
  "媒體請求過多，請稍後再試": "Too many media requests — try again shortly",
};

// 帶可變尾巴的線上字串：前綴命中就翻前綴，尾巴再遞迴過一次 err()。
var WIRE_PREFIX = [
  ["同步失敗：", "Sync failed: "],
  ["貼圖清單讀不到：", "Couldn't load stickers: "],
  ["剪貼簿的圖片格式不支援: ", "Unsupported clipboard image type: "],
  ["找不到檔案: ", "File not found: "],
  ["不是一般檔案: ", "Not a regular file: "],
];

// 可以出現在字串中段的安全 token（多字、不會撞到一般中文名詞）——
// 例如聊天室清單預覽 "已隱藏 · 我： [圖片]"。裸 "我" 不進這張表：
// 會把使用者自己打的「我們家」吃掉，只能靠 WIRE_EN 的精確比對。
var WIRE_TOKENS = [
  ["已隱藏 · ", "Hidden · "],
  ["我: ", "me: "],
  ["（已過期）", " (expired)"],
  ["（已收回）", " (unsent)"],
  ["（已編輯）", " (edited)"],
  // 括號包住的都是 daemon 佔位字，出現在組合字串中段也安全替換。
  ["[E2EE 解密失敗]", "[E2EE decryption failed]"],
  ["[已收回訊息]", "[message unsent]"],
  ["已收回訊息", "Message unsent"],
  ["[貼文通知]", "[Post]"],
  ["[系統事件]", "[System event]"],
  ["[新訊息]", "[New message]"],
  ["[貼圖]", "[Sticker]"],
  ["[圖片]", "[Image]"],
  ["[影片]", "[Video]"],
  ["[語音]", "[Voice]"],
  ["[檔案]", "[File]"],
  ["[位置]", "[Location]"],
  ["[連結]", "[Link]"],
  ["[音樂]", "[Music]"],
  ["[通話]", "[Call]"],
  ["[聯絡資訊]", "[Contact]"],
  ["[付款]", "[Payment]"],
  ["[禮物]", "[Gift]"],
];

// "繁體中文" | "English" | "System"（看 localeName）→ "zh" | "en"
function normalizeLang(raw, localeName) {
  if (raw === "en" || raw === "English") return "en";
  if (raw === "zh" || raw === "繁體中文") return "zh";
  var loc = String(localeName || "");
  return loc.indexOf("zh") === 0 ? "zh" : "en";
}

function t(key, lang) {
  var row = STRINGS[key];
  if (!row) return key;
  var v = row[lang];
  return v === undefined ? (row.zh === undefined ? key : row.zh) : v;
}

// fmt("read.n", lang, 3) —— %1..%9 位置插值。
function fmt(key, lang) {
  var s = t(key, lang);
  for (var i = 2; i < arguments.length; i++)
    s = s.split("%" + (i - 1)).join(String(arguments[i]));
  return s;
}

// daemon 回來的中文錯誤 / 佔位字 → 依顯示語言換英文；zh 介面原樣回傳。
// 精確比對 → 前綴（尾巴遞迴再過一次）→ 中段 token 掃過。
function err(text, lang) {
  if (lang !== "en") return text;
  var s = String(text == null ? "" : text);
  if (s.length === 0) return s;
  var hit = WIRE_EN[s];
  if (hit !== undefined) return hit;
  for (var i = 0; i < WIRE_PREFIX.length; i++) {
    var p = WIRE_PREFIX[i];
    if (s.indexOf(p[0]) === 0) return p[1] + err(s.slice(p[0].length), lang);
  }
  for (var j = 0; j < WIRE_TOKENS.length; j++)
    s = s.split(WIRE_TOKENS[j][0]).join(WIRE_TOKENS[j][1]);
  return s;
}

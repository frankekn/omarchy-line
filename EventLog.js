.pragma library

// EventLog.js — 訊息清單的事件套用與唯讀投影。整份都是純函式：
// 不碰 socket、不碰 root，要的上下文（自己的 mid、讀者總數）由呼叫端傳進來。
// Panel.qml 只留一行轉接；測試直接載入這個檔案，跟 DraftStore.js 同一套做法。

// 目前頁面跟事件環的對帳：同一個 bootId 裡 seq 嚴格遞增，只取比 watermark
// 新的；bootId 換了（daemon 重啟）整批都是新一輪，watermark 歸零重算。
// reload 代表「中間有洞補不回來」，呼叫端要整頁重抓。
function eventsSince(events, bootId, seenBootId, seenSeq) {
  var live = Array.isArray(events)
  var list = live ? events : []
  var first = String(seenBootId || "").length === 0
  var restarted = String(bootId || "") !== String(seenBootId || "")
  // 重啟＝seq 從 1 重來，舊的 watermark 只會把新的那一輪整批擋掉。
  var seen = restarted ? 0 : (Number(seenSeq) || 0)
  var out = []
  var top = seen
  var oldest = -1
  for (var i = 0; i < list.length; i++) {
    var ev = list[i]
    // 沒有 seq 的東西沒辦法定位在這一輪的哪裡，寧可不吃。
    if (!ev || typeof ev.seq !== "number" || !isFinite(ev.seq)) continue
    if (oldest < 0 || ev.seq < oldest) oldest = ev.seq
    if (ev.seq > top) top = ev.seq
    if (ev.seq > seen && !first) out.push(ev)
  }
  // 緩衝區裡最舊的一筆都比 watermark 的下一號還新 = 中間那幾筆被擠掉了。
  // 第一次讀不算缺口（那是「還沒開始追」，歷史本來就會抓一次）。
  return { list: out, seq: top, live: live,
           reload: !first && (restarted || (seen > 0 && oldest > seen + 1)) }
}

// patch 裡值是 undefined 的鍵是「刪掉」不是「設成 undefined」—— 契約是
// 「沒值的欄位整個不存在」，留一個 undefined key 會讓物件 diff 以為有改動。
function withFields(m, patch) {
  var out = {}
  for (var k in m) out[k] = m[k]
  for (var f in patch) {
    if (patch[f] === undefined) delete out[f]
    else out[f] = patch[f]
  }
  return out
}

// 事件送來的新訊息。已經在清單裡的（自己送的 LINE 會推回來、同一份 state 讀到兩次）
// 只換掉不新增；還在等回覆的那顆樂觀泡泡則被真的那則取代 —— 文字一樣、id 不一樣，
// 不取代的話畫面上會有兩句一模一樣的話。
function mergeMessage(list, m, myMid) {
  if (!m || String(m.id || "").length === 0) return list
  var id = String(m.id)
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id || "") !== id) continue
    var dup = list.slice()
    dup[i] = m
    return dup
  }
  if (String(m.from || "") === myMid) {
    var requestId = String(m.requestId || "")
    if (requestId) {
      for (var ri = 0; ri < list.length; ri++) {
        if (!list[ri].pending || String(list[ri].requestId || "") !== requestId) continue
        var exact = list.slice()
        exact[ri] = m
        return exact
      }
    }
    // 舊 daemon 或其他裝置的訊息沒有 token；只配同樣沒有 token 的舊泡泡。
    for (var j = 0; j < list.length; j++) {
      // Failed local copies remain available for recovery and must never be
      // consumed as the echo of a later successful retry.
      if (!list[j].pending || list[j].failed === true) continue
      if (String(list[j].requestId || "")) continue
      if (String(list[j].text || "") !== String(m.text || "")) continue
      var swap = list.slice()
      swap[j] = m
      return swap
    }
  }
  return list.concat([m])
}

// 編輯跟新訊息的差別就在這裡：清單裡沒有這則（不在這一頁、被收回過）就什麼都
// 不做，不能像 mergeMessage 那樣補到尾端 —— 一則舊訊息被編輯，把它插在最後面
// 等於畫出一個順序錯的假新訊息。
function applyEdit(list, m) {
  if (!m || String(m.id || "").length === 0) return list
  var id = String(m.id)
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id || "") !== id) continue
    var out = list.slice()
    out[i] = m
    return out
  }
  return list
}

// daemon 本地庫先回了舊頁、對帳後發現 LINE 說的不一樣時送來的頭版。
// 它是那個區段的權威：同 id 換新；清單裡它沒涵蓋的（往上翻到的舊頁、
// 還沒送出的 pending 泡泡）原樣保留，靠 (time, id) 併回正確位置 ——
// 不整份替換，使用者捲上去讀的東西就不會被抽走。
function applyHistory(list, fresh) {
  if (!Array.isArray(fresh) || fresh.length === 0) return list
  var freshIds = {}
  for (var i = 0; i < fresh.length; i++) freshIds[String(fresh[i].id || "")] = true
  // 本地才有的東西（送出中、送失敗留下的泡泡）永遠不會出現在 wire 頁面裡，
  // 所以先抽出來、最後放尾巴 —— 對帳換頁不能把它們連帶抹掉。其餘沒被這一頁
  // 涵蓋的（往上翻到的舊頁）也保留，靠 (time, id) 併回各自的位置。
  var pending = []
  var kept = []
  for (var k = 0; k < list.length; k++) {
    var m = list[k]
    if (freshIds[String(m.id || "")]) continue
    if (m.pending || m.failed) pending.push(m)
    else kept.push(m)
  }
  var merged = kept.concat(fresh)
  merged.sort(function (a, b) {
    var ta = Number(a.time || 0), tb = Number(b.time || 0)
    if (ta !== tb) return ta - tb
    // 同毫秒的平手用訊息 id 定序：LINE id 是 i64，數字會溢出、字串會把
    // "123" 排在 "45" 前面 —— 先比長度（長者大）再比字典序才是對的次序。
    var ia = String(a.id || ""), ib = String(b.id || "")
    if (ia.length !== ib.length) return ia.length - ib.length
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
  return merged.concat(pending)
}

// 已讀。事件只說「這個人讀到 upTo」，位置就從清單裡找：upTo（含）以前自己傳的
// 都被他讀了。找不到 upTo 就什麼都不做 —— 比它舊的本來就不在這一頁上，比它新的
// 是還沒收到；寧可少算，也不要把沒人讀的畫成已讀。
function applyRead(list, upTo, by, myMid, readerCount) {
  var target = String(upTo || "")
  var at = -1
  for (var i = 0; i < list.length; i++)
    if (String(list[i].id || "") === target) { at = i; break }
  if (at < 0) return list
  var who = String(by || "")
  // op 40 的自我游標是「我讀了別人的」，不是「誰讀了我送的」。把它當讀者計算，
  // 1:1 就會把自己的泡泡畫成已讀。它擋掉的是：手機上讀了、本端 markRead 的
  // echo、事件環重放回來的舊自我事件。對方真讀（op 55）與 daemon history 帶的
  // readBy 都不會以自己為 by，所以不受影響。
  if (who === String(myMid || "")) return list
  var out = list
  for (var j = at; j >= 0; j--) {
    var m = out[j]
    if (String(m.from || "") !== myMid || m.failed === true) continue
    // LINE 同一個人會重複回報，所以記的是「誰讀過」而不是一個數字 —— 只加數字的話
    // 對方每讀一次群組就多一個人。
    var seen = Array.isArray(m.readSeen) ? m.readSeen : []
    if (who.length > 0 && seen.indexOf(who) >= 0) continue
    var next = who.length > 0 ? seen.concat([who]) : seen
    // daemon 開聊天室時算過一次（那一份不知道是誰讀的），兩邊取大的：人重疊
    // 只會讓數字少算，而少算是可以被下一次載入歷史修好的，多算不是。
    var count = Math.max(Number((m.readBy || {}).count || 0), next.length)
    if (count <= 0) continue
    if (out === list) out = list.slice()
    out[j] = withFields(m, { readSeen: next,
      readBy: { count: count, all: readerCount > 0 && count >= readerCount } })
  }
  return out
}

// 表情：事件給的是整串新的（不是差異），直接換掉就好。空的就把欄位拿掉，
// 跟契約的「沒值的欄位整個不存在」對齊。
function applyReaction(list, id, rows) {
  var target = String(id || "")
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id || "") !== target) continue
    var bar = Array.isArray(rows) ? rows : []
    var out = list.slice()
    out[i] = withFields(list[i], { reactions: bar.length > 0 ? bar : undefined })
    return out
  }
  return list
}

// 收回：daemon 對歷史訊息做的那一套，這裡照做一次。少拿掉一樣，畫面上就會是
// 一張照常顯示的貼圖旁邊寫著它已經被收回。mentions 也一定要拿掉 —— 位移是照
// 原本那句話算的，套在「已收回訊息」上會把顏色塗在別的字上。
function applyUnsend(list, id) {
  var target = String(id || "")
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id || "") !== target) continue
    var out = list.slice()
    out[i] = withFields(list[i], {
      text: "已收回訊息", unsent: true, mediaState: "unsent", hasMedia: false,
      mentions: undefined, reactions: undefined, readBy: undefined, readSeen: undefined,
      mediaPath: undefined, stickerUrl: undefined, flexImages: undefined, altText: undefined
    })
    return out
  }
  return list
}

// 自己傳的訊息底下那行小字。什麼都不知道的時候契約是「整個欄位不存在」，
// 那就什麼都不畫 —— 不能把「不知道」畫成「沒人讀」。
function readText(m, myMid, tr) {
  if (!m || m.failed === true || String(m.from || "") !== myMid) return ""
  var r = m.readBy
  if (!r) return ""
  var n = Number(r.count || 0)
  if (!(n > 0)) return ""
  return r.all === true ? tr("read.all") : tr("read.n", n)
}

// LINE 那六個表情的圖是它自己的素材，這裡挑意思最接近的 emoji —— 名字
//（NICE／LOVE／…）才是契約，emoji 只是畫面。認不得的型別就把名字原樣印出來：
// LINE 之後多加一種，畫面上會是那個名字，不會是一個看不懂的空白。
function reactionEmoji(type) {
  var t = String(type || "")
  if (t === "NICE") return "👍"
  if (t === "LOVE") return "❤️"
  if (t === "FUN") return "😆"
  if (t === "AMAZING") return "😲"
  if (t === "SAD") return "😢"
  if (t === "OMG") return "😱"
  return t.length > 0 ? t : "？"
}

// 自己在這一則上選的那個表情，沒有就是空字串。一個人只會有一個 —— 契約寫死的。
function myReaction(m) {
  var rows = m && Array.isArray(m.reactions) ? m.reactions : []
  for (var i = 0; i < rows.length; i++)
    if (rows[i] && rows[i].mine === true) return String(rows[i].type || "")
  return ""
}

function isSystemEvent(m) {
  return m.contentType === "CHATEVENT" || m.contentType === "POSTNOTIFICATION"
}

// 這兩種事件的 text 幾乎都是空的，走 bodyText 會印出 [CHATEVENT] 這種內部代號。
function systemEventText(m, tr) {
  var label = tr(m.contentType === "POSTNOTIFICATION" ? "sys.post" : "sys.event")
  // LINE 常把事件名本身塞進 text（text === "POSTNOTIFICATION"），
  // 照印就變成聊天視窗裡的英文代碼，所以只有真的人話才用 text。
  var t = m.text || ""
  if (t.length === 0 || t.toUpperCase() === (m.contentType || "")) return label
  return t
}

// 這一則能不能回覆／加表情／收回。系統事件沒有一則訊息可以指，樂觀泡泡的 id 是
// 面板自己編的（daemon 不認得），已經收回的沒有東西可以再收回一次。
function canActOn(m) {
  if (!m || m.pending === true) return false
  if (String(m.id || "").length === 0) return false
  if (m.unsent === true || isSystemEvent(m)) return false
  return true
}

function oneLine(t) {
  return String(t || "").replace(/\s+/g, " ").trim()
}

function quoteText(r, tr) {
  if (!r) return ""
  var name = String(r.fromName || "")
  var body = oneLine(String(r.text || ""))
  if (body.length === 0) body = tr("notif.msg")
  return name.length > 0 ? name + tr("sep.colon") + body : body
}

// 分隔線的「天」：訊息進清單時就把 day 蓋上去，delegate 就不用每列各算一次。
// 已經有 day 的不重蓋 —— state 重讀回來的那份清單可能帶著不同基準的舊戳。
function withDay(list) {
  var out = Array.isArray(list) ? list : []
  for (var i = 0; i < out.length; i++)
    if (out[i] && out[i].day === undefined) out[i].day = String(dayStart(out[i].time))
  return out
}

function dayStart(ms) {
  var d = new Date(Number(ms || 0))
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 以 nowMs 為基準，跨午夜時 30 秒的計時器會讓「今天」自己往前挪。
// 「昨天」不用 nowMs - 86400000 直接比：夏令時間那兩天差的不是 24 小時，
// 先歸到今天凌晨再退 12 小時，落在哪一天都還是昨天。
function dayLabel(ms, nowMs, tr) {
  var day = dayStart(ms)
  var today = dayStart(nowMs)
  if (day === today) return tr("day.today")
  if (day === dayStart(today - 43200000)) return tr("day.yesterday")
  var d = new Date(day)
  var md = tr("day.md", d.getMonth() + 1, d.getDate())
  // 跨年之後只寫「1月3日」會讓人以為是今年的：不同年就把年份補上。
  return d.getFullYear() === new Date(today).getFullYear()
    ? md
    : tr("day.ymd", d.getFullYear(), d.getMonth() + 1, d.getDate())
}

// 未讀分隔線畫在哪一則之上。daemon 只給得到「這間還有幾則未讀」，所以從最後一則
// 往回數，只算別人說的（自己送的、系統事件都不進未讀數）。數不滿就回 -1 ——
// 這一頁還沒讀到那麼舊的地方，寧可不畫也不要畫在錯的位置。
function firstUnreadIndex(messages, unread, myMid) {
  var list = Array.isArray(messages) ? messages : []
  var left = Number(unread) || 0
  if (left <= 0) return -1
  for (var i = list.length - 1; i >= 0; i--) {
    var m = list[i]
    if (!m || m.pending || isSystemEvent(m)) continue
    if (String(m.from || "") === myMid) continue
    left--
    if (left === 0) return i
  }
  return -1
}

// 縮圖路徑有兩個來源：daemon 已經快取過的那則隨列帶著 mediaPath；畫面上後來才
// 抓到的放在面板的 previewPaths（id → 路徑），不寫回列裡 —— 寫回去等於每張縮圖
// 都整份換一次模型，ListView 每換一次就先清空再放回位置，對話跟著上下跳。
// 已經打不開的（過期、收回）一律沒有縮圖，那一則該改畫成附件那一行。
function previewPathFor(m, paths) {
  if (!m) return ""
  if (m.mediaPath) return String(m.mediaPath)
  if (!m.hasMedia || (m.mediaState !== undefined && m.mediaState !== "ok")) return ""
  return paths && paths[String(m.id)] ? String(paths[String(m.id)]) : ""
}

function withPreviewPaths(rows, paths) {
  return (Array.isArray(rows) ? rows : []).map(function(m) {
    var path = previewPathFor(m, paths)
    return !m || m.mediaPath || !path ? m : withFields(m, { mediaPath: path })
  })
}

// 歷史頁不帶縮圖路徑：daemon 換頁時不抓媒體。畫面上同一則列裡已經有路徑就沿用，
// 不然每次重抓，每張圖都先縮回一行「載入中…」。
function keepPreviewPaths(shown, rows) {
  var paths = {}
  var list = Array.isArray(shown) ? shown : []
  for (var i = 0; i < list.length; i++)
    if (list[i] && list[i].mediaPath) paths[String(list[i].id)] = list[i].mediaPath
  return withPreviewPaths(rows, paths)
}

// 兩份清單畫出來會不會一樣。整列比（鍵排序過的 JSON）而不是挑欄位：泡泡讀的欄位
// 很多（表情、已讀、引言、大頭貼……），挑漏一個就會把真的改動當成沒變。
function sameRows(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (var i = 0; i < a.length; i++)
    if (canonicalJson(a[i]) !== canonicalJson(b[i])) return false
  return true
}

function canonicalJson(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]"
  if (v === null || typeof v !== "object") return v === undefined ? "null" : JSON.stringify(v)
  var keys = Object.keys(v).filter(function(k) { return v[k] !== undefined }).sort()
  return "{" + keys.map(function(k) {
    return JSON.stringify(k) + ":" + canonicalJson(v[k])
  }).join(",") + "}"
}

// 送失敗留下的泡泡要併回新抓的歷史裡 —— 不然重抓一次，畫面上那則「沒送出去」
// 就消失了，但它根本還沒送出去。同 id 的去重在上游 remember 那邊做過了。
function mergeFailedMessages(failed, list) {
  var delivered = Array.isArray(list) ? list.slice() : []
  if (!Array.isArray(failed) || failed.length === 0) return delivered
  var merged = delivered.concat(failed)
  merged.sort(function(a, b) { return Number(a.time || 0) - Number(b.time || 0) })
  return merged
}

// 送失敗的訊息記一份在面板這邊（聊天室 -> 最近幾則），重抓歷史時併回去。
// Recovery state is deliberately bounded: at most five failures in each
// of the twenty most recently touched chats. null = 沒有該記的東西。
function recordFailure(byChat, chat, message) {
  var mid = String(chat || "")
  if (!mid || !message) return null
  var next = Object.assign({}, byChat)
  var rows = Array.isArray(next[mid]) ? next[mid].filter(function(m) {
    return String(m.id || "") !== String(message.id || "")
  }) : []
  rows.push(message)
  delete next[mid]
  next[mid] = rows.slice(-5)
  var chatsWithFailures = Object.keys(next)
  while (chatsWithFailures.length > 20) {
    delete next[chatsWithFailures.shift()]
  }
  return next
}

// 這一則旁邊要不要掛大頭貼：群組裡（isGroup 由呼叫端判定）、不是自己講的、
// 而且是同一個人連著講的那一串的第一則。1:1 只有兩個人，每一則都掛一張臉
// 只是噪音。
function showAvatarAt(list, i, isGroup, myMid) {
  if (!isGroup) return false
  if (!list || i < 0 || i >= list.length) return false
  var m = list[i]
  if (!m || isSystemEvent(m)) return false
  var from = String(m.from || "")
  if (from.length === 0 || from === myMid) return false
  for (var j = i - 1; j >= 0; j--) {
    var p = list[j]
    // 中間夾一則入群通知，不該把同一個人講的那一串切成兩段。
    if (!p || isSystemEvent(p)) continue
    // 隔了一天就重新算一串：日期分隔線底下第一則沒有臉，會像是接在分隔線上面那串。
    if (dayStart(Number(p.time || 0)) !== dayStart(Number(m.time || 0))) return true
    return String(p.from || "") !== from
  }
  return true
}

.pragma library

// PanelKit.js — 面板的純 UI 幫手：夾值、按鈕讀數、滾輪步距、燈箱幾何、
// 清單投影。全部純函式；要用的面板狀態（倍率、段位、當前時間）一律由
// 呼叫端傳進來。Panel.qml 留一行轉接，測試直接載入這個檔案。

function placementMode(value) {
  var v = String(value === undefined || value === null ? "" : value).toLowerCase()
  if (v.indexOf("app") >= 0) return "app"
  if (v.indexOf("center") >= 0) return "center"
  return "bar"
}

// App 視窗的大小記在設定裡。範圍要自己夾 —— `omarchy bar set` 不驗 schema，
// shell.json 裡真的可能是任何數字（或不是數字）。
function clampWindowSize(value, fallback, min) {
  var n = Math.round(Number(value))
  if (!isFinite(n) || n <= 0) n = fallback
  return Math.max(min, Math.min(4096, n))
}

function clampScroll(value) {
  var n = Math.round(Number(value))
  if (!isFinite(n) || n <= 0) n = 100
  return Math.max(50, Math.min(300, n))
}

// 文字大小（%）。上限 160 跟 manifest 的 textScale max 同一個數；下限 50 是
// 原本就有的那一道 —— 設定頁最低只給 80，但 shell.json 手改得到。
function clampTextScale(value) {
  var n = Math.round(Number(value))
  if (!isFinite(n) || n <= 0) n = 100
  return Math.max(50, Math.min(160, n))
}

// 上限 200 跟 daemon 那邊的夾值同一個數：面板送得出去、daemon 收得下，兩邊才不會
// 一邊以為要了 500 則、另一邊默默只給 200。
function clampHistory(value) {
  var n = Math.round(Number(value))
  if (!isFinite(n) || n <= 0) n = 60
  return Math.max(20, Math.min(200, n))
}

function placementLabel(mode, tr) {
  if (mode === "app") return tr("place.app")
  if (mode === "center") return tr("place.center")
  return tr("place.bar")
}

// 按一下換下一段：找「下一個更大的」而不是查現在排第幾 —— shell.json 手改
// 得到的數字（例如 37、120）也接得上，不會卡在找不到的段位上。
function nextStep(steps, value) {
  for (var i = 0; i < steps.length; i++)
    if (steps[i] > value) return steps[i]
  return steps[0]
}

// 按鈕標的是現在幾倍，理由同 placementLabel：六段輪替標「下一步」看不懂。
// 字級按 A−／A+ 當場看得出來，捲動速度看不出來，所以這一顆一定要有讀數。
// 100 要寫成 1× 不是 1.00×，除以 100 之後讓 JS 自己去尾零。
function scrollLabel(percent) {
  return String(clampScroll(percent) / 100) + "×"
}

// 理由同 scrollLabel：這一顆按下去畫面上當場什麼都不會變（下一次開聊天室、
// 下一次往上翻才看得出來），沒有讀數就等於按了不知道自己在第幾段。
function historyLabel(count) {
  return String(clampHistory(count))
}

// 一格滾輪走多少像素。兩種解讀都算，取絕對值大的那個：
//   刻度：angleDelta / 120 * basePx（一般滑鼠一格是 120，單位 1/8 度，也就是 15°；
//         基準 60 是「一格約三行」，接近 Flickable 本來一格的距離）
//   像素：pixelDelta（觸控板真的滑了幾像素，一段本來就比換算出來的大，會贏）
// 原本是「有 pixelDelta 就用 pixelDelta」，高解析度滑鼠會被它坑死：量過，
// Frank 的滾輪一格同時給 angleDelta≈-160 和 pixelDelta≈-14，於是一格只捲 14px
// —— 比 Flickable 自己那一格（60–90px）慢三到六倍，捲起來像一格一格挪，而倍率
// 乘在這麼小的基準上，200% 也還是只有 28px，這就是「scroll speed 好像不會生效」。
// 取大的那個之後方向不能反過來：同一個事件兩個 delta 同號，所以連號帶值一起回。
function wheelDistance(angleDeltaY, pixelDeltaY, basePx, speed) {
  var px = Number(pixelDeltaY)
  if (!isFinite(px)) px = 0
  var deg = Number(angleDeltaY)
  if (!isFinite(deg)) deg = 0
  var notch = deg / 120 * basePx
  return (Math.abs(notch) > Math.abs(px) ? notch : px) * speed
}

// 三個捲動區共用這一條。夾在 originY 和內容底部之間：虛擬化之後內容的頂端不一定
// 是 0，而超出範圍會被 boundsBehavior 彈回來 —— 彈回來的那幾幀也是 contentYChanged，
// 訊息清單的「捲到頂就載入上一頁」會被白白觸發。null = 沒有可捲的距離或零位移。
function wheelTargetY(originY, span, contentY, angleDeltaY, pixelDeltaY, basePx, speed) {
  if (span <= 0) return null                        // 內容比視窗短，沒東西可捲
  var d = wheelDistance(angleDeltaY, pixelDeltaY, basePx, speed)
  if (d === 0) return null                          // 橫向滾輪／零位移：別發空的 contentYChanged
  return Math.max(originY, Math.min(originY + span, contentY - d))
}

// 清單排序：未讀在前、其餘照時間，最後才是隱藏的那幾間 —— state.chats 只照時間排，
// 「未讀在前」一直是面板自己分的（每一堆內部維持原順序）。隱藏列只有搜尋有字時
// 才進結果。
function chatRows(all, query, up) {
  if (!up) return []
  var q = String(query || "").trim().toLowerCase()
  // lastText / lastFrom 是選填欄位，舊 state.json 沒有；用 || "" 避免 "undefined" 誤中。
  function hit(c) {
    var hay = String(c.name || c.mid) + " " + String(c.lastFrom || "") + " " + String(c.lastText || "")
    return hay.toLowerCase().indexOf(q) >= 0
  }
  var unread = []
  var rest = []
  var hid = []        // 已隱藏，只有搜尋有字時才會被放進來
  for (var i = 0; i < all.length; i++) {
    var c = all[i]
    if (q.length > 0 && !hit(c)) continue
    if (c.hidden) hid.push(c)
    else if (Number(c.unread || 0) > 0) unread.push(c)
    else rest.push(c)
  }
  return q.length === 0 ? unread.concat(rest) : unread.concat(rest, hid)
}

// 清單那一列的第二行。隱藏的聊天只有在搜尋結果裡才看得到，所以那一列得自己
// 說明為什麼平常找不到它 —— 字級與顏色照舊，這裡只是多一個前綴。
function rowSubtitle(c, tr) {
  var line = (c.lastFrom ? c.lastFrom + ": " : "") + (c.lastText || "")
  if (!c.hidden) return line
  return line.length > 0 ? tr("hidden.row", line) : tr("hidden.only")
}

function mediaUsable(m) {
  if (!m || !m.hasMedia) return false
  return m.mediaState === undefined || m.mediaState === "ok"
}

function mediaLabel(m, tr) {
  var name = m.fileName || ("[" + m.contentType + "]")
  if (m.fileSize) {
    var kb = m.fileSize / 1024
    name += "  " + (kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB")
  }
  // 打不開的理由寫在名字後面。daemon 連要都不會去要，少了這幾個字，
  // 使用者看到的只是一行點不動的灰字，會以為是自己按錯地方。
  // 收回的訊息 hasMedia 是 false，走不到這一行，但燈箱標題也用同一支，還是擋著。
  if (m.mediaState === "expired") return name + tr("media.expired")
  if (m.mediaState === "unsent") return name + tr("media.unsent")
  return name
}

// 這間聊天室裡「看得到的圖」照時間順序攤平：IMAGE 的縮圖一則一張，
// FLEX 的 carousel 一張圖算一格（每格就是一個 bubble），←/→ 就是走這串。
// 抓不到縮圖的 IMAGE 排除掉 —— 燈箱開起來會是一片黑，比不能按還糟。
// 收回、過期的一樣不進來：版面上那一格已經不畫圖了，這串卻還留著位子的話，
// ←/→ 會走到一格空白，看起來就是燈箱壞了。
// 沒有檔名的那幾格用 tr("image") 當標題 —— 燈箱標題直接畫這個字，不能寫死中文。
function pictureList(messages, tr) {
  var out = []
  var list = Array.isArray(messages) ? messages : []
  for (var i = 0; i < list.length; i++) {
    var m = list[i]
    if (!m) continue
    // FLEX 的圖不算 hasMedia，過不了 mediaUsable，收回與否只能自己看。
    if (m.unsent) continue
    var flex = m.flexImages
    if (Array.isArray(flex) && flex.length > 0) {
      // FLEX 圖是公開 CDN 網址，Image 自己載得動，沒有原檔可以 download，所以 id 留空。
      for (var j = 0; j < flex.length; j++)
        out.push({ id: "", source: String(flex[j]), name: tr("image") })
      continue
    }
    if (m.contentType === "IMAGE" && mediaUsable(m) && m.mediaPath)
      out.push({ id: String(m.id), source: fileUrl(m.mediaPath), name: String(m.fileName || tr("image")) })
  }
  return out
}

// 縮放固定在 [1,4]：小於 1 就沒有放大的意義，大於 4 縮圖會糊成馬賽克。
// cx/cy 是游標相對於燈箱中心的位置；回傳的 x/y 讓游標底下那一點不動。
function zoomAt(scale, panX, panY, cx, cy, factor) {
  var next = Math.max(1, Math.min(4, scale * factor))
  if (next <= 1) return { scale: 1, x: 0, y: 0 }
  var k = next / scale
  return { scale: next, x: cx - (cx - panX) * k, y: cy - (cy - panY) * k }
}

// 平移的邊界：放大後的圖不能整片被拖出畫面外（拖到剩一角就等於弄丟了，
// 而且只能靠雙擊才回得來）。比畫面窄的那一軸沒得動，直接置中。
function clampPan(x, y, scale, paintedW, paintedH, stageW, stageH) {
  var lx = Math.max(0, (paintedW * scale - stageW) / 2)
  var ly = Math.max(0, (paintedH * scale - stageH) / 2)
  return { x: Math.max(-lx, Math.min(lx, Number(x) || 0)),
           y: Math.max(-ly, Math.min(ly, Number(y) || 0)) }
}

// 按下到放開之間移動超過幾 px 就算拖曳，門檻刻意不看縮放：1× 時圖是不動，
// 但手上的動作仍然是拖曳，放開那一下不該被當成「點背景」把燈箱關掉。
function isDrag(dx, dy) {
  return Math.abs(dx) > 4 || Math.abs(dy) > 4
}

// 點擊落在圖（放大、平移之後的實際範圍）外面 = 點到背景。
function outsidePicture(mx, my, stageW, stageH, panX, panY, scale, paintedW, paintedH) {
  return Math.abs(mx - (stageW / 2 + panX)) > paintedW * scale / 2
      || Math.abs(my - (stageH / 2 + panY)) > paintedH * scale / 2
}

// 燈箱標題：檔名（有大小就換成 mediaLabel 那行完整資訊）加上「n / m」。
function lightboxCaption(lightbox, messages, tr) {
  if (!lightbox) return ""
  var label = String(lightbox.name || tr("image"))
  var list = Array.isArray(messages) ? messages : []
  for (var i = 0; i < list.length; i++)
    if (list[i].id === lightbox.id && list[i].fileSize) {
      label = mediaLabel(list[i], tr)
      break
    }
  var n = pictureList(list, tr).length
  return n > 1 ? label + "   " + ((Number(lightbox.index) || 0) + 1) + " / " + n : label
}

// Esc 的去向只有一個地方決定，免得燈箱、聊天室、面板三層各自搶著關。
function escapeAction(lightbox, stickerOpen, view) {
  if (lightbox) return "lightbox"
  // 貼圖選單疊在對話上面，Esc 先收它 —— 不然一按就退出聊天室，選單還開著。
  if (stickerOpen) return "sticker"
  return view === "chat" ? "back" : "close"
}

// 徽章欄很窄，單位只留一個字，不用「分鐘/小時/天前」。
function agoText(ms, nowMs, tr) {
  // 沒有最後一則訊息的聊天室 lastTime 是 0，算出來會是兩萬多天。
  if (Number(ms || 0) <= 0) return ""
  var mins = Math.floor((Number(nowMs || 0) - Number(ms || 0)) / 60000)
  if (mins < 1) return tr("ago.now")
  if (mins < 60) return tr("ago.min", mins)
  var hours = Math.floor(mins / 60)
  if (hours < 24) return tr("ago.hour", hours)
  return tr("ago.day", Math.floor(hours / 24))
}

// ---------------------------------------------------------------- 訊息文字

// 本文要能點連結，所以它是 RichText；RichText 代表整段字都會被當標記解析，
// 使用者打的 < 和 & 本來就該原樣顯示。所以先全部跳脫，畫面上剩下的標記
// 只會有 linkify 自己包的那些 —— 訊息內容沒有任何一條路徑能變成標記。
function escapeHtml(t) {
  return String(t === undefined || t === null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

// 跳脫要在包 <a> 之前，反過來的話我們自己包的標記也會被跳脫掉。
// linkColor 直接寫進標記：TextEdit 沒有 Text 那個 linkColor 屬性，不指定的話
// Qt 給的是寫死的 #0000ff，在深色主題上幾乎看不見。空的就不上色。
function linkify(text, linkColor) {
  var s = escapeHtml(text)
  var c = String(linkColor === undefined || linkColor === null ? "" : linkColor)
  var openTag = c.length > 0 ? "<a style=\"color:" + c + "\" href=\"" : "<a href=\""
  // 網址只吃 RFC 3986 允許的那些 ASCII。不能用「吃到空白為止」——
  // 中文訊息常常網址後面直接接字，沒有空白，那樣會把整句話都吞進網址。
  // 這組字元也蓋得住跳脫後的實體（&amp; 就是 & a m p ;）。
  var re = /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+/g
  // 句尾標點是句子的，不是網址的。中英文各挑常見的收尾符號。
  var trailing = ",.;:!?)]}」』、。"
  var out = ""
  var last = 0
  var m
  while ((m = re.exec(s)) !== null) {
    // 前面黏著英數字的不是網址開頭（swww.example.com），往後挪一格再找。
    if (m.index > 0 && /[A-Za-z0-9]/.test(s.charAt(m.index - 1))) {
      re.lastIndex = m.index + 1
      continue
    }
    var url = m[0]
    // 前綴要在砍句尾標點之前先認，不然「www.,」會被砍成「www」，
    // 反而變成一個看起來很像主機名的東西。
    var www = url.indexOf("www.") === 0
    var head = www ? 4 : url.indexOf("://") + 3
    // &amp; 這種實體結尾的分號不是句尾標點，砍掉只會剩半截 &amp。
    while (url.length > head && trailing.indexOf(url.charAt(url.length - 1)) >= 0
           && !/&(amp|lt|gt|quot|#39);$/.test(url))
      url = url.slice(0, url.length - 1)
    // 砍完只剩前綴的不是網址（「http://.」「www.,」這種），原樣留著。
    if (url.length <= head) { re.lastIndex = m.index + m[0].length; continue }
    out += s.slice(last, m.index)
    out += openTag + (www ? "https://" + url : url) + "\">" + url + "</a>"
    last = m.index + url.length
    re.lastIndex = last
  }
  out += s.slice(last)
  // RichText 不認 \n，而真實訊息約七分之一含換行。
  return out.replace(/\r?\n/g, "<br>")
}

// 把本文照 mention 切段：mention 那幾段只跳脫再上色（人名裡不會有網址），
// 其餘每一段各自 linkify。跳脫一定要切完之後各段自己做 —— 先跳脫整段的話
// 一個 & 會變成五個字，後面每一個位移都被推掉，mention 就切在錯的地方。
function markupBody(text, spans, color) {
  var t = String(text === undefined || text === null ? "" : text)
  var list = Array.isArray(spans) ? spans : []
  var out = ""
  var last = 0
  for (var i = 0; i < list.length; i++) {
    out += linkify(t.slice(last, list[i].start), color)
    // linkify 會把換行換成 <br>，這一段沒走 linkify，得自己補一次；
    // 顯示名稱理論上不含換行，但那是別人的帳號設定，不是我們說了算。
    out += "<span style=\"color:" + color + "\">"
      + escapeHtml(t.slice(list[i].start, list[i].end)).replace(/\r?\n/g, "<br>")
      + "</span>"
    last = list[i].end
  }
  return out + linkify(t.slice(last), color)
}

// daemon 送來的 mentions 在畫之前先過一次：切段的迴圈只走一趟，
// 兩個蓋在同一個字上的框會把那段字畫兩次，超出範圍的則會把後半段吃掉。
function mentionRanges(mentions, len) {
  var list = Array.isArray(mentions) ? mentions : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var s = list[i] ? list[i].start : undefined
    var e = list[i] ? list[i].end : undefined
    // 位移只認真正的整數。不先 Number() 是因為它太好說話 —— true 是 1、
    // null 和 [] 是 0、"0x10" 是 16 —— 沒帶位移的那一筆照樣會湊出一個能用的
    // 數字，然後把顏色塗在沒人指定的那幾個字上。daemon 送過來的本來就是整數
    // （它自己也是這樣擋的，mentionOffset），對不上的就是沒有這個標記。
    if (typeof s !== "number" || typeof e !== "number") continue
    if (!isFinite(s) || !isFinite(e)) continue
    if (Math.floor(s) !== s || Math.floor(e) !== e) continue
    if (s < 0 || e <= s || e > len) continue
    out.push({ start: s, end: e })
  }
  out.sort(function(a, b) { return a.start - b.start })
  var kept = []
  for (var j = 0; j < out.length; j++)
    if (kept.length === 0 || out[j].start >= kept[kept.length - 1].end) kept.push(out[j])
  return kept
}

function bodyText(m, tr) {
  if (m.decryptFailed) return tr("ct.e2eeFail")
  // 收回看旗標不看 text：墓碑的字（daemon 線上值、applyUnsend 寫的）
  // 都是中文，介面語言要在這一層換掉。
  if (m.unsent === true) return tr("msg.unsent")
  if (m.text && m.text.length > 0) return m.text
  // FLEX/RICH 這類版面訊息，LINE 自己附了純文字備援，比印 [FLEX] 有用得多。
  if (m.altText && m.altText.length > 0) return m.altText
  // 舊 daemon 沒有 stickerUrl，貼圖只能落到這裡，別印 [STICKER]。
  if (m.contentType === "STICKER") return tr("ct.sticker")
  return "[" + (m.contentType || tr("ct.nonText")) + "]"
}

// pre-wrap：訊息裡的連續空白和縮排是使用者自己打的，HTML 預設會把它們併成
// 一格。加上它就留得住，長行照樣自動換行（在 Qt 6.11 量過）。
// accent 是已去掉 alpha 的 CSS 色字串：帶 alpha 的 QML 顏色會變成 #AARRGGBB，
// CSS 讀不懂，所以轉字串這一步留在呼叫端。
function bodyHtml(m, accent, tr) {
  var text = bodyText(m, tr)
  // mentions 的位移是照 m.text 算的。bodyText 換成「[貼圖]」這種替代文字的時候
  // 套上去會切在別的地方，所以只有本文真的就是 m.text 時才上色。
  var spans = (m && m.text && text === String(m.text))
    ? mentionRanges(m.mentions, text.length) : []
  return "<div style=\"white-space: pre-wrap\">"
    + markupBody(text, spans, accent) + "</div>"
}

// 只放行 http/https。<a> 是上面自己包的，理論上不會有別的 scheme，但
// onLinkActivated 收到什麼字串是引擎說了算，交給 xdg-open 前一定要再擋一次。
// 回傳正規化後的網址；空字串代表不放行。
function linkTarget(url) {
  var u = String(url === undefined || url === null ? "" : url).trim()
  if (u.toLowerCase().indexOf("www.") === 0) u = "https://" + u
  var low = u.toLowerCase()
  if (low.indexOf("http://") !== 0 && low.indexOf("https://") !== 0) return ""
  // 中間夾空白或控制字元的一律不開：那不會是使用者看到的那一條。
  if (/[\s\x00-\x1f\x7f]/.test(u)) return ""
  return u
}

// ---------------------------------------------------------------- @成員

// 游標左邊那個 @ 在哪、後面打了什麼。@ 前面一定要是空白或行首，
// 不然 a@b.com 這種 email 一打就會冒出選單。
function mentionQuery(text, cursor) {
  var t = String(text === undefined || text === null ? "" : text)
  var pos = Math.max(0, Math.min(Number(cursor) || 0, t.length))
  if (pos <= 0) return null
  var at = t.lastIndexOf("@", pos - 1)
  if (at < 0) return null
  if (at > 0 && !/\s/.test(t.charAt(at - 1))) return null
  var q = t.slice(at + 1, pos)
  // 顯示名稱裡有空白很常見（「STUB Alice」），所以空白不當結束符 ——
  // 打到沒有人對得上，選單自己就收起來了。換行才真的是另一段。
  if (/[\r\n]/.test(q)) return null
  if (q.length > 32) return null
  return { start: at, query: q }
}

function mentionRank(names, q) {
  var best = -1
  for (var i = 0; i < names.length; i++) {
    var at = q.length === 0 ? 0 : String(names[i] || "").toLowerCase().indexOf(q)
    if (at === 0) return 0
    if (at > 0) best = 1
  }
  return best
}

// 最多 8 列：再多就蓋掉半個對話，而且沒人會往下捲到第九個名字。
function mentionMatches(members, query, tr) {
  var q = String(query === undefined || query === null ? "" : query).toLowerCase()
  var rows = []
  // 「全部」不是群組成員，但它是最常用的一個 @，所以跟人名排在同一份清單裡。
  // 名字顯示跟介面語言走，比對仍是雙語（使用者打 all 或 全部 都找得到）。
  var allRank = mentionRank(["All", "全部"], q)
  if (allRank >= 0)
    rows.push({ name: tr("mention.all"), insert: "All", all: true, rank: allRank })
  var list = Array.isArray(members) ? members : []
  for (var i = 0; i < list.length; i++) {
    var name = String(list[i] && list[i].name ? list[i].name : "")
    if (name.length === 0) continue
    var rank = mentionRank([name], q)
    if (rank < 0) continue
    rows.push({ name: name, insert: name, mid: String(list[i].mid || ""), rank: rank })
  }
  // 開頭就對的排前面，其餘照 daemon 給的順序（已經照名字排好）。
  var head = rows.filter(function(r) { return r.rank === 0 })
  var tail = rows.filter(function(r) { return r.rank !== 0 })
  return head.concat(tail).slice(0, 8)
}

// 把 @查詢那一段換成「@名字 」，回傳新的文字和游標該停在哪。
// 後面補一個空白：不補的話下一個字會黏在名字上，送出前回頭找就找不到了。
function mentionInsert(text, cursor, row) {
  var t = String(text === undefined || text === null ? "" : text)
  var pos = Math.max(0, Math.min(Number(cursor) || 0, t.length))
  var token = mentionQuery(t, pos)
  if (!token || !row) return { text: t, cursor: pos }
  var head = t.slice(0, token.start) + "@" + String(row.insert || row.name || "") + " "
  return { text: head + t.slice(pos), cursor: head.length }
}

// 送出前才算位移：挑完之後那句話還會被繼續編輯，挑的當下記下來的
// 位置早就不對了。照名字回頭在文字裡找一次 —— 找不到就是被刪掉或改掉了，
// 那一個就不送，寧可少一個通知也不要把別人的名字標成另一個人。
function deriveMentions(text, picks) {
  var t = String(text === undefined || text === null ? "" : text)
  var list = (Array.isArray(picks) ? picks : []).slice()
  // 同名的人 LINE 上很常見。start 會被編輯弄歪，但它仍然是「誰在前面」唯一的
  // 線索，所以先照它排，再照出現順序一個配一個。
  list.sort(function(a, b) { return (Number(a.start) || 0) - (Number(b.start) || 0) })
  var out = []
  for (var i = 0; i < list.length; i++) {
    var token = "@" + String(list[i].name || "")
    if (token.length < 2) continue
    var from = 0
    var at = -1
    while (from <= t.length) {
      at = t.indexOf(token, from)
      if (at < 0) break
      // 已經被別人佔走的那一段不能再用：@小明 是 @小明明 的前綴，
      // 兩段疊在一起送出去，LINE 會把中間那幾個字算兩次。
      var clash = false
      for (var j = 0; j < out.length; j++)
        if (at < out[j].end && at + token.length > out[j].start) clash = true
      if (!clash) break
      from = at + 1
      at = -1
    }
    if (at < 0) continue
    var m = { start: at, end: at + token.length }
    if (list[i].all) m.all = true
    else m.mid = String(list[i].mid || "")
    out.push(m)
  }
  out.sort(function(a, b) { return a.start - b.start })
  return out
}

// ------------------------------------------------------------- 指令與提示

function isSendCmd(cmd) {
  return cmd === "send" || cmd === "reply"
}

function isMessageSendCmd(cmd) {
  return isSendCmd(cmd) || cmd === "sendSticker" || cmd === "sendFile"
      || cmd === "sendClipboardImage"
}

// 送出前先塞了一顆樂觀泡泡的那三支。送失敗都要把那顆拿掉，但只有帶文字的
// 兩支還要把字還回輸入框 —— 貼圖沒有字可以還，所以拿掉和還字不是同一個判斷。
function hasPendingBubble(cmd) {
  return isSendCmd(cmd) || cmd === "sendSticker"
}

function nearOlderEdge(contentY, originY, contentHeight, height) {
  if (!(contentHeight > height)) return false
  return contentY - originY <= height
}

// 前置一頁之後視窗要停在哪。錨點（positionViewAtIndex）只把「原本的第 0 則」放回
// 視窗頂端，那在捲到頂才翻頁的年代剛好對：那時人離頂端 0 px，錨點就是眼前那一則。
// 提早一個畫面預抓之後不再是這樣 —— 換模型的那一刻人可能還在往上捲的路上，離頂端
// 有 keep px，只擺錨點會把畫面往上拉走 keep（最多一整屏）。keep 是換之前量到的
// 距離，補回去人才會停在原地。
// 這一條同時讓預抓自己收斂：位置補回去之後，每多一頁離頂端就多一頁的高度，累積到
// 超過一個畫面就跳出門檻。不補的話每一頁都把人放回「離頂端一頁高」，訊息短、視窗
// 高（一頁比一個畫面矮）時就會沒人碰滑鼠也一頁接一頁抓到最舊。
function anchoredContentY(afterY, originY, keep, contentHeight, height) {
  if (!(keep > 0)) return afterY
  return Math.min(afterY + keep, originY + Math.max(0, contentHeight - height))
}

// state.chatList 是選填欄位：舊的 daemon 和 stub.py 都不送，缺的時候一律當作正常。
function partialListNoticeText(chatList, chatsCount, searching, tr) {
  if (!chatList || chatList.complete !== false) return ""
  var count = Number(chatList.loaded || chatsCount || 0)
  return tr("list.partial", count)
    + (searching ? tr("list.partialSearch") : "")
}

// state.link / state.refresh 都是選填欄位（README 契約）：link.push 說的是 push
// 那條連線，refresh 說的是聊天室清單那條路（getMessageBoxes），兩者可以一好一壞 ——
// 09-11 就是 push 剛重建好、清單卻在死掉的連線池上連錯 33 次，面板整整
// 18 分鐘顯示 22 小時前的內容。兩句同時成立只印上面那句 —— 連線斷了本來
// 就拓不到清單，那句更根本。門檻 2：一次 30 秒的 timeout 手機熱點下就會
// 發生，單次就跳字太吵，連續兩次（≥ 60 秒）才算真的。
function linkNoticeText(state, online, nowMs, searching, chatsCount, tr) {
  var cl = state && state.chatList ? state.chatList : null
  var partial = partialListNoticeText(cl, chatsCount, searching, tr)
  if (!online) return partial
  var l = state && state.link ? state.link : null
  if (l && String(l.push || "") === "down") {
    // since 是選填／可能是 0，agoText 這時會回空字串，就不要留一個空括號。
    var ago = agoText(Number(l.since || 0), nowMs, tr)
    var t = ago ? tr("link.downAgo", ago) : tr("link.down")
    // 這一行本身就是「現在就重連」那顆按鈕。純文字看不出來點得下去，
    // 所以把動作寫進句子裡 —— 斷線時人最想按的就是這個。
    return t + tr("link.reconnectHint") + (partial ? tr("sep.semi") + partial : "")
  }
  var r = state && state.refresh ? state.refresh : null
  if (!r || Number(r.failures || 0) < 2) {
    return partial
  }
  // at 是選填／可能是 0；「剛剛」接上「前」不成話，而且剛更新過的括號
  // 本來就沒有資訊，一併省掉。
  var upd = agoText(Number(r.at || 0), nowMs, tr)
  var s = upd && upd !== tr("ago.now") ? tr("list.staleAgo", upd)
                                       : tr("list.stale")
  // 後綴同上：這一行同時是重連按鈕。徽章不動 —— 未讀數是斷線前抓到的，
  // 還是真的，只是不夠新。
  return s + tr("list.staleHint") + (partial ? tr("sep.semi") + partial : "")
}

// 清單標題下那一行實際顯示什麼。單欄時對話那半邊整個不可見，提示只能借這一行 ——
// 不然按「同步」在單欄清單裡等於什麼都沒發生。兩欄時 noticeLine 一直在畫面上，
// 再借一次只是把同一句話同時印兩遍。linkText 是呼叫端算好的 linkNoticeText()。
function listNoticeText(draftWriteError, chatList, twoPane, notice, linkText, tr) {
  if (String(draftWriteError || "").length > 0) return draftWriteError
  if (chatList && chatList.complete === false) {
    if (!twoPane && notice.length > 0)
      return notice + (linkText ? tr("sep.semi") + linkText : "")
    return linkText
  }
  if (!twoPane && notice.length > 0) return notice
  return linkText
}

// login.reason 同樣是選填。舊 daemon 只有 error，那就照舊把原字串放出來 ——
// 那是英文的函式庫訊息，但比一句沒有內容的「登入失敗」有用。
function loginErrorDetail(loginInfo, tr) {
  var reason = loginInfo ? String(loginInfo.reason || "") : ""
  if (reason === "token_expired") return tr("login.tokenExpired")
  if (reason === "network") return tr("login.network")
  return loginInfo ? String(loginInfo.error || "") : ""
}

// ------------------------------------------------------------- 清單與選單

// 沒有大頭貼時畫的那顆圓的底色。照 mid 的雜湊挑，同一個人每次都是同一個顏色 ——
// 隨機或照清單位置挑的話，未讀往前排一次整排顏色就跟著換，看起來像換了一批人。
function avatarColor(mid) {
  // 八個都是深色：縮寫一律白字，主題換成淺色的也讀得到。
  var palette = ["#c0392b", "#b8621b", "#8f7300", "#2e7d32",
                 "#00796b", "#1565c0", "#6a1b9a", "#ad1457"]
  var s = String(mid || "")
  var h = 0
  for (var i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) % 1000003
  return palette[h % palette.length]
}

// 縮寫取第一個字。字串是 UTF-16，charAt(0) 會把 emoji 開頭的名字切成半個代理對，
// 畫出來是一個空白方塊。
function avatarInitial(text) {
  var s = String(text || "").trim()
  if (s.length === 0) return ""
  var c = s.charCodeAt(0)
  if (c >= 0xd800 && c <= 0xdbff && s.length > 1) return s.substring(0, 2)
  return s.charAt(0).toUpperCase()
}

// 清單那一列的右鍵選單。二選一：同一列不會同時給兩個相反的動作，
// 看到哪一個就代表現在是哪一種狀態。
function chatMenuItems(c, tr) {
  return [c && c.hidden
          ? { action: "unhide", label: tr("menu.unhide") }
          : { action: "hide", label: tr("menu.hide") }]
}

// 兩欄時清單那半邊有多寬。上限照字級縮放 —— TUI 的左欄是固定 34 個字寬，字放大
// 時清單也要跟著寬，不然一列塞不下一個聊天室名字。但視窗被 Hyprland 切窄的時候
// （實測 718px）那個上限會把對話擠成一條，所以再夾一層「最多占可用寬度三成五」。
// 扣掉的 space24+1 是分隔線兩側各 12px 的邊距加分隔線本身，也就是兩欄真正分得到
// 的寬。
function listPaneWidth(parentWidth, fontScale, space300, space24) {
  return Math.round(Math.min(space300 * fontScale,
    Math.max(0, parentWidth - space24 - 1) * 0.35))
}

// 搜尋框和右邊那排操作按鈕要不要拆成上下兩列。門檻是按鈕寬度再加 160 ——
// 只比按鈕寬度的話，搜尋框會被壓成一條連 placeholder 都放不下的縫。
function toolsStacked(paneWidth, toolsWidth, space160) {
  return paneWidth < toolsWidth + space160
}

// ---------------------------------------------------------------- 貼圖

function stickerStill(url) {
  return String(url === undefined || url === null ? "" : url)
    .replace("/sticker_animation.png", "/sticker.png")
}

// 一包貼圖攤成格子。沒有編號的那幾張直接不畫：按下去 daemon 會回「貼圖編號
// 不對」，畫一格按了只會被罵的東西沒有意義。
function stickerCells(pack) {
  if (!pack || !Array.isArray(pack.stickers)) return []
  var pid = String(pack.id || "")
  if (pid.length === 0) return []
  var version = Math.round(Number(pack.version || 0))
  var out = []
  for (var i = 0; i < pack.stickers.length; i++) {
    var s = pack.stickers[i]
    var sid = s ? String(s.id || "") : ""
    if (sid.length === 0) continue
    out.push({ packageId: pid, stickerId: sid, url: stickerStill(s.url),
               version: isFinite(version) ? version : 0 })
  }
  return out
}

// 貼圖包編號 → 分頁列上的第幾格。找不到回 -1：清單還沒回來，或那一包已經
// 不在清單裡了。分頁要捲到哪、←/→ 走到哪一包，都從這個位置算。
function stickerTabIndex(packs, id) {
  var want = String(id || "")
  if (want.length === 0) return -1
  var list = Array.isArray(packs) ? packs : []
  for (var i = 0; i < list.length; i++)
    if (String(list[i].id || "") === want) return i
  return -1
}

// 貼圖包編號 → 那一包。找不到回 null：最近用過的那幾張可能來自已經不在清單
// 裡的貼圖包，那時候送出去由 daemon 拒絕、理由由它說。
function stickerPack(packs, id) {
  var i = stickerTabIndex(packs, id)
  return i < 0 ? null : packs[i]
}

// 分頁上的名字。小舖沒給名字的那幾包不能變成一格空白 —— 認不出來就沒得選。
function stickerPackName(pack, tr) {
  if (!pack) return ""
  var name = String(pack.name || "").trim()
  return name.length > 0 ? name : tr("sticker.pack", pack.id || "")
}

// 分頁列捲到哪裡，永遠夾在 0（第一包）和捲到底之間。內容比列還窄時只有 0：
// 不夾的話滾一下就能把整列推出畫面，看起來會像貼圖包全不見了。
function stickerTabClamp(x, viewWidth, contentWidth) {
  var want = Number(x)
  if (!isFinite(want)) return 0
  var max = Number(contentWidth) - Number(viewWidth)
  if (!isFinite(max) || max < 0) max = 0
  return Math.max(0, Math.min(want, max))
}

// 滑鼠的滾輪。橫向的 Flickable 根本不吃滾輪（Qt 6.11 量過：垂直、水平兩軸
// 都不動一格），所以原本只有用拖的捲得動 —— 滑鼠沒有那個手勢，右邊那幾包
// 等於不存在，2.7.0 之前使用者看到的就是「貼圖 pop up 不能換」。
// 一個刻度（120）走一步；往上（正值）＝往左，跟直向捲動同一個方向感。
// 距離跟其他可捲的區塊一樣算在 wheelDistance 裡：只回報 pixelDelta 的觸控板
// （angleDelta 是 0）本來在這兩列上一格都捲不動，而「捲動速度」那一段也該管
// 得到這裡。wheelDistance 的一格是 basePx，這兩列的一格是 step，按
// 比例換算過去 —— 滑鼠一個刻度還是剛好一個 step，手感不變。
function stickerTabScroll(contentX, angleY, pixelY, step, viewWidth, contentWidth,
                          basePx, speed) {
  var notch = Number(basePx)
  var by = notch > 0 ? wheelDistance(angleY, pixelY, basePx, speed) / notch * Number(step) : 0
  return stickerTabClamp(Number(contentX) - (isFinite(by) ? by : 0),
                         viewWidth, contentWidth)
}

// 選到的那一包要在畫面裡：偏左就把左緣貼齊，偏右就把右緣貼齊，已經看得見
// 就不動 —— 每次換包都置中會讓整列在腳下跳。一格寬過整列時左緣優先，
// 名字是從左邊開始讀的。
function stickerTabInView(contentX, itemX, itemWidth, viewWidth, contentWidth) {
  var x = Number(contentX)
  var left = Number(itemX)
  var w = Number(itemWidth)
  var view = Number(viewWidth)
  if (!isFinite(x) || !isFinite(left) || !isFinite(w) || !isFinite(view))
    return stickerTabClamp(x, viewWidth, contentWidth)
  var want = x
  if (left + w > x + view) want = left + w - view
  if (left < want) want = left
  return stickerTabClamp(want, viewWidth, contentWidth)
}

// 純函式：一份存檔 ＋ 一個帳號 → 畫得出來的那幾張。每個欄位都自己轉一次型別，
// 這是外部檔案，手改壞了不該讓選單整個畫不出來。
function storedRecent(store, mid, max) {
  var key = String(mid || "")
  if (key.length === 0 || !store) return []
  var list = store[key]
  if (!Array.isArray(list)) return []
  var out = []
  for (var i = 0; i < list.length && out.length < max; i++) {
    var e = list[i]
    var sid = e ? String(e.stickerId || "") : ""
    var pid = e ? String(e.packageId || "") : ""
    var url = e ? stickerStill(e.url) : ""
    // 三個欄位缺一個，這一格就是「畫不出來又送不出去」：沒有網址是一片空白
    // （連載入失敗的 ? 都不會有），沒有貼圖包編號按下去只會被 daemon 退回來。
    // stickerCells 早就把沒編號的整包丟掉了，存檔讀回來的這一排照同一個標準。
    if (sid.length === 0 || pid.length === 0 || url.length === 0) continue
    out.push({ packageId: pid, stickerId: sid, url: url })
  }
  return out
}

// sendSticker 的請求內容。version 只在真的知道的時候帶 —— 契約說不帶就用
// daemon 清單裡那一包的，那一份一定比面板手上的新。
function stickerRequest(chat, sticker) {
  var req = {
    chat: String(chat || ""),
    packageId: String(sticker ? sticker.packageId || "" : ""),
    stickerId: String(sticker ? sticker.stickerId || "" : "")
  }
  var v = Math.round(Number(sticker ? sticker.version : 0))
  if (isFinite(v) && v > 0) req.version = v
  return req
}

// 最近用過的那一排：同一張推上去，重的往後擠掉，整排上限 max 張。
function recentPush(list, item, max) {
  var cap = Math.round(Number(max))
  if (!isFinite(cap) || cap <= 0) return []
  var src = Array.isArray(list) ? list : []
  var sid = item ? String(item.stickerId || "") : ""
  if (sid.length === 0) return src.slice(0, cap)
  var key = String(item.packageId || "") + ":" + sid
  var out = [item]
  for (var i = 0; i < src.length && out.length < cap; i++) {
    var e = src[i]
    if (!e) continue
    if (String(e.packageId || "") + ":" + String(e.stickerId || "") === key) continue
    out.push(e)
  }
  return out
}

// 格子高度：最多 maxRows 列，不夠就只給需要的高度 —— 一包只有八張的時候
// 底下不該空著兩列。
function stickerGridHeight(count, width, cell, maxRows) {
  var n = Math.max(0, Math.round(Number(count) || 0))
  if (n === 0) return 0
  var side = Math.max(1, Math.round(Number(cell) || 0))
  var cols = Math.max(1, Math.floor(Number(width) / side))
  return Math.max(1, Math.min(Math.round(Number(maxRows) || 1), Math.ceil(n / cols))) * side
}

// 選單裡那一行字。三種「一片空白」要分得出來：還在讀、這個帳號沒有貼圖包、
// 這一包這次讀不到（契約：讀不到時 stickers 是空陣列，不是把整包藏起來）。
function stickerStatusText(error, loading, packs, gridCount, tr) {
  if (String(error || "").length > 0) return String(error)
  if (loading && (!packs || packs.length === 0)) return tr("sticker.loading")
  if (!packs || packs.length === 0) return tr("sticker.none")
  if (gridCount === 0) return tr("sticker.packFail")
  return ""
}

// 版面位置按鈕的下一步：貼齊 bar → 置中 → App 視窗 → 繞回來。
function nextPlacement(mode) {
  if (mode === "bar") return "Center of screen"
  if (mode === "center") return "App window"
  return "Below the bar"
}

function chatById(chats, mid) {
  var list = Array.isArray(chats) ? chats : []
  for (var i = 0; i < list.length; i++) if (list[i].mid === mid) return list[i]
  return null
}

// 草稿檔裡還欠著回覆的送出（ambiguousSends）：把「等回覆中」的跟上次存的
// 併起來，requestId 去重，removedByChat 那批是已經結案的不要回來。
// 全程不動入參，回一份新的 accounts map。
function accountsWithAmbiguous(accounts, account, byChat, changedChats, removedByChat, clearAll) {
  var next = Object.assign({}, accounts || {})
  var chats = Object.assign({}, next[account] || {})
  var touched = changedChats || byChat || {}
  for (var chat in touched) {
    if (!touched[chat]) continue
    var saved = Object.assign({}, chats[chat] || {})
    var waiting = Array.isArray(byChat[chat]) ? byChat[chat] : []
    var previous = Array.isArray(saved.ambiguousSends) ? saved.ambiguousSends : []
    var removed = (removedByChat || {})[chat] || {}
    var merged = []
    var seen = {}
    if (!clearAll)
      for (var pi = 0; pi < previous.length; pi++) {
        var previousId = String((previous[pi] || {}).requestId || "")
        if (!previousId || removed[previousId] || seen[previousId]) continue
        seen[previousId] = true
        merged.push(previous[pi])
      }
    for (var wi = 0; wi < waiting.length; wi++) {
      var waitingId = String((waiting[wi] || {}).requestId || "")
      if (!waitingId || removed[waitingId] || seen[waitingId]) continue
      seen[waitingId] = true
      merged.push(waiting[wi])
    }
    if (merged.length > 0) saved.ambiguousSends = merged
    else delete saved.ambiguousSends
    if (Object.keys(saved).length > 0) chats[chat] = saved
    else delete chats[chat]
  }
  if (Object.keys(chats).length > 0) next[account] = chats
  else delete next[account]
  return next
}

// 本地檔案路徑轉成 Image 吃得下的網址。路徑原封不動接在 file:// 後面的話，$HOME 或
// XDG_STATE_HOME 裡只要有 #、?、% 或空白，QUrl 就會把後半段當成 fragment／query
// 或壞掉的跳脫序列，圖就這樣破了。逐段 encodeURIComponent，斜線留著當分隔。
// 空路徑照舊回 "file://"：呼叫端原本就各自擋掉空值，這裡不替它們改判斷。
function fileUrl(path) {
  var p = String(path === undefined || path === null ? "" : path)
  if (p.length === 0) return "file://"
  var parts = p.split("/")
  for (var i = 0; i < parts.length; i++) parts[i] = encodeURIComponent(parts[i])
  return "file://" + parts.join("/")
}

// fileUrl 的反方向：交給 xdg-open 的是檔案系統路徑，不是網址，跳脫要解回來。
// 不是 file:// 的（FLEX 圖的 https）原樣奉還；解不開的跳脫序列也原樣奉還，
// 總比丟一個例外、讓按鍵整個沒反應好。
function localPath(url) {
  var s = String(url === undefined || url === null ? "" : url)
  if (s.indexOf("file://") !== 0) return s
  try {
    return decodeURIComponent(s.slice(7))
  } catch (e) {
    return s.slice(7)
  }
}

// shell.json 的寫入佇列。`omarchy bar set` 每次都是整份讀進來、改一格、整份寫回，
// 兩條同時跑就會互相蓋掉；一個 Process 又在跑的時候再設 running = true 什麼都不會
// 發生，第二下就這樣不見了。所以所有寫入排成一列、一次只送一條。
// 同一個 key 只留一筆，後來的值就地取代前面那筆：反正只有最後一個值算數，
// 位置不動是為了不讓別的 key 因此被往後擠。回傳新陣列（鐵則 11）。
function queueSetting(queue, key, value) {
  var list = Array.isArray(queue) ? queue : []
  var out = []
  var replaced = false
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].key === key) {
      if (!replaced) out.push({ key: key, value: value })
      replaced = true
    } else {
      out.push(list[i])
    }
  }
  if (!replaced) out.push({ key: key, value: value })
  return out
}

// 「這個 key 馬上就會是什麼值」：佇列裡等著的優先，其次是正在寫的那筆，
// 都沒有才是設定檔現在的值。連按兩下 A+ 時熱重載還沒回來，只看現值的話
// 兩下會算出同一個數字，等於只按了一下。
function pendingSetting(queue, inFlight, key, current) {
  var list = Array.isArray(queue) ? queue : []
  for (var i = list.length - 1; i >= 0; i--)
    if (list[i] && list[i].key === key) return list[i].value
  if (inFlight && inFlight.key === key) return inFlight.value
  return current
}

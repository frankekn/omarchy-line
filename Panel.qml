import QtQuick
import QtQuick.Controls
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "DraftStore.js" as DraftStore
import "EventLog.js" as EventLog
import "PanelKit.js" as PanelKit

// bar 上的 LINE：未讀數、聊天室清單、對話與回覆。
//
// 對同一個 daemon（daemon/daemon.ts，systemd user unit `enil`）走兩條路：
//   state.json  — 用看的，徽章跟聊天室清單自動跟著更新
//   unix socket — 一問一答，只在面板開著時用
//
// 這個 widget 不會自己連 LINE。session 歸 daemon 管：LINE 的 refresh token
// 每次登入都會換，同一時間只能有一個 process 握著它。
Panel {
  id: root

  property var imagePaths: ({})
  property var imageRequests: ({})
  property var imageRetryQueue: ({})
  property var imageRetryAttempts: ({})
  property var imageConsumers: ({})
  property var previewRequests: ({})
  property var previewRetryQueue: ({})
  property var previewRetryAttempts: ({})
  property var previewDecodeRetries: ({})
  property bool previewRefreshNeeded: false
  property bool historyRefreshNeeded: false
  property var historyRefreshRemovedByChat: ({})
  property int historyReloadAfterGeneration: 0
  property string historyReloadChat: ""
  property int reconciliationEpoch: 0
  property int reconciliationAttemptedEpoch: -1
  property var ambiguousSendsByChat: ({})
  property var pendingAmbiguousByAccount: ({})

  // Caps for the media bookkeeping tables. They only shed entries when a
  // retry finishes, a URL is re-asked, or the session ends — so a shell that
  // pages media for weeks without any of those kept growing them forever.
  // Object insertion order is age order here (and LINE's numeric ids sort
  // ascending too), so dropping from the front drops the oldest.
  readonly property int mediaRetryMax: 200
  readonly property int imagePathsMax: 2000

  function fetchImage(url, invalidate) {
    var key = String(url || "")
    var queuedRetry = root.imageRetryQueue[key]
    var replace = invalidate === true || (queuedRetry && queuedRetry.invalidate === true)
    if (!/^https:\/\//i.test(url) || !sock.connected || root.imagePaths[url] || root.imageRequests[url]) return
    root.imageRequests[url] = true
    if (!root.request("image", { url: url, invalidate: replace }, url)) {
      delete root.imageRequests[url]
      return
    }
    if (queuedRetry) {
      var queued = Object.assign({}, root.imageRetryQueue)
      delete queued[key]
      root.imageRetryQueue = queued
    }
  }

  // 快取檔會被掃掉（public-images 跟 media/ 是同一條 14 天／500 MB 政策），面板卻
  // 還握著那條 file://：fetchImage 看到 imagePaths 有值就直接回頭，那張圖到面板重開
  // 為止都是破的。忘掉那一筆，下一次 fetchImage 才問得出去。
  // 鐵則 11：指派新物件，就地 delete 不會觸發綁定。
  function forgetImage(url) {
    var next = {}
    for (var k in root.imagePaths) if (k !== url) next[k] = root.imagePaths[k]
    root.imagePaths = next
  }

  function retainImage(url) {
    var key = String(url || "")
    if (!/^https:\/\//i.test(key)) return
    var consumers = Object.assign({}, root.imageConsumers)
    consumers[key] = Number(consumers[key] || 0) + 1
    root.imageConsumers = consumers
  }

  function releaseImage(url) {
    var key = String(url || "")
    var consumers = Object.assign({}, root.imageConsumers)
    var remaining = Math.max(0, Number(consumers[key] || 0) - 1)
    if (remaining > 0) {
      consumers[key] = remaining
      root.imageConsumers = consumers
      return
    }
    delete consumers[key]
    root.imageConsumers = consumers
    var queued = Object.assign({}, root.imageRetryQueue)
    delete queued[key]
    root.imageRetryQueue = queued
    root.finishImageRetry(key)
  }

  component CachedImage: Image {
    id: cachedImage
    property string remoteSource: ""
    property string registeredSource: ""
    property bool downloadFailed: root.imagePaths[remoteSource] === ""
    // 重抓只補一次：檔案還在、內容卻壞掉的時候，daemon 只 stat 大小，第二次回的
    // 還是同一條路徑 —— 不擋就是一個畫不出來、又一直重抓的迴圈。
    property bool refetched: false
    source: remoteSource.indexOf("file://") === 0 ? remoteSource
      : (root.imagePaths[remoteSource] || "")
    function syncConsumer() {
      if (cachedImage.registeredSource === cachedImage.remoteSource) return
      if (cachedImage.registeredSource) root.releaseImage(cachedImage.registeredSource)
      cachedImage.registeredSource = cachedImage.remoteSource
      if (cachedImage.registeredSource) root.retainImage(cachedImage.registeredSource)
    }
    onRemoteSourceChanged: {
      cachedImage.refetched = false
      cachedImage.syncConsumer()
      root.fetchImage(remoteSource)
    }
    Component.onCompleted: {
      cachedImage.syncConsumer()
      root.fetchImage(remoteSource)
    }
    Component.onDestruction: root.releaseImage(cachedImage.registeredSource)
    onStatusChanged: {
      // remoteSource 本身就是 file:// 的那幾個是下載好的原檔，不歸這個快取管，
      // 忘掉也問不回來。抓失敗那一筆存的是空字串，source 是空的畫不出 Error，
      // 破圖的標記照舊由 downloadFailed 出面。
      if (cachedImage.status !== Image.Error || cachedImage.refetched) return
      if (cachedImage.remoteSource.indexOf("file://") === 0) return
      cachedImage.refetched = true
      root.forgetImage(cachedImage.remoteSource)
      root.fetchImage(cachedImage.remoteSource, true)
    }
    Connections {
      target: sock
      function onConnectionStateChanged() {
        if (sock.connected) root.fetchImage(cachedImage.remoteSource)
      }
    }
  }

  moduleName: "io.github.frankekn.line"
  ipcTarget: "io.github.frankekn.line"

  // bar.foreground 才跟隨主題；bar.barForeground 在透明 bar 下會換成
  // 為桌布可讀性挑的顏色，切主題不會變。面板內容要用前者。
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.4)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // 面板內文字大小（設定裡的 textScale，%）。bar 上的圖示仍跟隨 bar 自己的設定。
  readonly property real fontScale: Math.max(0.5, Number(setting("textScale", 100)) / 100)
  readonly property int fontBody: Math.round(Style.font.bodySmall * fontScale)
  readonly property int fontTitle: Math.round(Style.font.body * fontScale)

  // 面板位置（設定裡的 Panel position）。比對子字串而不是整串相等 ——
  // 選項的值就是顯示文字，改字面不該讓設定靜默失效。認不得的字串一律當預設，
  // 手改壞 shell.json 不該讓面板整個開不出來。
  function placementMode(value) {
    return PanelKit.placementMode(value)
  }

  readonly property string placement: placementMode(setting("placement", "Below the bar"))
  readonly property bool centeredPanel: placement === "center"
  // App window：同一份面板內容改掛在一個真的 toplevel 視窗（LineWindow）裡，
  // 由 Hyprland 管。另外兩種都還是 LinePanel 那層 overlay。
  readonly property bool appWindow: placement === "app"

  // 置中與 App 視窗都夠寬，走 TUI 那種兩欄版面：左清單、右對話，兩邊同時看得到。
  // 吊在 bar 下時寬度不夠擺兩欄，維持原本的單欄切換。
  readonly property bool twoPane: centeredPanel || appWindow

  // App 視窗的大小記在設定裡。範圍要自己夾 —— `omarchy bar set` 不驗 schema，
  // shell.json 裡真的可能是任何數字（或不是數字）。
  function clampWindowSize(value, fallback, min) {
    return PanelKit.clampWindowSize(value, fallback, min)
  }

  readonly property int windowWidth: clampWindowSize(setting("windowWidth", 1040), 1040, 560)
  readonly property int windowHeight: clampWindowSize(setting("windowHeight", 720), 720, 480)

  // 捲動速度（設定裡的 scrollSpeed，%）。Flickable 沒有「滾輪一格捲多少」可以設 ——
  // 步距寫死在 QQuickFlickable 裡，改 flickDeceleration 之類的只會影響甩出去之後的
  // 慣性，不影響一格走多遠 —— 所以訊息、聊天清單和貼圖格都自己接下滾輪算 contentY
  // （wheelScroll），倍率就乘在那裡。100 是預設，一格大約等於原本那一格。
  // scrollSteps 只是按鈕輪替的段位；shell.json 手改得到、`omarchy bar set` 也不驗
  // schema，所以這裡只夾上下限，中間的數字（例如 120）照樣算數。
  readonly property var scrollSteps: [50, 75, 100, 150, 200, 300]

  function clampScroll(value) {
    return PanelKit.clampScroll(value)
  }

  readonly property int scrollPercent: clampScroll(setting("scrollSpeed", 100))
  readonly property real scrollSpeed: scrollPercent / 100

  // 一格滾輪走多少像素。兩種解讀都算，取絕對值大的那個：
  //   刻度：angleDelta / 120 * 60（一般滑鼠一格是 120，單位 1/8 度，也就是 15°；
  //         基準 60 是「一格約三行」，接近 Flickable 本來一格的距離）
  //   像素：pixelDelta（觸控板真的滑了幾像素，一段本來就比換算出來的大，會贏）
  // 原本是「有 pixelDelta 就用 pixelDelta」，高解析度滑鼠會被它坑死：量過，
  // Frank 的滾輪一格同時給 angleDelta≈-160 和 pixelDelta≈-14，於是一格只捲 14px
  // —— 比 Flickable 自己那一格（60–90px）慢三到六倍，捲起來像一格一格挪，而倍率
  // 乘在這麼小的基準上，200% 也還是只有 28px，這就是「scroll speed 好像不會生效」。
  // 取大的那個之後方向不能反過來：同一個事件兩個 delta 同號，所以連號帶值一起回。
  function wheelDistance(angleDeltaY, pixelDeltaY) {
    return PanelKit.wheelDistance(angleDeltaY, pixelDeltaY, Style.space(60), root.scrollSpeed)
  }

  // 三個捲動區共用這一條。夾在 originY 和內容底部之間：虛擬化之後內容的頂端不一定
  // 是 0，而超出範圍會被 boundsBehavior 彈回來 —— 彈回來的那幾幀也是 contentYChanged，
  // 訊息清單的「捲到頂就載入上一頁」會被白白觸發。
  function wheelScroll(view, angleDeltaY, pixelDeltaY) {
    var y = PanelKit.wheelTargetY(view.originY, view.contentHeight - view.height,
                                  view.contentY, angleDeltaY, pixelDeltaY,
                                  Style.space(60), root.scrollSpeed)
    if (y !== null) view.contentY = y
  }

  // 三個捲動區各掛一顆，實作只有這一份。只吃滾輪：acceptedButtons 是 NoButton，
  // 按下、拖曳、點擊照樣穿過去給下面的 delegate（滾輪的送達不看 acceptedButtons，
  // 這一層還是收得到），interactive 也就原封不動，觸控和拖曳仍歸 Flickable。
  // ListView／GridView 會把宣告在裡面的 Item 收進 contentItem，座標是內容座標，
  // 所以貼著整份內容鋪，y 跟著 originY（虛擬化之後內容頂端不一定是 0）——
  // 捲到哪裡滑鼠都還在這一層上面。它疊在 delegate 底下沒關係：delegate 沒有人接
  // 滾輪，事件會一路往下找到這裡才被吃掉，Flickable 自己那套步距就輪不到。
  component WheelSpeed: MouseArea {
    id: wheelSpeed

    required property Flickable view

    y: wheelSpeed.view.originY
    width: wheelSpeed.view.width
    height: Math.max(wheelSpeed.view.height, wheelSpeed.view.contentHeight)
    acceptedButtons: Qt.NoButton
    onWheel: function(wheel) {
      root.wheelScroll(wheelSpeed.view, wheel.angleDelta.y, wheel.pixelDelta.y)
    }
  }

  // 一次跟 daemon 要幾則（設定裡的 historyPage）。開聊天室的第一頁和往上翻的每一頁
  // 共用同一個數字 —— 兩邊各自一套的話，調大只有一半有感，而且開場跟翻頁的節奏對不起來。
  // 預設從 30 提到 60：30 則大概就是一個畫面多一點，於是每往上翻一次就撞一次網路
  // 來回，畫面停在頂端等，翻舊訊息變成一段一段卡。
  // historySteps 只是按鈕輪替的段位；shell.json 手改得到、`omarchy bar set` 也不驗
  // schema，所以這裡只夾上下限，中間的數字（例如 37）照樣算數。
  // 上限 200 跟 daemon 那邊的夾值同一個數：面板送得出去、daemon 收得下，兩邊才不會
  // 一邊以為要了 500 則、另一邊默默只給 200。
  readonly property var historySteps: [30, 60, 100, 150]

  function clampHistory(value) {
    return PanelKit.clampHistory(value)
  }

  readonly property int historyPage: clampHistory(setting("historyPage", 60))

  readonly property string stateDir:
    (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") || "") + "/.local/state") + "/enil"

  property var state: null
  property double nowMs: Date.now()

  // A heartbeat replaces state.json but does not make 500 chat delegates new.
  // New daemons move chatsRevision only with chats/chatList; old daemons have
  // no revision and retain the compatible update-on-every-state behavior.
  property var chatSnapshot: []
  property double chatRevisionSeen: -1
  property string chatBootSeen: ""
  readonly property var chats: chatSnapshot
  // 隱藏的聊天不算未讀 —— 從清單拿掉了卻還在 bar 圖示上亮一個數字，等於沒隱藏。
  // 隱藏是 daemon 記在 hidden.json 的本機偏好，聊天本身照樣留在 state.chats 裡，
  // 搜尋才找得回來。
  readonly property var unreadChats: chats.filter(function(c) { return !c.hidden && Number(c.unread || 0) > 0 })
  readonly property int totalUnread: unreadChats.reduce(function(sum, c) { return sum + Number(c.unread || 0) }, 0)
  // The daemon resyncs every 60s, so silence past 3 minutes means it died.
  readonly property bool online: !!state && (nowMs - Number(state.updatedAt || 0)) < 180000
  readonly property color statusColor: !online ? dim : (totalUnread > 0 ? urgent : foreground)
  readonly property string myMid: state && state.me ? String(state.me.mid || "") : ""

  // 登入狀態：daemon 在登入完成前就會寫 state，UI 靠這段顯示 QR / PIN。
  readonly property var loginInfo: state && state.login ? state.login : null
  readonly property string loginStatus: loginInfo ? String(loginInfo.status || "") : ""
  readonly property bool loggedIn: loginStatus === "ok"
  // idle = daemon 活著但沒有可用憑證，等人主動要求 QR。
  // QR 需要有人拿手機在旁邊，所以不自動開 —— 沒人時它只是一張沒人掃的憑證。
  readonly property bool canLogin: loginStatus === "idle" || loginStatus === "error"
  // daemon 每次產生 QR 都換檔名，所以純綁定就會自動重載 ——
  // 不要用 imperative 去指派 source，面板沒開時那個 Image 還不存在。
  readonly property string qrSource: loginInfo && loginInfo.qrPng ? "file://" + loginInfo.qrPng : ""

  // "list" or "chat"
  property string view: "list"
  property var activeChat: null
  property var messages: []
  property string notice: ""
  property double loadedAt: 0
  property int selectedIndex: 0
  property bool loading: false
  property bool loadingOlder: false
  // 這間聊天室已經翻到最舊的一則了。預抓的門檻是「離頂端一個畫面高」而不是「貼到頂」，
  // 沒有這面旗子的話，翻到底之後每一次 contentYChanged 都會再問 daemon 一次同樣的
  // 問題、拿回同樣的空答案。整份重抓（開聊天室、同步、事件觸發的重讀）會把它放回
  // false —— 那時 messages[0] 換人了，上一次那個「沒有更舊的」不再是同一個問題。
  property bool noMoreOlder: false
  // 這一份歷史的世代，loadHistory 每叫一次 +1。整份重讀的那一刻 messages 換人了，
  // 還在飛的那趟 older 是照舊的 messages[0] 問的：把它前置到新的一份上面，就是一頁
  // 很舊的訊息直接黏在新訊息前面、中間缺一段，而且不會有任何錯誤訊息。older 送出時
  // 記下當下的世代，回來對不上就整趟丟掉（見 onReply 的 outdated）。事件補進來的
  // 新訊息只接在尾巴、messages[0] 沒動，所以那條路不算換代。
  property int historyGen: 0
  // 手動同步：送出到回來這段要看得見在動（按鈕自己會變成「同步中…」），
  // 回來之後要留下「什麼時候同步的」，不然按了跟沒按長得一樣。
  property bool syncing: false
  property double syncedAt: 0
  // 只有「本來就在底部」才跟著新內容捲到底；否則圖片載入完會把使用者拉回去。
  // 換掉 messages 的那一刻才算數：ListView 虛擬化之後，生成／回收項目的過程中
  // contentY、originY、contentHeight 會連跳好幾輪，一直重算只會被中間狀態帶著跑。
  property bool atBottom: true
  // 前置更舊的訊息時，換完要把哪一則放回視窗頂端。記索引不記高度：虛擬化之後
  // contentHeight 只是估計值（沒生成的項目按平均值算），用高度差補位置會歪掉。
  property int prependAnchorIndex: -1
  // 換模型之前使用者捲到哪（相對 originY）。ListView 一遇到 model reset 就把
  // contentY 歸零（Qt 6.11 量過：捲到底 1034 → 0），換完得自己放回去。
  // >= 0 同時代表「正在換模型」，這段期間的 contentY 都不是使用者捲的。
  property real keepContentY: -1
  // 開聊天室時那間還有幾則未讀 —— 分隔線就畫在倒數第 N 則之上。歷史回來才算得出
  // 是哪一則（開的當下 messages 還是上一份），算完存 id：前置舊訊息會讓索引整批位移。
  property int unreadMarkCount: 0
  property string unreadMarkId: ""
  // mid → { at, messages }。重開同一間聊天室時先貼上一次那份，
  // 不然每次都要盯著一片「載入中…」等 daemon 回來。at 只拿來汰舊。
  property var historyCache: ({})
  // chat mid → failed optimistic bubbles retained for copying. They are kept
  // outside historyCache because pending local ids must never look delivered.
  property var failedMessagesByChat: ({})
  // 上一次看到的登入帳號 mid，用來認出「登出／換帳號」這個轉換。
  // 空字串代表目前沒有已登入的 session。
  property string sessionMid: ""
  // Account ids can repeat after logout/login; this cannot.
  property int sessionEpoch: 0
  // A no-token restart publishes starting then idle under one boot id. Keep
  // that transition separate from an old idle state file read at startup.
  property string resumeAttemptBootId: ""
  // A settled logout/resume snapshot is repeated on every heartbeat. Record
  // the outcome already consumed so its startup fallback cannot clear a
  // second account after the known session was cleared on the first copy.
  property string sessionEndHandledKey: ""
  property bool clearLastDraftOnLoad: false

  // ------------------------------------------------------------ 即時事件
  // 已經吃到哪一筆事件。bootId 是 daemon 這次啟動的 id —— 換了就代表 seq 從 1 重來，
  // 舊的號碼對不上新的那一輪，watermark 要跟著歸零。
  property string lastBootId: ""
  property int lastSeq: 0
  // 通知點下去之後 daemon 會寫一筆 state.wanted。那個欄位不會自己消失，所以判準是
  // seq 有沒有往前（同一間連點兩次是兩筆），bootId 換了就代表 seq 從 1 重來。
  property string wantedBootId: ""
  property int honouredWanted: 0
  // 認下了、但還沒跳過去的那一間。寫 state 和叫 shell 開面板是兩件事，先到的
  // 常常是 state —— 那一刻面板還沒開，openChat 會被 onOpenedChanged 的重置擦掉，
  // 所以先記著，等面板真的開了再跳。
  property string pendingWanted: ""
  // 正在回覆的那一則：{ id, fromName, text }。null 代表這句話是普通訊息。
  // 只留畫得出來的那三個欄位，不留整則 —— 訊息隨時會被一次 history 整份換掉，
  // 留著整個物件等於留著一份不會再更新的舊資料。
  property var replyTarget: null
  // Per-account, per-chat drafts. This lives beside state.json and is written
  // atomically so closing the panel or restarting the shell does not eat text.
  property var draftStore: ({})
  property string draftLastAccount: ""
  property bool draftStoreLoaded: false
  property bool draftStoreUnavailable: false
  property bool draftRevisionExhausted: false
  property string draftWriteError: ""
  property int draftLoadRetryAttempt: 0
  property bool sessionEstablished: false
  property string sessionBootId: ""
  property bool initialIdleDraftHandled: false
  property bool settledIdleBeforeDraftLoad: false
  property string settledIdleDraftAccount: ""
  property double settledIdleDraftRevision: 0
  property double settledIdleDraftAt: 0
  property var pendingDraftAccountClears: ({})
  property var pendingDraftComposers: ({})
  property var deferredDraftRequests: []
  property var deferredDraftPickers: []
  property bool composerEditedBeforeDraftLoad: false
  property bool restoringDraft: false
  property bool resettingComposerAfterSend: false
  readonly property string panelInstanceId: String(Date.now()) + "-"
      + Math.floor(Math.random() * 4294967296).toString(36)
  property int composerGeneration: 0
  property var composerGenerationByChat: ({})
  property var composerDirtyByChat: ({})
  property var composerDraftVersionByChat: ({})
  property var draftDurabilityPendingByChat: ({})
  // Sends discarded by a socket disconnect can no longer receive an
  // acknowledgement, but their drafts must remain recoverable until a newer
  // non-empty composer replaces them.
  property var draftRecoveryHolds: ({})
  property int draftRestoreEpoch: 0
  onReplyTargetChanged: {
    root.noteComposerEdit()
    scheduleDraftSave()
  }
  onMentionPicksChanged: {
    root.noteComposerEdit()
    scheduleDraftSave()
  }
  // LINE 的六個預設表情，照 LINE 列舉的順序。表情列和右鍵選單共用這一份，
  // 兩邊的順序才不會各走各的。
  readonly property var reactionTypes: ["NICE", "LOVE", "FUN", "AMAZING", "SAD", "OMG"]
  // 「都讀了」的分母：1:1 就是對方一個人，群組看成員名單（daemon 給的名單不含自己）。
  // 名單還沒回來就是 0＝不知道，那就一直畫「已讀 N」——「已讀」是有人都讀完了才說的話。
  readonly property int readerCount:
    !root.activeChat ? 0
      : (/^u/.test(String(root.activeChat.mid || "")) ? 1 : root.members.length)

  // ------------------------------------------------------------ @群組成員
  // 現在這間聊天室的成員（daemon 的 members 指令）。換聊天室時 loadMembers 會先
  // 清空，慢一步回來的那份則被 onReply 的 stale 擋掉，所以它永遠只屬於眼前這間。
  property var members: []
  // 讀不到成員時的原因。不跳橫幅：這是開聊天室時自己送的請求，使用者沒按過。
  // 真的要看的時候（打了 @）選單就會把它印出來，不會靜靜地什麼都不做。
  property string membersError: ""
  // 這則訊息挑過的人：{ name, mid|all, start }。start 只是挑的當下的位置，
  // 之後編輯會讓它失準，送出前一律照名字回頭在文字裡找一次。
  property var mentionPicks: []
  // 選單裡目前選到第幾列。列數一變就歸零（onMentionRowsChanged）。
  property int mentionIndex: 0
  // 按 Esc 關掉選單的那個 @ 的位置。記位置而不是記一個 bool，是為了讓「關掉」
  // 只對這一個 @ 有效：游標移到別的 @ 或打了新的 @，選單自己會再開。
  property int mentionDismissedAt: -1
  // daemon 活著但還沒登入 —— 這時要顯示 QR，不是空的聊天室清單。
  readonly property bool needsLogin: online && !loggedIn

  // 清單順序：未讀在前，其餘照時間。清單可捲，不另外設上限
  //（state.chats 本身就是最近 50 個）。鍵盤選取與滑鼠點的是同一份。
  property string search: ""
  readonly property var listModel: root.chatRows(root.chats, root.search, root.online)

  // 抽成函式而不是把整段留在綁定裡：隱藏之後這裡有三條路（離線、沒搜尋、有搜尋），
  // 而 tests/qml/run.js 是拿參數去餵函式來驗行為的，綁定它只能用正規表示式看一眼。
  //
  // 隱藏的那幾間平常不在清單裡，但**搜尋一打字就回來**（排在沒隱藏的結果後面，
  // 那一列會標「已隱藏」）—— 桌面版 LINE 也是只有搜尋找得回隱藏的聊天。
  function chatRows(all, query, up) {
    return PanelKit.chatRows(all, query, up)
  }

  function rowSubtitle(c) {
    return PanelKit.rowSubtitle(c)
  }

  // 清單變短（隱藏一列、搜尋縮小結果）之後選取要跟著夾回來，
  // 不然 Enter 會開到一列已經不存在的聊天。
  function clampSelection() {
    var n = root.listModel.length
    root.selectedIndex = n === 0 ? 0 : Math.max(0, Math.min(root.selectedIndex, n - 1))
  }

  // 只看列數而不是整份模型：每次 state 寫回來模型都是新陣列，但列數沒變時
  // 選取沒有理由動（滑鼠停在哪一列就是哪一列）。
  readonly property int listCount: root.listModel.length
  onListCountChanged: root.clampSelection()

  // 選取與開啟：keyCatcher 和搜尋框都要用，抽出來共用。
  function moveSelection(step) {
    var n = root.listModel.length
    if (n === 0) return
    root.selectedIndex = Math.max(0, Math.min(root.selectedIndex + step, n - 1))
    var rowH = Math.round(Style.space(44) * root.fontScale) + Style.space(8)
    var top = root.selectedIndex * rowH
    if (top < listFlick.contentY) listFlick.contentY = top
    else if (top + rowH > listFlick.contentY + listFlick.height)
      listFlick.contentY = top + rowH - listFlick.height
  }

  function openSelected() {
    var chat = root.listModel[root.selectedIndex]
    if (chat) root.openChat(chat)
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // ----------------------------------------------------------- state file

  FileView {
    path: root.stateDir + "/state.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.parseState(text())
    onLoadFailed: root.clearStateAfterLoadFailure()
  }

  // events.json carries the live-event ring — up to a few hundred KB of
  // message payloads. While the socket is connected, the daemon pushes each
  // event over it in under a millisecond, so watching this file then would
  // only pay a giant JSON re-parse per message for data already applied.
  // Disconnected is exactly when the file matters: the ring is the catch-up
  // layer for what push could not deliver.
  FileView {
    id: eventsView
    path: root.stateDir + "/events.json"
    watchChanges: !sock.connected
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.parseEventsText(text())
    onLoadFailed: root.finishEventsSync()
  }

  // Pushes that land while a catch-up read is in flight must not jump the
  // watermark — the file's older events have to settle first or the gap
  // between them is silently dropped. Queued, then drained by
  // finishEventsSync once the file read publishes its watermark.
  property bool eventsSyncing: false
  property var queuedPushes: []
  // True once this daemon has proven it publishes events -- either the ring
  // file parsed or a live push arrived. False means gaps have no backstop,
  // so parseState falls back to refetching on lastTime movement.
  property bool eventsLive: false
  // False until the panel has actually consumed an events read or push. The
  // first consumption adopts the ring's watermark without applying it --
  // the panel fetched its own history when it opened the chat.
  property bool eventsConsumed: false

  function parseEventsText(content) {
    var parsed = null
    try { parsed = JSON.parse(String(content || "")) } catch (e) {
      console.warn("line", "Ignoring bad events file", e)
    }
    root.consumeEventsFile(parsed && typeof parsed === "object" ? parsed : null)
    root.finishEventsSync()
  }

  function finishEventsSync() {
    root.eventsSyncing = false
    var queued = root.queuedPushes
    if (queued.length === 0) return
    root.queuedPushes = []
    for (var i = 0; i < queued.length; i++) root.onPushedEvent(queued[i])
  }

  // A live event pushed over the socket: same shape as a ring entry. seq
  // only ever climbs within a boot, so skipping what the file path already
  // delivered (or vice versa) is free.
  function onPushedEvent(res) {
    if (!res || typeof res !== "object") return
    var ev = res.event
    if (!ev || typeof ev.seq !== "number" || !isFinite(ev.seq)) return
    var boot = String(res.boot || "")
    if (boot.length > 0 && boot !== root.lastBootId) {
      root.lastBootId = boot
      root.lastSeq = 0
    }
    if (root.eventsSyncing) {
      var held = root.queuedPushes
      held.push(res)
      root.queuedPushes = held
      return
    }
    if (ev.seq <= root.lastSeq) return
    root.lastSeq = ev.seq
    // A push arriving at all proves this daemon publishes events.
    root.eventsLive = true
    root.eventsConsumed = true
    root.applyEvents([ev])
  }

  // The watermark-and-apply half of a state read, now fed by events.json
  // instead of state.json. watermark 一律往前推，就算這一刻沒人在看對話 ——
  // 不推的話面板關著的那段時間累積下來的事件會在重開的瞬間整批重放一次。
  function consumeEventsFile(evState) {
    // 第一次消費走收編：watermark 直接跟到 ring 頂端、事件一則不套用 —— 面板開
    // 聊天室時自己抓過歷史，ring 裡的東西都已經在。lastBootId 可能被 state.json
    // 先記成同一輪的 boot，所以不能靠它是不是空來判「第一次」；lastSeq > 0 也
    // 代表早就在消費了。
    var consumed = root.eventsConsumed || root.lastSeq > 0
    var evs = root.eventsSince(evState ? evState.events : null,
                               evState ? evState.bootId : "",
                               consumed ? root.lastBootId : "",
                               root.lastSeq)
    root.lastBootId = evState ? String(evState.bootId || "") : root.lastBootId
    root.lastSeq = evs.seq
    root.eventsLive = evs.live
    if (evState) root.eventsConsumed = true

    // A new message in the chat you are reading should just appear.
    // twoPane 時對話一直開著，view 會是 "list" 也照樣要更新。
    // 面板關著時 socket 也斷了，這時抓歷史只會留下假的「daemon 沒在跑」。
    if (sock.connected && (root.view === "chat" || root.twoPane) && root.activeChat) {
      var fresh = root.chatById(root.activeChat.mid)
      var moved = !!fresh && Number(fresh.lastTime || 0) > root.loadedAt
      // 會寫 events 的 daemon：一則新訊息就只是接一顆泡泡，不再重抓整頁歷史。
      // loadedAt 是 0 代表手上根本還沒有這一份（重開面板時 socket 常常還沒接上），
      // 事件補不了一份不存在的歷史。
      if (evs.live && root.loadedAt > 0 && !evs.reload) root.applyEvents(evs.list)
      else if (moved || evs.reload) {
        root.historyReloadAfterGeneration = Math.max(root.historyReloadAfterGeneration,
                                                     root.historyGen + 1)
        root.historyReloadChat = String(root.activeChat.mid || "")
        if (!root.loading) {
          root.reconciliationAttemptedEpoch = root.reconciliationEpoch
          root.loadHistory(root.activeChat.mid)
        }
      }
    }
  }

  Connections {
    target: DraftWriter
    function onWriteFailed(error) {
      root.draftWriteError = "草稿尚未保存：" + String(error || "寫入失敗")
    }
    function onWriteSucceeded(content) {
      root.draftWriteError = ""
      root.confirmDraftSaved(content)
    }
  }

  function clearStateAfterLoadFailure() {
    root.state = null
    root.chatSnapshot = []
    root.chatRevisionSeen = -1
    root.chatBootSeen = ""
  }

  function replaceChatSnapshot(incoming) {
    var oldY = listFlick.contentY
    var wasAtBeginning = oldY <= listFlick.originY + 1
    var oldIndex = -1
    var probeY = oldY
    var probeEnd = Math.min(listFlick.contentHeight, oldY + listFlick.height)
    while (oldIndex < 0 && probeY <= probeEnd) {
      oldIndex = listFlick.indexAt(1, probeY)
      probeY++
    }
    var oldRow = oldIndex >= 0 ? root.listModel[oldIndex] : null
    var oldMid = oldRow ? String(oldRow.mid || "") : ""
    var oldItem = oldIndex >= 0 ? listFlick.itemAtIndex(oldIndex) : null
    var oldOffset = oldItem ? oldItem.y - oldY : 0
    root.chatSnapshot = incoming
    if (wasAtBeginning) {
      Qt.callLater(function() { listFlick.positionViewAtBeginning() })
      return
    }
    if (!oldMid) return
    Qt.callLater(function() {
      var nextIndex = -1
      for (var i = 0; i < root.listModel.length; i++) {
        if (String(root.listModel[i].mid || "") === oldMid) {
          nextIndex = i
          break
        }
      }
      if (nextIndex < 0) return
      listFlick.positionViewAtIndex(nextIndex, ListView.Beginning)
      var nextItem = listFlick.itemAtIndex(nextIndex)
      if (!nextItem) return
      var maximum = Math.max(listFlick.originY,
                             listFlick.contentHeight - listFlick.height)
      listFlick.contentY = Math.max(
        listFlick.originY, Math.min(maximum, nextItem.y - oldOffset))
    })
  }

  function parseState(content) {
    var wasOk = root.loginStatus === "ok"
    try {
      var parsed = JSON.parse(String(content || ""))
      root.state = parsed && typeof parsed === "object" ? parsed : null
    } catch (e) {
      console.warn("line", "Ignoring bad state file", e)
      root.state = null
    }
    var incoming = root.state && Array.isArray(root.state.chats) ? root.state.chats : []
    var revision = root.state ? Number(root.state.chatsRevision) : NaN
    var chatBoot = root.state ? String(root.state.bootId || "") : ""
    // revision 只能用 >：推播 patch 會先把 watermark 推到檔案還沒寫到的位置，
    // 晚到的舊檔不能被允許把新列蓋回去。
    if (!isFinite(revision) || chatBoot !== root.chatBootSeen
        || revision > root.chatRevisionSeen) {
      if (root.replaceChatSnapshot) root.replaceChatSnapshot(incoming)
      else root.chatSnapshot = incoming
      root.chatRevisionSeen = isFinite(revision) ? revision : -1
      root.chatBootSeen = chatBoot
    }
    // 登出／換帳號後不能把上一個帳號的快取訊息顯示出來。
    var nowStatus = root.state && root.state.login
        ? String(root.state.login.status || "") : ""
    var nowOk = nowStatus === "ok"
    var hasSettled = root.loginInfo && root.loginInfo.settled !== undefined
    var loginAttempt = root.loginInfo ? String(root.loginInfo.attempt || "") : ""
    var retryableSessionError = nowStatus === "error" && root.state && root.state.login
        && String(root.state.login.reason || "") === "network"
        && !(loginAttempt === "manual" && root.loginInfo.settled === true)
    var nowMid = root.state && root.state.me ? String(root.state.me.mid || "") : ""
    if (nowStatus === "starting" && loginAttempt === "resume" && chatBoot !== "")
      root.resumeAttemptBootId = chatBoot
    var legacyTerminalError = !hasSettled && nowStatus === "error"
        && root.loginInfo && String(root.loginInfo.reason || "") === "token_expired"
    var sessionEnded = hasSettled
        ? root.loginInfo.settled === true
        : legacyTerminalError || (nowStatus === "idle" && root.sessionEstablished
          && root.sessionBootId !== "" && chatBoot === root.sessionBootId)
    var terminalTeardown = sessionEnded && (nowStatus === "idle"
        || (nowStatus === "error" && root.loginInfo
            && (String(root.loginInfo.reason || "") === "token_expired"
                || loginAttempt === "manual" || loginAttempt === "resume")))
    var resumeEndedWithoutSession = !nowOk && sessionEnded && !retryableSessionError
        && chatBoot !== ""
        && (loginAttempt === "resume" || loginAttempt === "logout"
            || root.resumeAttemptBootId === chatBoot)
    var endedAttempt = loginAttempt === "logout" ? "logout" : "resume"
    var sessionEndKey = resumeEndedWithoutSession
        ? chatBoot + ":" + endedAttempt : ""
    var unhandledSessionEnd = sessionEndKey !== ""
        && root.sessionEndHandledKey !== sessionEndKey
    if (!root.draftStoreLoaded && !root.sessionEstablished
        && terminalTeardown && !retryableSessionError
        && (nowStatus === "error" || sessionEndKey !== "")) {
      root.settledIdleBeforeDraftLoad = true
      root.settledIdleDraftAccount = root.sessionMid
      root.settledIdleDraftRevision = Number(DraftStore.snapshot().revision || 0)
      root.settledIdleDraftAt = Date.now()
    }
    // A daemon boot may publish idle before token recovery has finished.
    // Preserve the old session until a settled state proves recovery ended.
    if (root.sessionMid !== ""
        && ((nowOk && nowMid !== root.sessionMid)
            || (!nowOk && sessionEnded && !retryableSessionError))) {
      if (sessionEndKey !== "") root.sessionEndHandledKey = sessionEndKey
      clearSession()
    } else if (unhandledSessionEnd) {
      root.sessionEndHandledKey = sessionEndKey
      // This panel started with no in-memory session, but the current daemon
      // boot has now proved that its resume attempt ended with no token.
      if (root.draftLastAccount) {
        root.sessionMid = root.draftLastAccount
        clearSession()
      } else if (!root.draftStoreLoaded) {
        root.clearLastDraftOnLoad = true
      }
    }
    if (nowOk) {
      if (!wasOk) {
        root.reconciliationEpoch++
        // An account change that happened while this panel was closed never
        // reaches the teardown paths above — nothing observed it. The first
        // settled look at the new session is the last chance to clear the
        // old account's orphan drafts.
        if (root.pruneDraftAccountsExcept) root.pruneDraftAccountsExcept(nowMid)
      }
      root.resumeAttemptBootId = ""
      root.sessionMid = nowMid
      root.sessionEstablished = true
      root.sessionBootId = chatBoot
      root.restoreAmbiguousSends(nowMid)
      // The socket can appear before daemon resume finishes. Retry recovery
      // on the first ready state instead of spending the only attempt early.
      if (sock.connected) root.reconcileAfterConnect()
    } else if (sessionEnded && !retryableSessionError) {
      root.sessionMid = ""
      root.resumeAttemptBootId = ""
    }
    // Covers a shell restart that begins logged out, before an account was
    // observed in this Panel instance.
    if (!nowOk && terminalTeardown && !retryableSessionError
        && root.draftStoreLoaded
        && (nowStatus === "error" || sessionEndKey !== "")
        && !root.sessionEstablished && !root.initialIdleDraftHandled
        && root.draftLastAccount) {
      root.initialIdleDraftHandled = true
      root.clearDraftAccount(root.draftLastAccount)
    }

    // 與事件網域同一個 bootId：state.json 先到就把「見過哪一輪」記下，讓
    // events.json 的 catch-up 能判 daemon 重啟。反過來，這裡先看到 boot 換了
    // 也代表重啟 —— 上一輪的事件已不可得，直接重抓。
    var stBoot = root.state ? String(root.state.bootId || "") : ""
    var bootChanged = stBoot.length > 0 && root.lastBootId.length > 0
                      && stBoot !== root.lastBootId
    if (stBoot.length > 0) root.lastBootId = stBoot

    // 要自己抓歷史的三個條件：手上根本沒有這一間（loadedAt === 0，推進來的事件
    // 只接得動泡泡接不動整頁）；這個 daemon 不寫 events（舊版，或 events.json
    // 讀不出來 —— 缺口沒人補，只能照 lastTime 追）；或 daemon 換了一輪
    // （bootChanged —— 重啟前的事件再也拿不到）。推播流著、檔案也讀得出來的
    // 時候不用看 —— 缺口各自有人補。
    // 面板關著時 socket 也斷了，這時抓歷史只會留下假的「daemon 沒在跑」。
    if (sock.connected && (root.view === "chat" || root.twoPane) && root.activeChat) {
      var fresh = root.chatById(root.activeChat.mid)
      var moved = !!fresh && Number(fresh.lastTime || 0) > root.loadedAt
      if ((moved && (root.loadedAt === 0 || !root.eventsLive)) || bootChanged) {
        root.historyReloadAfterGeneration = Math.max(root.historyReloadAfterGeneration,
                                                     root.historyGen + 1)
        root.historyReloadChat = String(root.activeChat.mid || "")
        if (!root.loading) {
          root.reconciliationAttemptedEpoch = root.reconciliationEpoch
          root.loadHistory(root.activeChat.mid)
        }
      }
    }

    // 從通知點進來的那一間。shell 的 IPC 只有 open／close／toggle，帶不了參數，
    // 所以「要開哪一間」是 daemon 寫在 state 裡的。放在最後：這一輪不管前面做了
    // 什麼，openChat 才是對「現在該看哪一間」最後說話的那一個。
    var want = root.state ? root.state.wanted : null
    if (want && Number(want.seq || 0) > 0) {
      var wantBoot = root.state ? String(root.state.bootId || "") : ""
      if (wantBoot !== root.wantedBootId || Number(want.seq) > root.honouredWanted) {
        root.wantedBootId = wantBoot
        root.honouredWanted = Number(want.seq)
        root.pendingWanted = String(want.chat || "")
      }
    }
    // 認下和跳過去是兩件事：面板還沒開、或 socket 還沒接上的時候跳不了，
    // 那就等下一次寫檔（心跳最久 30 秒）再試一次。
    root.takeWanted()
  }

  // 換了帳號就等於換了一份資料，舊的一律丟掉；
  // historyCache 照鐵則 11 指派新物件，就地清空不會觸發綁定。
  function clearSession() {
    root.sessionEpoch++
    root.sessionBootId = ""
    // 上一個帳號在飛的那幾筆要當作取消。斷線走的是同一支，差別在這裡線還連著，
    // 回覆真的會回來：onReply 認的是 pending，清掉它慢一步的那份就進不了新的
    // session —— 不清的話上一個帳號沒送出去的那句話會被還進新帳號的輸入框，
    // 一張上一個帳號的圖也會補回剛清空的 imagePaths。
    root.dropInFlight()
    root.ambiguousSendsByChat = ({})
    root.historyRefreshNeeded = false
    root.historyRefreshRemovedByChat = ({})
    root.historyReloadAfterGeneration = 0
    root.historyReloadChat = ""
    root.persistAmbiguousSends(root.sessionMid, {}, {}, true)
    // sessionMid is still the account being left when parseState calls us.
    if (root.clearDraftAccount) root.clearDraftAccount(root.sessionMid)
    root.clearPreviewRetries()
    root.imageRetryQueue = ({})
    root.imageRetryAttempts = ({})
    root.imagePaths = ({})
    // 登出後那一筆通知指向的聊天室已經開不起來了（daemon 也會把 wanted 拿掉）。
    root.pendingWanted = ""
    root.activeChat = null
    root.setMessages([], true)
    // Programmatic composer cleanup must not look like a user edit while the
    // asynchronous draft file is still loading. Otherwise the next account
    // can overwrite its saved draft with this empty composer.
    root.resettingComposerAfterSend = true
    root.replyTarget = null
    root.unreadMarkCount = 0
    root.unreadMarkId = ""
    root.historyCache = ({})
    root.failedMessagesByChat = ({})
    // 換一個帳號就是換一批貼圖包（daemon 那邊也把快取清掉了）。最近用過的
    // 那一排是照 mid 綁出來的，會自己跟著換，不必在這裡動。
    root.setStickerOpen(false)
    root.stickerPacks = []
    root.stickerTab = ""
    root.stickerError = ""
    root.view = "list"
    root.notice = ""
    root.loading = false
    root.loadingOlder = false
    replyField.text = ""
    root.mentionPicks = []
    root.resettingComposerAfterSend = false
    root.composerEditedBeforeDraftLoad = false
    root.composerGenerationByChat = ({})
    root.composerDirtyByChat = ({})
    root.draftDurabilityPendingByChat = ({})
    root.composerDraftVersionByChat = ({})
    root.draftRecoveryHolds = ({})
    root.deferredDraftRequests = []
    root.deferredDraftPickers = []
    root.previewDecodeRetries = ({})
    root.draftRestoreEpoch++
    root.restoringDraft = false
  }

  // --------------------------------------------------------------- drafts

  FileView {
    id: draftFile
    path: root.stateDir + "/panel-drafts.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.handleDraftLoaded(text())
    onLoadFailed: function(error) { root.handleDraftLoadFailure(error) }
    onFileChanged: reload()
  }

  Timer {
    id: draftLoadRetryTimer
    interval: 250
    repeat: false
    onTriggered: draftFile.reload()
  }

  Timer {
    id: draftSaveTimer
    interval: 500
    repeat: false
    onTriggered: root.saveActiveDraft(false)
  }

  Component.onDestruction: {
    draftSaveTimer.stop()
    root.saveActiveDraft(false)
  }

  Timer {
    id: previewRetryTimer
    interval: 250
    repeat: false
    onTriggered: {
      if (!sock.connected) {
        root.previewRefreshNeeded = true
        return
      }
      var queued = Object.assign({}, root.previewRetryQueue)
      for (var i = 0; i < root.messages.length; i++) {
        var message = root.messages[i]
        var key = String(message.id || "")
        var retry = queued[key]
        if (!retry) continue
        // Publish the removal before the call: a refused fetch re-queues
        // itself against the live object, and entries no visible message
        // owns -- another chat's list holds them -- must survive to be
        // replayed when that chat is opened again.
        delete queued[key]
        root.previewRetryQueue = queued
        root.fetchPreview(message, retry.invalidate === true)
      }
    }
  }

  Timer {
    id: imageRetryTimer
    interval: 250
    repeat: false
    onTriggered: {
      if (!sock.connected) return
      var queued = root.imageRetryQueue
      root.imageRetryQueue = ({})
      for (var url in queued)
        root.fetchImage(url, queued[url] && queued[url].invalidate === true)
    }
  }

  function scheduleImageRetry(url, invalidate) {
    var key = String(url || "")
    if (Number(root.imageConsumers[key] || 0) <= 0) return false
    var attempts = Object.assign({}, root.imageRetryAttempts)
    var attempt = Number(attempts[key] || 0) + 1
    attempts[key] = attempt
    var queued = Object.assign({}, root.imageRetryQueue)
    queued[key] = { invalidate: invalidate === true }
    // The attempt counter only falls off on a finished retry: a URL whose
    // image left the visible list mid-congestion kept its entry for the
    // whole login. A re-asked URL simply starts its backoff again.
    var qkeys = Object.keys(queued)
    for (var drop = 0; drop < qkeys.length - root.mediaRetryMax; drop++) {
      delete queued[qkeys[drop]]
      delete attempts[qkeys[drop]]
    }
    root.imageRetryAttempts = attempts
    root.imageRetryQueue = queued
    imageRetryTimer.interval = Math.min(4000, 250 * Math.pow(2, attempt - 1))
    imageRetryTimer.restart()
    return true
  }

  function finishImageRetry(url) {
    var key = String(url || "")
    var attempts = Object.assign({}, root.imageRetryAttempts)
    delete attempts[key]
    root.imageRetryAttempts = attempts
  }

  function schedulePreviewRetry(id, invalidate, chat) {
    var key = String(id || "")
    // A worker can remain occupied through LINE's talk request, OBS headers,
    // and a streamed response. Keep retrying at the capped interval while the
    // message remains visible instead of duplicating those evolving deadlines.
    var attempts = Object.assign({}, root.previewRetryAttempts)
    var attempt = Number(attempts[key] || 0) + 1
    attempts[key] = attempt
    var queued = Object.assign({}, root.previewRetryQueue)
    // chat rides along so the reconnect replay keeps entries belonging to
    // another chat's list instead of dropping them unseen.
    queued[key] = {
      invalidate: invalidate === true
          || (queued[key] && queued[key].invalidate === true),
      chat: String(chat || ""),
    }
    // Cap the queue and its attempt counters together (see mediaRetryMax):
    // entries for chats nobody reopens only leave the replay list on
    // logout, which for a long-lived session is never.
    var qkeys = Object.keys(queued)
    for (var drop = 0; drop < qkeys.length - root.mediaRetryMax; drop++) {
      delete queued[qkeys[drop]]
      delete attempts[qkeys[drop]]
    }
    root.previewRetryAttempts = attempts
    root.previewRetryQueue = queued
    previewRetryTimer.interval = Math.min(4000, 250 * Math.pow(2, attempt - 1))
    previewRetryTimer.restart()
    return true
  }

  function finishPreviewRetry(id) {
    var attempts = Object.assign({}, root.previewRetryAttempts)
    delete attempts[String(id || "")]
    root.previewRetryAttempts = attempts
  }

  function finishPreviewDecode(id) {
    var decodeRetries = Object.assign({}, root.previewDecodeRetries)
    delete decodeRetries[String(id || "")]
    root.previewDecodeRetries = decodeRetries
  }

  function clearPreviewRetries() {
    previewRetryTimer.stop()
    root.previewRetryQueue = ({})
    root.previewRetryAttempts = ({})
  }

  function handleDraftLoaded(content) {
    var valid = false
    try {
      var parsed = JSON.parse(String(content || ""))
      valid = parsed && parsed.version === 1 && parsed.accounts
          && typeof parsed.accounts === "object"
    } catch (e) {}
    if (!valid) {
      root.handleDraftLoadFailure(FileViewError.Unknown)
      return
    }
    root.loadDraftStore(content)
  }

  function handleDraftLoadFailure(error) {
    if (root.draftStoreLoaded) return
    if (error === FileViewError.FileNotFound) {
      root.handleDraftLoaded(JSON.stringify({
        version: 1, revision: 0, lastAccount: "", accounts: {}
      }))
      return
    }
    root.draftLoadRetryAttempt++
    if (root.draftLoadRetryAttempt <= 5) {
      draftLoadRetryTimer.interval = Math.min(
        4000, 250 * Math.pow(2, root.draftLoadRetryAttempt - 1))
      draftLoadRetryTimer.restart()
    } else {
      root.draftStoreUnavailable = true
      root.notice = "草稿檔無法讀取；本次不會覆寫"
      if (root.flushDeferredDraftActions) root.flushDeferredDraftActions()
    }
  }

  function flushDeferredDraftActions() {
    var queued = root.deferredDraftRequests || []
    root.deferredDraftRequests = []
    var retry = []
    for (var i = 0; i < queued.length; i++) {
      var item = queued[i]
      var current = item && item.session === root.sessionEpoch
          && item.account === root.myMid
      var dispatched = current
          && root.request(item.cmd, item.extra, item.msgId)
      if (!dispatched) {
        // A disconnected socket is temporary. Keep the complete composer
        // snapshot and its optimistic bubble, then replay it on reconnect;
        // reducing it to one per-chat draft would lose an older submitted
        // message when the user has already started a newer one.
        if (current) retry.push(item)
        else if (item && item.msgId) root.dropMessage(item.msgId)
      }
    }
    root.deferredDraftRequests = retry
    root.flushDeferredDraftPickers()
  }

  function flushDeferredDraftPickers() {
    if ((!root.draftStoreLoaded && !root.draftStoreUnavailable) || root.pickerBusy()) return
    var queued = (root.deferredDraftPickers || []).slice()
    while (queued.length > 0) {
      var pickerRequest = queued.shift()
      if (!pickerRequest || pickerRequest.session !== root.sessionEpoch
          || pickerRequest.account !== root.myMid) continue
      root.deferredDraftPickers = queued
      root.pickFile(true, pickerRequest.generation, pickerRequest.chat,
                    pickerRequest.version)
      return
    }
    root.deferredDraftPickers = []
  }

  function pickerBusy() {
    return picker.running
  }

  function loadDraftStore(content) {
    var firstLoad = !root.draftStoreLoaded
    // Read both the account hint and revision boundary from the FileView
    // response before DraftStore.load merges newer in-process state.
    var loadedLastAccount = ""
    var diskLastAccount = ""
    var loadedSnapshotValid = false
    var diskRevision = 0
    var rawDrafts = null
    try {
      rawDrafts = JSON.parse(String(content || ""))
      if (rawDrafts && rawDrafts.version === 1 && rawDrafts.accounts
          && typeof rawDrafts.accounts === "object") {
        loadedSnapshotValid = true
        loadedLastAccount = String(rawDrafts.lastAccount || "")
        diskLastAccount = loadedLastAccount
        diskRevision = Number(rawDrafts.revision || 0)
        for (var diskAccount in rawDrafts.accounts) {
          var diskChats = rawDrafts.accounts[diskAccount] || {}
          for (var diskChat in diskChats)
            diskRevision = Math.max(
                diskRevision, Number(diskChats[diskChat].version || 0))
        }
      }
    } catch (e) {}
    var loaded = DraftStore.load(content)
    if (!loaded) {
      root.handleDraftLoadFailure(FileViewError.Unknown)
      return
    }
    root.draftLoadRetryAttempt = 0
    root.draftStoreUnavailable = false
    root.draftRevisionExhausted = false
    var before = loaded.accounts
    var next = Object.assign({}, before)
    var last = loaded.lastAccount
    // Logout can beat the asynchronous FileView load. Remember that account
    // and apply the deletion to the loaded snapshot before publishing it.
    var pendingClears = root.pendingDraftAccountClears || {}
    if (root.clearLastDraftOnLoad) {
      pendingClears = Object.assign({}, pendingClears)
      if (loadedLastAccount) pendingClears[loadedLastAccount] = true
      // A failed read has no account identity; retain the obligation for the
      // next valid notification.
      if (loadedLastAccount || (loadedSnapshotValid
          && Object.keys(rawDrafts.accounts).length === 0))
        root.clearLastDraftOnLoad = false
    }
    var recoveredEmptyComposers = ({})
    var changed = false
    var deletionChanged = false
    for (var clearAccount in pendingClears) {
      if (!next[clearAccount]) continue
      var clearMarker = pendingClears[clearAccount]
      var pendingBoundary = Number(
          clearMarker && typeof clearMarker === "object"
              ? clearMarker.revision || 0 : clearMarker || 0)
      var pendingAt = Number(
          clearMarker && typeof clearMarker === "object"
              ? clearMarker.at || 0 : 0)
      var clearBoundary = pendingBoundary > 0 ? pendingBoundary : diskRevision
      var survivingChats = Object.assign({}, next[clearAccount])
      for (var clearChat in survivingChats) {
        var clearDraft = survivingChats[clearChat] || {}
        var clearUpdatedAt = Number(clearDraft.updatedAt || 0)
        var clearByTime = pendingBoundary <= 0 && pendingAt > 0
            && clearUpdatedAt > 0
        if ((clearByTime && clearUpdatedAt <= pendingAt)
            || (!clearByTime
                && Number(clearDraft.version || 0) <= clearBoundary)) {
          delete survivingChats[clearChat]
          changed = true
          deletionChanged = true
        }
      }
      if (Object.keys(survivingChats).length > 0) next[clearAccount] = survivingChats
      else delete next[clearAccount]
    }
    // A settled idle observed before FileView answered remains proof of the
    // preceding logout even if a new login has started meanwhile. Delete the
    // old durable account first; edits staged by the new session are merged
    // below and therefore survive a fast logout/login cycle.
    var retiredDraftAccount = root.settledIdleDraftAccount || diskLastAccount
    var discardLoggedOut = root.settledIdleBeforeDraftLoad
        && !root.initialIdleDraftHandled && retiredDraftAccount
    if (discardLoggedOut && next[retiredDraftAccount]) {
      var retiredBoundary = root.settledIdleDraftRevision > 0
          ? root.settledIdleDraftRevision : diskRevision
      var retiredChats = Object.assign({}, next[retiredDraftAccount])
      for (var retiredChat in retiredChats) {
        var retiredDraft = retiredChats[retiredChat] || {}
        var retiredUpdatedAt = Number(retiredDraft.updatedAt || 0)
        var retireByTime = root.settledIdleDraftRevision <= 0
            && root.settledIdleDraftAt > 0 && retiredUpdatedAt > 0
        if ((retireByTime && retiredUpdatedAt <= root.settledIdleDraftAt)
            || (!retireByTime
                && Number(retiredDraft.version || 0) <= retiredBoundary)) {
          delete retiredChats[retiredChat]
          changed = true
          deletionChanged = true
        }
      }
      if (Object.keys(retiredChats).length > 0)
        next[retiredDraftAccount] = retiredChats
      else delete next[retiredDraftAccount]
    }
    // Apply staged removals with logout cleanup before attempting additions.
    // At the numeric ceiling, deletions remain safe even though a new draft
    // identity cannot be allocated.
    var staged = root.pendingDraftComposers || {}
    for (var stagedAccount in staged) {
      var stagedChats = staged[stagedAccount] || {}
      var accountChats = Object.assign({}, next[stagedAccount] || {})
      for (var stagedChat in stagedChats) {
        var edit = stagedChats[stagedChat]
        if (!edit || !edit.remove) continue
        // An acknowledgement cannot delete a newer draft another panel
        // persisted. A local removal keeps unresolved-send correlation only.
        if (!edit.acknowledged && accountChats[stagedChat] !== undefined) {
          var removed = accountChats[stagedChat] || null
          if (removed && Array.isArray(removed.ambiguousSends)
              && removed.ambiguousSends.length > 0)
            accountChats[stagedChat] = { ambiguousSends: removed.ambiguousSends }
          else delete accountChats[stagedChat]
          changed = true
          deletionChanged = true
        }
      }
      if (Object.keys(accountChats).length > 0) next[stagedAccount] = accountChats
      else delete next[stagedAccount]
    }
    if (deletionChanged) {
      var deletionHint = root.myMid && next[root.myMid] ? root.myMid : last
      var deletionMerge = DraftStore.merge(before, next, deletionHint)
      if (!deletionMerge) {
        root.draftStore = before
        root.draftLastAccount = loaded.lastAccount
        root.draftStoreLoaded = true
        root.markDraftStoreUnavailable()
        return
      }
      before = deletionMerge.accounts
      next = Object.assign({}, before)
      last = deletionMerge.lastAccount
      root.draftStore = before
      root.draftLastAccount = last
      DraftWriter.save(draftFile.path, DraftStore.serialize())
      changed = false
    }
    root.pendingDraftAccountClears = ({})
    if (root.settledIdleBeforeDraftLoad) root.initialIdleDraftHandled = true
    root.settledIdleBeforeDraftLoad = false
    root.settledIdleDraftAccount = ""
    root.settledIdleDraftRevision = 0
    root.settledIdleDraftAt = 0
    var remainingStaged = ({})
    for (var retainedAccount in staged) {
      var retainedChats = staged[retainedAccount] || {}
      var retainedAccountChats = ({})
      for (var retainedChat in retainedChats) {
        if (retainedChats[retainedChat] && !retainedChats[retainedChat].remove)
          retainedAccountChats[retainedChat] = retainedChats[retainedChat]
      }
      if (Object.keys(retainedAccountChats).length > 0)
        remainingStaged[retainedAccount] = retainedAccountChats
    }
    root.pendingDraftComposers = remainingStaged
    staged = remainingStaged
    // Composer additions made before FileView answered are applied after all
    // independent deletions have been published.
    for (var stagedAddAccount in staged) {
      var stagedAddChats = staged[stagedAddAccount] || {}
      var addedAccountChats = Object.assign({}, next[stagedAddAccount] || {})
      for (var stagedAddChat in stagedAddChats) {
        var stagedEdit = stagedAddChats[stagedAddChat]
        if (stagedEdit) {
          var persistedEdit = Object.assign({}, stagedEdit)
          delete persistedEdit.generation
          delete persistedEdit.emptyComposerGeneration
          delete persistedEdit.baseVersion
          var allocatedRevision = DraftStore.allocateRevision()
          if (allocatedRevision <= 0) {
            root.draftStore = before
            root.draftLastAccount = last
            root.draftStoreLoaded = true
            root.markDraftStoreUnavailable()
            return
          }
          var existingAmbiguous = Array.isArray(
              (addedAccountChats[stagedAddChat] || {}).ambiguousSends)
            ? addedAccountChats[stagedAddChat].ambiguousSends : []
          addedAccountChats[stagedAddChat] = Object.assign({}, persistedEdit, {
            version: allocatedRevision,
            updatedAt: Date.now()
          })
          if (existingAmbiguous.length > 0)
            addedAccountChats[stagedAddChat].ambiguousSends = existingAmbiguous.slice()
          var pendingAfterLoad = Object.assign({}, root.pending || {})
          var pendingChanged = false
          for (var pendingId in pendingAfterLoad) {
            var pendingSend = pendingAfterLoad[pendingId]
            if (!pendingSend || !pendingSend.spendsDraft
                || Number(pendingSend.draftVersion || 0) !== 0
                || String(pendingSend.chat || "") !== String(stagedAddChat)
                || stagedEdit.generation === undefined
                || Number(pendingSend.draftGeneration || 0)
                   !== Number(stagedEdit.generation || 0)) continue
            pendingAfterLoad[pendingId] = Object.assign({}, pendingSend, {
              draftVersion: allocatedRevision
            })
            pendingChanged = true
          }
          if (pendingChanged) root.pending = pendingAfterLoad
          var deferredAfterLoad = (root.deferredDraftRequests || []).slice()
          var deferredChanged = false
          for (var deferredIndex = 0;
               deferredIndex < deferredAfterLoad.length; deferredIndex++) {
            var deferredSend = deferredAfterLoad[deferredIndex]
            var deferredExtra = deferredSend && deferredSend.extra
            if (!deferredExtra || deferredSend.account !== stagedAddAccount
                || String(deferredExtra.chat || "") !== String(stagedAddChat)
                || Number(deferredExtra._draftVersion || 0) !== 0
                || stagedEdit.generation === undefined
                || Number(deferredExtra._draftGeneration || 0)
                   !== Number(stagedEdit.generation || 0)) continue
            deferredAfterLoad[deferredIndex] = Object.assign({}, deferredSend, {
              extra: Object.assign({}, deferredExtra, {
                _draftVersion: allocatedRevision
              })
            })
            deferredChanged = true
          }
          if (deferredChanged)
            root.deferredDraftRequests = deferredAfterLoad
          if (root.rebindPickerDraft)
            root.rebindPickerDraft(stagedAddAccount, stagedAddChat,
                                   stagedEdit.generation, allocatedRevision)
          if (stagedEdit.emptyComposerGeneration !== undefined) {
            if (!recoveredEmptyComposers[stagedAddAccount])
              recoveredEmptyComposers[stagedAddAccount] = ({})
            recoveredEmptyComposers[stagedAddAccount][stagedAddChat] = {
              generation: Number(stagedEdit.emptyComposerGeneration),
              version: allocatedRevision
            }
          }
        }
        changed = true
      }
      if (Object.keys(addedAccountChats).length > 0)
        next[stagedAddAccount] = addedAccountChats
      else delete next[stagedAddAccount]
    }
    var stagedAmbiguous = root.pendingAmbiguousByAccount || {}
    for (var ambiguousAccount in stagedAmbiguous) {
      // clearDraftAccount() removed every marker staged by the old session
      // when it recorded pendingClears. Anything present now belongs to a
      // later login and must be merged after the old loaded account is gone.
      var ambiguousEdit = stagedAmbiguous[ambiguousAccount] || {}
      var ambiguousChats = ambiguousEdit.byChat || {}
      var ambiguousTouched = Object.assign({}, ambiguousEdit.changedChats || {})
      if (ambiguousEdit.clearAll)
        for (var storedChat in (next[ambiguousAccount] || {}))
          ambiguousTouched[storedChat] = true
      next = root.accountsWithAmbiguous(next, ambiguousAccount,
                                        ambiguousChats, ambiguousTouched,
                                        ambiguousEdit.removedByChat || {},
                                        !!ambiguousEdit.clearAll)
      changed = true
    }
    if (changed) {
      var lastHint = root.myMid && next[root.myMid] ? root.myMid : last
      var cleaned = DraftStore.merge(before, next, lastHint)
      if (!cleaned) {
        root.draftStore = before
        root.draftLastAccount = last
        root.draftStoreLoaded = true
        root.markDraftStoreUnavailable()
        return
      }
      next = cleaned.accounts
      last = cleaned.lastAccount
      DraftWriter.save(draftFile.path, DraftStore.serialize())
    }
    root.pendingDraftComposers = ({})
    root.pendingAmbiguousByAccount = ({})
    root.draftLastAccount = last
    root.draftStore = next
    root.draftStoreLoaded = true
    if (root.myMid && root.restoreAmbiguousSends)
      root.restoreAmbiguousSends(root.myMid)
    if (firstLoad && root.activeChat) {
      var activeChatId = String(root.activeChat.mid || "")
      var recoveredEmpty = (recoveredEmptyComposers[root.myMid] || {})[activeChatId]
      var deferredActive = null
      var deferredDrafts = root.deferredDraftRequests || []
      for (var deferredAt = 0; deferredAt < deferredDrafts.length; deferredAt++) {
        var deferredCandidate = deferredDrafts[deferredAt]
        var deferredCandidateExtra = deferredCandidate && deferredCandidate.extra
        if (deferredCandidateExtra
            && String(deferredCandidateExtra.chat || "") === activeChatId
            && Number(deferredCandidateExtra._draftGeneration || 0)
               === root.composerGenerationFor(activeChatId)) {
          deferredActive = deferredCandidateExtra
          break
        }
      }
      var composerEmpty = (typeof replyField === "undefined"
          || String(replyField.text || "").length === 0)
          && !root.replyTarget
          && (!Array.isArray(root.mentionPicks) || root.mentionPicks.length === 0)
      if (deferredActive && composerEmpty) {
        // submit() already cleared this exact generation. Keep its durable
        // recovery copy, but do not paint submitted text back into the editor
        // while the deferred request is being moved onto the socket.
        var deferredVersions = Object.assign({}, root.composerDraftVersionByChat)
        deferredVersions[activeChatId] = Number(
          deferredActive._draftVersion || 0)
        root.composerDraftVersionByChat = deferredVersions
        var deferredClean = Object.assign({}, root.composerDirtyByChat)
        deferredClean[activeChatId] = false
        root.composerDirtyByChat = deferredClean
      } else if (recoveredEmpty
          && root.composerGenerationFor(activeChatId) === recoveredEmpty.generation
          && composerEmpty) {
        var recoveredVersions = Object.assign({}, root.composerDraftVersionByChat)
        recoveredVersions[activeChatId] = recoveredEmpty.version
        root.composerDraftVersionByChat = recoveredVersions
        var recoveredClean = Object.assign({}, root.composerDirtyByChat)
        recoveredClean[activeChatId] = false
        root.composerDirtyByChat = recoveredClean
      } else if (root.composerEditedBeforeDraftLoad) root.saveActiveDraft(false)
      else root.restoreDraft(root.activeChat.mid)
    }
    if (root.pruneDraftAccountsExcept) root.pruneDraftAccountsExcept(root.myMid)
    root.composerEditedBeforeDraftLoad = false
    if (root.flushDeferredDraftActions) root.flushDeferredDraftActions()
  }

  function markDraftStoreUnavailable() {
    root.draftRevisionExhausted = true
    root.draftStoreUnavailable = true
    root.notice = "草稿版本已達上限；本次不會覆寫"
    if (root.flushDeferredDraftActions) root.flushDeferredDraftActions()
  }

  function stageExhaustedComposer() {
    var loaded = root.draftStoreLoaded
    var chat = root.activeChat ? String(root.activeChat.mid || "") : ""
    var baseVersion = Number(
        (root.composerDraftVersionByChat || {})[chat] || 0)
    root.draftStoreLoaded = false
    root.composerEditedBeforeDraftLoad = true
    root.saveActiveDraft(false)
    root.draftStoreLoaded = loaded
    var staged = Object.assign({}, root.pendingDraftComposers)
    var stagedChats = Object.assign({}, staged[root.myMid] || {})
    if (chat && stagedChats[chat] && baseVersion > 0) {
      stagedChats[chat] = Object.assign({}, stagedChats[chat], {
        baseVersion: baseVersion
      })
      staged[root.myMid] = stagedChats
      root.pendingDraftComposers = staged
    }
  }

  function writeDraftStore(next) {
    var hint = root.myMid && next[root.myMid] ? root.myMid : undefined
    var merged = DraftStore.merge(root.draftStore, next, hint)
    if (!merged) {
      root.markDraftStoreUnavailable()
      return false
    }
    root.draftStore = merged.accounts
    root.draftLastAccount = merged.lastAccount
    if (DraftWriter.save(draftFile.path, DraftStore.serialize()) === false)
      return false
    return true
  }

  function confirmDraftSaved(content) {
    var parsed = null
    try { parsed = JSON.parse(String(content || "")) } catch (e) {}
    if (!parsed || !parsed.accounts || !root.myMid) return
    var account = parsed.accounts[root.myMid] || {}
    var pending = Object.assign({}, root.draftDurabilityPendingByChat)
    for (var chat in pending) {
      var expected = Number(pending[chat] || 0)
      var saved = account[chat] || null
      if ((expected > 0 && saved && Number(saved.version || 0) === expected)
          || (expected === 0 && !saved)) delete pending[chat]
    }
    root.draftDurabilityPendingByChat = pending
  }

  function accountsWithAmbiguous(accounts, account, byChat, changedChats, removedByChat, clearAll) {
    return PanelKit.accountsWithAmbiguous(accounts, account, byChat,
                                          changedChats, removedByChat, clearAll)
  }

  function persistAmbiguousSends(account, byChat, changedChats, clearAll, removedByChat) {
    if (!account) return
    if (!root.draftStoreLoaded) {
      var staged = Object.assign({}, root.pendingAmbiguousByAccount)
      var old = staged[String(account)] || {}
      var stagedChats = Object.assign({}, old.byChat || {})
      var stagedTouched = Object.assign({}, old.changedChats || {})
      var stagedRemoved = Object.assign({}, old.removedByChat || {})
      var edits = changedChats || byChat || {}
      for (var stagedChat in edits) {
        if (!edits[stagedChat]) continue
        stagedTouched[stagedChat] = true
        stagedRemoved[stagedChat] = Object.assign({}, stagedRemoved[stagedChat] || {},
                                                  (removedByChat || {})[stagedChat] || {})
        var queued = Array.isArray(stagedChats[stagedChat])
          ? stagedChats[stagedChat].slice() : []
        var queuedIds = {}
        for (var qi = 0; qi < queued.length; qi++)
          if (queued[qi] && queued[qi].requestId)
            queuedIds[String(queued[qi].requestId)] = true
        var additions = Array.isArray(byChat[stagedChat]) ? byChat[stagedChat] : []
        for (var si = 0; si < additions.length; si++) {
          var additionId = String((additions[si] || {}).requestId || "")
          if (additionId && !queuedIds[additionId]) {
            queuedIds[additionId] = true
            queued.push(additions[si])
          }
        }
        stagedChats[stagedChat] = queued.filter(function(entry) {
          return entry && entry.requestId
              && !stagedRemoved[stagedChat][String(entry.requestId)]
        })
      }
      staged[String(account)] = { byChat: stagedChats, changedChats: stagedTouched,
                                  removedByChat: stagedRemoved,
                                  clearAll: !!clearAll || !!old.clearAll }
      root.pendingAmbiguousByAccount = staged
      return
    }
    var latest = DraftStore.snapshot()
    root.draftStore = latest.accounts
    root.draftLastAccount = latest.lastAccount
    var touched = Object.assign({}, changedChats || byChat || {})
    if (clearAll)
      for (var storedChat in (latest.accounts[String(account)] || {})) touched[storedChat] = true
    var written = root.writeDraftStore(
        root.accountsWithAmbiguous(latest.accounts, String(account),
                                   byChat, touched,
                                   removedByChat || {}, !!clearAll))
    if (written === false) {
      // Keep correlation in memory when the shared revision clock cannot
      // publish an addition. A later restore must not mistake that absence
      // from disk for confirmation by another panel.
      var loaded = root.draftStoreLoaded
      root.draftStoreLoaded = false
      root.persistAmbiguousSends(account, byChat, touched, clearAll,
                                 removedByChat || {})
      root.draftStoreLoaded = loaded
    }
  }

  function restoreAmbiguousSends(account) {
    if (!root.draftStoreLoaded || !account) return
    var accounts = root.draftStore
    var staged = (root.pendingAmbiguousByAccount || {})[String(account)] || null
    if (staged) {
      accounts = root.accountsWithAmbiguous(
          accounts, String(account), staged.byChat || {},
          staged.changedChats || {}, staged.removedByChat || {},
          !!staged.clearAll)
    }
    var chats = accounts[String(account)] || {}
    var next = {}
    for (var chat in chats) {
      var saved = Array.isArray((chats[chat] || {}).ambiguousSends)
        ? chats[chat].ambiguousSends : []
      if (saved.length > 0) next[chat] = saved.slice()
    }
    var previous = root.ambiguousSendsByChat || {}
    if (JSON.stringify(next) === JSON.stringify(previous)) return
    var removals = Object.assign({}, root.historyRefreshRemovedByChat || {})
    var removedEntries = {}
    for (var previousChat in previous) {
      var before = Array.isArray(previous[previousChat]) ? previous[previousChat] : []
      var after = Array.isArray(next[previousChat]) ? next[previousChat] : []
      var afterTokens = {}
      for (var ai = 0; ai < after.length; ai++)
        if (after[ai] && after[ai].requestId)
          afterTokens[String(after[ai].requestId)] = true
      for (var bi = 0; bi < before.length; bi++)
        if (before[bi] && before[bi].requestId
            && !afterTokens[String(before[bi].requestId)]) {
          var removedForChat = Array.isArray(removedEntries[previousChat])
              ? removedEntries[previousChat] : []
          removedForChat.push(before[bi])
          removedEntries[previousChat] = removedForChat
          removals[previousChat] = Math.max(Number(removals[previousChat] || 0),
                                            root.historyGen + 1)
        }
    }
    root.ambiguousSendsByChat = next
    root.historyRefreshRemovedByChat = removals
    root.historyRefreshNeeded = Object.keys(next).length > 0 || Object.keys(removals).length > 0
    if (root.activeChat) {
      var mid = String(root.activeChat.mid || "")
      var activeBefore = Array.isArray(previous[mid]) ? previous[mid] : []
      var activeAfter = Array.isArray(next[mid]) ? next[mid] : []
      if (JSON.stringify(activeBefore) !== JSON.stringify(activeAfter)) {
        var removedActive = Array.isArray(removedEntries[mid]) ? removedEntries[mid] : []
        for (var ri = 0; ri < removedActive.length; ri++) {
          var confirmed = removedActive[ri]
          if (confirmed && confirmed.spendsDraft
              && Number(confirmed.draftVersion || 0) > 0
              && Number(root.composerDraftVersionByChat[mid] || 0)
                  === Number(confirmed.draftVersion)
              && !root.composerDirtyByChat[mid]) {
            root.draftRestoreEpoch++
            root.restoringDraft = false
            root.resetComposerAfterSuccessfulSend()
            var versions = Object.assign({}, root.composerDraftVersionByChat)
            versions[mid] = 0
            root.composerDraftVersionByChat = versions
            break
          }
        }
        root.setMessages(root.withDay(root.preserveAmbiguousBubbles(mid, root.messages)), false)
        if (sock.connected && !root.loading) root.loadHistory(mid)
      }
    }
  }

  function scheduleDraftSave() {
    if (!root.draftStoreLoaded || root.restoringDraft
        || !root.activeChat || !root.myMid) return
    // A real debounce. The stop-and-save-it-here version this replaces made
    // the 500ms timer below dead code: every keystroke paid a full deep-copy,
    // serialize and atomic write of the draft store on the UI thread, and
    // burned a store revision. saveActiveDraft() is self-guarding
    // (restoringDraft + per-chat dirty), and openChat/backToList flush the
    // composer themselves before switching, so the trailing save is safe.
    draftSaveTimer.restart()
  }

  function stopDraftSaveTimer() {
    draftSaveTimer.stop()
  }

  function noteComposerEdit() {
    if (!root.restoringDraft && !root.resettingComposerAfterSend) {
      root.composerGeneration++
      if (root.activeChat) {
        var generations = Object.assign({}, root.composerGenerationByChat)
        var chat = String(root.activeChat.mid || "")
        generations[chat] = root.composerGeneration
        root.composerGenerationByChat = generations
        var dirty = Object.assign({}, root.composerDirtyByChat)
        dirty[chat] = true
        root.composerDirtyByChat = dirty
      }
      if (!root.draftStoreLoaded) root.composerEditedBeforeDraftLoad = true
    }
  }

  function composerGenerationFor(chat) {
    return Number(root.composerGenerationByChat[String(chat || "")] || 0)
  }

  function resetComposerAfterSuccessfulSend() {
    root.resettingComposerAfterSend = true
    replyField.text = ""
    root.mentionPicks = []
    root.replyTarget = null
    root.resettingComposerAfterSend = false
  }

  function restorePendingComposer(chat, draft, version) {
    if (!draft || !root.activeChat
        || String(root.activeChat.mid || "") !== String(chat || "")) return
    var restoreEpoch = ++root.draftRestoreEpoch
    root.restoringDraft = true
    replyField.text = String(draft.text || "")
    root.mentionPicks = Array.isArray(draft.mentions) ? draft.mentions : []
    root.replyTarget = draft.replyTo || null
    var clean = Object.assign({}, root.composerDirtyByChat)
    clean[String(chat || "")] = false
    root.composerDirtyByChat = clean
    var versions = Object.assign({}, root.composerDraftVersionByChat)
    versions[String(chat || "")] = Number(version || 0)
    root.composerDraftVersionByChat = versions
    var cursor = Number(draft.cursor || 0)
    Qt.callLater(function() {
      if (restoreEpoch !== root.draftRestoreEpoch) return
      replyField.cursorPosition = Math.max(0, Math.min(cursor, replyField.length))
      root.restoringDraft = false
    })
  }

  function pendingDraftSend(chat, draftVersion) {
    var ambiguous = root.ambiguousSendsByChat[String(chat || "")]
    if (Array.isArray(ambiguous))
      for (var ai = 0; ai < ambiguous.length; ai++)
        if (ambiguous[ai] && ambiguous[ai].spendsDraft
            && (draftVersion === undefined
                || Number(ambiguous[ai].draftVersion || 0) === Number(draftVersion || 0)))
          return true
    for (var id in root.pending) {
      var entry = root.pending[id]
      // A live request can still fail and restore its submitted draft even if
      // a newer composer revision has already been saved. Keep that newer
      // revision until the request resolves; persisted ambiguity markers are
      // version-filtered above because they can outlive later explicit edits.
      if (entry && entry.spendsDraft
          && String(entry.chat || "") === String(chat || ""))
        return true
    }
    if (root.deferredDraftSend(chat)) return true
    return false
  }

  function deferredDraftSend(chat) {
    var deferred = root.deferredDraftRequests || []
    for (var i = 0; i < deferred.length; i++) {
      var extra = deferred[i] && deferred[i].extra
      if (extra && String(extra.chat || "") === String(chat || "")) return true
    }
    return false
  }

  function draftRecoveryHeld(chat, version, generation, composerGeneration) {
    var hold = (root.draftRecoveryHolds || {})[String(chat || "")] || null
    if (!hold) return false
    var sameDraft = Number(version || 0) > 0
        ? Number(hold.version || 0) === Number(version)
        : generation === undefined
          || Number(hold.generation || 0) === Number(generation)
    return sameDraft && (composerGeneration === undefined
        || Number(hold.emptyGeneration || 0) === Number(composerGeneration))
  }

  function draftVersionInFlight(chat, version, generation) {
    for (var id in root.pending) {
      var entry = root.pending[id]
      if (entry && entry.spendsDraft
          && String(entry.chat || "") === String(chat || "")
          && Number(entry.draftVersion || 0) === Number(version || 0)
          && (Number(version || 0) > 0 || generation === undefined
              || Number(entry.draftGeneration || 0) === Number(generation)))
        return true
    }
    return false
  }

  function saveActiveDraft(removeEmpty) {
    if (!root.activeChat || !root.myMid || root.restoringDraft) return
    var account = root.myMid
    var chat = String(root.activeChat.mid || "")
    if (!chat) return
    var body = String(replyField.text || "")
    var target = root.replyTarget
    if (root.draftStoreLoaded === false) {
      if (!root.composerEditedBeforeDraftLoad) return
      var waiting = Object.assign({}, root.pendingDraftComposers)
      var waitingChats = Object.assign({}, waiting[account] || {})
      var stagedGeneration = root.composerGenerationFor
          ? root.composerGenerationFor(chat) : Number(root.composerGeneration || 0)
      // The staged copy is the only durable recovery source while the store
      // cannot be read. Keep it until the in-flight send succeeds; otherwise
      // switching chats after typing and erasing a next sentence loses the
      // original message if the send later fails.
      if (body.length === 0 && !target
          && (root.pendingDraftSend(chat)
              || (root.draftRecoveryHeld
                  && root.draftRecoveryHeld(
                    chat, 0,
                    Number(waitingChats[chat] && waitingChats[chat].generation || 0),
                    stagedGeneration)))) {
        if (waitingChats[chat]) {
          var recoveryDraft = Object.assign({}, waitingChats[chat])
          recoveryDraft.emptyComposerGeneration = stagedGeneration
          waitingChats[chat] = recoveryDraft
          waiting[account] = waitingChats
          root.pendingDraftComposers = waiting
        }
        root.composerEditedBeforeDraftLoad = false
        return
      }
      waitingChats[chat] = body.length === 0 && !target
        ? { remove: true, generation: stagedGeneration }
        : {
          text: body,
          cursor: Number(replyField.cursorPosition || 0),
          mentions: Array.isArray(root.mentionPicks) ? root.mentionPicks : [],
          replyTo: target ? { id: String(target.id || ""),
                              fromName: String(target.fromName || ""),
                              text: String(target.text || "") } : null,
          generation: stagedGeneration
        }
      waiting[account] = waitingChats
      root.pendingDraftComposers = waiting
      root.composerEditedBeforeDraftLoad = false
      return
    }
    // Allocate the version from the shared in-process snapshot. Another Panel
    // may have merged this same chat before its file notification reaches us.
    var latest = DraftStore.snapshot()
    root.draftStore = latest.accounts
    root.draftLastAccount = latest.lastAccount
    var next = Object.assign({}, latest.accounts)
    var chats = Object.assign({}, next[account] || {})
    var previous = chats[chat] || null
    // An unchanged restored composer is only a view of the shared store.
    // Leaving it must not overwrite a newer edit from another panel or mint a
    // new revision for text this panel did not change.
    if (!root.composerDirtyByChat[chat]) return
    // The empty composer may mean its contents are in flight. Keep the saved
    // revision until an affirmative reply spends it; a close/chat switch must
    // not turn a later send failure into data loss.
    if (body.length === 0 && !target
        && ((root.draftVersionInFlight
              && root.draftVersionInFlight(chat, previous && previous.version))
            || (root.deferredDraftSend && root.deferredDraftSend(chat)))) return
    // A disconnected send keeps its correlation marker; an explicit removal
    // may clear the composer while retaining that marker for reconciliation.
    if (body.length === 0 && !target && !removeEmpty
        && (root.pendingDraftSend(chat, previous && previous.version)
            || (root.draftRecoveryHeld && root.draftRecoveryHeld(
              chat, Number(previous && previous.version || 0), undefined,
              root.composerGenerationFor(chat))))) return
    if (body.length === 0 && !target) {
      if (previous && Array.isArray(previous.ambiguousSends)
          && previous.ambiguousSends.length > 0)
        chats[chat] = { ambiguousSends: previous.ambiguousSends }
      else delete chats[chat]
      var clearedHolds = Object.assign({}, root.draftRecoveryHolds)
      delete clearedHolds[chat]
      root.draftRecoveryHolds = clearedHolds
    } else if (body.length > 0 || target) {
      var holds = Object.assign({}, root.draftRecoveryHolds)
      delete holds[chat]
      root.draftRecoveryHolds = holds
      var allocated = DraftStore.allocateRevision()
      if (allocated <= 0) {
        root.markDraftStoreUnavailable()
        if (root.stageExhaustedComposer) root.stageExhaustedComposer()
        return
      }
      chats[chat] = {
        text: body,
        cursor: Number(replyField.cursorPosition || 0),
        mentions: Array.isArray(root.mentionPicks) ? root.mentionPicks : [],
        replyTo: target ? { id: String(target.id || ""),
                            fromName: String(target.fromName || ""),
                            text: String(target.text || "") } : null,
        // The shared file revision never rewinds when this chat is deleted.
        // Using its next value makes the draft identity survive deletion and
        // recreation instead of reusing version 1 for unrelated contents.
        version: allocated,
        updatedAt: Date.now()
      }
      if (previous && Array.isArray(previous.ambiguousSends))
        chats[chat].ambiguousSends = previous.ambiguousSends
    }
    if (Object.keys(chats).length > 0) next[account] = chats
    else delete next[account]
    if (root.writeDraftStore(next) === false) {
      root.stageExhaustedComposer()
      return
    }
    if (body.length === 0 && !target && root.draftStoreUnavailable) {
      var retainedStaged = Object.assign({}, root.pendingDraftComposers)
      var retainedChats = Object.assign({}, retainedStaged[account] || {})
      delete retainedChats[chat]
      if (Object.keys(retainedChats).length > 0)
        retainedStaged[account] = retainedChats
      else delete retainedStaged[account]
      root.pendingDraftComposers = retainedStaged
    }
    var versions = Object.assign({}, root.composerDraftVersionByChat)
    versions[chat] = Number(chats[chat] && chats[chat].version || 0)
    root.composerDraftVersionByChat = versions
    var durability = Object.assign({}, root.draftDurabilityPendingByChat)
    durability[chat] = versions[chat]
    root.draftDurabilityPendingByChat = durability
    // This composer is now merged into the process-wide store. Durability is
    // tracked separately above so a coalesced FileView write cannot make an
    // unchanged older panel overwrite a newer panel's edit on close.
    var clean = Object.assign({}, root.composerDirtyByChat)
    clean[chat] = false
    root.composerDirtyByChat = clean
  }

  function restoreDraft(chat) {
    var stagedAccount = ((root.pendingDraftComposers || {})[root.myMid] || {})
    var stagedRestore = root.draftStoreUnavailable
        && Object.prototype.hasOwnProperty.call(
          stagedAccount, String(chat || ""))
    if (!root.draftStoreLoaded && !stagedRestore) return
    var restoreEpoch = ++root.draftRestoreEpoch
    root.restoringDraft = true
    var account = stagedRestore ? stagedAccount : (root.draftStore[root.myMid] || {})
    var saved = account[String(chat || "")] || null
    if (saved && saved.remove) saved = null
    replyField.text = saved ? String(saved.text || "") : ""
    root.mentionPicks = saved && Array.isArray(saved.mentions) ? saved.mentions : []
    root.replyTarget = saved && saved.replyTo ? saved.replyTo : null
    var clean = Object.assign({}, root.composerDirtyByChat)
    clean[String(chat || "")] = stagedRestore && !!saved
    root.composerDirtyByChat = clean
    var versions = Object.assign({}, root.composerDraftVersionByChat)
    versions[String(chat || "")] = stagedRestore
        ? 0 : Number(saved && saved.version || 0)
    root.composerDraftVersionByChat = versions
    if (stagedRestore && saved && saved.generation !== undefined) {
      var generations = Object.assign({}, root.composerGenerationByChat)
      generations[String(chat || "")] = Number(saved.generation || 0)
      root.composerGenerationByChat = generations
      root.composerGeneration = Math.max(
        root.composerGeneration, Number(saved.generation || 0))
    }
    var cursor = saved ? Number(saved.cursor || 0) : 0
    Qt.callLater(function() {
      if (restoreEpoch !== root.draftRestoreEpoch) return
      replyField.cursorPosition = Math.max(0, Math.min(cursor, replyField.length))
      root.restoringDraft = false
    })
  }

  function clearDraft(chat, expectedVersion, expectedGeneration, expectedGenerationOwner) {
    if (!root.myMid || !chat) return
    if (root.draftRecoveryHeld
        && root.draftRecoveryHeld(chat, expectedVersion, expectedGeneration)) {
      var remainingHolds = Object.assign({}, root.draftRecoveryHolds)
      delete remainingHolds[String(chat)]
      root.draftRecoveryHolds = remainingHolds
    }
    var exhaustedChats = ((root.pendingDraftComposers || {})[root.myMid] || {})
    var stagedExhausted = root.draftStoreUnavailable
        && Object.prototype.hasOwnProperty.call(exhaustedChats, String(chat))
    if (stagedExhausted && root.draftStoreLoaded) {
      var exhaustedEdit = exhaustedChats[String(chat)] || null
      if (exhaustedEdit && expectedGeneration !== undefined
          && Number(exhaustedEdit.generation || 0) > Number(expectedGeneration)) return
      var retainedStaged = Object.assign({}, root.pendingDraftComposers)
      var retainedChats = Object.assign({}, retainedStaged[root.myMid] || {})
      delete retainedChats[String(chat)]
      if (Object.keys(retainedChats).length > 0)
        retainedStaged[root.myMid] = retainedChats
      else delete retainedStaged[root.myMid]
      root.pendingDraftComposers = retainedStaged
      var exhaustedLatest = DraftStore.snapshot()
      var exhaustedNext = Object.assign({}, exhaustedLatest.accounts)
      var exhaustedAccount = Object.assign({}, exhaustedNext[root.myMid] || {})
      root.draftStore = exhaustedLatest.accounts
      root.draftLastAccount = exhaustedLatest.lastAccount
      var ownedVersion = Number(exhaustedEdit && exhaustedEdit.baseVersion || 0)
      var exhaustedSaved = exhaustedAccount[String(chat)] || null
      if (ownedVersion > 0 && exhaustedSaved
          && Number(exhaustedSaved.version || 0) === ownedVersion) {
        delete exhaustedAccount[String(chat)]
        if (Object.keys(exhaustedAccount).length > 0)
          exhaustedNext[root.myMid] = exhaustedAccount
        else delete exhaustedNext[root.myMid]
        root.writeDraftStore(exhaustedNext)
      }
      if (root.activeChat
          && String(root.activeChat.mid || "") === String(chat)
          && expectedGeneration !== undefined
          && root.composerGenerationFor(chat) === Number(expectedGeneration)) {
        root.draftRestoreEpoch++
        root.restoringDraft = false
        root.resetComposerAfterSuccessfulSend()
        var exhaustedClean = Object.assign({}, root.composerDirtyByChat)
        exhaustedClean[String(chat)] = false
        root.composerDirtyByChat = exhaustedClean
      }
      var exhaustedVersions = Object.assign({}, root.composerDraftVersionByChat)
      exhaustedVersions[String(chat)] = 0
      root.composerDraftVersionByChat = exhaustedVersions
      return
    }
    if (root.draftStoreLoaded === false) {
      var staged = Object.assign({}, root.pendingDraftComposers)
      var stagedChats = Object.assign({}, staged[root.myMid] || {})
      var stagedEdit = stagedChats[String(chat)] || null
      if (stagedEdit && expectedGeneration !== undefined
          && Number(stagedEdit.generation || 0) > Number(expectedGeneration)) return
      stagedChats[String(chat)] = {
        remove: true,
        acknowledged: true,
        generation: expectedGeneration !== undefined
          ? Number(expectedGeneration) : Number(stagedEdit && stagedEdit.generation || 0)
      }
      staged[root.myMid] = stagedChats
      root.pendingDraftComposers = staged
      if (root.activeChat
          && String(root.activeChat.mid || "") === String(chat)
          && expectedGeneration !== undefined
          && root.composerGenerationFor(chat) === Number(expectedGeneration)) {
        root.draftRestoreEpoch++
        root.restoringDraft = false
        root.resetComposerAfterSuccessfulSend()
        var clean = Object.assign({}, root.composerDirtyByChat)
        clean[String(chat)] = false
        root.composerDirtyByChat = clean
      }
      return
    }
    // Another screen can merge a newer draft before this screen receives the
    // file notification. A send acknowledgement must compare against the
    // shared library's latest snapshot, not this Panel's stale property.
    var latest = DraftStore.snapshot()
    root.draftStore = latest.accounts
    root.draftLastAccount = latest.lastAccount
    var next = Object.assign({}, latest.accounts)
    var chats = Object.assign({}, next[root.myMid] || {})
    var saved = chats[String(chat)] || null
    if (saved && expectedVersion !== undefined
        && Number(saved.version || 0) !== Number(expectedVersion)) return
    var restoringThis = root.restoringDraft && root.activeChat
        && String(root.activeChat.mid || "") === String(chat)
    var composerMatches = saved
        && String(replyField.text || "") === String(saved.text || "")
        && (restoringThis
            || Number(replyField.cursorPosition || 0) === Number(saved.cursor || 0))
        && JSON.stringify(root.mentionPicks || []) === JSON.stringify(saved.mentions || [])
        && JSON.stringify(root.replyTarget || null) === JSON.stringify(saved.replyTo || null)
    var unchangedRestored = composerMatches
        && !root.composerDirtyByChat[String(chat)]
    // Contents can be identical after a fast new edit (send "x", then type
    // the next "x") while the debounce has not produced a newer version yet.
    if (root.activeChat && String(root.activeChat.mid || "") === String(chat)
        && expectedGeneration !== undefined
        && (String(expectedGenerationOwner || "") !== root.panelInstanceId
            || (Number(expectedGeneration) !== root.composerGenerationFor(chat)
                && !unchangedRestored))) {
      if (String(replyField.text || "").length > 0 || root.replyTarget
          || (Array.isArray(root.mentionPicks) && root.mentionPicks.length > 0)) {
        root.saveActiveDraft(false)
        return
      }
      // Exact history reconciliation removes its ambiguity marker first. If
      // the newer composer is still empty and nothing else owns the draft,
      // the confirmed revision can be spent despite the generation change.
      if (root.pendingDraftSend(chat, saved && saved.version)) return
    }
    // A send reply may arrive after the user has started the next sentence.
    // Persist that new composer state immediately instead of letting the old
    // request spend it. The version check covers the same race after switching
    // away, where saveActiveDraft() already wrote the newer draft.
    if (root.activeChat && String(root.activeChat.mid || "") === String(chat)
        && (String(replyField.text || "").length > 0 || root.replyTarget
            || (Array.isArray(root.mentionPicks) && root.mentionPicks.length > 0))
        && !composerMatches) {
      root.saveActiveDraft(false)
      return
    }
    if (root.activeChat && String(root.activeChat.mid || "") === String(chat)
        && composerMatches && root.resetComposerAfterSuccessfulSend) {
      root.draftRestoreEpoch++
      root.restoringDraft = false
      root.resetComposerAfterSuccessfulSend()
    }
    var stillAmbiguous = saved && Array.isArray(saved.ambiguousSends)
      ? saved.ambiguousSends : []
    if (stillAmbiguous.length > 0)
      chats[String(chat)] = { ambiguousSends: stillAmbiguous }
    else delete chats[String(chat)]
    if (Object.keys(chats).length > 0) next[root.myMid] = chats
    else delete next[root.myMid]
    root.writeDraftStore(next)
    var versions = Object.assign({}, root.composerDraftVersionByChat)
    versions[String(chat)] = 0
    root.composerDraftVersionByChat = versions
  }

  function clearDraftAccount(account) {
    if (!account) return
    // Revision exhaustion can stage a composer even after the file loaded.
    // Logout owns all in-memory work for the departing account in either state.
    var staged = Object.assign({}, root.pendingDraftComposers)
    delete staged[String(account)]
    root.pendingDraftComposers = staged
    if (!root.draftStoreLoaded) {
      // A composer edit can already be staged while FileView is still loading.
      // Logout owns that account whole, including edits not merged into the
      // file snapshot yet; otherwise loadDraftStore() recreates the draft.
      var stagedAmbiguous = Object.assign({}, root.pendingAmbiguousByAccount)
      delete stagedAmbiguous[String(account)]
      root.pendingAmbiguousByAccount = stagedAmbiguous
      var pending = Object.assign({}, root.pendingDraftAccountClears)
      pending[String(account)] = {
        revision: Number(DraftStore.snapshot().revision || 0),
        at: Date.now()
      }
      root.pendingDraftAccountClears = pending
      return
    }
    var latest = DraftStore.snapshot()
    root.draftStore = latest.accounts
    root.draftLastAccount = latest.lastAccount
    if (!latest.accounts[account]) return
    var next = Object.assign({}, latest.accounts)
    delete next[account]
    if (root.draftLastAccount === account) root.draftLastAccount = ""
    root.writeDraftStore(next)
  }

  // Drafts belong to an account and die with its session — that is the rule
  // clearDraftAccount() implements when the end is OBSERVED. A session that
  // ended while this panel was closed is never observed (parseState's teardown
  // arms all require seeing the transition), so its drafts would otherwise
  // live in the shared file forever: another user's unsent message, on this
  // disk, under a mid nobody logs into again. When a session settles as
  // account X, every entry that is not X's is such an orphan, and one daemon
  // can only have one X at a time.
  function pruneDraftAccountsExcept(keepAccount) {
    if (!root.draftStoreLoaded || !keepAccount) return
    var latest = DraftStore.snapshot()
    var foreign = false
    for (var account in latest.accounts) {
      if (String(account) !== String(keepAccount)) { foreign = true; break }
    }
    if (!foreign) return
    root.draftStore = latest.accounts
    root.draftLastAccount = keepAccount
    var next = Object.assign({}, latest.accounts)
    for (var other in next) {
      if (String(other) !== String(keepAccount)) delete next[other]
    }
    if (!root.writeDraftStore(next)) return
    var staged = Object.assign({}, root.pendingDraftComposers)
    for (var s in staged) {
      if (String(s) !== String(keepAccount)) delete staged[s]
    }
    root.pendingDraftComposers = staged
    var ambiguous = Object.assign({}, root.pendingAmbiguousByAccount)
    for (var a in ambiguous) {
      if (String(a) !== String(keepAccount)) delete ambiguous[a]
    }
    root.pendingAmbiguousByAccount = ambiguous
    var clears = Object.assign({}, root.pendingDraftAccountClears)
    for (var c in clears) {
      if (String(c) !== String(keepAccount)) delete clears[c]
    }
    root.pendingDraftAccountClears = clears
  }

  function clearAllDrafts() {
    if (Object.keys(root.draftStore || {}).length === 0) return
    root.writeDraftStore({})
  }

  function chatById(mid) {
    return PanelKit.chatById(root.chats, mid)
  }

  // --------------------------------------------------------------- socket

  function reconcileAfterConnect() {
    if (!root.activeChat || !root.loggedIn) return false
    var chat = String(root.activeChat.mid || "")
    var needsHistory = root.historyRefreshNeeded
        && (!!root.ambiguousSendsByChat[chat] || !!root.historyRefreshRemovedByChat[chat])
    needsHistory = needsHistory || (root.historyReloadAfterGeneration > 0
        && root.historyReloadChat === chat)
    if (!root.previewRefreshNeeded && !needsHistory) return false
    if (root.loading) return true
    if (root.reconciliationAttemptedEpoch === root.reconciliationEpoch) return true
    root.reconciliationAttemptedEpoch = root.reconciliationEpoch
    root.loadHistory(root.activeChat.mid)
    return true
  }

  function settleConfirmedSends(chat, confirmed) {
    if (!root.myMid || !chat || !Array.isArray(confirmed) || confirmed.length === 0) return
    var key = String(chat)
    if (!root.draftStoreLoaded) {
      var removed = {}
      for (var ci = 0; ci < confirmed.length; ci++) {
        var confirmedToken = String((confirmed[ci] || {}).requestId || "")
        if (confirmedToken) removed[confirmedToken] = true
      }
      var removedByChat = {}
      removedByChat[key] = removed
      var changedChats = {}
      changedChats[key] = true
      root.persistAmbiguousSends(root.myMid, {}, changedChats, false, removedByChat)
      return
    }
    var latest = DraftStore.snapshot()
    root.draftStore = latest.accounts
    root.draftLastAccount = latest.lastAccount
    var next = Object.assign({}, latest.accounts)
    var chats = Object.assign({}, next[root.myMid] || {})
    var saved = chats[key] ? Object.assign({}, chats[key]) : null
    if (!saved) return
    var keptComposerVersion = 0
    var removed = {}
    var spender = null
    for (var i = 0; i < confirmed.length; i++) {
      var token = String((confirmed[i] || {}).requestId || "")
      if (token) removed[token] = true
      if (confirmed[i] && confirmed[i].spendsDraft
          && (!spender || Number(confirmed[i].draftVersion || 0) === Number(saved.version || 0)))
        spender = confirmed[i]
    }
    var remaining = Array.isArray(saved.ambiguousSends)
      ? saved.ambiguousSends.filter(function(entry) {
          return entry && !removed[String(entry.requestId || "")]
        }) : []
    if (remaining.length > 0) saved.ambiguousSends = remaining
    else delete saved.ambiguousSends

    function keepCurrentComposer() {
      if (!root.composerDirtyByChat[key]) return false
      var allocated = DraftStore.allocateRevision()
      if (allocated <= 0) {
        root.markDraftStoreUnavailable()
        if (root.stageExhaustedComposer) root.stageExhaustedComposer()
        saved = remaining.length > 0 ? { ambiguousSends: remaining } : null
        return true
      }
      saved = {
        text: String(replyField.text || ""),
        cursor: Number(replyField.cursorPosition || 0),
        mentions: Array.isArray(root.mentionPicks) ? root.mentionPicks : [],
        replyTo: root.replyTarget ? {
          id: String(root.replyTarget.id || ""),
          fromName: String(root.replyTarget.fromName || ""),
          text: String(root.replyTarget.text || "")
        } : null,
        version: allocated,
        updatedAt: Date.now()
      }
      if (remaining.length > 0) saved.ambiguousSends = remaining
      keptComposerVersion = allocated
      return true
    }

    var spend = spender && Number(saved.version || 0) === Number(spender.draftVersion || 0)
    if (spend) {
      var active = root.activeChat && String(root.activeChat.mid || "") === key
      var hasComposer = active && (String(replyField.text || "").length > 0
          || root.replyTarget
          || (Array.isArray(root.mentionPicks) && root.mentionPicks.length > 0))
      var generationChanged = active && spender.draftGeneration !== undefined
          && (String(spender.draftGenerationOwner || "") !== root.panelInstanceId
              || Number(spender.draftGeneration) !== root.composerGenerationFor(key))
      var restoringThis = root.restoringDraft && active
      var composerMatches = active
          && String(replyField.text || "") === String(saved.text || "")
          && (restoringThis
              || Number(replyField.cursorPosition || 0) === Number(saved.cursor || 0))
          && JSON.stringify(root.mentionPicks || []) === JSON.stringify(saved.mentions || [])
          && JSON.stringify(root.replyTarget || null) === JSON.stringify(saved.replyTo || null)
      var preserve = false
      if (generationChanged && hasComposer
          && !(composerMatches && !root.composerDirtyByChat[key])) {
        if (!keepCurrentComposer())
          saved = remaining.length > 0 ? { ambiguousSends: remaining } : null
      }
      else if (generationChanged && root.pendingDraftSend(key, saved.version)) preserve = true
      else if (hasComposer && !composerMatches) {
        if (!keepCurrentComposer())
          saved = remaining.length > 0 ? { ambiguousSends: remaining } : null
      }
      else {
        if (active && composerMatches && root.resetComposerAfterSuccessfulSend) {
          root.draftRestoreEpoch++
          root.restoringDraft = false
          root.resetComposerAfterSuccessfulSend()
        }
        saved = remaining.length > 0 ? { ambiguousSends: remaining } : null
      }
      if (preserve && remaining.length > 0) saved.ambiguousSends = remaining
    }
    if (saved && Object.keys(saved).length > 0) chats[key] = saved
    else delete chats[key]
    if (Object.keys(chats).length > 0) next[root.myMid] = chats
    else delete next[root.myMid]
    var wroteDraft = root.writeDraftStore(next)
    if (!wroteDraft && keptComposerVersion > 0) {
      if (root.stageExhaustedComposer) root.stageExhaustedComposer()
      var stagedVersions = Object.assign({}, root.composerDraftVersionByChat)
      stagedVersions[key] = 0
      root.composerDraftVersionByChat = stagedVersions
    }
    if (wroteDraft && keptComposerVersion > 0) {
      var versions = Object.assign({}, root.composerDraftVersionByChat)
      versions[key] = keptComposerVersion
      root.composerDraftVersionByChat = versions
      var clean = Object.assign({}, root.composerDirtyByChat)
      clean[key] = false
      root.composerDirtyByChat = clean
    }
    if (spend && (!saved || saved.text === undefined)) {
      var cleared = Object.assign({}, root.composerDraftVersionByChat)
      cleared[key] = 0
      root.composerDraftVersionByChat = cleared
    }
  }

  function reconcileAmbiguous(chat, list, completedHistoryGeneration) {
    var key = String(chat || "")
    var waiting = root.ambiguousSendsByChat[key]
    if (!Array.isArray(waiting) || waiting.length === 0) {
      var completedRefreshes = Object.assign({}, root.historyRefreshRemovedByChat || {})
      if (Number(completedHistoryGeneration || 0) >= Number(completedRefreshes[key] || Infinity)) {
        delete completedRefreshes[key]
        root.historyRefreshRemovedByChat = completedRefreshes
        root.historyRefreshNeeded = Object.keys(root.ambiguousSendsByChat).length > 0
            || Object.keys(completedRefreshes).length > 0
      }
      return
    }
    var remaining = []
    var confirmed = []
    for (var i = 0; i < waiting.length; i++) {
      var entry = waiting[i]
      var observed = false
      for (var j = 0; j < list.length; j++) {
        var message = list[j]
        if (!message.pending && String(message.from || "") === root.myMid && entry.requestId
            && String(message.requestId || "") === String(entry.requestId)) {
          observed = true
          break
        }
      }
      if (!observed) remaining.push(entry)
      else confirmed.push(entry)
    }
    var next = Object.assign({}, root.ambiguousSendsByChat)
    if (remaining.length > 0) next[key] = remaining
    else delete next[key]
    root.ambiguousSendsByChat = next
    var completedRefreshes = Object.assign({}, root.historyRefreshRemovedByChat || {})
    if (Number(completedHistoryGeneration || 0) >= Number(completedRefreshes[key] || Infinity))
      delete completedRefreshes[key]
    root.historyRefreshRemovedByChat = completedRefreshes
    root.historyRefreshNeeded = Object.keys(next).length > 0
        || Object.keys(completedRefreshes).length > 0
    root.settleConfirmedSends(key, confirmed)
  }

  function preserveAmbiguousBubbles(chat, list) {
    var key = String(chat || "")
    var waiting = root.ambiguousSendsByChat[key]
    var out = Array.isArray(list) ? list.slice() : []
    if (!Array.isArray(waiting) || waiting.length === 0) return out
    var tokens = {}
    var entries = {}
    for (var i = 0; i < waiting.length; i++)
      if (waiting[i] && waiting[i].requestId) {
        tokens[String(waiting[i].requestId)] = true
        entries[String(waiting[i].requestId)] = waiting[i]
      }
    var observedTokens = {}
    for (var j = 0; j < out.length; j++) {
      var observed = out[j] || {}
      var observedToken = String(observed.requestId || "")
      if (!observed.pending && String(observed.from || "") === root.myMid
          && observedToken && tokens[observedToken]) {
        delete tokens[observedToken]
        observedTokens[observedToken] = true
      }
    }
    out = out.filter(function(message) {
      return !(message && message.pending
          && observedTokens[String(message.requestId || "")])
    })
    var present = {}
    for (var oi = 0; oi < out.length; oi++) {
      var presentToken = String((out[oi] || {}).requestId || "")
      if (presentToken && out[oi] && out[oi].pending) present[presentToken] = true
    }
    for (var k = 0; k < root.messages.length; k++) {
      var bubble = root.messages[k]
      var token = String((bubble || {}).requestId || "")
      if (bubble && bubble.pending && token && tokens[token] && !present[token]) {
        out.push(bubble)
        present[token] = true
      }
    }
    for (var tokenKey in tokens) {
      var storedBubble = entries[tokenKey] ? entries[tokenKey].bubble : null
      // A server row seen through push may predate every row in this newest
      // history page. Keep its token unresolved until pagination encounters
      // the row in order; only optimistic bubbles belong at the page tail.
      if (storedBubble && storedBubble.pending && !present[tokenKey]) {
        out.push(storedBubble)
        present[tokenKey] = true
      }
    }
    return out
  }

  property int nextId: 1
  property var pending: ({})

  Socket {
    id: sock
    path: root.stateDir + "/sock"
    // Only hold the connection while the panel is open.
    connected: root.opened
    parser: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { root.onReply(line) }
    }
    onConnectionStateChanged: {
      // 斷線時在飛的那次同步永遠不會回來了；不跟著清掉，那顆按鈕就會一直
      // 停在「同步中…」，下次開面板也還是按不動。
      // 斷線後補齊靠 events.json：ring 讀完之前推播要先排隊，不然中間那段的
      // seq 會被當成已吃過而丟掉。
      if (!connected) {
        root.dropInFlight()
        return
      }
      root.reconciliationEpoch++
      // Events that accrued while disconnected live in events.json — the
      // ring read must settle before pushes resume or the gap in between is
      // skipped as already-seen. Queue them until the read lands.
      root.eventsSyncing = true
      eventsView.reload()
      if (Object.keys(root.previewRetryQueue).length > 0)
        previewRetryTimer.restart()
      if ((root.draftStoreLoaded || root.draftStoreUnavailable)
          && root.deferredDraftRequests.length > 0)
        root.flushDeferredDraftActions()
      // 通知點進來的那一筆常常是卡在這裡：面板開了、state 也讀了，就差這條線。
      if (root.takeWanted()) return
      if (root.reconcileAfterConnect()) return
      // 面板重開時這條線常常還沒接上，onOpenedChanged 只好把 loadedAt 歸零
      // 等心跳（最久 30 秒）補抓 —— 既然接上了就別讓人乾等那一輪。
      // 重抓不標已讀：沒人點開聊天室，只是這條線接上了。
      if (root.loggedIn && root.twoPane && root.activeChat && root.loadedAt === 0)
        root.loadHistory(root.activeChat.mid, false)
    }
  }

  // 斷線＝所有在飛的請求都不會回來了。三份等回覆的紀錄要一起清，留著哪一份，
  // 那一份就會拿「還在等」當真：openWanted 留著的話，燈箱裡按 o 會以為原圖
  // 還在路上，改去等一個永遠不來的回覆。
  // 燈箱本身不動 —— 縮圖是本地檔案，斷線不影響看，收掉只是平白搶走畫面。
  function dropInFlight() {
    var queuedImages = Object.assign({}, root.imageRetryQueue)
    for (var imagePendingId in root.pending) {
      var imagePending = root.pending[imagePendingId]
      if (!imagePending || imagePending.cmd !== "image"
          || imagePending.invalidate !== true || !imagePending.msgId) continue
      queuedImages[String(imagePending.msgId)] = { invalidate: true }
    }
    root.imageRetryQueue = queuedImages
    root.imageRequests = ({})
    // Offline time is not media-lane congestion. Keep queued invalidations,
    // but give them a fresh connected admission window after reconnect.
    var queuedPreviews = Object.assign({}, root.previewRetryQueue)
    for (var previewPendingId in root.pending) {
      var previewPending = root.pending[previewPendingId]
      if (!previewPending || previewPending.cmd !== "preview"
          || previewPending.invalidate !== true || !previewPending.msgId) continue
      var previewKey = String(previewPending.msgId)
      queuedPreviews[previewKey] = {
        invalidate: true,
        chat: String(previewPending.chat || ""),
      }
    }
    root.previewRetryQueue = queuedPreviews
    if (Object.keys(root.previewRequests).length > 0)
      root.previewRefreshNeeded = true
    root.previewRequests = ({})
    var recoveryHolds = Object.assign({}, root.draftRecoveryHolds)
    for (var pendingId in root.pending) {
      var pendingEntry = root.pending[pendingId]
      if (!pendingEntry || !pendingEntry.spendsDraft || !pendingEntry.chat) continue
      recoveryHolds[String(pendingEntry.chat)] = {
        version: Number(pendingEntry.draftVersion || 0),
        generation: Number(pendingEntry.draftGeneration || 0),
        emptyGeneration: root.composerGenerationFor(pendingEntry.chat)
      }
    }
    root.draftRecoveryHolds = recoveryHolds
    // A disconnected side effect is ambiguous: LINE may have accepted it even
    // though its acknowledgement never reached this socket. Keep optimistic
    // bubbles and persisted drafts in place, then reconcile from history after
    // reconnect instead of restoring the composer and inviting a duplicate.
    var lost = root.pending
    var lostAccount = root.sessionMid || root.myMid
    var uncertainSend = false
    var interruptedClipboardProbe = false
    var ambiguous = Object.assign({}, root.ambiguousSendsByChat)
    var additions = {}
    var changedChats = {}
    for (var id in lost) {
      var entry = lost[id]
      if (!entry) continue
      if (root.isMessageSendCmd && root.isMessageSendCmd(entry.cmd)) {
        uncertainSend = true
        if (entry.chat && entry.requestId) {
          var chat = String(entry.chat)
          var waiting = Array.isArray(ambiguous[chat]) ? ambiguous[chat].slice() : []
          var savedBubble = null
          for (var bi = 0; bi < root.messages.length; bi++) {
            var candidate = root.messages[bi] || {}
            if ((entry.msgId && String(candidate.id || "") === String(entry.msgId))
                || (!candidate.pending && String(candidate.from || "") === lostAccount
                    && String(candidate.requestId || "") === String(entry.requestId))) {
                savedBubble = candidate
                break
            }
          }
          if (!savedBubble && entry.bubble) savedBubble = entry.bubble
          waiting.push({ requestId: String(entry.requestId),
                         spendsDraft: !!entry.spendsDraft,
                         draftVersion: Number(entry.draftVersion || 0),
                         draftGeneration: Number(entry.draftGeneration || 0),
                         draftGenerationOwner: String(entry.draftGenerationOwner || ""),
                         bubble: savedBubble })
          ambiguous[chat] = waiting
          var added = Array.isArray(additions[chat]) ? additions[chat] : []
          added.push(waiting[waiting.length - 1])
          additions[chat] = added
          changedChats[chat] = true
        }
      } else if (entry.cmd === "probeClipboardImage") interruptedClipboardProbe = true
    }
    root.ambiguousSendsByChat = ambiguous
    if (root.persistAmbiguousSends)
      root.persistAmbiguousSends(lostAccount, additions, changedChats)
    root.pending = ({})
    if (uncertainSend) {
      root.historyRefreshNeeded = Object.keys(ambiguous).length > 0
          || Object.keys(root.historyRefreshRemovedByChat || {}).length > 0
      root.notice = "連線中斷，請確認訊息是否送出"
    } else if (interruptedClipboardProbe) root.notice = "連線中斷，圖片尚未送出"
    root.openWanted = ({})
    root.syncing = false
    // 貼圖清單跟同步是同一件事：那一趟回不來了。旗子留著，下次開選單就一直
    // 停在「載入中…」，連 ⟳ 都按不動 —— loadStickers 第一行先看的就是它。
    root.stickerLoading = false
    // 歷史的兩面旗子同理，而且鎖得更死：它們的意思就是「還在等那一筆回覆」，
    // 而那一筆剛剛被丟掉了，沒有人會回來熄燈。loading 留著，loadOlder 第一行
    // 就把自己擋掉；loadingOlder 留著，這間聊天室從此翻不上去 —— 兩個都要
    // 離開再進來才會好。今天沒出事只是因為關面板還會順路走 backToList()，
    // 那是巧合：斷線和登出這兩條路都不經過它。
    root.loading = false
    root.loadingOlder = false
  }

  // reply 就是帶引言的 send：一樣有樂觀泡泡、送失敗一樣要把字還回輸入框。
  // 兩個 cmd 名字散在 onReply 的四個分支裡，寫成一支才不會漏掉其中一個。
  function isSendCmd(cmd) {
    return PanelKit.isSendCmd(cmd)
  }

  function isMessageSendCmd(cmd) {
    return PanelKit.isMessageSendCmd(cmd)
  }

  // 送出前先塞了一顆樂觀泡泡的那三支。送失敗都要把那顆拿掉，但只有帶文字的
  // 兩支還要把字還回輸入框 —— 貼圖沒有字可以還，所以拿掉和還字不是同一個判斷。
  function hasPendingBubble(cmd) {
    return PanelKit.hasPendingBubble(cmd)
  }

  // 回傳有沒有真的送出去。要「送成功才記」的呼叫端看這個回傳值，別自己再判一次
  // sock.connected —— 同一個條件寫在兩個地方，遲早會不一致，這次的 bug 就是這樣來的。
  function request(cmd, extra, msgId) {
    if (!sock.connected) { root.notice = "daemon 沒在跑"; return false }
    var spendsDraft = root.isSendCmd(cmd) || !!(extra && extra._spendsDraft)
    // A pre-load draft has no stable version yet. Sending it with version 0
    // lets an early acknowledgement miss the staged revision and resurrect it
    // when FileView finishes, so wait for that merge before putting it on wire.
    if (spendsDraft && !root.draftStoreLoaded && !root.draftStoreUnavailable) {
      var pendingChat = String(extra && extra.chat || "")
      if (root.deferredDraftSend(pendingChat)) {
        root.notice = "前一則正在等待草稿載入"
        return false
      }
      var queued = (root.deferredDraftRequests || []).slice()
      var queuedExtra = Object.assign({}, extra || {})
      var queuedChat = String(queuedExtra.chat || "")
      // pendingBubble() has already used this number. Reserve it now so a
      // sticker or another chat cannot reuse the optimistic message id while
      // this request waits outside root.pending.
      queuedExtra._requestId = root.nextId++
      queuedExtra._draftVersion = 0
      queuedExtra._draftGeneration = root.composerGenerationFor(queuedChat)
      queuedExtra._displayedComposer = {
        text: String(replyField.text || ""),
        cursor: Number(replyField.cursorPosition || 0),
        mentions: Array.isArray(root.mentionPicks) ? root.mentionPicks.slice() : [],
        replyTo: root.replyTarget ? {
          id: String(root.replyTarget.id || ""),
          fromName: String(root.replyTarget.fromName || ""),
          text: String(root.replyTarget.text || "")
        } : null
      }
      queued.push({
        cmd: cmd,
        extra: queuedExtra,
        msgId: msgId || "",
        session: root.sessionEpoch,
        account: root.myMid
      })
      root.deferredDraftRequests = queued
      root.notice = "草稿載入後傳送"
      return true
    }
    var reservedId = extra && Number(extra._requestId || 0)
    var id = reservedId > 0 ? reservedId : root.nextId++
    // older 和 markRead 在線上都是 history，差別只在回來要怎麼處理：older 前置一頁、
    // markRead 什麼都不做（它是為了讓 daemon 送出已讀，那一頁本來就不要）。
    var req = { id: id, cmd: (cmd === "older" || cmd === "markRead") ? "history" : cmd }
    for (var k in extra) if (String(k).charAt(0) !== "_") req[k] = extra[k]
    var requestId = ""
    var requestBubble = null
    if (root.isMessageSendCmd(cmd)) {
      requestId = String(root.sessionEpoch) + "-" + String(Date.now()) + "-" + String(id)
          + "-" + Math.floor(Math.random() * 4294967296).toString(36)
      req.requestId = requestId
      if (msgId) {
        var tagged = []
        for (var mi = 0; mi < root.messages.length; mi++) {
          var message = root.messages[mi]
          if (String((message || {}).id || "") === String(msgId)
              && !String((message || {}).requestId || "")) {
            requestBubble = root.withFields(message, { requestId: requestId })
            tagged.push(requestBubble)
          } else tagged.push(message)
        }
        root.setMessages(tagged, false)
      }
    }
    var p = root.pending
    var draftAccount = (root.draftStore || {})[root.myMid] || {}
    var draftChat = extra && extra.chat ? String(extra.chat) : ""
    var draftAtSend = draftAccount[draftChat] || null
    var displayedDraftVersion = Number(
      root.composerDraftVersionByChat[draftChat] || 0)
    var draftGenerationAtSend = extra && extra._draftGeneration !== undefined
      ? Number(extra._draftGeneration)
      : root.composerGenerationFor(draftChat)
    var displayedComposer = extra && extra._displayedComposer
        ? extra._displayedComposer : null
    if (!displayedComposer && spendsDraft && root.activeChat
        && String(root.activeChat.mid || "") === draftChat
        && (String(replyField.text || "").length > 0 || root.replyTarget
            || (Array.isArray(root.mentionPicks) && root.mentionPicks.length > 0))
        && draftGenerationAtSend === root.composerGenerationFor(draftChat)) {
      displayedComposer = {
        text: String(replyField.text || ""),
        cursor: Number(replyField.cursorPosition || 0),
        mentions: Array.isArray(root.mentionPicks) ? root.mentionPicks : [],
        replyTo: root.replyTarget ? {
          id: String(root.replyTarget.id || ""),
          fromName: String(root.replyTarget.fromName || ""),
          text: String(root.replyTarget.text || "")
        } : null
      }
    }
    // 送出的內容留一份在 pending 上：送失敗要還回輸入框，而 messages 隨時
    // 可能被一次 history 重讀整份換掉，那顆樂觀的泡泡就不見了。
    p[id] = { cmd: cmd, msgId: msgId || "", text: extra && extra.text ? String(extra.text) : "",
              chat: extra && extra.chat ? String(extra.chat) : "",
              spendsDraft: spendsDraft,
              draftVersion: extra && extra._draftVersion !== undefined
                ? Number(extra._draftVersion)
                : (spendsDraft && root.activeChat
                   && String(root.activeChat.mid || "") === draftChat
                    ? displayedDraftVersion
                    : Number(draftAtSend && draftAtSend.version || 0)),
              draftGeneration: extra && extra._draftGeneration !== undefined
                ? Number(extra._draftGeneration)
                : root.composerGenerationFor(draftChat),
              draftGenerationOwner: root.panelInstanceId,
              requestId: requestId,
              bubble: requestBubble,
              displayedComposer: displayedComposer,
              invalidate: (cmd === "image" || cmd === "preview")
                && extra && extra.invalidate === true,
              // 送出的這一刻是第幾份歷史。只有 older 回來時比對它，但記在這裡就不必
              // 為了一個 cmd 在 request 裡多開一條路。
              gen: root.historyGen }
    root.pending = p
    sock.write(JSON.stringify(req) + "\n")
    return true
  }

  function onReply(line) {
    var res
    try { res = JSON.parse(String(line || "")) } catch (e) { return }
    // Unsolicited pushes carry no request id, so they would die at the
    // pending lookup below. `event` is a ring entry; `chat` is a single-row
    // list patch stamped with the revision it moves to.
    if (res && typeof res === "object" && res.event) {
      root.onPushedEvent(res)
      return
    }
    if (res && typeof res === "object" && res.chat) {
      root.applyChatPatch(res.chat, res.chatsRevision, res.boot)
      return
    }
    var entry = root.pending[res.id]
    // pending 就是「還在等的那幾筆」。不在裡面＝這一筆已經被取消（斷線、換帳號
    // 都會清），回來的東西不屬於現在這個 session。id 只增不重用，所以認不得的 id
    // 只有這一個來源；不擋的話它會一路掉到最底下那句通用的錯誤，登出的瞬間閃一條
    // 上一個帳號的「尚未登入」，圖片那支還會把上一個帳號的路徑補回 imagePaths。
    if (!entry) return
    var cmd = entry.cmd
    var msgId = entry.msgId
    // 切聊天室不會取消已經送出的 history。慢一步回來的那份要記得自己是替誰問的，
    // 不然會蓋掉現在這間的訊息跟快取。
    var askedFor = entry.chat ? String(entry.chat) : ""
    var stale = askedFor.length > 0 && (!root.activeChat || askedFor !== root.activeChat.mid)
    // 同一間聊天室也會過期：older 還在飛的時候整份重讀過一次（新訊息、同步、重連、
    // 重開面板都會走 loadHistory），那趟問的是舊錨點上面那一頁，回來時 messages 已經
    // 換人 —— 去重是在回覆抵達的當下用 root.messages 算的，會拿重讀後的最新一批當
    // 基準，於是把一頁很舊的訊息接在新訊息前面。只有 older 看這面旗子，其餘的 cmd
    // 跟「這是哪一份歷史」無關。今天 daemon 的 servePanel 一次只處理一個請求，回覆
    // 順序等於送出順序，所以還撞不到；面板不再靠那個前提（daemon.ts servePanel 那裡
    // 有對應的註解）。
    var outdated = Number(entry.gen) !== root.historyGen
    var p = root.pending; delete p[res.id]; root.pending = p

    if (cmd === "preview") {
      var previews = Object.assign({}, root.previewRequests)
      delete previews[msgId]
      root.previewRequests = previews
      // Preview loading is background work. It never replaces a useful
      // banner with an error and a reply for a chat we left is discarded.
      if (!res.ok || stale) {
        if (!stale && String(res.error || "") === "媒體請求過多，請稍後再試")
          root.schedulePreviewRetry(
            msgId, entry && entry.invalidate === true, entry && entry.chat,
          )
        else root.finishPreviewRetry(msgId)
        return
      }
      root.finishPreviewRetry(msgId)
      var previewPath = String(res.data && res.data.path ? res.data.path : "")
      if (!previewPath) return
      var changed = []
      for (var pi = 0; pi < root.messages.length; pi++) {
        var pm = root.messages[pi]
        changed.push(String(pm.id || "") === String(msgId) && root.mediaUsable(pm)
          ? root.withFields(pm, { mediaPath: previewPath }) : pm)
      }
      root.setMessages(changed)
      if (root.activeChat) root.rememberHistory(root.activeChat.mid, root.messages)
      return
    }

    if (cmd === "image") {
      delete root.imageRequests[msgId]
      if (!res.ok && String(res.error || "") === "媒體請求過多，請稍後再試") {
        if (root.scheduleImageRetry(msgId, entry && entry.invalidate === true)) return
      }
      root.finishImageRetry(msgId)
      var paths = Object.assign({}, root.imagePaths)
      paths[msgId] = res.ok && res.data && res.data.path
        ? "file://" + res.data.path : ""
      // Age-cap the path table (see imagePathsMax): an entry is cheap, but
      // it only left on a read error or logout, so the map grew with every
      // image the shell ever displayed in one login. Forgetting the oldest
      // just makes fetchImage re-ask the daemon for it.
      var pkeys = Object.keys(paths)
      for (var pd = 0; pd < pkeys.length - root.imagePathsMax; pd++) {
        delete paths[pkeys[pd]]
      }
      root.imagePaths = paths
      return
    }

    if (!res.ok) {
      // 同步是整個面板的動作，不屬於任何一間聊天室，所以永遠不會 stale，
      // 也不能掉進下面那串「換聊天室就吞掉」的規則裡 —— 人按了就要有回音。
      if (cmd === "sync") {
        root.syncing = false
        root.notice = String(res.error || "同步失敗")
        return
      }
      // 隱藏／取消隱藏帶著 chat，但它是對清單那一列做的，跟現在停在哪一間無關 ——
      // 掉進下面那條 stale 規則就會變成「按了右鍵、什麼都沒發生、也沒說為什麼」。
      if (cmd === "hide" || cmd === "unhide") {
        root.notice = String(res.error || (cmd === "hide" ? "隱藏失敗" : "取消隱藏失敗"))
        return
      }
      // 失敗的是別間聊天室的請求：現在這間的輸入框、提示、轉圈都不能動，
      // 不然 A 送失敗的那句話會掉進 B 的框裡，還跳一條 B 根本沒做的錯誤。
      // 樂觀那顆還是照 id 拿掉（不在現在這份清單裡就等於沒事）。
      // 開聊天室時 loadingOlder 就歸零了，這面旗子只屬於現在這間。慢一步回來的
      // older 若把它關掉，現在這間會再送一次 older，兩份重疊撞壞去重跟錨點高度。
      // download 跟現在停在哪一間無關：成功那邊故意不看 stale 照開檔案，失敗
      // 這邊就得對稱，切走聊天室不代表這次抓檔的錯誤可以吞掉。提示照跳，
      // 那顆等著開的旗子也照拿掉，不然失敗一次就永遠留在 openWanted 裡。
      if (cmd === "download") {
        if (msgId) root.forgetOpen(msgId)
        if (stale) { root.notice = String(res.error || "下載失敗"); return }
      }
      // A queued picker can intentionally finish after the user moved to a
      // different chat. Its failure is still the result of a visible action,
      // but it must not restore anything into the current chat's composer.
      if (cmd === "sendFile" && stale) {
        root.notice = String(res.error || "傳送檔案失敗")
        return
      }
      if (stale) {
        if (root.hasPendingBubble(cmd) && msgId) root.dropMessage(msgId)
        return
      }
      // 已讀是面板在背景自己送的，人沒按過任何東西 —— 失敗跳一條紅字，畫面上就會是
      // 「讀著讀著自己冒出一條錯誤」。這一次沒標到，下一則訊息、下一次開聊天室都會
      // 再送一次，沒有東西需要人介入。
      if (cmd === "markRead") return
      // 成員名單是開聊天室時自己送的，人沒按過任何東西 —— 失敗跳一條紅字
      // 等於每開一次 room 就罵一次。留著原因，等使用者真的打 @ 再說。
      if (cmd === "members") { root.membersError = String(res.error || "讀不到成員名單"); return }
      // 貼圖清單也是選單自己送的，而選單就疊在橫幅上面 —— 理由留在選單裡，
      // 不然按了 ⟳ 看起來像什麼都沒發生。
      if (cmd === "stickers") {
        root.stickerLoading = false
        root.stickerError = String(res.error || "貼圖清單讀不到")
        return
      }
      // 過期的那趟連旗子都不能碰：重讀之後新送出去的那趟才是 loadingOlder 的主人，
      // 提早清掉的話同一間聊天室會有兩趟 older 同時在飛，撞壞去重跟錨點。
      // 失敗照舊不 latch noMoreOlder：翻頁是捲動驅動的，latch 會讓這間在重開之前
      // 再也翻不上去。
      if (cmd === "older") { if (!outdated) root.loadingOlder = false; return }
      // Ctrl+V 貼到的是文字。剪貼簿在 daemon 那一邊，所以「改貼字」只能等到這裡；
      // 認的是那一句話本身，其餘每一句拒絕都是真的錯，照樣留在橫幅上。
      // 位置在 stale 底下：換了聊天室之後才回來的那份不該把字貼進另一間的框裡。
      if (cmd === "probeClipboardImage" && String(res.error || "") === root.clipboardEmpty) {
        root.notice = ""
        replyField.paste()
        return
      }
      root.notice = String(res.error || "失敗")
      // 送失敗時，空輸入框可直接還原原稿。若使用者已經在打下一句，不能用
      // 舊稿蓋掉它，也不能刪掉唯一仍看得到的舊內容；把樂觀泡泡標成失敗，
      // 讓原稿留在畫面上供複製，新的輸入與其持久化草稿都保持不動。
      // 貼圖也走這裡：entry.text 是空的，底下那段自然什麼都不還，只把泡泡拿掉。
      if (root.hasPendingBubble(cmd) && msgId) {
        var lost = entry && entry.text ? String(entry.text) : ""
        if (lost.length === 0)
          for (var j = 0; j < root.messages.length; j++)
            if (root.messages[j].id === msgId) lost = String(root.messages[j].text || "")
        var submittedGenerationLost = entry && entry.draftGeneration !== undefined
          && Number(entry.draftGeneration) !== root.composerGenerationFor(askedFor)
        var keepFailed = root.isSendCmd(cmd) && lost.length > 0
          && (replyField.text.length > 0 || root.mentionPicks.length > 0
              || root.replyTarget !== null || submittedGenerationLost)
        if (keepFailed) {
          var failedMessages = []
          var retainedFailure = null
          for (var k = 0; k < root.messages.length; k++) {
            var failedMessage = root.messages[k]
            if (failedMessage.id === msgId) {
              retainedFailure = root.withFields(failedMessage, {
                  failed: true,
                  failure: String(res.error || "傳送失敗")
                })
              failedMessages.push(retainedFailure)
            } else failedMessages.push(failedMessage)
          }
          // A history refresh can replace the optimistic bubble before the
          // refusal arrives. Rebuild the recovery row from the request entry
          // so the only remaining copy of A is still surfaced beside B.
          if (!retainedFailure) {
            var displayed = entry && entry.displayedComposer ? entry.displayedComposer : {}
            retainedFailure = {
              id: msgId, chat: askedFor, from: root.myMid, fromName: "我",
              text: lost, time: Date.now(), contentType: "NONE",
              decryptFailed: false, hasMedia: false, pending: true, failed: true,
              failure: String(res.error || "傳送失敗"),
              mentions: root.deriveMentions(
                lost, Array.isArray(displayed.mentions) ? displayed.mentions : [])
            }
            if (displayed.replyTo) retainedFailure.replyTo = displayed.replyTo
            failedMessages.push(retainedFailure)
          }
          root.setMessages(root.withDay(failedMessages))
          root.rememberFailedMessage(askedFor, retainedFailure)
        } else root.dropMessage(msgId)
        if (!stale && lost.length > 0 && replyField.text.length === 0
          && entry.draftGeneration !== undefined
            && String(entry.draftGenerationOwner || "") === root.panelInstanceId
            && Number(entry.draftGeneration) === root.composerGenerationFor(askedFor)) {
          // The persisted revision contains the mention and quote metadata as
          // well as the text. Restore it whole when this is still its chat.
          var accountDrafts = (root.draftStore || {})[root.myMid] || {}
          if (entry.displayedComposer)
            root.restorePendingComposer(askedFor, entry.displayedComposer,
                                        entry.draftVersion)
          else if (accountDrafts[askedFor]) root.restoreDraft(askedFor)
          else replyField.text = lost
        }
      }
      if (!stale && entry && entry.spendsDraft && replyField.text.length === 0
          && entry.draftGeneration !== undefined
          && String(entry.draftGenerationOwner || "") === root.panelInstanceId
          && Number(entry.draftGeneration) === root.composerGenerationFor(askedFor)) {
        var savedDrafts = (root.draftStore || {})[root.myMid] || {}
        if (entry.displayedComposer)
          root.restorePendingComposer(askedFor, entry.displayedComposer,
                                      entry.draftVersion)
        else if (savedDrafts[askedFor]) root.restoreDraft(askedFor)
      }
      if (!stale && entry && entry.spendsDraft && replyField.text.length === 0
          && entry.draftGeneration !== undefined
          && Number(entry.draftGeneration) !== root.composerGenerationFor(askedFor)) {
        var failedHolds = Object.assign({}, root.draftRecoveryHolds)
        failedHolds[askedFor] = {
          version: Number(entry.draftVersion || 0),
          generation: Number(entry.draftGeneration || 0),
          emptyGeneration: root.composerGenerationFor(askedFor)
        }
        root.draftRecoveryHolds = failedHolds
      }
      if (cmd === "history") {
        root.loading = false
        var failedGeneration = Number(entry.gen || 0)
        var newerSharedRefresh = Number(
            root.historyRefreshRemovedByChat[askedFor] || 0)
        if ((root.historyReloadChat === askedFor
             && root.historyReloadAfterGeneration > failedGeneration)
            || newerSharedRefresh > failedGeneration) {
          root.reconciliationEpoch++
          root.reconcileAfterConnect()
        }
      }
      return
    }
    // 同理，成功也一樣：背景標好了已讀，不代表使用者眼前那條提示過期了。
    // 底下每一支都是人按出來的，所以「有回音就把上一條清掉」只對它們成立。
    if (cmd === "markRead" || cmd === "discardClipboardImage") return
    if (!stale) root.notice = ""

    if (cmd === "older") {
      // 同上：先確認是不是現在這間、而且還是同一份歷史，才輪得到動 loadingOlder。
      // 對不上就整趟丟掉：messages、prependAnchorIndex、noMoreOlder 一個都不能動。
      if (stale || outdated) return
      root.loadingOlder = false
      var older = Array.isArray(res.data) ? res.data : []
      // 空的一頁就是「沒有更舊的了」。錨點（messages[0]）沒有動，再問一次只會拿回
      // 同一個答案，所以記下來別再問 —— 預抓的門檻有一個畫面高那麼寬，不記的話
      // 翻到底之後每捲一下就打一次 daemon。
      if (older.length === 0) { root.noMoreOlder = true; return }
      var seen = {}
      for (var i = 0; i < root.messages.length; i++) seen[root.messages[i].id] = true
      var fresh = older.filter(function(m) { return !seen[m.id] })
      var combined = root.preserveAmbiguousBubbles(askedFor, fresh.concat(root.messages))
      root.reconcileAmbiguous(askedFor, combined)
      // 同上：整頁都是已經有的（daemon 一定會把錨點那則再送回來一次），代表那一頁
      // 就是錨點自己，上面沒東西了。
      if (fresh.length === 0) { root.noMoreOlder = true; return }
      // 換完把「原本的第 0 則」放回視窗頂端；捲到頂才會走到這裡，所以那一則
      // 正是使用者眼前這一則。
      var oldFirst = root.messages.length > 0 ? String(root.messages[0].id || "") : ""
      root.prependAnchorIndex = 0
      for (var fi = 0; fi < combined.length; fi++)
        if (String((combined[fi] || {}).id || "") === oldFirst) {
          root.prependAnchorIndex = fi
          break
        }
      root.setMessages(root.withDay(combined), false)
    } else if (cmd === "history") {
      // 已經沒人在看這份了：只有在完全沒開聊天室時才把轉圈關掉，
      // 不然會把現在這間還在飛的那次 loadHistory 的轉圈提早關掉。
      if (stale) { if (!root.activeChat) root.loading = false; return }
      var historyRows = Array.isArray(res.data) ? res.data : []
      var retainedRows = root.mergeFailedMessages(askedFor, historyRows)
      root.setMessages(root.withDay(
          root.preserveAmbiguousBubbles(askedFor, retainedRows)), true)
      root.reconcileAmbiguous(askedFor, root.messages, Number(entry.gen || 0))
      var deferredReload = root.historyReloadChat === askedFor
          ? root.historyReloadAfterGeneration : 0
      if (deferredReload > 0 && Number(entry.gen || 0) >= deferredReload) {
        root.historyReloadAfterGeneration = 0
        root.historyReloadChat = ""
      }
      root.loadedAt = Date.now()
      root.loading = false
      root.previewRefreshNeeded = false
      // 開聊天室那一刻記下的未讀數，要等這一份回來才知道是哪一則。只認第一份：
      // 之後的重抓（同步、新訊息進來）再算一次會把分隔線一路往下推。
      if (root.unreadMarkCount > 0) {
        var unreadAt = root.firstUnreadIndex(root.messages, root.unreadMarkCount)
        root.unreadMarkId = unreadAt >= 0 ? String(root.messages[unreadAt].id || "") : ""
        root.unreadMarkCount = 0
      }
      if (root.activeChat) root.rememberHistory(root.activeChat.mid, root.messages)
      if (deferredReload > Number(entry.gen || 0)
          || Number(root.historyRefreshRemovedByChat[askedFor] || 0) > Number(entry.gen || 0)) {
        root.reconciliationEpoch++
        root.reconcileAfterConnect()
      }
    } else if (cmd === "sync") {
      root.syncing = false
      // at 是 daemon 的時鐘；舊的 daemon 不送就用自己的，這個時間戳只拿來顯示。
      root.syncedAt = res.data && res.data.at ? Number(res.data.at) : Date.now()
      root.notice = "已同步 " + root.clockText(root.syncedAt)
      // 清單是 daemon 寫 state.json、面板自己重讀的，對話那半邊沒有那條路 ——
      // 不自己再抓一次，「同步」對眼前正在看的訊息等於沒做事。
      if (root.activeChat) root.loadHistory(root.activeChat.mid)
    } else if (cmd === "probeClipboardImage") {
      var stage = String(res.data && res.data.stage ? res.data.stage : "")
      if (stage.length === 0) {
        if (!stale) root.notice = "剪貼簿暫存已失效"
        return
      }
      // Only this second request can create a LINE message, so it is the first
      // point that receives a reconciliation token. A failed probe above is a
      // plain read and cannot survive disconnect as an ambiguous send.
      if (!stale) root.notice = "傳送中…"
      // Switching chats changes where the result is displayed, not the send
      // destination captured when Ctrl+V was pressed.
      if (!root.request("sendClipboardImage", { chat: askedFor, stage: stage }))
        root.request("discardClipboardImage", { stage: stage })
    } else if (cmd === "members") {
      // 慢一步回來的那份會被上面的 stale 擋掉；這裡再記一次是誰的，
      // 選單才不會在 members 還沒換掉的空檔列出上一間群組的人。
      if (stale) return
      root.members = Array.isArray(res.data) ? res.data : []
      root.membersError = ""
    } else if (cmd === "stickers") {
      root.stickerLoading = false
      root.stickerError = ""
      var packs = res.data && Array.isArray(res.data.packages) ? res.data.packages : []
      root.stickerPacks = packs
      // 分頁停在原來那一包；那一包不在了（換帳號、重抓之後沒了）才跳回第一包。
      if (!root.stickerPack(root.stickerTab))
        root.stickerTab = packs.length > 0 ? String(packs[0].id || "") : ""
    } else if (root.isSendCmd(cmd) || cmd === "sendFile" || cmd === "sendClipboardImage") {
      // daemon 送完會改 state，parseState 會重讀；這裡再抓一次就是兩次。
      // 樂觀那顆先留著，等重讀回來整份替換掉。
      if (!stale) root.notice = ""
      // Only the revision that actually got an affirmative reply spends the
      // persisted draft. Clipboard sends never came from the composer.
      if (entry.spendsDraft && root.clearDraft)
        root.clearDraft(askedFor, entry.draftVersion, entry.draftGeneration,
                        entry.draftGenerationOwner)
    } else if (cmd === "download" && msgId && root.openWanted[msgId]) {
      // 這裡故意不看 stale：download 帶了 chat，切走聊天室就會變成過期的，
      // 但開檔案跟現在停在哪一間無關，人按了就是要開，照開。session 的
      // 結束是另一回事——已登出帳號的檔案不該被新 session 打開。
      var wanted = root.openWanted[msgId]
      if (wanted && Number(wanted.session) === root.sessionEpoch) {
        root.forgetOpen(msgId)
        root.deliverMedia(msgId, String(res.data && res.data.path ? res.data.path : ""), String(wanted.intent))
      } else {
        root.forgetOpen(msgId)
      }
    }
  }

  // 自動的那兩層都要等：watchdog 一分鐘才看一次 push 有沒有斷，保底輪詢是五分鐘。
  // 這顆是人按的 —— 睡醒、網路抖一下、或只是不確定手上這份是不是最新的 ——
  // 按下去 daemon 就重建 push 連線並立刻重抓，幾秒內給答案。
  function syncNow() {
    if (!sock.connected) { root.notice = "daemon 沒在跑"; return }
    // 已經在同步了：再送一次只是多抓一輪，daemon 那邊也會併成同一次。
    if (root.syncing) return
    root.syncing = true
    root.notice = "同步中…"
    request("sync", {})
  }

  // ---------------------------------------------------------------- 媒體

  // 畫面上的圖片 delegate 透過 preview 指令延遲抓縮圖，路徑回填在 msg.mediaPath。
  // 檔案是點了才抓，抓完交給 xdg-open。
  //
  // openWanted 是「這次抓回來要幹嘛」：id → "lightbox"（燈箱要換上原圖）或
  // "external"（人要用外部程式開）。只記 true 的時候分不出這兩種，燈箱先關掉、
  // 原圖才回來的話就會冒出一個沒人要求過的看圖視窗。
  property var openWanted: ({})

  // 燈箱：{ id, source, name, index }。id 是訊息 id（FLEX 圖沒有原檔可抓，留空字串）。
  property var lightbox: null
  property real lightScale: 1
  property real lightX: 0
  property real lightY: 0

  // 字級寫回 shell.json 走 omarchy 自己的指令，存檔後會熱重載，
  // settings 跟著更新 → fontScale 重算。不要自己寫 shell.json。
  Process { id: settingWriter; running: false }

  function setTextScale(delta) {
    var next = Math.max(80, Math.min(160, Math.round(root.fontScale * 100) + delta))
    if (next === Math.round(root.fontScale * 100)) return
    settingWriter.command = ["omarchy", "bar", "set", root.moduleName, "textScale", String(next)]
    settingWriter.running = true
  }

  // 面板位置也寫回 shell.json，跟字級同一條路。
  // omarchy 4.0.1 沒有把 manifest 的 schema 畫成設定表單的介面，所以自己放一顆鈕。
  // 三種模式輪著換；字面要跟 manifest 的 options 一字不差，那是寫進設定檔的值。
  function nextPlacement(mode) {
    return PanelKit.nextPlacement(mode)
  }

  // 按鈕上顯示的是「現在是哪一種」。兩種的時候標「按下去會變成什麼」還講得清楚，
  // 三種輪換就不行了 —— 看到「置中」根本分不出那是現況還是下一步。
  function placementLabel(mode) {
    return PanelKit.placementLabel(mode)
  }

  function togglePlacement() {
    settingWriter.command = ["omarchy", "bar", "set", root.moduleName, "placement",
      root.nextPlacement(root.placement)]
    settingWriter.running = true
  }

  // 捲動速度也是同一條路。按一下換下一段：比現在大的第一段，到頂繞回最小 ——
  // 找「下一個更大的」而不是查現在排第幾，手改成 120 也接得上（下一下是 150）。
  function nextScroll(percent) {
    return PanelKit.nextStep(root.scrollSteps, percent)
  }

  // 按鈕標的是現在幾倍，理由同 placementLabel：六段輪替標「下一步」看不懂。
  // 字級按 A−／A+ 當場看得出來，捲動速度看不出來，所以這一顆一定要有讀數。
  // 100 要寫成 1× 不是 1.00×，除以 100 之後讓 JS 自己去尾零。
  function scrollLabel(percent) {
    return PanelKit.scrollLabel(percent)
  }

  function stepScrollSpeed() {
    settingWriter.command = ["omarchy", "bar", "set", root.moduleName, "scrollSpeed",
      String(root.nextScroll(root.scrollPercent))]
    settingWriter.running = true
  }

  // 讀取筆數走同一條路：找「下一個更大的段位」而不是查現在排第幾，手改成 37
  // 也接得上（下一下是 60）。
  function nextHistory(count) {
    return PanelKit.nextStep(root.historySteps, count)
  }

  // 理由同 scrollLabel：這一顆按下去畫面上當場什麼都不會變（下一次開聊天室、
  // 下一次往上翻才看得出來），沒有讀數就等於按了不知道自己在第幾段。
  function historyLabel(count) {
    return PanelKit.historyLabel(count)
  }

  function stepHistoryPage() {
    settingWriter.command = ["omarchy", "bar", "set", root.moduleName, "historyPage",
      String(root.nextHistory(root.historyPage))]
    settingWriter.running = true
  }

  // App 視窗被拉大／縮小之後把尺寸記回 shell.json，下次開一樣大。
  Process { id: sizeWriter; running: false }

  function saveWindowSize(w, h) {
    var nw = root.clampWindowSize(w, root.windowWidth, 560)
    var nh = root.clampWindowSize(h, root.windowHeight, 480)
    // 沒變就別寫。寫回去會讓 settings 熱重載、implicitWidth 重算，
    // 每次都寫等於自己一直觸發自己。
    if (nw === root.windowWidth && nh === root.windowHeight) return
    // 一個 Process 一次只跑一條命令，而寬高是兩次 `omarchy bar set`，同時送會
    // 各自讀寫一次 shell.json 互相蓋掉；包一層 sh 讓它們依序跑。值是上面自己
    // 夾出來的整數，沒有引號問題。
    sizeWriter.command = ["sh", "-c",
      "omarchy bar set " + root.moduleName + " windowWidth " + nw +
      " && omarchy bar set " + root.moduleName + " windowHeight " + nh]
    sizeWriter.running = true
  }

  function pickerComposerStillOwned(chat, version, generation) {
    if (root.composerGenerationFor(chat) !== Number(generation)) return false
    var expected = Number(version || 0)
    if (expected <= 0) return true
    return Number(root.composerDraftVersionByChat[String(chat)] || 0) === expected
  }

  // 選檔用系統對話框（zenity + xdg-desktop-portal-gtk），選完把路徑印到 stdout。
  // Omarchy 沒有預裝 zenity。執行檔不存在時 Process 起不來，也就沒有 exited 可以接，
  // 按下去等於完全沒反應；所以外面包一層 sh -c，讓 shell 自己回報缺什麼，
  // 缺的訊息跟選到的路徑走同一條 stdout，一個收集器就判得完。
  Process {
    id: picker
    property string originChat: ""
    property string originAccount: ""
    property int originSession: -1
    property double originDraftVersion: 0
    property int originDraftGeneration: 0
    property bool originSpendsDraft: false
    command: ["sh", "-c",
      "command -v zenity >/dev/null 2>&1 || { echo __NO_ZENITY__; exit 0; }; " +
      "exec zenity --file-selection --title='選擇要傳送的檔案'"]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var path = String(text || "").trim()
        if (picker.originChat && picker.originAccount === root.myMid
            && picker.originSession === root.sessionEpoch) {
          if (path === "__NO_ZENITY__") {
            root.notice = "找不到 zenity，請 sudo pacman -S zenity"
          } else if (path.length > 0) {
            root.notice = "傳送中…"
            if (root.request("sendFile", {
              chat: picker.originChat, path: path,
              _spendsDraft: picker.originSpendsDraft,
              _draftVersion: picker.originDraftVersion,
              _draftGeneration: picker.originDraftGeneration
            })) {
              if (picker.originSpendsDraft && root.activeChat
                  && String(root.activeChat.mid || "") === picker.originChat
                  && root.pickerComposerStillOwned(
                    picker.originChat, picker.originDraftVersion,
                    picker.originDraftGeneration)) {
                root.resetComposerAfterSuccessfulSend()
              }
            }
          }
        }
        Qt.callLater(root.flushDeferredDraftPickers)
      }
    }
  }

  function pickFile(submitComposer, expectedGeneration, expectedChat, expectedVersion) {
    if (!root.activeChat && expectedChat === undefined) return
    var spendsComposer = submitComposer === true
    var deferredOrigin = expectedChat !== undefined
    var pickerChat = expectedChat === undefined
        ? String(root.activeChat.mid || "") : String(expectedChat || "")
    if (!pickerChat) return
    var requestedGeneration = expectedGeneration === undefined
        ? root.composerGenerationFor(pickerChat) : Number(expectedGeneration)
    var ownsComposer = requestedGeneration === root.composerGenerationFor(pickerChat)
    var hasComposerDraft = String(replyField.text || "").length > 0
        || !!root.replyTarget
        || (Array.isArray(root.mentionPicks) && root.mentionPicks.length > 0)
    if (!root.draftStoreLoaded && !root.draftStoreUnavailable
        && spendsComposer && hasComposerDraft) {
      var deferredPickers = (root.deferredDraftPickers || []).slice()
      deferredPickers.push({
        session: root.sessionEpoch,
        account: root.myMid,
        chat: pickerChat,
        generation: requestedGeneration,
        version: 0
      })
      root.deferredDraftPickers = deferredPickers
      root.notice = "草稿載入後開啟選檔"
      return
    }
    if (!picker.running) {
      picker.originChat = pickerChat
      picker.originAccount = root.myMid
      picker.originSession = root.sessionEpoch
      picker.originDraftVersion = 0
      picker.originDraftGeneration = requestedGeneration
      picker.originSpendsDraft = false
      if (spendsComposer && ownsComposer) {
        if (!deferredOrigin) root.saveActiveDraft(false)
        var stagedDrafts = ((root.pendingDraftComposers || {})[root.myMid] || {})
        var stagedMode = root.draftStoreUnavailable
            && Object.prototype.hasOwnProperty.call(
              stagedDrafts, picker.originChat)
        var accountDrafts = stagedMode
            ? stagedDrafts
            : ((root.draftStore || {})[root.myMid] || {})
        var saved = accountDrafts[picker.originChat] || null
        if (!stagedMode)
          picker.originDraftVersion = deferredOrigin
            ? Number(expectedVersion || 0)
            : Number(root.composerDraftVersionByChat[picker.originChat] || 0)
        picker.originDraftGeneration = stagedMode && saved
            && saved.generation !== undefined ? Number(saved.generation)
            : root.composerGenerationFor(picker.originChat)
        picker.originSpendsDraft = !!saved && !saved.remove && !root.draftVersionInFlight(
          picker.originChat, picker.originDraftVersion, picker.originDraftGeneration)
      }
      picker.running = true
    }
  }

  function rebindPickerDraft(account, chat, generation, revision) {
    var queued = (root.deferredDraftPickers || []).slice()
    var changed = false
    for (var i = 0; i < queued.length; i++) {
      var item = queued[i]
      if (!item || item.account !== String(account || "")
          || item.chat !== String(chat || "")
          || Number(item.generation || 0) !== Number(generation)) continue
      queued[i] = Object.assign({}, item, { version: Number(revision || 0) })
      changed = true
    }
    if (changed) root.deferredDraftPickers = queued
    if (!picker.running || picker.originAccount !== String(account || "")
        || picker.originChat !== String(chat || "")
        || generation === undefined
        || picker.originDraftGeneration !== Number(generation)) return
    picker.originDraftVersion = Number(revision || 0)
  }

  // daemon 對「剪貼簿裡是文字，不是圖片」的那一句。一字不差是契約的一部分：
  // 底下靠它分出「這一下只是普通的貼上」和其餘每一句真的拒絕（沒裝 wl-clipboard、
  // 連不上 Wayland、太大、格式送不出去…），那些都要留在橫幅上。
  readonly property string clipboardEmpty: "剪貼簿裡沒有圖片"

  // 上一次 Ctrl+V 還在等 daemon 回話嗎。答案直接從 pending 算，不另外記一面旗子：
  // onReply 一進來就把那一筆從 pending 刪掉，成功、拒絕、過期三條路都在那一行底下，
  // 斷線走的 dropInFlight() 則是整份清空 —— 換成旗子的話那是五個要記得歸零的地方，
  // 漏掉任何一個，Ctrl+V 就永遠按不動了。
  // 寫成函式而不是綁定：pending 是 property var，改內容再指派回自己不會發訊號
  // —— QML 只在 property 被指到另一個值時才發，就地改內容參考沒變就當作沒變 ——
  // 綁定於是不會重算，函式每次呼叫才讀得到當下的值。
  function clipboardBusy() {
    for (var k in root.pending)
      if (root.pending[k].cmd === "probeClipboardImage"
          || root.pending[k].cmd === "sendClipboardImage") return true
    return false
  }

  // 輸入框裡的 Ctrl+V。面板讀不到 Wayland 的剪貼簿（wl-paste 在 daemon 那邊），
  // 先用 probeClipboardImage 把當下內容存成 daemon 管理的暫存檔；只有確定是圖片後，
  // 才送會配置對帳 token 的 sendClipboardImage。探測失敗或途中斷線都不是訊息傳送，
  // 不會留下永遠等不到歷史訊息的模糊 token；第二階段也不會重讀已改變的剪貼簿。
  // 回傳「這一下 daemon 接手了」；false 就是讓 TextArea 照原本的方式貼上。
  function pasteClipboard() {
    if (!root.activeChat) return false
    // 按住 Ctrl+V 是會自動重複的，而上傳要好幾秒。上一次還沒回話就再送一次，
    // 剪貼簿裡是圖片就是送出兩張一模一樣的，是文字就是同一段字貼兩次。
    // 這一下要「收下來、什麼都不做」（跟 picker 還開著時再按一次 📎 一樣），
    // 不能退回去讓 TextArea 自己貼 —— 那一次貼上正好就是「貼兩次」的第二次。
    if (root.clipboardBusy()) return true
    // daemon 沒在跑就沒有圖片送得出去，這一下還是得是一次普通的貼上。
    // 理由 request() 已經放上橫幅了，不用再說一次。
    if (!root.request("probeClipboardImage", { chat: root.activeChat.mid })) return false
    // 跟 📎 同一句：上傳幾秒鐘之內畫面上不能什麼都沒有。樂觀泡泡則不畫 ——
    // 按下去的這一刻還不知道剪貼簿裡是不是圖片，先畫一顆再為了一次貼字收回來，
    // 等於每貼一段文字都閃一顆泡泡。
    root.notice = "傳送中…"
    return true
  }

  // 檔案類的點下去才抓原檔，抓完交給 xdg-open。
  // 一定要帶 chat：daemon 拿它當 messageBoxId，少了它 LINE 回 ILLEGAL_ARGUMENT
  // 「Invalid messageBoxId」，按下去只會跳一行錯，附件永遠開不起來。
  // intent 是 "lightbox" 或 "external"；沒給就當 "external"，因為只有燈箱那條
  // 路是新加的，其餘每個呼叫點的意思都還是「開出去」。
  function openMedia(id, intent) {
    if (!root.activeChat) return
    // 送出去了才記用途：daemon 沒在跑的時候 request 只會跳一行提示，那筆用途
    // 等不到任何回覆，卻會讓後面的 o 以為原圖還在路上。
    if (root.request("download", { chat: root.activeChat.mid, messageId: id, preview: false }, id))
      root.markOpen(id, intent === "lightbox" ? "lightbox" : "external")
  }

  function fetchPreview(m, invalidate) {
    var kind = m ? String(m.contentType || "") : ""
    var supported = kind === "IMAGE" || (kind === "VIDEO" && m.previewable === true)
    if (!m || !supported || m.mediaPath
        || !root.mediaUsable(m) || root.previewRequests[m.id]
        || !root.activeChat
        || String(m.chat || "") !== String(root.activeChat.mid || "")) return
    var queued = root.previewRetryQueue[String(m.id || "")]
    // !! because `false || (undefined && ...)` is undefined, and the queue
    // entry below must carry a real boolean for the replay checks.
    var mustInvalidate = !!(invalidate === true
        || (queued && queued.invalidate === true))
    // Preview loading is background work. With the socket down there is no
    // one to ask, and request() would replace a useful banner -- a dropped
    // send's "可能沒送出去" warning -- with the generic offline notice.
    // Defer instead. Reconnect restarts previewRetryTimer while the queue
    // is non-empty, so a queued id replays deterministically -- a history
    // reload alone would skip the refetch when the rows come back
    // unchanged. The entry keeps the invalidate marker so a delegate
    // replay without an argument cannot let the daemon reuse a corrupt
    // cache file either.
    if (!sock.connected) {
      var offlineQueue = Object.assign({}, root.previewRetryQueue)
      offlineQueue[String(m.id || "")] = {
        invalidate: mustInvalidate,
        chat: String(m.chat || ""),
      }
      root.previewRetryQueue = offlineQueue
      root.previewRefreshNeeded = true
      return
    }
    var busy = Object.assign({}, root.previewRequests)
    busy[m.id] = true
    root.previewRequests = busy
    if (!root.request("preview", {
      chat: root.activeChat.mid, messageId: m.id, invalidate: mustInvalidate
    }, m.id)) {
      root.previewRefreshNeeded = true
      if (mustInvalidate) {
        var retryQueue = Object.assign({}, root.previewRetryQueue)
        retryQueue[String(m.id || "")] = {
          invalidate: true,
          chat: String(m.chat || ""),
        }
        root.previewRetryQueue = retryQueue
      }
      delete busy[m.id]
      root.previewRequests = Object.assign({}, busy)
    } else if (queued) {
      var remaining = Object.assign({}, root.previewRetryQueue)
      delete remaining[String(m.id || "")]
      root.previewRetryQueue = remaining
    }
  }

  function retryPreview(id, automatic) {
    var retryId = String(id || "")
    var decodeRetries = Object.assign({}, root.previewDecodeRetries)
    if (automatic === true) {
      if (decodeRetries[retryId]) return
      decodeRetries[retryId] = true
    } else delete decodeRetries[retryId]
    root.previewDecodeRetries = decodeRetries
    var changed = []
    var target = null
    for (var i = 0; i < root.messages.length; i++) {
      var message = root.messages[i]
      if (String(message.id || "") === String(id || "")) {
        target = root.withFields(message, { mediaPath: undefined })
        changed.push(target)
      } else changed.push(message)
    }
    if (!target) return
    // Claim the request before replacing the delegate model. Its
    // onModelDataChanged handler then sees the in-flight entry and cannot race
    // this cache-invalidating retry with an ordinary preview request.
    root.fetchPreview(target, true)
    root.setMessages(changed, false)
    if (root.activeChat) root.rememberHistory(root.activeChat.mid, root.messages)
  }

  // property var 存 JS 物件時改內容不會觸發綁定：QML 比的是參考，就地改內容參考
  // 沒變就不發變更訊號。所以複製一份、改在新的那份上、整份換掉。
  function markOpen(id, intent) {
    var w = {}
    for (var k in root.openWanted) w[k] = root.openWanted[k]
    // session fences the delivery: bytes a retired session's socket write
    // already landed cannot be retracted by closing it, so the panel itself
    // refuses a wanted file that outlived the session that asked for it.
    w[id] = { intent: intent, session: root.sessionEpoch }
    root.openWanted = w
  }

  // 成功、失敗兩條路都要拿掉這顆旗子，所以抄成一份共用的。
  function forgetOpen(id) {
    var w = {}
    for (var k in root.openWanted) if (k !== id) w[k] = root.openWanted[k]
    root.openWanted = w
  }

  // 這個附件到底還點不點得下去。mediaState 是 U39 之後 daemon 才送的欄位，
  // 缺的時候一律當作可用 —— 面板先更新、daemon 還是舊的那半天裡，
  // 附件不該整片變成按不動的死字。
  function mediaUsable(m) {
    return PanelKit.mediaUsable(m)
  }

  // 打不開的理由寫在名字後面。daemon 連要都不會去要，少了這幾個字，
  // 使用者看到的只是一行點不動的灰字，會以為是自己按錯地方。
  // 收回的訊息 hasMedia 是 false，走不到這一行，但燈箱標題也用同一支，還是擋著。
  function mediaLabel(m) {
    return PanelKit.mediaLabel(m)
  }

  // ---------------------------------------------------------------- 燈箱

  // 這間聊天室裡「看得到的圖」照時間順序攤平：IMAGE 的縮圖一則一張，
  // FLEX 的 carousel 一張圖算一格（每格就是一個 bubble），←/→ 就是走這串。
  // 抓不到縮圖的 IMAGE 排除掉 —— 燈箱開起來會是一片黑，比不能按還糟。
  // 收回、過期的一樣不進來：版面上那一格已經不畫圖了，這串卻還留著位子的話，
  // ←/→ 會走到一格空白，看起來就是燈箱壞了。
  function pictureList(messages) {
    return PanelKit.pictureList(messages)
  }

  // 縮放固定在 [1,4]：小於 1 就沒有放大的意義，大於 4 縮圖會糊成馬賽克。
  // cx/cy 是游標相對於燈箱中心的位置；回傳的 x/y 讓游標底下那一點不動。
  function zoomAt(scale, panX, panY, cx, cy, factor) {
    return PanelKit.zoomAt(scale, panX, panY, cx, cy, factor)
  }

  // 平移的邊界：放大後的圖不能整片被拖出畫面外（拖到剩一角就等於弄丟了，
  // 而且只能靠雙擊才回得來）。比畫面窄的那一軸沒得動，直接置中。
  function clampPan(x, y, scale, paintedW, paintedH, stageW, stageH) {
    return PanelKit.clampPan(x, y, scale, paintedW, paintedH, stageW, stageH)
  }

  // 按下到放開之間移動超過幾 px 就算拖曳，門檻刻意不看縮放：1× 時圖是不動，
  // 但手上的動作仍然是拖曳，放開那一下不該被當成「點背景」把燈箱關掉。
  function isDrag(dx, dy) {
    return PanelKit.isDrag(dx, dy)
  }

  // 點擊落在圖（放大、平移之後的實際範圍）外面 = 點到背景。
  function outsidePicture(mx, my, stageW, stageH, panX, panY, scale, paintedW, paintedH) {
    return PanelKit.outsidePicture(mx, my, stageW, stageH, panX, panY, scale, paintedW, paintedH)
  }

  function openPicture(id, source, name, index) {
    // 先用縮圖把燈箱撐開，按下去就有反應；原圖 0.5 秒後回來再換。
    root.lightbox = { id: String(id || ""), source: String(source), name: String(name || "圖片"),
                      index: Number(index) || 0 }
    root.lightScale = 1
    root.lightX = 0
    root.lightY = 0
    // 焦點搶過來，不然 Esc/←/→ 會被下面的輸入框吃掉。
    keyCatcher.forceActiveFocus()
    // 這次抓原圖是為了換上燈箱，不是要開外部程式 —— 用途要跟著送出去。
    if (String(id || "").length > 0) root.openMedia(String(id), "lightbox")
  }

  // 從版面上點下去的入口：自己在圖串裡找位置，才有「n / m」跟左右可以走。
  function showPicture(id, source, name) {
    var list = root.pictureList(root.messages)
    var idx = 0
    for (var i = 0; i < list.length; i++)
      if (list[i].source === source) { idx = i; break }
    root.openPicture(id, source, name, idx)
  }

  function stepPicture(dx) {
    if (!root.lightbox) return
    var list = root.pictureList(root.messages)
    var idx = (Number(root.lightbox.index) || 0) + dx
    // 到頭就停，不繞回去：繞回去會讓人以為自己走錯方向。
    if (idx < 0 || idx >= list.length) return
    root.openPicture(list[idx].id, list[idx].source, list[idx].name, idx)
  }

  function closeLightbox() {
    root.lightbox = null
    root.lightScale = 1
    root.lightX = 0
    root.lightY = 0
    // 焦點還回原本的落點，規則跟 panel.focusTarget 同一條，否則關掉燈箱後打字沒地方去。
    if (root.needsLogin) keyCatcher.forceActiveFocus()
    else if (root.view === "chat") replyField.forceActiveFocus()
    else searchField.forceActiveFocus()
  }

  function lightboxCaption() {
    return PanelKit.lightboxCaption(root.lightbox, root.messages)
  }

  // Esc 的去向只有一個地方決定，免得燈箱、聊天室、面板三層各自搶著關。
  function escapeAction() {
    return PanelKit.escapeAction(root.lightbox, root.stickerOpen, root.view)
  }

  // download 回來的原檔往哪去，看的是當初為什麼抓（intent），不是「此刻燈箱在不在
  // 這張」—— 後者會被時間差左右：燈箱先關掉，同一份原檔就變成一個外部視窗。
  // 影片、檔案交給外部程式。面板是全螢幕的 WlrLayer.Overlay，不先 close() 的話
  // xdg-open 起來的視窗會被壓在下面，使用者只會覺得「按了沒反應」。
  // App window 模式沒有這個問題（那是一般視窗，不是 overlay），關掉反而是
  // 平白把人家正在看的東西收走。
  // execDetached 走 argv，不經過 shell，也不像舊的 Process 那樣一次只能開一個。
  function deliverMedia(id, path, intent) {
    if (path.length === 0) { root.notice = "下載失敗"; return }
    if (intent === "lightbox") {
      // 燈箱還開在這張才換圖。人已經按 Esc、翻到下一張或換了聊天室的話，這份
      // 原檔就只是躺在快取裡，沒有別的事要做 —— 尤其不能拿去開外部程式：
      // 那是使用者從頭到尾沒要求過的動作，畫面上會莫名其妙跳出一個看圖視窗。
      if (root.lightbox && root.lightbox.id === id)
        root.lightbox = { id: root.lightbox.id, source: "file://" + path,
                          name: root.lightbox.name, index: root.lightbox.index }
      return
    }
    if (!root.appWindow) root.close()
    Quickshell.execDetached(["xdg-open", path])
  }

  // 燈箱裡按 o：原圖已經在手上就直接開。overlay 的兩種擺法都要把面板收掉，理由同上。
  function openExternally() {
    if (!root.lightbox) return
    var src = String(root.lightbox.source || "")
    if (src.length === 0) return
    var id = String(root.lightbox.id || "")
    // 原圖還在路上（燈箱這時顯示的還是縮圖）：把那次下載的用途改成「開外部」，
    // 等它回來再開。現在就開等於把縮圖丟給看圖程式 —— 人要的是原圖；兩邊都開
    // 則會冒出兩個視窗。面板留著不關，這半秒裡萬一下載失敗，那行錯誤才有地方顯示。
    if (id.length > 0 && root.openWanted[id]
        && String(root.openWanted[id].intent) === "lightbox") {
      root.markOpen(id, "external")
      root.closeLightbox()
      return
    }
    root.closeLightbox()
    if (!root.appWindow) root.close()
    // FLEX 圖是 http 網址，沒有本地檔可以開，交給瀏覽器也算「打開它」。
    Quickshell.execDetached(["xdg-open", src.indexOf("file://") === 0 ? src.slice(7) : src])
  }

  // ------------------------------------------------------------ 訊息清單

  // messages 一律從這裡換。ListView 每次 model reset 都會把 contentY 歸零
  // （Qt 6.11 量過），所以「換完視窗停在哪」只有換之前這一刻的幾何說得準 ——
  // 換完 msgList.onModelChanged 照這兩面旗子把視窗放回去。
  // follow 是「這次要不要跟到最後一則」：開聊天室、重抓歷史一律要，
  // 沒給就照使用者換之前在不在底部。
  function setMessages(list, follow) {
    root.atBottom = follow === undefined
      ? msgList.contentY >= msgList.originY + msgList.contentHeight - msgList.height - Style.space(24)
      : !!follow
    root.keepContentY = Math.max(0, msgList.contentY - msgList.originY)
    root.messages = list
    // 新舊內容一模一樣時 ListView 根本不換模型（QVariant 比對相等就直接 return），
    // modelChanged 不發，旗子沒人收就會把「捲到頂要上一頁」永遠擋住。
    Qt.callLater(root.clearSwap)
  }

  function clearSwap() {
    root.keepContentY = -1
    root.prependAnchorIndex = -1
  }

  // 日期分隔線是 ListView 的 section，而 section.property 讀的是模型的欄位，
  // 讀不到「呼叫函式算出來」的值 —— 所以訊息進 messages 之前就把當天的起點蓋上去。
  // 存字串不存數字：section 只給得到字串，大數字轉回來會是 1.75717e+12。
  function withDay(list) {
    return EventLog.withDay(list)
  }

  // 未讀分隔線畫在哪一則之上。daemon 只給得到「這間還有幾則未讀」，所以從最後一則
  // 往回數，只算別人說的（自己送的、系統事件都不進未讀數）。數不滿就回 -1 ——
  // 這一頁還沒讀到那麼舊的地方，寧可不畫也不要畫在錯的位置。
  function firstUnreadIndex(messages, unread) {
    return EventLog.firstUnreadIndex(messages, unread, root.myMid)
  }

  // ------------------------------------------------------------ 即時事件

  // 這一份 state 裡還沒吃過的事件。純函式，watermark 從參數進來：
  //   list   還沒處理過的事件。第一次讀到 state 時是空的 —— 緩衝區裡那些都比待會兒
  //          抓回來的那份歷史舊，重放一次只是多做工
  //   seq    新的 watermark
  //   reload 中間有事件沒看到（daemon 重啟過，或環狀緩衝繞過去把舊的擠掉了），
  //          光靠事件補不齊，正在看的那間要重抓一次歷史
  //   live   這個 daemon 會寫 events。不會的話面板要退回舊做法（lastTime 一動就重抓）
  // 本體在 EventLog.js —— 事件環對帳、bubble 合併、已讀/表情/收回都是純函式，
  // 這裡只剩把面板狀態（myMid、readerCount）餵進去的轉接。
  function eventsSince(events, bootId, seenBootId, seenSeq) {
    return EventLog.eventsSince(events, bootId, seenBootId, seenSeq)
  }

  // 單列清單 patch：socket 推來的 row 直接蓋進 snapshot，照 lastTime 重排。
  // 只吃「跟已讀快照同一輪 boot」的推播 —— 還沒讀過檔案（chatBootSeen 空）
  // 或 daemon 已換輪而檔案還沒到時先丟掉：整份清單會由下一次檔案讀取收口，
  // 先吃了反而把 watermark 墊過檔案頭、讓整份快照被當成舊的擋掉。
  function applyChatPatch(row, revision, boot) {
    if (!row || row.mid === undefined || row.mid === null) return
    var pushBoot = String(boot || "")
    var seenBoot = String(root.chatBootSeen || "")
    if (seenBoot.length === 0) return
    if (pushBoot.length > 0 && pushBoot !== seenBoot) return
    var rev = Number(revision)
    if (isFinite(rev) && rev <= root.chatRevisionSeen) return
    var list = root.chatSnapshot.slice()
    var at = -1
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].mid) === String(row.mid)) { at = i; break }
    }
    var merged = at >= 0 ? Object.assign({}, list[at], row) : row
    if (at >= 0) list.splice(at, 1)
    list.push(merged)
    list.sort(function(a, b) { return Number(b.lastTime || 0) - Number(a.lastTime || 0) })
    root.chatSnapshot = list
    if (isFinite(rev)) root.chatRevisionSeen = rev
  }

  // 事件只套在眼前這間聊天室上。清單那半邊是 daemon 寫 chats 時就更新的，
  // 不必也不該從事件重算。
  function applyEvents(list) {
    var evs = Array.isArray(list) ? list : []
    if (!root.activeChat || evs.length === 0) return
    var mid = String(root.activeChat.mid || "")
    var next = root.messages
    var incoming = false
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i]
      if (!ev || String(ev.chat || "") !== mid) continue
      if (ev.kind === "message") {
        var was = next
        next = root.mergeMessage(next, ev.message)
        if (next !== was && String((ev.message || {}).from || "") !== root.myMid) incoming = true
      } else if (ev.kind === "read") next = root.applyRead(next, ev.upTo, ev.by)
      else if (ev.kind === "reaction") next = root.applyReaction(next, ev.messageId, ev.reactions)
      else if (ev.kind === "unsend") next = root.applyUnsend(next, ev.messageId)
      else if (ev.kind === "edit") next = root.applyEdit(next, ev.message)
      else if (ev.kind === "history") next = root.applyHistory(next, ev.messages)
    }
    // 下面四支沒改到東西時原封不動回傳同一份，所以參考沒變就是這一輪什麼都沒發生。
    // 照樣呼叫 setMessages 的話，每一次心跳都會把捲動位置重算一遍。
    if (next === root.messages) return
    root.setMessages(root.withDay(next))
    root.reconcileAmbiguous(mid, root.messages)
    // 標已讀本來是搭「重抓整頁」順便做的（history 的 markRead）。整頁不抓了，這件事
    // 就得自己做一次 —— 少了它，人正在讀的聊天室會一直掛著未讀數，對方也永遠等不到
    // 已讀。count 給 1：要的只是 daemon 那一句 sendChatChecked，不是那一頁訊息。
    // 一批事件只送一次，相簿一次進來十則不必標十次。
    if (incoming) root.request("markRead", { chat: mid, count: 1, markRead: true })
  }

  // 改過的那一則要換成新物件：純 JS 物件就地改內容不會發變更訊號（QML 比的是參考，
  // 內容改了參考沒變就當作沒變），而且 ListView 比對前後兩份模型時，元素還是同一個
  // 參考就當作沒變、連 delegate 都不會重建。patch 裡的 undefined 是「拿掉這個欄位」
  // —— 契約說沒值的欄位是整個不存在。
  function withFields(m, patch) {
    return EventLog.withFields(m, patch)
  }

  function mergeMessage(list, m) {
    return EventLog.mergeMessage(list, m, root.myMid)
  }

  function applyEdit(list, m) {
    return EventLog.applyEdit(list, m)
  }

  function applyHistory(list, fresh) {
    return EventLog.applyHistory(list, fresh)
  }

  function applyRead(list, upTo, by) {
    return EventLog.applyRead(list, upTo, by, root.myMid, root.readerCount)
  }

  function applyReaction(list, id, rows) {
    return EventLog.applyReaction(list, id, rows)
  }

  function applyUnsend(list, id) {
    return EventLog.applyUnsend(list, id)
  }

  function readText(m) {
    return EventLog.readText(m, root.myMid)
  }

  function reactionEmoji(type) {
    return EventLog.reactionEmoji(type)
  }

  function myReaction(m) {
    return EventLog.myReaction(m)
  }

  function canActOn(m) {
    return EventLog.canActOn(m)
  }

  // 點表情：點自己已經選的那個就是收回。LINE 一個人在同一則上只有一個表情，
  // 再點一次不是疊加，所以「取消」沒有別的入口。
  function toggleReaction(m, type) {
    if (!root.canActOn(m) || !root.activeChat) return
    var t = root.myReaction(m) === String(type) ? "UNDO" : String(type)
    root.request("react", { chat: root.activeChat.mid, messageId: String(m.id), type: t })
  }

  // 收回。daemon 會擋別人的訊息，但選單本來就只對自己的給這一項；
  // 超過 24 小時之類的拒絕由 daemon 說，橫幅照跳。
  function unsendMessage(m) {
    if (!root.canActOn(m) || !root.activeChat) return
    root.request("unsend", { chat: root.activeChat.mid, messageId: String(m.id) })
  }

  // 回覆哪一則。存的是畫得出來的那三個欄位，跟 daemon 給的 replyTo 同一個形狀。
  function startReply(m) {
    if (!root.canActOn(m)) return
    root.replyTarget = { id: String(m.id),
      fromName: String(m.from === root.myMid ? "我" : (m.fromName || "")),
      text: root.oneLine(root.bodyText(m)) }
  }

  // 引言那一行。daemon 查不到原文時 replyTo 只有 id（契約寫的「盡力而為」），
  // 那就退成「訊息」——「某某：」後面接一片空白看起來像壞掉。
  function quoteText(r) {
    return EventLog.quoteText(r)
  }

  // 引言點下去跳回原訊息。翻不到那麼舊的時候要說一聲 —— 按了沒反應是最難查的
  // 那種失敗。
  function scrollToMessage(id) {
    var target = String(id || "")
    for (var i = 0; i < root.messages.length; i++) {
      if (String(root.messages[i].id || "") !== target) continue
      msgList.positionViewAtIndex(i, ListView.Center)
      return true
    }
    root.notice = "原訊息不在這一頁裡，往上捲可以載入更舊的"
    return false
  }

  // ------------------------------------------------------------ 樂觀送出

  // 樂觀泡泡的共同欄位，加上把它接進清單。文字和貼圖只差最後那兩個欄位，
  // 整顆各寫一份的話之後多一個欄位就會有一邊漏掉。
  // This identity survives alongside bubbles restored from another Panel.
  // The socket request later attaches its own stable request token.
  function pendingBubble(fields) {
    var bubble = {
      id: "pending-" + root.panelInstanceId + "-" + String(root.nextId)
          + "-" + Math.floor(Math.random() * 4294967296).toString(36),
      chat: root.activeChat.mid,
      from: root.myMid, fromName: "我", text: "", time: Date.now(),
      contentType: "NONE", decryptFailed: false, hasMedia: false, pending: true,
      mentions: []
    }
    for (var k in fields) bubble[k] = fields[k]
    var list = root.messages.slice()
    list.push(bubble)
    root.setMessages(root.withDay(list))
    return bubble.id
  }

  function appendPending(body, mentions, replyTo) {
    // mentions 也塞進去：等 daemon 回來重讀那半秒，自己 @ 的人本來就該是亮的，
    // 不然畫面會先灰一下再變色，看起來像送出去之後才決定 @ 到誰。
    var fields = { text: body, mentions: Array.isArray(mentions) ? mentions : [] }
    // 引言也先畫上：等 daemon 把真的那則推回來的那一兩秒，畫面上不該只是一句
    // 沒頭沒尾的話 —— 使用者剛剛才挑了要回哪一則。
    if (replyTo) fields.replyTo = replyTo
    return root.pendingBubble(fields)
  }

  // 貼圖沒有文字，走不了 appendPending。stickerUrl 一設，泡泡畫的就是那張圖：
  // 泡泡裡那個 Image 跟收到的貼圖是同一段程式，兩邊的網址又都過了 stickerStill
  // —— daemon 從 2.4.0 起送出時會帶 STKOPT，LINE 推回來的那則是動態網址，不換成
  // 靜態的話 mergeMessage 換掉的就不是同一張圖，畫面上會閃一下。
  function appendPendingSticker(url) {
    return root.pendingBubble({ contentType: "STICKER", stickerUrl: String(url || "") })
  }

  function dropMessage(id) {
    var list = []
    for (var i = 0; i < root.messages.length; i++)
      if (root.messages[i].id !== id) list.push(root.messages[i])
    root.setMessages(list)
  }

  function rememberFailedMessage(chat, message) {
    var next = EventLog.recordFailure(root.failedMessagesByChat, chat, message)
    if (next) root.failedMessagesByChat = next
  }

  function mergeFailedMessages(chat, list) {
    return EventLog.mergeFailedMessages(root.failedMessagesByChat[String(chat || "")], list)
  }

  // atBottom 不在這裡設：這支只是把請求送出去，回來要停在哪由 setMessages
  // 在真的換清單的那一刻決定，中間使用者還捲得動。
  // markRead 沒帶就照舊標已讀：openChat 開聊天室是「人在看」，標是合理語意。
  // twoPane 重開面板（onOpenedChanged）與 socket 重連（onConnectionStateChanged）
  // 的重抓帶 false —— 右欄留著的對話只是跟著面板被打開，使用者沒點開它，
  // 不能因為重抓就被標成已讀。
  function loadHistory(mid, markRead) {
    root.loading = true
    // 整份換掉，messages[0] 就換人了 —— 上一次問出來的「沒有更舊的」是問另一則的，
    // 這裡不放回去的話，重抓之後這間就再也翻不上去。
    root.noMoreOlder = false
    // 同一個道理，往前推一代：還在飛的那趟 older 問的是舊的 messages[0]，接到這一份
    // 上面會缺一段，所以它回來時要被 onReply 丟掉。
    root.historyGen++
    // 被丟掉的那趟不會再清這面旗子（它已經不是這一代的了），不在這裡清就等於這間
    // 聊天室再也翻不上去。清掉不會讓兩趟同時在飛：這一刻 loading 是 true，
    // loadOlder 第一行就擋住，要等這份歷史回來才送得出下一趟 older。
    root.loadingOlder = false
    // 送不出去就把旗子收回來。request() 回 false 代表這一趟沒有登記 pending，
    // 沒有任何回覆會來把「載入中…」熄掉；留著它 loadOlder 第一行就永遠擋住自己，
    // 這間聊天室要離開再進來才翻得動。看的是 request() 的回傳值，不是自己再問
    // 一次 sock.connected —— 同一個條件抄成兩份，遲早有一份會漏。
    if (!request("history", { chat: mid, count: root.historyPage,
                              markRead: markRead !== false }))
      root.loading = false
  }

  // 快取上限 20 間；再多就從最久沒動的開始丟到剩 20。一次只丟一間的話，
  // 快取一旦超標（舊版留下來的、或同一輪補進多間）就再也降不回上限。
  // at 可能是 undefined 或字串，不先轉成數字排出來的順序是亂的，會丟錯間。
  // 照鐵則 11：整份重建一個新物件，就地改 property var 不會觸發綁定。
  function rememberHistory(mid, list) {
    if (!mid) return
    var next = {}
    for (var k in root.historyCache) {
      if (k === mid) continue
      next[k] = root.historyCache[k]
    }
    // 樂觀氣泡只是本地暫時狀態，存進快取的話切回來會看到一顆永遠送不出去的訊息。
    next[mid] = { at: Date.now(), messages: list.filter(function(m) { return !m.pending }) }
    var keys = Object.keys(next)
    if (keys.length > 20) {
      keys.sort(function(a, b) { return (Number(next[a].at) || 0) - (Number(next[b].at) || 0) })
      for (var i = 0; i < keys.length - 20; i++) delete next[keys[i]]
    }
    root.historyCache = next
  }

  // 快捲到頂就往前翻一頁（門檻見 nearOlderEdge）。錨點那則會被重複回傳，前置時要去重。
  // 一次只有一趟在飛：loadingOlder 擋掉第二次，否則兩份重疊會撞壞去重跟錨點。
  function loadOlder() {
    if (root.loadingOlder || root.loading || root.noMoreOlder) return
    if (!root.activeChat || root.messages.length === 0) return
    var before = ""
    for (var i = 0; i < root.messages.length; i++) {
      if (root.messages[i].pending || root.messages[i].failed === true) continue
      before = String(root.messages[i].id || "")
      if (before.length > 0) break
    }
    // A chat containing only local recovery rows has no server cursor yet.
    if (before.length === 0) return
    root.loadingOlder = true
    // 同 loadHistory：送不出去就收回旗子。daemon 重啟的那幾秒往上捲一下，
    // 旗子留著就是這間聊天室從此翻不上去，而畫面上只有一句「daemon 沒在跑」，
    // 看不出翻頁已經壞了。
    if (!request("older", { chat: root.activeChat.mid, count: root.historyPage,
                            before: before }))
      root.loadingOlder = false
  }

  // 預抓的門檻：離頂端還有一個畫面高就先去要下一頁，不要等真的貼到頂。等貼到頂的話
  // 每翻一頁都要停在頂端等一趟 daemon＋LINE 的來回，翻舊訊息就是一段一段卡。
  // 係數取 1（＝msgList.height）：那正好是「從看到這一屏到捲到頂」還要走的距離，
  // 一格滾輪 60px 的話大約六、七格的時間，一趟來回通常趕得上；再大就會在使用者
  // 根本沒打算往上翻的時候先白抓一頁。
  // contentHeight > height 這一條是原本就有的：內容比視窗短時 contentY 恆等於
  // originY，不擋的話一開聊天室就永遠算在門檻內。
  function nearOlderEdge(contentY, originY, contentHeight, height) {
    return PanelKit.nearOlderEdge(contentY, originY, contentHeight, height)
  }

  // 前置一頁之後視窗要停在哪：keep 是換模型之前量到的「人離頂端幾 px」，
  // 錨點定位完再補回去，人才會停在原地，預抓也才不會無限連抓。
  function anchoredContentY(afterY, originY, keep, contentHeight, height) {
    return PanelKit.anchoredContentY(afterY, originY, keep, contentHeight, height)
  }

  function openChat(chat) {
    root.lightbox = null
    // 引言屬於上一間的那一則，跟著換聊天室一起丟掉。貼圖選單也收起來：
    // 挑到一半換了聊天室，下一張就會送錯間。
    if (root.saveActiveDraft) root.saveActiveDraft(true)
    if (root.stopDraftSaveTimer) root.stopDraftSaveTimer()
    root.restoringDraft = true
    replyField.text = ""
    root.mentionPicks = []
    root.replyTarget = null
    root.restoringDraft = false
    root.setStickerOpen(false)
    // 一定要排在 activeChat 之前：activeHidden 綁在 activeChat 上，指派的那一刻
    // 就重算完、onActiveHiddenChanged 也跟著跑完了，這一行留在後面的話，從搜尋
    // 點進來的隱藏聊天會在畫面出現之前就被彈回清單。
    root.hiddenOnOpen = chat && root.chatHidden(chat.mid) ? String(chat.mid || "") : ""
    root.activeChat = chat
    // 有快取就先貼上去 —— messages 非空時那個「載入中…」佔位就不顯示了，
    // 底下照樣重抓一次，回來整份替換。
    var cached = root.historyCache[chat.mid]
    // follow 給 true：開聊天室一律從最後一則看起，不能沿用上一間捲到哪的判斷。
    var cachedMessages = cached ? cached.messages.slice() : []
    cachedMessages = root.mergeFailedMessages(chat.mid, cachedMessages)
    root.setMessages(root.withDay(
        root.preserveAmbiguousBubbles(chat.mid, cachedMessages)), true)
    // 未讀分隔線用的是「開的這一刻」那個數字 —— loadHistory 會叫 daemon 標成已讀，
    // 下一份 state 寫回來 unread 就是 0 了，那時再問就永遠問不到。
    root.unreadMarkCount = Number(chat.unread || 0)
    root.unreadMarkId = ""
    // 前一個聊天的 older 可能還在路上，回來時已被當成過期丟掉；
    // 旗標不跟著清就會一直卡住，新聊天按不動 loadOlder()。
    root.loadingOlder = false
    root.view = "chat"
    root.loadHistory(chat.mid)
    root.loadMembers(chat.mid)
    // loadMembers resets mentionPicks for the previous chat. Restore after it
    // so a failed send keeps the mention spans with the text being retried.
    if (root.restoreDraft) root.restoreDraft(chat.mid)
    // callLater：這一刻聊天檢視還沒 visible，看不見的東西拿不到焦點。
    Qt.callLater(function() { replyField.forceActiveFocus() })
  }

  // 認下的那一筆只跳一次，跳成功才回 true。跳不成（清單裡還沒有這一間）就丟掉 ——
  // 留著的話下次開面板會跳進一間跟這次通知無關的聊天室。
  // socket 還沒接上就先不跳：openChat 會去抓歷史，而沒接上的 request 只會留下
  // 一句假的「daemon 沒在跑」。接上的那一刻 onConnectionStateChanged 會再叫一次。
  function takeWanted() {
    if (!root.opened || !sock.connected || root.pendingWanted.length === 0) return false
    var chat = root.chatById(root.pendingWanted)
    root.pendingWanted = ""
    if (!chat) return false
    root.openChat(chat)
    return true
  }

  // 正在看的那間被隱藏了（在 twoPane 版面右鍵按得到，別台機器也改得到 hidden.json）
  // 就退回清單，走跟 Esc 完全同一條路 —— 隱藏之後它已經不在清單裡，停在裡面等於
  // 留了一條回不去的路。activeChat 是開的當下那一份，隱藏狀態要回頭去現在的
  // state.chats 裡問。
  function chatHidden(mid) {
    var c = root.chatById(String(mid || ""))
    return !!c && !!c.hidden
  }

  // openChat() 開的那一間，若開的當下就已經隱藏，mid 記在這裡。
  property string hiddenOnOpen: ""

  // 「停在裡面的時候被隱藏」跟「從搜尋點進一間本來就隱藏的」是兩回事，而
  // activeChat 一換過去，光看隱藏狀態的話兩者長得一模一樣。只看狀態就會把後者
  // 也彈回清單 —— 搜尋是隱藏聊天唯一的入口，那等於那幾列永遠點不開。
  // 差別只有一個：開的當下它是不是已經隱藏。開著的時候被拿掉才退回去；
  // 自己找進來的那一間就一直待到你自己離開。
  function hiddenSinceOpened(chat, openedHidden) {
    var mid = chat ? String(chat.mid || "") : ""
    if (mid.length === 0 || mid === openedHidden) return false
    return root.chatHidden(mid)
  }

  readonly property bool activeHidden:
    root.hiddenSinceOpened(root.activeChat, root.hiddenOnOpen)

  onActiveHiddenChanged: if (root.activeHidden) root.backToList()

  function backToList() {
    if (root.saveActiveDraft) root.saveActiveDraft(true)
    if (root.stopDraftSaveTimer) root.stopDraftSaveTimer()
    // 燈箱是對話的一部分，離開對話就不該留著。引言、貼圖選單同理。
    root.lightbox = null
    if (!root.twoPane) {
      root.restoringDraft = true
      root.replyTarget = null
      root.mentionPicks = []
      root.restoringDraft = false
    }
    root.setStickerOpen(false)
    // 離開前留一份：翻上去的舊訊息也在裡面，下次進來不用從頭再等一次。
    if (root.activeChat && root.messages.length > 0)
      root.rememberHistory(root.activeChat.mid, root.messages)
    root.view = "list"
    root.notice = ""
    root.loading = false
    root.loadingOlder = false
    // 焦點還給 keyCatcher，否則回到清單後方向鍵不會動。
    // 順便把清單捲回選取項附近 —— 停在上次離開的位置會讓人以為清單少了東西。
    listFlick.contentY = 0
    root.selectedIndex = 0
    Qt.callLater(function() { searchField.forceActiveFocus() })
    // twoPane 時右邊那半一直看得見，清掉就變成一片空白 —— Esc 只是把焦點交回清單。
    if (root.twoPane) return
    root.activeChat = null
    root.setMessages([], true)
    root.unreadMarkCount = 0
    root.unreadMarkId = ""
  }

  onOpenedChanged: {
    if (!opened) backToList()
    else {
      listFlick.contentY = 0
      searchField.text = ""
      if (root.activeChat && root.restoreDraft) root.restoreDraft(root.activeChat.mid)
      else {
        root.restoringDraft = true
        replyField.text = ""
        root.mentionPicks = []
        root.replyTarget = null
        root.restoringDraft = false
      }
      root.mentionDismissedAt = -1
      Qt.callLater(function() { searchField.forceActiveFocus() })
      // twoPane 關起來時對話留著，但關著的期間 socket 斷了、什麼都沒收到，
      // 所以一開回來就重抓一次；順便把關起來前留下的橫幅清掉。
      root.notice = ""
      root.loading = false
      // 面板是 daemon 叫 shell 開的，state 常常比 open 還早到 —— 那一筆等在這裡。
      // 跳成功的話右半邊已經換成新的那一間，底下不必再抓一次要離開的那一間。
      if (!root.takeWanted() && root.twoPane && root.activeChat) {
        // 關著的期間進來的那幾則也該有一條分隔線。這條路沒經過 openChat，未讀數
        // 得自己再問一次 state。聊天室不在清單裡（剛被刪掉）就是 0，畫錯位置
        // 比不畫還糟。
        var kept = root.chatById(root.activeChat.mid)
        root.unreadMarkCount = kept ? Number(kept.unread || 0) : 0
        root.unreadMarkId = ""
        // socket 是跟著 opened 重連的，這一刻常常還沒連上；沒連上就別送
        // （送了只會留假的「daemon 沒在跑」），把 loadedAt 歸零，
        // daemon 每 30 秒的心跳一寫 state，parseState 就會補抓。
        // 重抓不帶 markRead：只是打開面板、沒點開聊天室，不能把留著的對話
        // 標成已讀 —— 未讀分隔線照畫，標已讀留給 openChat 那一趟。
        if (sock.connected) root.loadHistory(root.activeChat.mid, false)
        else root.loadedAt = 0
      }
    }
  }

  // ---------------------------------------------------------------- utils

  function agoText(ms) {
    return PanelKit.agoText(ms, root.nowMs)
  }

  // state.link 是選填欄位：舊的 daemon 和 stub.py 都不送，缺的時候一律當作正常，
  // 不能因為沒有這個欄位就在標題下掛一行「連線中斷」。
  // 徽章不動 —— 未讀數是斷線前抓到的，還是真的，只是可能不夠新。
  function partialListNoticeText() {
    var cl = root.state && root.state.chatList ? root.state.chatList : null
    return PanelKit.partialListNoticeText(cl, root.chats.length,
                                          root.search.length > 0)
  }

  function linkNoticeText() {
    return PanelKit.linkNoticeText(root.state, root.online, root.nowMs,
                                   root.search.length > 0, root.chats.length)
  }

  // 清單標題下那一行實際顯示什麼。單欄時對話那半邊整個不可見（chatPane 的 visible
  // 是 twoPane || view === "chat"），noticeLine 跟著看不到，所以提示只能借這一行 ——
  // 不然按「同步」在單欄清單裡等於什麼都沒發生。兩欄時 noticeLine 一直在畫面上，
  // 再借一次只是把同一句話同時印兩遍。
  function listNoticeText() {
    var cl = root.state && root.state.chatList ? root.state.chatList : null
    return PanelKit.listNoticeText(root.draftWriteError, cl, root.twoPane,
                                   root.notice, root.linkNoticeText())
  }

  function loginErrorDetail() {
    return PanelKit.loginErrorDetail(root.loginInfo)
  }

  function listPaneWidth(parentWidth, fontScale) {
    return PanelKit.listPaneWidth(parentWidth, fontScale,
                                  Style.space(300), Style.space(24))
  }

  function toolsStacked(paneWidth, toolsWidth) {
    return PanelKit.toolsStacked(paneWidth, toolsWidth, Style.space(160))
  }

  // 訊息可能含換行；elide 只處理單行，多行會把列高撐爆疊到別的列上。
  function oneLine(t) {
    return EventLog.oneLine(t)
  }

  function clockText(ms) {
    return Qt.formatDateTime(new Date(Number(ms || 0)), "HH:mm")
  }

  // --------------------------------------------------------------- 大頭貼

  // 沒有大頭貼時畫的那顆圓的底色。照 mid 的雜湊挑，同一個人每次都是同一個顏色 ——
  // 隨機或照清單位置挑的話，未讀往前排一次整排顏色就跟著換，看起來像換了一批人。
  function avatarColor(mid) {
    return PanelKit.avatarColor(mid)
  }

  function avatarInitial(text) {
    return PanelKit.avatarInitial(text)
  }

  // 這一則旁邊要不要掛大頭貼：群組裡、不是自己講的、而且是同一個人連著講的那一串的
  // 第一則。1:1 只有兩個人，每一則都掛一張臉只是噪音。
  function showAvatarAt(list, i) {
    var group = !!root.activeChat && /^[cr]/.test(String(root.activeChat.mid || ""))
    return EventLog.showAvatarAt(list, i, group, root.myMid)
  }

  // 圓形大頭貼。圓角遮罩要一張材質，材質要一個 FBO —— 沒有圖的那幾列不該付這個錢，
  // 所以 hasPicture 是 false 時整組圖層都不開，看得見的就是底下那顆縮寫圓；圖載不到
  // （檔案被清掉了）也是退回同一顆，不會留一個空洞。
  // Quickshell.Widgets 的 ClippingRectangle 也做得到，但那個模組的外掛只註冊在
  // quickshell 執行檔裡（qmldir 是 optional plugin + prefer :/qt/qml/…），qmllint
  // 和純 qml 都吃不到；MultiEffect 是 shell 自己在用的那一套（Tray、image-picker）。
  component AvatarBadge: Item {
    id: badge

    // 本機絕對路徑，空字串代表沒有大頭貼
    property string picture: ""
    // 沒有大頭貼時畫的縮寫
    property string label: ""
    // 配色用的 mid
    property string seed: ""
    readonly property bool hasPicture: badge.picture.length > 0

    Rectangle {
      anchors.fill: parent
      radius: width / 2
      color: root.avatarColor(badge.seed)

      Text {
        anchors.centerIn: parent
        text: badge.label
        // 底色是固定的深色，白字才一定讀得到 —— 跟著主題走會在淺色主題上消失。
        color: "#ffffff"
        font.family: root.fontFamily
        font.pixelSize: Math.max(1, Math.round(parent.width * 0.5))
      }
    }

    Item {
      id: circleMask
      anchors.fill: parent
      visible: false
      layer.enabled: badge.hasPicture

      Rectangle {
        anchors.fill: parent
        radius: width / 2
        color: "white"
      }
    }

    Image {
      id: badgePicture
      anchors.fill: parent
      // 載入中、或路徑指到一個已經不在的檔案時，看得見的是底下那顆縮寫圓。
      visible: badge.hasPicture && badgePicture.status === Image.Ready
      source: badge.hasPicture ? "file://" + badge.picture : ""
      fillMode: Image.PreserveAspectCrop
      asynchronous: true
      cache: true
      // 用邏輯像素解碼在 HiDPI 上是糊的（跟 shell 的 Tray 同一個理由）。
      sourceSize.width: Math.round(width * Screen.devicePixelRatio)
      sourceSize.height: Math.round(height * Screen.devicePixelRatio)
      layer.enabled: badgePicture.visible
      layer.smooth: true
      layer.effect: MultiEffect {
        maskEnabled: true
        maskSource: circleMask
        maskThresholdMin: 0.5
        maskSpreadAtMin: 0.1
      }
    }
  }

  // 這一則屬於哪一天：當天凌晨的毫秒。日期分隔線是 ListView 的 section，
  // 同一天的訊息要算出同一個值才會歸在同一段。
  function dayStart(ms) {
    return EventLog.dayStart(ms)
  }

  function dayLabel(ms, nowMs) {
    return EventLog.dayLabel(ms, nowMs)
  }

  function isSystemEvent(m) {
    return EventLog.isSystemEvent(m)
  }

  function systemEventText(m) {
    return EventLog.systemEventText(m)
  }

  function bodyText(m) {
    return PanelKit.bodyText(m)
  }

  // ------------------------------------------------------ 選取、連結、複製

  // 本文要能點連結，所以它是 RichText；RichText 代表整段字都會被當標記解析，
  // 使用者打的 < 和 & 本來就該原樣顯示。所以先全部跳脫，畫面上剩下的標記
  // 只會有 linkify 自己包的那些 —— 訊息內容沒有任何一條路徑能變成標記。
  function escapeHtml(t) {
    return PanelKit.escapeHtml(t)
  }

  function linkify(text, linkColor) {
    return PanelKit.linkify(text, linkColor)
  }

  // 顏色去掉 alpha 再轉字串：帶 alpha 的 QML 顏色會變成 #AARRGGBB，CSS 讀不懂。
  function bodyHtml(m) {
    var accent = String(Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 1))
    return PanelKit.bodyHtml(m, accent)
  }

  // 純函式。把本文照 mention 切段：mention 那幾段只跳脫再上色（人名裡不會有網址），
  // 其餘每一段各自 linkify。跳脫一定要切完之後各段自己做 —— 先跳脫整段的話
  // 一個 & 會變成五個字，後面每一個位移都被推掉，mention 就切在錯的地方。
  function markupBody(text, spans, color) {
    return PanelKit.markupBody(text, spans, color)
  }

  // 純函式。daemon 送來的 mentions 在畫之前先過一次：切段的迴圈只走一趟，
  // 兩個蓋在同一個字上的框會把那段字畫兩次，超出範圍的則會把後半段吃掉。
  function mentionRanges(mentions, len) {
    return PanelKit.mentionRanges(mentions, len)
  }

  // 只放行 http/https。<a> 是上面自己包的，理論上不會有別的 scheme，但
  // onLinkActivated 收到什麼字串是引擎說了算，交給 xdg-open 前一定要再擋一次。
  // 回傳正規化後的網址；空字串代表不放行。
  function linkTarget(url) {
    return PanelKit.linkTarget(url)
  }

  function openLink(url) {
    var target = root.linkTarget(url)
    // 網址是訊息內容，任何情況都不進 log。
    if (target.length === 0) { root.notice = "這個連結打不開"; return }
    // 面板是整片的 WlrLayer.Overlay，不先收掉的話瀏覽器會開在它下面，使用者
    // 只會覺得「按了沒反應」（理由同 deliverMedia）。App window 不是 overlay。
    if (!root.appWindow) root.close()
    Quickshell.execDetached(["xdg-open", target])
  }

  // 複製走 wl-copy 的 stdin：argv 直送、內容只走管線，不經過 shell，也就沒有
  // 引號可以跳脫錯 —— 訊息內容永遠不會變成命令列的一部分。omarchy 自己的面板
  // 是 bash -c 加引號（network/Panel.qml），那條路上內容就是命令列的一部分。
  property string pendingCopy: ""
  // 這一輪 wl-copy 有沒有真的起來。執行檔不存在時 Process 只是把 running 打回
  // false，連 started 都不會發（量過的）；沒有這個旗標，複製失敗就是靜悄悄的。
  property bool copyStarted: false

  Process {
    id: clipWriter
    command: ["wl-copy"]
    running: false
    stdinEnabled: true
    onStarted: root.copyStarted = true
    // 排隊掛在 running 上而不是 exited：起不來的那種失敗沒有 exited 可以接。
    onRunningChanged: {
      if (clipWriter.running) return
      if (!root.copyStarted) root.notice = "複製失敗：系統裡找不到 wl-copy"
      root.flushCopy()
    }
  }

  function copyText(text) {
    var t = String(text === undefined || text === null ? "" : text)
    if (t.length === 0) return false
    // 一個 Process 一次只跑一條命令。連按兩下複製時第二下不能靜靜地不見，
    // 所以先記下來，等前一個收掉再送。
    root.pendingCopy = t
    if (!clipWriter.running) root.flushCopy()
    return true
  }

  function flushCopy() {
    if (clipWriter.running || root.pendingCopy.length === 0) return
    var t = root.pendingCopy
    root.pendingCopy = ""
    root.copyStarted = false
    clipWriter.stdinEnabled = true
    clipWriter.running = true
    clipWriter.write(t)
    // wl-copy 讀到 EOF 才收下，不關 stdin 它會一直等在那裡。
    clipWriter.stdinEnabled = false
  }

  // 右鍵選單的項目。整段一定在；連結那兩項只有右鍵真的壓在連結上才給 ——
  // 點不到東西的選項比沒有這個選項更糟。回覆／收回同理：指不到一則真的訊息就不給，
  // 收回更只給自己傳的（daemon 也會擋，但選單先擋掉才不會讓人按了才被罵）。
  function messageMenuItems(link, m) {
    var items = [{ action: "body", label: "複製訊息" }]
    if (String(link === undefined || link === null ? "" : link).length > 0) {
      items.push({ action: "link", label: "複製連結" })
      items.push({ action: "open", label: "開啟連結" })
    }
    if (root.canActOn(m)) {
      items.push({ action: "reply", label: "回覆" })
      if (String(m.from || "") === root.myMid) items.push({ action: "unsend", label: "收回" })
    }
    return items
  }

  // 聊天清單那一列的右鍵選單。跟訊息共用同一個 Popup —— 選單只有這一份實作。
  // 二選一：同一列不會同時給兩個相反的動作，看到哪一個就代表現在是哪一種狀態。
  function chatMenuItems(c) {
    return PanelKit.chatMenuItems(c)
  }

  // 選單現在列的是哪一組。msgMenu.chat 非 null 就代表這次右鍵壓在清單那一列上。
  function menuItems() {
    return msgMenu.chat ? root.chatMenuItems(msgMenu.chat)
                        : root.messageMenuItems(msgMenu.link, msgMenu.msg)
  }

  function runMenuAction(action) {
    if (action === "body") root.copyText(msgMenu.body)
    else if (action === "link") root.copyText(msgMenu.link)
    else if (action === "open") root.openLink(msgMenu.link)
    else if (action === "reply") root.startReply(msgMenu.msg)
    else if (action === "unsend") root.unsendMessage(msgMenu.msg)
    else if (action === "hide") root.setChatHidden(msgMenu.chat, true)
    else if (action === "unhide") root.setChatHidden(msgMenu.chat, false)
    msgMenu.close()
  }

  // 隱藏／取消隱藏交給 daemon（它記在 hidden.json，是這台機器上的偏好，不上傳
  // LINE）。面板不自己記狀態：下一份 state.json 回來時那一列身上就會帶著 hidden，
  // 自己先改一份等於留了一個跟 daemon 不一致的畫面。
  function setChatHidden(c, hide) {
    var mid = c ? String(c.mid || "") : ""
    if (mid.length === 0) return
    root.request(hide ? "hide" : "unhide", { chat: mid })
  }

  // 右鍵：選單開在游標上。linkAt 吃的是本文自己的座標，位置再換算成 keyCatcher
  // 的 —— 內容整棵在兩個宿主之間搬家，只有這一套座標三種擺法都算得準。
  function openMessageMenu(item, x, y, m) {
    msgMenu.chat = null
    msgMenu.msg = m || null
    msgMenu.body = root.bodyText(m || {})
    // 圖片、貼圖上按右鍵也開得起來，而那些不是文字，沒有 linkAt 可以問。
    msgMenu.link = item && item.linkAt ? root.linkTarget(item.linkAt(x, y)) : ""
    var p = item.mapToItem(keyCatcher, x, y)
    // 高度自己乘出來，不讀 msgMenu.implicitHeight —— Column 的 implicitHeight
    // 要等下一次 polish 才更新，這一刻讀到的還是上一次那份，一行的選單換成
    // 三行的就會夾在錯的位置。表情那一列也剛好是一行高。
    var h = (root.messageMenuItems(msgMenu.link, msgMenu.msg).length
             + (root.canActOn(msgMenu.msg) ? 1 : 0)) * Style.spacing.popupRowHeight
    // 貼著右下角按右鍵時選單會掉到卡片外面，先夾回來。
    msgMenu.x = Math.max(0, Math.min(p.x, keyCatcher.width - msgMenu.width))
    msgMenu.y = Math.max(0, Math.min(p.y, keyCatcher.height - h))
    msgMenu.open()
  }

  // 清單那一列的右鍵：同一個 Popup、同一套夾邊，差別只在項目那一組，
  // 以及沒有表情列（那六個是給訊息按的）。
  function openChatMenu(item, x, y, c) {
    msgMenu.chat = c || null
    msgMenu.msg = null
    msgMenu.body = ""
    msgMenu.link = ""
    var p = item.mapToItem(keyCatcher, x, y)
    var h = root.chatMenuItems(msgMenu.chat).length * Style.spacing.popupRowHeight
    msgMenu.x = Math.max(0, Math.min(p.x, keyCatcher.width - msgMenu.width))
    msgMenu.y = Math.max(0, Math.min(p.y, keyCatcher.height - h))
    msgMenu.open()
  }

  // ------------------------------------------------------- @成員選單

  // 只有群組（c…）和 room（r…）有成員可以 @；1:1（u…）沒有。用正面表列而不是
  // 「不是 u 就算」—— mid 的第一個字母是 LINE 的型別（core/mod.ts:214：
  // u 使用者、r room、c 群組、s、m、p、v、t），不在清單裡的都不是聊天室。
  // room 的名單 daemon 多半拿不到，那就讓選單照樣開、在裡面說原因 ——
  // 按了 @ 什麼都沒發生才是最難查的那種失敗。
  readonly property bool mentionCapable:
    !!root.activeChat && /^[cr]/.test(String(root.activeChat.mid || ""))
  // 打到一半的那個 @：null 代表游標不在一段 @… 裡面。整條綁在輸入框上，
  // 所以打字、移游標、貼上、刪字都會重算，沒有任何一個 imperative 的觸發點。
  readonly property var mentionToken:
    root.mentionCapable && replyField.activeFocus
      ? root.mentionQuery(replyField.text, replyField.cursorPosition) : null
  readonly property var mentionRows:
    root.mentionToken ? root.mentionMatches(root.members, root.mentionToken.query) : []
  readonly property bool mentionOpen:
    !!root.mentionToken && root.mentionToken.start !== root.mentionDismissedAt
    && (root.mentionRows.length > 0 || root.membersError.length > 0)
  // 選單「開著」和「收得到按鍵」是兩件事：讀不到成員時只有一列說明，
  // 那時候 ↑↓/Enter/Tab 還是該照原本的意思做（Enter 就是送出）。
  readonly property bool mentionPicking: root.mentionOpen && root.mentionRows.length > 0
  // 夾住而不是相信 mentionIndex：列數是綁出來的，可能在按鍵和重畫之間就變了。
  readonly property int mentionSelected:
    Math.max(0, Math.min(root.mentionIndex, root.mentionRows.length - 1))

  onMentionRowsChanged: root.mentionIndex = 0

  // 純函式。names 任一個對得上就算：「全部」那一列 All 和 全部 兩種打法都認。
  // 回傳 −1 不符、0 從開頭就對（排前面）、1 中間才對。
  function mentionRank(names, q) {
    return PanelKit.mentionRank(names, q)
  }

  function mentionQuery(text, cursor) {
    return PanelKit.mentionQuery(text, cursor)
  }

  function mentionMatches(members, query) {
    return PanelKit.mentionMatches(members, query)
  }

  function mentionInsert(text, cursor, row) {
    return PanelKit.mentionInsert(text, cursor, row)
  }

  function deriveMentions(text, picks) {
    return PanelKit.deriveMentions(text, picks)
  }

  // 選單開著的時候 ↑↓ 換人。照鐵則 11 這裡改的是 int，不是 property var。
  function moveMention(step) {
    if (root.mentionRows.length === 0) return
    var n = root.mentionRows.length
    root.mentionIndex = (root.mentionSelected + step + n) % n
  }

  // Enter／Tab／點一下都走這裡。照鐵則 11：picks 整份重建，就地 push 不會觸發綁定。
  function takeMention(index) {
    var i = index === undefined ? root.mentionSelected : Number(index)
    var row = root.mentionRows[i]
    if (!row) return false
    var token = root.mentionQuery(replyField.text, replyField.cursorPosition)
    if (!token) return false
    var next = root.mentionInsert(replyField.text, replyField.cursorPosition, row)
    var picks = root.mentionPicks.slice()
    picks.push({ name: String(row.insert || row.name || ""),
                 mid: row.all ? "" : String(row.mid || ""),
                 all: !!row.all,
                 start: token.start })
    root.mentionPicks = picks
    replyField.text = next.text
    replyField.cursorPosition = next.cursor
    return true
  }

  // Esc 只收掉選單，不離開輸入框 —— 打到一半的那句話還在。
  function dismissMention() {
    root.mentionDismissedAt = root.mentionToken ? root.mentionToken.start : -1
  }

  // 換聊天室就換一份名單。1:1 不送（daemon 會回「這不是群組」），
  // 而不是送了再吞掉回覆：不需要的請求就是不要送。
  function loadMembers(mid) {
    root.members = []
    root.membersError = ""
    var wasRestoring = root.restoringDraft
    root.restoringDraft = true
    root.mentionPicks = []
    root.restoringDraft = wasRestoring
    root.mentionDismissedAt = -1
    if (!/^[cr]/.test(String(mid || ""))) return
    // 開聊天室時就要，不是等打了 @ 才要：這時本來就在等 history 回來，成員這一趟
    // 搭在同一段等待裡；等打了 @ 才送的話，選單會先空一下再冒出來。daemon 那邊
    // 有十分鐘的快取，同一間聊天室來回開關只會真的抓一次。
    root.request("members", { chat: String(mid) })
  }

  // ------------------------------------------------------------- 貼圖選單

  // 這個帳號自己的貼圖包（daemon 的 stickers 指令）。第一次打開選單才問：
  // 54 包 2200 張、回應約 280 KB，每開一次就重抓太貴 —— daemon 那邊本來也
  // 快取一小時，要新的得自己按 ⟳。
  property var stickerPacks: []
  property bool stickerOpen: false
  property bool stickerLoading: false
  // 讀不到貼圖清單的原因。不進橫幅：選單是自己打開的，而且它就疊在橫幅上面，
  // 寫進橫幅等於寫在一塊看不到的地方。
  property string stickerError: ""
  // 現在選到哪一包（貼圖包編號）。空字串＝清單還沒回來。
  property string stickerTab: ""
  // 最近用過的上限。一排捲一下就到底，再多就不如去分頁裡挑。
  readonly property int recentStickerMax: 16

  // 最近用過的貼圖：{ mid: [{ packageId, stickerId, url }] }。整份留著才不會
  // 在存檔時把別的帳號那一份洗掉。
  property var stickerStore: ({})
  // 畫出來的永遠是「現在這個帳號的」—— 換帳號就是換一批貼圖包，上一個帳號
  // 用過的那幾張在這裡多半送不出去（daemon 會拒絕）。
  readonly property var recentStickers: root.storedRecent(root.stickerStore, root.myMid)
  // 分頁選到的那一包攤成格子。整個選單只有這一份 model，所以場景上永遠只有
  // 看得見的那一包，不是 54 包一起掛著。
  readonly property var stickerGridModel: root.stickerCells(root.stickerPack(root.stickerTab))

  // 存在 daemon 的 state 目錄裡，跟 state.json 同一個地方：那是這個外掛唯一
  // 保證存在的目錄（daemon 建的），而貼圖選單本來就只有 daemon 活著時用得到。
  // 原子寫入；watchChanges 是為了多螢幕 —— bar 每個螢幕一份，共用這個檔。
  FileView {
    id: stickerFile
    path: root.stateDir + "/panel-stickers.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadStickerStore(text())
    onLoadFailed: root.loadStickerStore("")
    onFileChanged: reload()
    // 存不進去只影響「下次開面板還記不記得」，這一次的那一排照樣是對的 ——
    // 不值得為它在選單裡跳一條紅字，但也不能無聲無息：留在 journal 裡。
    onSaveFailed: function(error) { console.warn("line", "sticker store not saved", error) }
  }

  function loadStickerStore(content) {
    var parsed = null
    try { parsed = JSON.parse(String(content || "")) } catch (e) { parsed = null }
    var recent = parsed && typeof parsed === "object" ? parsed.recent : null
    root.stickerStore = recent && typeof recent === "object" ? recent : ({})
  }

  // 純函式：一份存檔 ＋ 一個帳號 → 畫得出來的那幾張。每個欄位都自己轉一次型別，
  // 這是外部檔案，手改壞了不該讓選單整個畫不出來。
  function storedRecent(store, mid) {
    return PanelKit.storedRecent(store, mid, root.recentStickerMax)
  }

  // 動態貼圖的 sticker_animation.png 是 APNG：Qt 只畫得出第一格，一張卻要
  // 幾百 KB，一格 40 張就是幾十 MB。畫面上每一張貼圖 —— 格子、樂觀泡泡、收到的
  // 那些 —— 都先過這一支，所以同一張貼圖永遠是同一個網址：LINE 把自己推回來的
  // 那則帶的是動畫網址（daemon 送出時帶 STKOPT，收到的人那邊才動得起來），
  // 不正規化的話泡泡一換就要重抓幾百 KB，而 Image 的 visible 綁在 status ===
  // Ready 上，那一格會先消失再出現。
  // 幾百 KB，一格 40 張就是幾十 MB。一律換成同一張的靜態圖。選單、最近用過的
  // 那一排和訊息泡泡都走這裡，所以收到的貼圖、樂觀泡泡和 LINE 推回來的那則畫的
  // 是同一張 —— daemon 從 2.4.0 起帶 STKOPT，推回來的網址是動態的那條。
  function stickerStill(url) {
    return PanelKit.stickerStill(url)
  }

  // 一包貼圖攤成格子。沒有編號的那幾張直接不畫：按下去 daemon 會回「貼圖編號
  // 不對」，畫一格按了只會被罵的東西沒有意義。
  function stickerCells(pack) {
    return PanelKit.stickerCells(pack)
  }

  // 貼圖包編號 → 分頁列上的第幾格。找不到回 -1：清單還沒回來，或那一包已經
  // 不在清單裡了。分頁要捲到哪、←/→ 走到哪一包，都從這個位置算。
  function stickerTabIndex(id) {
    return PanelKit.stickerTabIndex(root.stickerPacks, id)
  }

  // 貼圖包編號 → 那一包。找不到回 null：最近用過的那幾張可能來自已經不在清單
  // 裡的貼圖包，那時候送出去由 daemon 拒絕、理由由它說。
  function stickerPack(id) {
    return PanelKit.stickerPack(root.stickerPacks, id)
  }

  // 分頁上的名字。小舖沒給名字的那幾包不能變成一格空白 —— 認不出來就沒得選。
  function stickerPackName(pack) {
    return PanelKit.stickerPackName(pack)
  }

  // 分頁列捲到哪裡，永遠夾在 0（第一包）和捲到底之間。內容比列還窄時只有 0：
  // 不夾的話滾一下就能把整列推出畫面，看起來會像貼圖包全不見了。
  function stickerTabClamp(x, viewWidth, contentWidth) {
    return PanelKit.stickerTabClamp(x, viewWidth, contentWidth)
  }

  // 滑鼠的滾輪。橫向的 Flickable 根本不吃滾輪（Qt 6.11 量過：垂直、水平兩軸
  // 都不動一格），所以原本只有用拖的捲得動 —— 滑鼠沒有那個手勢，右邊那幾包
  // 等於不存在，2.7.0 之前使用者看到的就是「貼圖 pop up 不能換」。
  // 一個刻度（120）走一步；往上（正值）＝往左，跟直向捲動同一個方向感。
  // 距離跟其他可捲的區塊一樣算在 wheelDistance 裡：只回報 pixelDelta 的觸控板
  // （angleDelta 是 0）本來在這兩列上一格都捲不動，而「捲動速度」那一段也該管
  // 得到這裡。wheelDistance 的一格是 Style.space(60)，這兩列的一格是 step，按
  // 比例換算過去 —— 滑鼠一個刻度還是剛好一個 step，手感不變。
  function stickerTabScroll(contentX, angleY, pixelY, step, viewWidth, contentWidth) {
    return PanelKit.stickerTabScroll(contentX, angleY, pixelY, step, viewWidth,
                                     contentWidth, Style.space(60), root.scrollSpeed)
  }

  // 選到的那一包要在畫面裡：偏左就把左緣貼齊，偏右就把右緣貼齊，已經看得見
  // 就不動 —— 每次換包都置中會讓整列在腳下跳。一格寬過整列時左緣優先，
  // 名字是從左邊開始讀的。
  function stickerTabInView(contentX, itemX, itemWidth, viewWidth, contentWidth) {
    return PanelKit.stickerTabInView(contentX, itemX, itemWidth, viewWidth, contentWidth)
  }

  // ←/→ 換貼圖包。到頭就停，不繞回去 —— 跟燈箱的上一張／下一張同一條規矩。
  function stepStickerTab(dx) {
    var n = root.stickerPacks.length
    if (n === 0) return false
    var step = Math.round(Number(dx) || 0)
    if (step === 0) return false
    var i = root.stickerTabIndex(root.stickerTab)
    // 現在沒選中任何一包（清單剛回來，或選到的那一包已經不在了）：從第一包起算。
    var next = i < 0 ? 0 : i + step
    if (next < 0 || next >= n) return false
    root.stickerTab = String(root.stickerPacks[next].id || "")
    return true
  }

  // 最近用過：剛用的排最前面，同一張不重複，超過 max 就從最舊的砍掉。
  function recentPush(list, item, max) {
    return PanelKit.recentPush(list, item, max)
  }

  // sendSticker 的請求內容。version 只在真的知道的時候帶 —— 契約說不帶就用
  // daemon 清單裡那一包的，那一份一定比面板手上的新。
  function stickerRequest(chat, sticker) {
    return PanelKit.stickerRequest(chat, sticker)
  }

  // 選單裡那一行字。三種「一片空白」要分得出來：還在讀、這個帳號沒有貼圖包、
  // 這一包這次讀不到（契約：讀不到時 stickers 是空陣列，不是把整包藏起來）。
  function stickerStatusText() {
    return PanelKit.stickerStatusText(root.stickerError, root.stickerLoading,
                                      root.stickerPacks, root.stickerGridModel.length)
  }

  // 格子高度：最多 maxRows 列，不夠就只給需要的高度 —— 一包只有八張的時候
  // 底下不該空著兩列。
  function stickerGridHeight(count, width, cell, maxRows) {
    return PanelKit.stickerGridHeight(count, width, cell, maxRows)
  }

  // 開關只有這一支：😊、Esc、點選單以外的地方，三個入口走同一條路 ——
  // 各寫一份就會有一種只關到一半的版本。回傳的是「關完之後開著沒有」。
  function setStickerOpen(on) {
    // 沒有聊天室就沒有「送到哪」，跟 📎 一樣按不動。
    if (on && !root.activeChat) return false
    root.stickerOpen = !!on
    if (!root.stickerOpen) return false
    // 兩塊都貼在輸入框上面，同時開會互相蓋掉。
    root.dismissMention()
    root.loadStickers(false)
    return true
  }

  function toggleSticker() {
    return root.setStickerOpen(!root.stickerOpen)
  }

  // 第一次打開才抓，之後靠選單裡的 ⟳。refresh 讓 daemon 重抓一次，
  // 買了新的貼圖包不必重開面板。
  function loadStickers(refresh) {
    if (root.stickerLoading) return false
    if (!refresh && root.stickerPacks.length > 0) return false
    root.stickerLoading = true
    root.stickerError = ""
    if (root.request("stickers", refresh ? { refresh: true } : {})) return true
    // 送不出去。request 已經把原因寫進橫幅，但這一趟是選單自己送的，而選單
    // 正蓋在橫幅上面 —— 把那句話搬進選單，不然按了 ⟳ 等於什麼都沒發生。
    root.stickerLoading = false
    root.stickerError = root.notice
    root.notice = ""
    return false
  }

  // 點一張貼圖。樂觀泡泡先畫上（送出到 LINE 把自己推回來大約 0.5~2 秒），
  // 選單收掉，最近用過的那一排更新並存檔。
  function sendSticker(cell) {
    if (!cell || !root.activeChat) return false
    // version 一律用現在清單裡那一包的：最近用過的那幾張是存檔讀回來的，
    // 手上那個號碼可能是上一輪的。
    var pack = root.stickerPack(cell.packageId)
    var payload = root.stickerRequest(root.activeChat.mid, {
      packageId: cell.packageId, stickerId: cell.stickerId,
      version: pack ? pack.version : cell.version
    })
    var url = root.stickerStill(cell.url)
    var pendingId = root.appendPendingSticker(url)
    if (!root.request("sendSticker", payload, pendingId)) {
      // 送不出去就別留一顆永遠不會變成真的的泡泡。
      root.dropMessage(pendingId)
      return false
    }
    root.rememberSticker({ packageId: payload.packageId, stickerId: payload.stickerId, url: url })
    root.setStickerOpen(false)
    return true
  }

  // 存檔。還不知道自己是誰的時候不存 —— 讀是照 mid 找的，存了也讀不回來。
  function rememberSticker(item) {
    if (root.myMid.length === 0) return
    var next = {}
    for (var k in root.stickerStore) next[k] = root.stickerStore[k]
    next[root.myMid] = root.recentPush(root.recentStickers, item, root.recentStickerMax)
    // 鐵則 11：整份換一個新物件，就地改 property var 不會觸發綁定。
    root.stickerStore = next
    stickerFile.setText(JSON.stringify({ version: 1, recent: next }) + "\n")
  }

  // 選單裡的一格。最近用過那一排和格子共用這一個 —— 兩份的話「點下去會送出」
  // 遲早只剩一邊還對。modelData 是 required：GridView 和 Repeater 都會自己填。
  component StickerCell: Item {
    id: stickerCell
    required property var modelData
    property int side: Style.space(64)

    width: stickerCell.side
    height: stickerCell.side

    Rectangle {
      anchors.fill: parent
      anchors.margins: Style.space(2)
      radius: Style.cornerRadius
      color: stickerCellHover.containsMouse
        ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"
    }

    CachedImage {
      id: stickerCellImage
      anchors.fill: parent
      anchors.margins: Style.space(6)
      remoteSource: stickerCell.modelData ? String(stickerCell.modelData.url || "") : ""
      asynchronous: true
      fillMode: Image.PreserveAspectFit
      // 一格 64px 卻去解一張 370px 的原圖，一包幾百張就是幾百 MB 的貼圖記憶體。
      // 跟大頭貼同一個理由用實體像素，不然 HiDPI 上是糊的。
      sourceSize.width: Math.round(width * Screen.devicePixelRatio)
      sourceSize.height: Math.round(height * Screen.devicePixelRatio)
    }

    // 圖載不到（離線、CDN 404）時這一格不能是一片空白 —— 那看起來像少了一張，
    // 其實編號還在、按下去照樣送得出去。
    Text {
      anchors.centerIn: parent
      visible: stickerCellImage.downloadFailed || stickerCellImage.status === Image.Error
      text: "?"
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: root.fontBody
    }

    MouseArea {
      id: stickerCellHover
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.sendSticker(stickerCell.modelData)
    }
  }

  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  // ------------------------------------------------------------ bar button

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: !root.online ? "󰭹"
      : (!root.loggedIn ? "󰭹 !" : (root.totalUnread > 0 ? "󰭹 " + root.totalUnread : "󰭹"))
    // 顏色交給 WidgetButton 預設（bar.barForeground），跟其他 bar 圖示一致。
    // active 只留給真的需要處理的狀態 —— 未讀是常態，不是告警。
    active: root.online && !root.loggedIn
    fontSize: Style.font.bodySmall
    horizontalMargin: 3.5
    onPressed: function(buttonCode) { root.toggle() }
  }

  // ----------------------------------------------------------------- panel

  // 開起來時焦點的落點。兩個宿主（面板、App 視窗）用同一條規則，各寫一份就會走鐘。
  readonly property Item focusLanding:
    root.needsLogin ? keyCatcher : (root.view === "chat" ? replyField : searchField)

  // 本文按 Esc、或點在氣泡以外的空白處：焦點還給該落的地方（對話檢視是回覆
  // 框）。反白由 persistentSelection: false 自己收掉。少了這一步，選過一次字
  // 之後打字會全部打進面板快捷鍵，回訊息就再也打不進去了。
  function dropBodyFocus() {
    if (root.focusLanding) root.focusLanding.forceActiveFocus()
  }

  // App window 模式的宿主。內容不在這裡，是下面那棵 keyCatcher 搬過來的。
  LineWindow {
    id: lineWindow
    owner: root
    wanted: root.opened && root.appWindow
    focusTarget: root.focusLanding
    implicitWidth: root.windowWidth
    implicitHeight: root.windowHeight
    onSizeSettled: function(w, h) { root.saveWindowSize(w, h) }
  }

  LinePanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    // App window 模式時這一層完全不出現，內容整棵搬去 lineWindow。
    open: root.opened && !root.appWindow
    centered: root.centeredPanel
    // 面板開啟時由 LinePanel 決定焦點落點，不要在外面用 callLater 跟它搶。
    focusTarget: root.focusLanding
    contentWidth: panel.fittedContentWidth(root.twoPane ? Style.space(940) : Style.space(420))
    // 兩欄時高度固定，不跟著聊天室數量長 —— 右邊那欄本來就要滿版。
    contentHeight: panel.fittedContentHeight(
      root.needsLogin ? loginColumn.implicitHeight
        : (root.twoPane || root.view === "chat" ? Style.space(560)
           : listHero.implicitHeight + linkNoticeSlot.height + linkNoticeSlot.anchors.topMargin
             + searchField.implicitHeight
             + (listPane.stackedTools ? scaleRow.height + Style.space(10) : 0)
             + Style.space(18) + listFlick.contentHeight),
      root.twoPane ? Style.space(720) : Style.space(600))

    // 面板內容只有這一棵，三種擺法共用。App window 模式時 parent 換成
    // lineWindow.contentSlot，整棵搬過去；換回來再搬回 panel.contentSlot。
    // 為什麼是搬家而不是 Loader/Component 各生一份：換模式不該把捲動位置、
    // 打到一半的草稿、開著的對話和燈箱全部弄丟。
    // 寫在 LinePanel 裡面只是因為那是它的預設落點（也讓 LinePanel 的
    // contentWidth/contentHeight 綁得到下面這些 id）；真正掛在哪由 parent 決定。
    PanelKeyCatcher {
      id: keyCatcher
      parent: root.appWindow ? lineWindow.contentSlot : panel.contentSlot
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        // 燈箱在最上層：←/→（h/l）換上一張下一張，上下不做事。
        if (root.lightbox) { if (dx !== 0) root.stepPicture(dx); return }
        // 貼圖選單開著時 ←/→（h/l）換貼圖包。焦點在輸入框裡的時候這裡收不到
        // 那兩顆鍵（它們在移游標），所以這條路只有 Esc 出框之後才走得到 ——
        // 打到一半的字不會被搶走。上下照舊捲訊息。
        if (root.stickerOpen && dx !== 0) { root.stepStickerTab(dx); return }
        if (dy === 0) return
        if (root.view === "list") { root.moveSelection(dy); return }
        // originY 不是 0：虛擬化之後內容的頂端跟著已生成的項目走。
        msgList.contentY = Math.max(msgList.originY, Math.min(
          msgList.contentY + dy * Style.space(52),
          msgList.originY + Math.max(0, msgList.contentHeight - msgList.height)))
      }
      onActivateRequested: if (root.view === "list" && !root.lightbox) root.openSelected()
      onCloseRequested: {
        var act = root.escapeAction()
        if (act === "lightbox") root.closeLightbox()
        else if (act === "sticker") root.setStickerOpen(false)
        else if (act === "back") root.backToList()
        else root.close()
      }
      // / 跳到搜尋，大寫 L 聚焦登出。這個 handler 只在 keyCatcher 有焦點時會收到按鍵 ——
      // 也就是使用者已經用 Esc 離開輸入框之後，所以不會跟 /file 或搜尋打字打架。
      onTextKey: function(t) {
        // 燈箱開著時只認 o（用外部程式開這張），其他鍵不該穿透到下面的清單。
        if (root.lightbox) { if (t === "o") root.openExternally(); return }
        // Tab 被 PanelKeyCatcher 攔去切換面板了（它從不設 blocked），所以內建的
        // tab chain 進不來，登出只能靠自己指一個鍵。小寫 l 是方向鍵，用大寫 L；
        // 要多按一個 Shift 對「砍掉登入狀態」這種動作反而剛好。
        // 第一下只給焦點（焦點框會亮），真的登出要再按 Enter／空白，避免手滑。
        if (t === "L") {
          if (root.loggedIn && root.view === "list") logoutLabel.forceActiveFocus()
          return
        }
        // r 立刻同步，清單和對話都算。這裡不照 L 那套「先給焦點再確認」——
        // 同步做壞不了東西，中間插一步反而讓最常用的那個動作變慢。
        // 沒登入時那顆按鈕本來就不在，按鍵也跟著什麼都不做。
        if (t === "r") {
          if (root.loggedIn) root.syncNow()
          return
        }
        if (t !== "/") return
        if (root.view === "chat") root.backToList()   // backToList 會聚焦搜尋框
        else searchField.forceActiveFocus()
      }
      // Tab 是「換到 bar 上隔壁那個面板」。App window 模式下這不是 bar 面板，
      // 按了只會憑空彈出別人的面板，所以那時什麼都不做。
      onTabRequested: function(direction) { if (!root.appWindow) root.switchPanel(direction) }

      // ----------------------------------------------------- login (QR)

      Column {
        id: loginColumn
        width: parent.width
        visible: root.needsLogin
        spacing: Style.space(10)

        PanelHero {
          width: parent.width
          title: "LINE"
          meta: root.loginStatus === "qr" ? "掃描登入"
            : (root.loginStatus === "pin" ? "手機輸入 PIN"
            : (root.loginStatus === "error" ? "登入失敗"
            : (root.loginStatus === "idle" ? "尚未登入" : "啟動中")))
          detail: root.loginStatus === "qr" ? "手機 LINE →「加入好友」→ 行動條碼"
            : (root.loginStatus === "pin" ? "在手機上輸入這組數字"
            : (root.loginStatus === "error" ? root.loginErrorDetail()
            : (root.loginStatus === "idle" ? "按下面的按鈕開始登入，手機要在手邊"
            : "daemon 正在啟動…")))
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            Text {
              text: "󰭹"
              color: Color.accent
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
        }

        // 只有按下去才產生 QR。
        Rectangle {
          anchors.horizontalCenter: parent.horizontalCenter
          visible: root.canLogin
          width: Math.min(parent.width, Style.space(200))
          height: Math.round(Style.space(34) * root.fontScale)
          radius: Style.space(6)
          color: loginHover.containsMouse
            ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.28)
            : Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)

          Text {
            anchors.centerIn: parent
            text: root.loginStatus === "error" ? "再試一次" : "登入 LINE"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontBody
          }

          MouseArea {
            id: loginHover
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.request("login", {})
          }
        }

        Image {
          id: qrImage
          anchors.horizontalCenter: parent.horizontalCenter
          visible: root.loginStatus === "qr" && status === Image.Ready
          source: root.qrSource
          cache: false
          asynchronous: true
          fillMode: Image.PreserveAspectFit
          width: Math.min(parent.width, Style.space(260))
          height: width
        }

        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          visible: root.loginStatus === "pin"
          text: root.loginInfo ? String(root.loginInfo.pin || "") : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.display
        }

        Text {
          width: parent.width
          visible: root.loginStatus === "qr"
          text: "掃完會出現一組 PIN，要在手機上輸入。"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: root.fontBody
          wrapMode: Text.Wrap
        }
      }

      // ------------------------------------------------------- chat list

      Item {
        id: listPane
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        // 寬度規則寫在 listPaneWidth()：對話那半邊才是主角，清單不能為了字級把它擠掉。
        width: root.twoPane ? root.listPaneWidth(parent.width, root.fontScale) : parent.width
        readonly property bool stackedTools: root.toolsStacked(width, scaleRow.implicitWidth)
        visible: !root.needsLogin && (root.twoPane || root.view === "list")

        // 標題固定在最上面，不隨清單捲走。
        PanelHero {
          id: listHero
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          title: "LINE"
          meta: !root.online ? "DAEMON 離線"
            : (root.totalUnread > 0
               ? root.unreadChats.length + " 個聊天共 " + root.totalUnread + " 則未讀"
               : root.chats.length + " 個聊天，沒有待處理")
          // 連線時 meta 已經寫著幾個聊天、幾則未讀，這裡再寫一次只是重複，留空。
          // 離線時 meta 只說得出「離線」，把人救回來的那句指令沒有別的地方可以放。
          detail: root.online ? "" : "daemon 沒在跑：systemctl --user start enil"
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            Text {
              text: "󰭹"
              color: root.statusColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
        }

        // daemon 活著不代表 LINE 連得上。斷線時徽章維持原樣，只在標題下補這一行，
        // 不然「沒有未讀」跟「三分鐘沒收到任何東西」在畫面上長得一模一樣。
        // 沒有內容時 height 和 topMargin 都要歸零，下面的搜尋框是靠 anchors 疊上來的。
        // 上面的 contentHeight 直接讀這裡的 topMargin，不要另外寫一個 6 —— 兩邊各寫一次
        // 就會漏掉這 6px，面板底部剛好被裁掉一條。
        // 高度綁在外面這層 Item 而不是 Text 自己：QQuickText 一被指定 height 就重跑
        // layout、重算 implicitHeight，而 height 正在讀它 —— 字從空變非空的那一刻必發
        // 「Binding loop detected for property "height"」（shell journal 三天四次，每次
        // 都在 reconnect 讓這行字出現的瞬間）。Text 對自己的 implicitHeight 不綁任何
        // 東西，讀它的是別人，迴圈就斷了；tests/qml/keytest 的離屏案例釘著這個。
        Item {
          id: linkNoticeSlot
          anchors.top: listHero.bottom
          anchors.topMargin: linkNotice.visible ? Style.space(6) : 0
          anchors.left: parent.left
          anchors.right: parent.right
          height: linkNotice.visible ? linkNotice.implicitHeight : 0

          Text {
            id: linkNotice
            anchors.left: parent.left
            anchors.right: parent.right
            visible: text !== ""
            // 顯示什麼的規則在 listNoticeText()，這裡不要再寫第二份。
            text: root.listNoticeText()
            // 顏色跟著現在顯示的是哪一種：提示用醒目色（跟對話那邊的 noticeLine 同一套），
            // 連線那句是可點的連結色。提示後面可能接著清單不完整警告，所以比對開頭。
            color: (root.notice.length > 0 && text.indexOf(root.notice) === 0) ? root.urgent
              : (linkHover.containsMouse ? Color.accent : root.dim)
            font.family: root.fontFamily
            font.pixelSize: root.fontBody
            elide: Text.ElideRight

            // 顯示錯誤時點一下就是重試，顯示斷線時點一下就是立刻重連 ——
            // 兩件事都是同一個動作，所以不用分。
            // 不要往外長：這一行是滿版寬度，撐出去會蓋到下面搜尋框的上緣。
            MouseArea {
              id: linkHover
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.syncNow()
            }
          }
        }

        // 字級調整：放在搜尋框右側，不另外佔一列；清單窄到並排會互相擠的時候
        // （toolsStacked）才改成搜尋框在上、這一排在下。
        // （不要放 hero 右上角 —— PanelHero 的 meta 徽章在那裡。）
        Row {
          id: scaleRow
          anchors.right: parent.right
          y: listPane.stackedTools ? searchField.y + searchField.height + Style.space(10)
            : searchField.y + (searchField.height - height) / 2
          spacing: Style.space(8)

          // 位置切換：貼齊 bar → 置中 → 視窗 → 貼齊 bar。標示的是現在這一種
          // （理由見 placementLabel）。
          Text {
            text: root.placementLabel(root.placement)
            color: placeHover.containsMouse ? Color.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: root.fontBody

            Accessible.role: Accessible.Button
            Accessible.name: "面板位置：" + root.placementLabel(root.placement)
            Accessible.description: "切換到「" + root.placementLabel(
              root.placementMode(root.nextPlacement(root.placement))) + "」"
            Accessible.onPressAction: root.togglePlacement()

            MouseArea {
              id: placeHover
              anchors.fill: parent
              anchors.margins: -Style.space(4)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.togglePlacement()
            }
          }

          Repeater {
            model: [{ label: "A−", delta: -10 }, { label: "A+", delta: 10 }]

            Text {
              required property var modelData
              text: modelData.label
              color: scaleHover.containsMouse ? Color.accent : root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontBody

              MouseArea {
                id: scaleHover
                anchors.fill: parent
                anchors.margins: -Style.space(4)
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.setTextScale(modelData.delta)
              }
            }
          }

          // 捲動速度：按一下換下一段（0.5× → 0.75× → 1× → 1.5× → 2× → 3× → 0.5×）。
          // 跟位置那顆一樣標「現在是哪一段」，而且一定要有讀數 —— 字級按下去當場
          // 看得出來，捲動速度不捲一下根本不知道自己在第幾段。
          Text {
            text: "捲動 " + root.scrollLabel(root.scrollPercent)
            color: speedHover.containsMouse ? Color.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: root.fontBody

            Accessible.role: Accessible.Button
            Accessible.name: "捲動速度：" + root.scrollLabel(root.scrollPercent)
            Accessible.description: "切換到 " + root.scrollLabel(root.nextScroll(root.scrollPercent))
            Accessible.onPressAction: root.stepScrollSpeed()

            MouseArea {
              id: speedHover
              anchors.fill: parent
              anchors.margins: -Style.space(4)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.stepScrollSpeed()
            }
          }

          // 讀取筆數：按一下換下一段（30 → 60 → 100 → 150 → 30）。開聊天室的第一頁
          // 和往上翻的每一頁都是這個數字。
          Text {
            text: "讀取 " + root.historyLabel(root.historyPage)
            color: pageHover.containsMouse ? Color.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: root.fontBody

            Accessible.role: Accessible.Button
            Accessible.name: "讀取筆數：" + root.historyLabel(root.historyPage)
            Accessible.description: "切換到 " + root.historyLabel(root.nextHistory(root.historyPage))
            Accessible.onPressAction: root.stepHistoryPage()

            MouseArea {
              id: pageHover
              anchors.fill: parent
              anchors.margins: -Style.space(4)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.stepHistoryPage()
            }
          }

          // 手動同步。樣式跟右邊的「登出」同一套（hover 變色、焦點框、Enter／空白），
          // 但不需要「先給焦點再確認」那一道 —— 同步壞不了任何東西，多按只是多抓一次。
          Text {
            id: syncLabel
            visible: root.loggedIn
            text: root.syncing ? "同步中…" : "同步"
            color: (syncHover.containsMouse || syncLabel.activeFocus) ? Color.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: root.fontBody
            activeFocusOnTab: true

            Accessible.role: Accessible.Button
            Accessible.name: "同步"
            Accessible.onPressAction: root.syncNow()
            Keys.onReturnPressed: root.syncNow()
            Keys.onEnterPressed: root.syncNow()
            Keys.onSpacePressed: root.syncNow()
            // 跟登出那顆同理：不接下 Esc 會冒到 keyCatcher 直接關掉整個面板。
            Keys.onEscapePressed: keyCatcher.forceActiveFocus()

            Rectangle {
              z: -1
              anchors.fill: parent
              anchors.margins: -Style.space(3)
              visible: syncLabel.activeFocus
              radius: Style.space(3)
              color: "transparent"
              border.width: 1
              border.color: Color.accent
            }

            MouseArea {
              id: syncHover
              anchors.fill: parent
              anchors.margins: -Style.space(4)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.syncNow()
            }
          }

          // 登出後 daemon 會把狀態切回 idle，登入欄自己會出現，這裡不用做別的。
          // 登入那顆是固定寬的 Rectangle 按鈕，塞不進這排小字連結，所以維持 Text，
          // 另外補上 Enter／空白鍵與 Accessible —— 只有 MouseArea 的話鍵盤和輔助
          // 工具完全碰不到「登出」。焦點是 keyCatcher 的 L 鍵給的，不是 tab chain。
          Text {
            id: logoutLabel
            visible: root.loggedIn
            text: "登出"
            color: (logoutHover.containsMouse || logoutLabel.activeFocus) ? Color.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: root.fontBody

            Accessible.role: Accessible.Button
            Accessible.name: "登出"
            Accessible.onPressAction: root.request("logout", {})
            Keys.onReturnPressed: root.request("logout", {})
            Keys.onEnterPressed: root.request("logout", {})
            Keys.onSpacePressed: root.request("logout", {})
            // 沒接下 Esc 的話它會往上冒到 keyCatcher，變成直接關掉整個面板；
            // 這裡要的是「不登出了」，所以把焦點交還回去就好。
            Keys.onEscapePressed: keyCatcher.forceActiveFocus()

            // 焦點框往外長，anchors 撐不動 Text 自己的尺寸，scaleRow 不會位移。
            Rectangle {
              z: -1
              anchors.fill: parent
              anchors.margins: -Style.space(3)
              visible: logoutLabel.activeFocus
              radius: Style.space(3)
              color: "transparent"
              border.width: 1
              border.color: Color.accent
            }

            MouseArea {
              id: logoutHover
              anchors.fill: parent
              anchors.margins: -Style.space(4)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.request("logout", {})
            }
          }
        }

        // 搜尋在標題下方、清單上方，兩者都不隨捲動移動。
        TextField {
          id: searchField
          anchors.top: linkNoticeSlot.bottom
          anchors.topMargin: Style.space(10)
          anchors.left: parent.left
          anchors.right: listPane.stackedTools ? parent.right : scaleRow.left
          anchors.rightMargin: listPane.stackedTools ? 0 : Style.space(10)
          placeholderText: "搜尋聊天室…"
          foreground: root.foreground
          accent: Color.accent
          font.family: root.fontFamily
          font.pixelSize: root.fontBody

          onTextChanged: { root.search = text; root.selectedIndex = 0; listFlick.contentY = 0 }
          // 上下鍵在輸入框裡是移動游標，攔下來改成移動選取項。
          Keys.onDownPressed: root.moveSelection(1)
          Keys.onUpPressed: root.moveSelection(-1)
          onAccepted: root.openSelected()
          // 空的時候直接 close()，焦點就永遠留在這個輸入框裡 —— PanelKeyCatcher 只在
          // 沒有輸入框持有焦點時收得到按鍵，搜尋框一直咬著焦點的話，清單檢視的
          // onTextKey 幾乎不會觸發、寫在那裡等於死碼，keyCatcher 拿不到焦點，
          // /、L、j/k 全部按不到。改成先把焦點還給 keyCatcher，跟對話檢視的輸入框
          // 同一套（Esc 離開輸入框，再 Esc 才退出）；第二下 Esc 由 keyCatcher 的
          // onCloseRequested 關掉面板。
          Keys.onEscapePressed: {
            if (text.length > 0) text = ""
            else keyCatcher.forceActiveFocus()
          }
        }

      ListView {
        id: listFlick
        anchors.top: searchField.bottom
        anchors.topMargin: Style.space(8)
          + (listPane.stackedTools ? scaleRow.height + Style.space(10) : 0)
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        spacing: Style.space(8)
        model: root.listModel
        cacheBuffer: Style.space(600)
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        // 跟訊息清單同一顆；列只接點擊和 hover，滾輪會穿過去。
        WheelSpeed { view: listFlick }

        delegate:
            Rectangle {
              required property var modelData
              required property int index
              width: listFlick.width
              height: Math.round(Style.space(44) * root.fontScale)
              radius: Style.space(6)
              clip: true
              color: (rowHover.containsMouse || index === root.selectedIndex)
                ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
                : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)

              MouseArea {
                id: rowHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onEntered: root.selectedIndex = index
                // 左鍵照舊開聊天室；右鍵開的是隱藏／取消隱藏那一個選單。
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(mouse) {
                  if (mouse.button === Qt.RightButton)
                    root.openChatMenu(rowHover, mouse.x, mouse.y, modelData)
                  else
                    root.openChat(modelData)
                }
              }

              AvatarBadge {
                id: rowAvatar
                anchors.left: parent.left
                anchors.leftMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                width: Math.round(Style.space(32) * root.fontScale)
                height: width
                picture: modelData.avatarPath || ""
                label: root.avatarInitial(modelData.name || modelData.mid)
                seed: modelData.mid || ""
              }

              Column {
                anchors.left: rowAvatar.right
                anchors.right: rowBadge.left
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(8)
                spacing: Style.space(2)

                Text {
                  width: parent.width
                  text: root.oneLine(modelData.name || modelData.mid)
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: root.fontBody
                  elide: Text.ElideRight
                  maximumLineCount: 1
                }
                Text {
                  width: parent.width
                  text: root.oneLine(root.rowSubtitle(modelData))
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: root.fontBody
                  elide: Text.ElideRight
                  maximumLineCount: 1
                  visible: text.length > 0
                }
              }

              Text {
                id: rowBadge
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.rightMargin: Style.space(10)
                text: (Number(modelData.unread || 0) > 0 ? modelData.unread + "  " : "") + root.agoText(modelData.lastTime)
                color: Number(modelData.unread || 0) > 0 ? root.urgent : root.dim
                font.family: root.fontFamily
                font.pixelSize: root.fontBody
              }
            }
      }

      }

      // ----------------------------------------------------- conversation

      Rectangle {
        id: paneDivider
        visible: root.twoPane && !root.needsLogin
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.left: listPane.right
        anchors.leftMargin: Style.space(12)
        width: 1
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.14)
      }

      Item {
        id: chatPane
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.left: root.twoPane ? paneDivider.right : parent.left
        anchors.leftMargin: root.twoPane ? Style.space(12) : 0
        anchors.right: parent.right
        visible: !root.needsLogin && (root.twoPane || root.view === "chat")

        Text {
          id: chatHeader
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          text: root.activeChat
            ? (root.twoPane ? "" : "‹  ") + (root.activeChat.name || root.activeChat.mid)
            : "選一個聊天室"
          color: root.activeChat ? root.foreground : root.dim
          font.family: root.fontFamily
          font.pixelSize: root.fontTitle
          elide: Text.ElideRight

          // 兩欄時清單一直在左邊，標題就不是返回鍵了。
          MouseArea {
            anchors.fill: parent
            enabled: !root.twoPane
            cursorShape: Qt.PointingHandCursor
            onClicked: root.backToList()
          }
        }

        // 送出／傳檔的狀態與錯誤。原本 notice 只在訊息列表為空時才顯示，
        // 等於有訊息時失敗是靜默的 —— 那是最不該藏的東西。
        Text {
          id: noticeLine
          anchors.bottom: replyBox.top
          anchors.bottomMargin: Style.space(4)
          anchors.left: parent.left
          anchors.right: parent.right
          visible: root.draftWriteError.length > 0 || root.notice.length > 0
          text: root.draftWriteError.length > 0 ? root.draftWriteError : root.notice
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: root.fontBody
          elide: Text.ElideRight
        }

        // 訊息一多，整欄重建每一顆氣泡就會頓 —— 改成 ListView 只生成看得見的那幾則。
        // 代價是 contentHeight／originY 變成估計值，所以捲動位置一律由下面那三個
        // handler 明講，不再靠高度差自己對齊。
        ListView {
          id: msgList
          anchors.top: chatHeader.bottom
          anchors.topMargin: Style.space(8)
          // 由下往上疊：回訊息的框、橫幅、引言條 —— 有誰在就往上讓一層。
          anchors.bottom: quoteStrip.visible ? quoteStrip.top
            : (noticeLine.visible ? noticeLine.top : replyBox.top)
          anchors.bottomMargin: Style.space(8)
          anchors.left: parent.left
          anchors.right: parent.right
          clip: true
          spacing: Style.space(6)
          model: root.messages
          verticalLayoutDirection: ListView.TopToBottom
          // 快取一個畫面高度的上下文：捲動時不必邊捲邊生成，圖片也不會一離開
          // 畫面就被回收、捲回來又重載一次。
          cacheBuffer: Style.space(1200)
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          // 換完模型視窗停在哪，只有這裡說了算。掛在 onModelChanged 而不是
          // onCountChanged：重抓回來則數一樣時 countChanged 根本不發，只靠它
          // 會被丟回對話最上面。
          onModelChanged: {
            var keep = root.keepContentY
            root.keepContentY = -1
            msgList.seenContentHeight = contentHeight
            if (count === 0) { root.prependAnchorIndex = -1; return }
            if (root.prependAnchorIndex >= 0) {
              positionViewAtIndex(Math.min(root.prependAnchorIndex, count - 1), ListView.Beginning)
              root.prependAnchorIndex = -1
              // 錨點只放對「哪一則」，人離頂端多遠要自己補回去（理由見
              // anchoredContentY）。捲到頂才翻頁時 keep 是 0，這一行等於不存在。
              contentY = root.anchoredContentY(contentY, originY, keep, contentHeight, height)
              return
            }
            if (root.atBottom) { msgList.toBottom(); return }
            if (keep >= 0) contentY = originY + Math.max(0, Math.min(keep, contentHeight - height))
          }

          // 縮圖、貼圖載完會把泡泡撐高。判斷用的是「變高之前」的高度：使用者捲動時
          // ListView 也會先改 contentHeight 再發 contentYChanged，拿當下的值去比
          // 會把正在往上捲的人硬拉回底部（量過）。
          property real seenContentHeight: 0
          onContentHeightChanged: {
            var wasAtBottom =
              contentY >= originY + msgList.seenContentHeight - height - Style.space(24)
            msgList.seenContentHeight = contentHeight
            if (wasAtBottom && root.keepContentY < 0 && root.prependAnchorIndex < 0)
              msgList.toBottom()
          }

          // 貼到最後一則要貼兩次：ListView 是先發訊號、之後才把新的高度排進版面，
          // 當場那一次會差最後一則的高度（量過：新訊息差 13px、縮圖長出來差 85px）。
          function toBottom() {
            positionViewAtEnd()
            Qt.callLater(msgList.positionViewAtEnd)
          }

          // 快捲到頂就往前翻一頁（差多少算「快到了」在 nearOlderEdge）。換模型時
          // ListView 會把 contentY 歸零，那不是使用者捲的 —— 旗子還在的期間一概
          // 不算，否則一開聊天室就白抓一頁舊訊息。
          onContentYChanged: {
            if (root.keepContentY >= 0 || root.prependAnchorIndex >= 0) return
            if (root.nearOlderEdge(contentY, originY, contentHeight, height)) root.loadOlder()
          }

          // 點在氣泡以外的空白處就把焦點還回去（反白跟著收掉）。它是 contentItem 的
          // 第一個小孩，delegate 是之後才生出來接在後面的，所以永遠疊在它上面 ——
          // 訊息、縮圖、連結的點擊照樣先被上面那層拿走。
          MouseArea {
            // contentItem 沒有大小，anchors.fill 會是 0；自己貼著內容量。
            // y 跟著 originY：虛擬化之後內容的頂端不一定在 0。
            // 不要用 z: -1 壓到底下 —— 量過：負 z 之後這一層一個事件都收不到。
            y: msgList.originY
            width: msgList.width
            height: Math.max(msgList.height, msgList.contentHeight)
            acceptedButtons: Qt.LeftButton
            onPressed: function(mouse) {
              root.dropBodyFocus()
              // 不接下這一下，ListView 才還拖得動。
              mouse.accepted = false
            }
          }

          // 滾輪一格走多遠由設定決定。掛在上面那一層之後：它只接 NoButton，
          // 按下去照樣落到下面那顆去收焦點。
          WheelSpeed { view: msgList }

          // 日期分隔線。section 讀的是 withDay() 蓋上去的 day 欄位（當天凌晨的
          // 毫秒，存成字串）—— section 只給得到字串，數字大到一定程度轉回來
          // 會變成 1.75717e+12。
          section.property: "day"
          section.criteria: ViewSection.FullString
          section.delegate: Text {
            required property string section
            width: msgList.width
            horizontalAlignment: Text.AlignHCenter
            topPadding: Style.space(6)
            bottomPadding: Style.space(2)
            text: root.dayLabel(Number(section), root.nowMs)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Math.max(1, root.fontBody - 1)
          }

          delegate: Column {
            id: msgDelegate
            required property var modelData
            // 大頭貼掛在一串連續發言的第一則，而「上一則是誰講的」只有索引問得到。
            required property int index
            readonly property bool withAvatar:
              root.showAvatarAt(root.messages, msgDelegate.index)
            readonly property bool systemEvent: root.isSystemEvent(modelData)
            // 收回的訊息 LINE 照樣送過來，daemon 只清掉 hasMedia、把 text 換成
            // 「已收回訊息」；stickerUrl／flexImages 還在，不擋的話畫面上會是
            // 一張照常顯示的貼圖，旁邊一句訊息說它已經被收回。
            readonly property bool recalled: modelData.unsent === true
            // 縮圖、點擊、燈箱三處要問的是同一句話，問一次就好。
            readonly property bool mediaOk: root.mediaUsable(modelData)
            readonly property bool mediaLoading:
              !!root.previewRequests[String(modelData.id || "")]
            readonly property bool sticker: !recalled
              && modelData.stickerUrl !== undefined
              && modelData.stickerUrl.length > 0
            // 上次離開之後進來的第一則就是這一則嗎（開聊天室時算一次，記的是 id ——
            // 前置舊訊息之後索引會整批位移）。
            readonly property bool firstUnread: root.unreadMarkId.length > 0
              && String(modelData.id || "") === root.unreadMarkId
            width: msgList.width
            spacing: Style.space(1)
            Component.onCompleted: root.fetchPreview(modelData)
            onModelDataChanged: root.fetchPreview(modelData)

            // 未讀分隔線。日期分隔線是 section 畫的，這一條不是 —— 它只出現一次，
            // 不是「同一天的訊息歸成一段」那種分組。
            Item {
              width: parent.width
              height: unreadLabel.implicitHeight + Style.space(6)
              visible: msgDelegate.firstUnread

              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                anchors.left: parent.left
                anchors.right: unreadLabel.left
                anchors.rightMargin: Style.space(6)
                height: 1
                color: root.urgent
                opacity: 0.5
              }

              Text {
                id: unreadLabel
                anchors.verticalCenter: parent.verticalCenter
                anchors.right: parent.right
                text: "未讀訊息"
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Math.max(1, root.fontBody - 1)
              }
            }

            // 系統事件沒有「誰說的」可言，給一行置中灰字就好。
            Text {
              width: parent.width
              visible: msgDelegate.systemEvent
              text: root.systemEventText(msgDelegate.modelData)
              horizontalAlignment: Text.AlignHCenter
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Math.max(1, root.fontBody - 1)
              wrapMode: Text.Wrap
            }

            // 誰、什麼時候。群組裡同一個人連著講的那幾則只有第一則掛大頭貼 ——
            // 每一則都掛的話，一長串下來就是一排一模一樣的圓圈。
            Row {
              width: parent.width
              visible: !msgDelegate.systemEvent
              spacing: Style.space(6)

              AvatarBadge {
                anchors.verticalCenter: parent.verticalCenter
                visible: msgDelegate.withAvatar
                width: Math.round(Style.space(20) * root.fontScale)
                height: width
                picture: modelData.fromAvatar || ""
                label: root.avatarInitial(modelData.fromName || modelData.from)
                seed: modelData.from || ""
              }

              Text {
                // Row 只管 x，寬度要自己扣掉左邊那顆臉，不然長名字會超出去。
                width: Math.max(0, parent.width - x)
                anchors.verticalCenter: parent.verticalCenter
                text: root.clockText(modelData.time) + "  "
                  + (modelData.from === root.myMid ? "我" : (modelData.fromName || "?"))
                  + (modelData.edited === true ? "  已編輯" : "")
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: root.fontBody
                elide: Text.ElideRight
              }
            }

            // 引言。daemon 只給 { id, fromName?, text? }，查不到原文時只有 id ——
            // 那也要畫得出來（退成一行「訊息」），不能整塊消失。
            Item {
              id: quoteBlock
              width: parent.width
              height: quoteLabel.implicitHeight + Style.space(4)
              visible: !msgDelegate.systemEvent && !msgDelegate.recalled
                && msgDelegate.modelData.replyTo !== undefined

              Rectangle {
                id: quoteRule
                width: Math.max(1, Style.space(2))
                height: parent.height
                color: root.dim
                opacity: 0.6
              }

              Text {
                id: quoteLabel
                anchors.left: quoteRule.right
                anchors.leftMargin: Style.space(6)
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                text: root.quoteText(msgDelegate.modelData.replyTo)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Math.max(1, root.fontBody - 1)
                // elide 只處理單行，而引言的原文可能是好幾行（quoteText 已經先壓成
                // 一行了，這兩行是保險）—— 撐開的話這一列會疊到別人身上。
                maximumLineCount: 1
                elide: Text.ElideRight
              }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.scrollToMessage(msgDelegate.modelData.replyTo.id)
              }
            }

            // 本文要能拖曳選字、Ctrl+C 複製、連結能點，所以是 TextEdit 不是
            // Text。readOnly 擋掉編輯；在 Qt 6.11 量過：TextEdit 會抓住滑鼠，
            // 在會捲動的列表裡往下拖是選字不是捲動，而唯讀狀態的 Ctrl+C
            // 照樣進得了剪貼簿。
            TextEdit {
              id: msgBody
              width: parent.width
              // 貼圖載入中或載不到（404／離線）時圖都是 0 高，這行要回來頂位子。
              visible: !modelData.hasMedia && !msgDelegate.systemEvent
                && (!msgDelegate.sticker || stickerImg.status !== Image.Ready)
              readOnly: true
              selectByMouse: true
              // 焦點一走就把反白收掉，不然畫面上會同時留著好幾段選取。
              persistentSelection: false
              activeFocusOnPress: true
              textFormat: TextEdit.RichText
              text: root.bodyHtml(modelData)
              color: (modelData.decryptFailed || modelData.pending || msgDelegate.recalled)
                ? root.dim : root.foreground
              // 收回的那一句是 LINE 代說的，不是對方打的字，斜體才分得出來。
              font.italic: msgDelegate.recalled
              font.family: root.fontFamily
              font.pixelSize: root.fontBody
              selectionColor: Style.selectionFillFor(root.foreground, Color.accent)
              selectedTextColor: root.foreground
              wrapMode: TextEdit.Wrap
              onLinkActivated: function(link) { root.openLink(link) }
              // 不接下 Esc 的話它會冒到 keyCatcher，變成直接退出對話；
              // 跟回覆框同一套（Esc 離開這裡，再 Esc 才退出）。
              Keys.onEscapePressed: root.dropBodyFocus()
              Keys.onPressed: function(event) {
                // 整段複製的鍵盤入口，跟右鍵選單的「複製訊息」同一件事。
                // TextEdit 自己沒有用到這個組合（量過）。
                if (event.key === Qt.Key_C && (event.modifiers & Qt.ControlModifier)
                    && (event.modifiers & Qt.ShiftModifier)) {
                  root.copyText(root.bodyText(msgDelegate.modelData))
                  event.accepted = true
                }
              }

              // 沒有這個 handler，TextEdit 根本收不到 hover 事件，
              // hoveredLink 永遠是空的（量過）；游標形狀也是它帶的。
              HoverHandler {
                cursorShape: msgBody.hoveredLink.length > 0
                  ? Qt.PointingHandCursor : Qt.IBeamCursor
              }

              // 右鍵開選單。只收右鍵，左鍵照樣落到底下的 TextEdit 去選字。
              MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.RightButton
                onClicked: function(mouse) {
                  root.openMessageMenu(msgBody, mouse.x, mouse.y, msgDelegate.modelData)
                }
              }
            }

            Text {
              width: parent.width
              visible: modelData.failed === true
              text: "傳送失敗；內容保留在這裡"
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Math.max(1, root.fontBody - 1)
              wrapMode: Text.Wrap
            }

            // 貼圖與 FLEX 圖由 daemon 下載，再讀取本機快取，
            // 不走 hasMedia／download 那條路（getData() 對貼圖會丟例外）。
            // 網址過 stickerStill 才畫：動態貼圖的網址指向 APNG，Qt 只畫得出第一格
            // 卻要抓幾百 KB。別人送來的動態貼圖一直是這條路，自己送出的那則從
            // 2.4.0 起也是（daemon 帶 STKOPT，LINE 推回來的就是動態網址）。
            CachedImage {
              id: stickerImg
              visible: msgDelegate.sticker && status === Image.Ready
              remoteSource: msgDelegate.sticker
                ? root.stickerStill(msgDelegate.modelData.stickerUrl) : ""
              asynchronous: true
              fillMode: Image.PreserveAspectFit
              width: Style.space(120)
              height: Math.min(implicitHeight * (width / Math.max(1, implicitWidth)), Style.space(160))

              // 貼圖一載進來本文那一行就收起來了，右鍵沒有別的地方可按 ——
              // 沒有這一塊，貼圖訊息就等於沒有回覆、表情、收回。左鍵不收
              //（貼圖沒有原檔可以開），照舊落到底下去。
              MouseArea {
                id: stickerMenu
                anchors.fill: parent
                acceptedButtons: Qt.RightButton
                onClicked: function(mouse) {
                  root.openMessageMenu(stickerMenu, mouse.x, mouse.y, msgDelegate.modelData)
                }
              }
            }

            // 圖片直接顯示縮圖；還沒抓到就先留一行字，不要跳版。
            // FLEX 的內容多半就在圖裡（carousel 每個 bubble 一張），
            // 所以不做完整版面引擎，把圖排成一列就是 carousel 本身。
            // 公開 CDN 圖片透過 daemon 快取，避免 shell 內的 HTTPS。
            Row {
              visible: !msgDelegate.recalled
                && modelData.flexImages !== undefined && modelData.flexImages.length > 0
              spacing: Style.space(6)

              Repeater {
                model: modelData.flexImages ?? []

                CachedImage {
                  id: flexImg
                  required property string modelData
                  remoteSource: modelData
                  asynchronous: true
                  fillMode: Image.PreserveAspectFit
                  width: Style.space(120)
                  height: Math.min(implicitHeight * (width / Math.max(1, implicitWidth)), Style.space(160))
                  opacity: flexHover.containsMouse ? 0.85 : 1.0

                  // 點下去直接把同一個 CDN 網址丟進燈箱：沒有原檔可以 download，
                  // 燈箱也使用同一份本機快取。
                  MouseArea {
                    id: flexHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.showPicture("", flexImg.modelData, "圖片")
                  }
                }
              }
            }

            // 顯示的是縮圖；圖片點下去在面板裡放大，影片點下去才交給外部程式。
            Image {
              id: thumb
              readonly property string messageId: String(modelData.id || "")
              onStatusChanged: {
                if (status === Image.Ready) {
                  root.finishPreviewDecode(messageId)
                  return
                }
                var failed = String(source || "")
                if (status !== Image.Error || !failed) return
                root.retryPreview(messageId, true)
              }
              visible: status === Image.Ready
              // 打不開的附件連縮圖都不畫，跟 pictureList 同一條規則 ——
              // 兩邊要是各判各的，就會出現一張看得到、←/→ 卻走不到的圖。
              source: msgDelegate.mediaOk && modelData.mediaPath
                ? "file://" + modelData.mediaPath : ""
              fillMode: Image.PreserveAspectFit
              width: Math.min(parent.width, Style.space(220))
              height: Math.min(implicitHeight * (width / Math.max(1, implicitWidth)), Style.space(220))
              opacity: thumbHover.containsMouse ? 0.85 : 1.0

              MouseArea {
                id: thumbHover
                anchors.fill: parent
                enabled: msgDelegate.mediaOk
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                cursorShape: Qt.PointingHandCursor
                onClicked: function(mouse) {
                  // 圖片訊息沒有文字泡泡，右鍵只能按在縮圖上；不收的話一整串照片
                  // 就等於沒有回覆、表情、收回。
                  if (mouse.button === Qt.RightButton) {
                    root.openMessageMenu(thumb, mouse.x, mouse.y, msgDelegate.modelData)
                    return
                  }
                  if (modelData.contentType === "IMAGE")
                    root.showPicture(modelData.id, "file://" + modelData.mediaPath,
                                     modelData.fileName || "圖片")
                  else root.openMedia(modelData.id, "external")
                }
              }
            }

            Text {
              width: parent.width
              visible: modelData.hasMedia
                && (!modelData.mediaPath || thumb.status === Image.Error)
              // 過期的圖片沒有縮圖可看，但那不是「載入失敗」—— 那句話正是
              // U39 要拿掉的謊。過不了 mediaUsable 就一律走 📎 那條，
              // 名字後面自己會帶（已過期）。
              text: msgDelegate.mediaLoading ? "載入中…"
                : modelData.contentType === "IMAGE" && msgDelegate.mediaOk
                  ? "[圖片載入失敗，點此重試]" : "📎 " + root.mediaLabel(modelData)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontBody
              wrapMode: Text.Wrap

              MouseArea {
                id: attachClick
                anchors.fill: parent
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                // 左鍵只有真的開得起來的附件才有意義，右鍵一律要開得了選單 ——
                // 所以條件從 enabled 搬進來，不然過期／收回的附件連右鍵都沒有。
                readonly property bool openable:
                  msgDelegate.mediaOk
                cursorShape: attachClick.openable ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: function(mouse) {
                  if (mouse.button === Qt.RightButton)
                    root.openMessageMenu(attachClick, mouse.x, mouse.y, msgDelegate.modelData)
                  else if (attachClick.openable) {
                    if (modelData.contentType === "IMAGE") {
                      root.finishPreviewRetry(modelData.id)
                      root.retryPreview(modelData.id, false)
                    } else root.openMedia(modelData.id, "external")
                  }
                }
              }
            }

            // 表情列。契約給的是整串（不是差異），照著畫就是。自己選的那個描邊，
            // 再點一次就是收回 —— LINE 一個人在同一則上只有一個表情，沒有別的入口。
            Row {
              id: reactionBar
              spacing: Style.space(4)
              visible: !msgDelegate.recalled
                && msgDelegate.modelData.reactions !== undefined
                && msgDelegate.modelData.reactions.length > 0

              Repeater {
                model: msgDelegate.modelData.reactions ?? []

                BorderSurface {
                  id: reactionPill
                  required property var modelData
                  readonly property bool mine: modelData.mine === true
                  width: Math.round(pillLabel.implicitWidth + Style.space(10))
                  height: Math.round(pillLabel.implicitHeight + Style.space(4))
                  radius: Style.cornerRadius
                  color: pillHover.containsMouse
                    ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"
                  borderSpec: Border.flat(reactionPill.mine ? Color.accent : root.dim, 1)

                  Text {
                    id: pillLabel
                    anchors.centerIn: parent
                    text: root.reactionEmoji(reactionPill.modelData.type)
                      + " " + Number(reactionPill.modelData.count || 0)
                    color: reactionPill.mine ? Color.accent : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Math.max(1, root.fontBody - 1)
                  }

                  MouseArea {
                    id: pillHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.toggleReaction(msgDelegate.modelData,
                                                   reactionPill.modelData.type)
                  }
                }
              }
            }

            // 已讀。只有自己傳的訊息才有 —— LINE 回報的是「誰讀了我送的」，
            // 不是反過來。什麼都不知道的時候 readText 回空字串，這一列就不存在。
            Text {
              width: parent.width
              horizontalAlignment: Text.AlignRight
              visible: text.length > 0
              text: root.readText(msgDelegate.modelData)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Math.max(1, root.fontBody - 1)
            }
          }
        }

        // 空清單的佔位。ListView 沒有訊息時什麼都不畫，這一行只好掛在它外面。
        Text {
          id: msgEmpty
          anchors.top: msgList.top
          anchors.left: msgList.left
          anchors.right: msgList.right
          visible: root.messages.length === 0
          // 少數聊天室有未讀卻讀不到歷史；別讓它停在「載入中」騙人。
          text: !root.activeChat ? "左邊選一個聊天室"
            : (root.draftWriteError.length > 0 ? root.draftWriteError
            : (root.notice.length > 0 ? root.notice
            : (root.loading ? "載入中…" : "這個聊天室讀不到歷史訊息")))
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: root.fontBody
        }

        Text {
          id: attachButton
          anchors.bottom: parent.bottom
          anchors.left: parent.left
          height: replyBox.height
          verticalAlignment: Text.AlignVCenter
          text: "📎"
          color: attachHover.containsMouse ? Color.accent : root.dim
          font.family: root.fontFamily
          font.pixelSize: root.fontBody

          MouseArea {
            id: attachHover
            anchors.fill: parent
            anchors.margins: -Style.space(4)
            enabled: !!root.activeChat
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.pickFile(false)
          }
        }

        // 貼圖選單的開關，跟 📎 並排。選單開著時上強調色 —— 按第二次收起來，
        // 而收起來的路是點在選單外面（上面那層 stickerScrim）。
        Text {
          id: stickerButton
          anchors.bottom: parent.bottom
          anchors.left: attachButton.right
          anchors.leftMargin: Style.space(8)
          height: replyBox.height
          verticalAlignment: Text.AlignVCenter
          text: "😊"
          color: (root.stickerOpen || stickerHover.containsMouse) ? Color.accent : root.dim
          font.family: root.fontFamily
          font.pixelSize: root.fontBody

          MouseArea {
            id: stickerHover
            anchors.fill: parent
            anchors.margins: -Style.space(4)
            enabled: !!root.activeChat
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.toggleSticker()
          }
        }

        // 真實訊息裡約七分之一含換行，單行 TextField 根本送不出去，
        // 所以改成 TextArea 放進 Flickable：Enter 送出、Shift+Enter 換行。
        // 邊框畫在 Flickable 外面而不是 TextArea 的 background，
        // 否則捲動時背景會跟著內容一起跑掉。
        Item {
          id: replyBox
          anchors.bottom: parent.bottom
          anchors.left: stickerButton.right
          anchors.leftMargin: Style.space(8)
          anchors.right: parent.right

          // 一行的高度用 contentHeight/lineCount 量，不猜字型的行距。
          readonly property real lineHeight:
            replyField.contentHeight / Math.max(1, replyField.lineCount)
          // 長到五行就停住，之後在框內捲；再長下去會把訊息列表擠掉。
          height: Math.min(replyField.implicitHeight,
            replyField.topPadding + replyField.bottomPadding + lineHeight * 5)

          BorderSurface {
            anchors.fill: parent
            color: Style.controlFill(replyField.activeFocus, replyField.hovered,
              root.foreground, Color.accent)
            borderSpec: replyField._borderSpec
            radius: Style.cornerRadius
          }

          Flickable {
            id: replyFlick
            anchors.fill: parent
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            flickableDirection: Flickable.VerticalFlick
            interactive: contentHeight > height
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            TextArea.flickable: TextArea {
              id: replyField
              enabled: !!root.activeChat
              // 「貼圖」在這個面板裡是 sticker，所以剪貼簿那條寫「剪貼簿的圖」。
              placeholderText: "回訊息，Enter 送出，Shift+Enter 換行"
                + "（/file <路徑> 傳檔案，Ctrl+V 送剪貼簿的圖）"
              wrapMode: TextArea.Wrap
              background: null
              font.family: root.fontFamily
              font.pixelSize: root.fontBody
              color: root.foreground
              selectionColor: Style.selectionFillFor(root.foreground, Color.accent)
              selectedTextColor: root.foreground
              placeholderTextColor: root.dim
              onTextChanged: {
                root.noteComposerEdit()
                root.scheduleDraftSave()
              }
              onCursorPositionChanged: {
                root.noteComposerEdit()
                root.scheduleDraftSave()
              }

              readonly property var _borderSpec: Border.controlSpec(
                activeFocus ? "focus" : (hovered ? "hover-cursor" : "normal"),
                root.foreground, Color.accent)

              leftPadding: Style.spacing.controlPaddingX + Border.left(_borderSpec)
              rightPadding: Style.spacing.controlPaddingX + Border.right(_borderSpec)
              topPadding: Style.spacing.inputPaddingY + Border.top(_borderSpec)
              bottomPadding: Style.spacing.inputPaddingY + Border.bottom(_borderSpec)

              function submit() {
                var body = text.trim()
                if (body.length === 0 || !root.activeChat) return
                if (root.deferredDraftSend(root.activeChat.mid)) {
                  root.notice = "前一則正在等待草稿載入"
                  return
                }
                // Persist the exact composer state before clearing it. The
                // request keeps this revision until success, so failure after
                // switching chats or closing the panel remains recoverable.
                root.saveActiveDraft(false)
                // 先塞一顆暫時的：送出到伺服器回來大約 0.5~2 秒，中間不該是空白。
                // 成功的話 loadHistory 整份替換會把它換成真的那筆。
                // /file <路徑>：傳檔案。沒有拖放介面，打路徑最省事也最好用（tab 補完在終端機補好再貼）。
                if (body === "/file") { root.pickFile(true); return }
                if (body.indexOf("/file ") === 0) {
                  var path = body.slice(6).trim()
                  if (path.length === 0) { text = ""; root.pickFile(true); return }
                  if (!root.request("sendFile", {
                    chat: root.activeChat.mid, path: path, _spendsDraft: true
                  })) return
                  root.notice = "傳送中…"
                  root.resetComposerAfterSuccessfulSend()
                  return
                }
                // 位移一定要照 body（trim 過的那份）算，那才是真的送出去的字串；
                // 照 text 算的話開頭多一個空白就整組偏一格。
                var mentions = root.deriveMentions(body, root.mentionPicks)
                var target = root.replyTarget
                var pendingId = root.appendPending(body, mentions, target)
                var payload = { chat: root.activeChat.mid, text: body }
                if (mentions.length > 0) payload.mentions = mentions
                // 帶引言就走 reply：daemon 兩支共用同一套加密與驗證，只多一個 replyTo。
                if (target) payload.replyTo = String(target.id)
                // 送不出去就把樂觀那顆收回來，草稿原封不動留在框裡。框裡那句話是
                // 使用者手上唯一的一份，清掉就沒了；泡泡留著則是一則永遠不會變成
                // 真的訊息，要等下一次整份重讀才會消失。跟 sendSticker 同一條路，
                // 也跟送出後才被 daemon 拒絕那條路收在同一個地方（見 onReply）。
                if (!root.request(target ? "reply" : "send", payload, pendingId)) {
                  root.dropMessage(pendingId)
                  return
                }
                root.resetComposerAfterSuccessfulSend()
              }

              // 選單開著時 ↑↓ 和 Tab 是它的。這三個沒有自己的 Keys 訊號，只能寫在
              // onPressed 裡。一定要 event.accepted = true：keyCatcher 的
              // Keys.priority 是 BeforeItem，但那只贏過它自己那個 Item，按鍵還是
              // 先到有焦點的這裡；不收下就會冒上去（Qt 6.11 用 qmltestrunner 量過：
              // ↑↓ 真的會冒到 keyCatcher 去捲訊息，Tab 則是被 TextArea 自己吃掉，
              // 所以「Tab 換面板」在焦點於輸入框時本來就沒發生過）。
              // Ctrl+V 同理沒有自己的訊號，也在這個 handler 裡，但它跟選單無關 ——
              // 所以擺在 mentionPicking 那道門前面：@ 打到一半照樣貼得出圖。
              Keys.onPressed: function(event) {
                // 不收下的話，TextArea 自己那份貼上會在 daemon 回話之前就把剪貼簿的
                // 文字塞進框裡，圖片送出去之後框裡還多一段字。Ctrl+Shift+V 則放過去：
                // Qt 沒有把它綁成貼上，在這裡新綁一個鍵不是這一單位要做的事。
                if (event.key === Qt.Key_V && (event.modifiers & Qt.ControlModifier)
                    && !(event.modifiers & Qt.ShiftModifier)) {
                  if (root.pasteClipboard()) event.accepted = true
                  return
                }
                if (!root.mentionPicking) return
                if (event.key === Qt.Key_Up) {
                  root.moveMention(-1); event.accepted = true; return
                }
                if (event.key === Qt.Key_Down) {
                  root.moveMention(1); event.accepted = true; return
                }
                // Tab 是打字打到一半最順手的那個選取鍵。
                if (event.key === Qt.Key_Tab && root.takeMention()) event.accepted = true
              }
              // Enter 和 Esc 不寫在上面那個 onPressed 裡：Qt 6.11 量過，
              // onReturnPressed／onEnterPressed／onEscapePressed 都比 onPressed 先跑，
              // 先跑的那個收下事件之後另一個根本不會收到，兩邊都寫只會有一份是死的。
              // event.accepted = false 才會讓 TextArea 自己插入換行。
              Keys.onReturnPressed: function(event) {
                if (root.mentionPicking && root.takeMention()) { event.accepted = true; return }
                if (event.modifiers & Qt.ShiftModifier) { event.accepted = false; return }
                replyField.submit()
                event.accepted = true
              }
              Keys.onEnterPressed: function(event) {
                if (root.mentionPicking && root.takeMention()) { event.accepted = true; return }
                if (event.modifiers & Qt.ShiftModifier) { event.accepted = false; return }
                replyField.submit()
                event.accepted = true
              }
              Keys.onEscapePressed: function(event) {
                // 貼圖選單是最上面那一塊，Esc 先收它。
                if (root.stickerOpen) { root.setStickerOpen(false); event.accepted = true; return }
                if (root.mentionOpen) { root.dismissMention(); event.accepted = true; return }
                // 引言先收掉，打到一半的字留著 —— 只是不再是一句回覆。
                if (root.replyTarget) { root.replyTarget = null; event.accepted = true; return }
                replyField.focus = false
                keyCatcher.forceActiveFocus()
              }
            }
          }
        }

        // 正在回覆哪一則。輸入框上面一行，✕ 收掉（Esc 也可以，草稿留著）。
        // 按了「回覆」之後畫面上要留得住痕跡 —— 不然送出前根本不知道自己回的是哪一則。
        Item {
          id: quoteStrip
          visible: !!root.replyTarget
          anchors.left: replyBox.left
          anchors.right: replyBox.right
          anchors.bottom: noticeLine.visible ? noticeLine.top : replyBox.top
          anchors.bottomMargin: Style.space(4)
          height: quoteStripLabel.implicitHeight + Style.space(6)

          Rectangle {
            id: quoteStripRule
            width: Math.max(1, Style.space(2))
            height: parent.height
            color: Color.accent
          }

          Text {
            id: quoteStripLabel
            anchors.left: quoteStripRule.right
            anchors.leftMargin: Style.space(6)
            anchors.right: quoteStripClose.left
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            text: "回覆 " + root.quoteText(root.replyTarget)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Math.max(1, root.fontBody - 1)
            maximumLineCount: 1
            elide: Text.ElideRight
          }

          Text {
            id: quoteStripClose
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: "✕"
            color: closeHover.containsMouse ? Color.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Math.max(1, root.fontBody - 1)

            MouseArea {
              id: closeHover
              anchors.fill: parent
              anchors.margins: -Style.space(4)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.replyTarget = null
            }
          }
        }

        // @選單。刻意不是 Popup：Popup 沒有 anchors，位置得自己 mapToItem 算完
        // 再夾回卡片裡，那就是用 imperative 去繞過宣告式綁定 —— 這條路踩過兩次
        // （Qt.callLater 搶焦點跟 focusTarget 賽跑；qrImage.source = "" 在面板還沒開、
        // 那個 Image 根本不存在時靜默失效，還順手毀掉原本的綁定），兩次都不會報錯。
        // 寫在 replyBox 後面 = 疊在訊息列表上面，不會把對話往上頂。
        // 它自始至終不拿焦點：按鍵是 replyField 收的，這裡只負責畫。
        Item {
          id: mentionPicker
          visible: root.mentionOpen
          anchors.left: replyBox.left
          anchors.right: replyBox.right
          // 引言條在的時候要疊在它上面，兩塊都貼在輸入框上會互相蓋掉。
          anchors.bottom: quoteStrip.visible ? quoteStrip.top
            : (noticeLine.visible ? noticeLine.top : replyBox.top)
          anchors.bottomMargin: Style.space(4)
          height: mentionColumn.implicitHeight

          BorderSurface {
            anchors.fill: parent
            color: Color.background
            borderSpec: Border.flat(root.dim, 1)
            radius: Style.cornerRadius
          }

          Column {
            id: mentionColumn
            width: parent.width

            // 按了 @ 什麼都不出現是最難查的那種失敗，所以原因印在使用者正在看的
            // 地方，而不是開聊天室時跳一條紅字。條件掛在 membersError 上而不是
            // 列數上：「全部」那一列不是成員、名單空的時候照樣在，光看列數就等於
            // 永遠不顯示 —— 剛打完 @ 的那一刻正是最需要看到原因的時候。
            Text {
              visible: root.membersError.length > 0
              width: mentionColumn.width
              height: Style.spacing.popupRowHeight
              leftPadding: Style.spacing.controlPaddingX
              rightPadding: Style.spacing.controlPaddingX
              verticalAlignment: Text.AlignVCenter
              textFormat: Text.PlainText
              text: root.membersError
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: root.fontBody
              elide: Text.ElideRight
            }

            Repeater {
              model: root.mentionRows

              Rectangle {
                required property var modelData
                required property int index
                width: mentionColumn.width
                height: Style.spacing.popupRowHeight
                color: (index === root.mentionSelected || mentionRowHover.containsMouse)
                  ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"

                Text {
                  anchors.fill: parent
                  anchors.leftMargin: Style.spacing.controlPaddingX
                  anchors.rightMargin: Style.spacing.controlPaddingX
                  verticalAlignment: Text.AlignVCenter
                  textFormat: Text.PlainText
                  // 「全部」上強調色：它會敲醒整個群組，跟點一個人不是同一件事。
                  text: "@" + modelData.name
                  color: modelData.all ? Color.accent : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: root.fontBody
                  elide: Text.ElideRight
                }

                MouseArea {
                  id: mentionRowHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.takeMention(index)
                }
              }
            }
          }
        }

        // 點在選單以外的地方＝收起來。蓋住整個對話半邊，排在選單前面所以疊在
        // 它下面。點下去不穿透到訊息列表：使用者要的是關掉選單，不是同時按到
        // 底下那顆氣泡。
        MouseArea {
          id: stickerScrim
          anchors.fill: parent
          visible: root.stickerOpen
          onClicked: root.setStickerOpen(false)
        }

        // 貼圖選單。跟 @選單同一套：刻意不是 Popup（Popup 沒有 anchors，位置得
        // 自己 mapToItem 算完再夾回卡片裡），而且自始至終不搶焦點 —— 打到一半
        // 的字還在輸入框裡，Esc 也還是輸入框收的。寫在最後 = 疊在訊息列表上面，
        // 不會把對話往上頂。
        Item {
          id: stickerPicker
          visible: root.stickerOpen
          anchors.left: replyBox.left
          anchors.right: replyBox.right
          // 由下往上疊：輸入框、橫幅、引言條 —— 跟 @選單同一條鏈。
          anchors.bottom: quoteStrip.visible ? quoteStrip.top
            : (noticeLine.visible ? noticeLine.top : replyBox.top)
          anchors.bottomMargin: Style.space(4)
          height: stickerColumn.implicitHeight

          // 一格的邊長；四格高就是格子的高度上限。
          readonly property int cell: Style.space(64)

          BorderSurface {
            anchors.fill: parent
            color: Color.background
            borderSpec: Border.flat(root.dim, 1)
            radius: Style.cornerRadius
          }

          Column {
            id: stickerColumn
            width: parent.width

            // 最近用過的排最上面：真正常按的就是這幾張，不該每次都先翻分頁。
            // 一排放不下就橫著捲。
            Item {
              width: stickerColumn.width
              height: stickerPicker.cell
              visible: root.recentStickers.length > 0

              // 分頁列那顆滾輪的同一件事：十六張排一列多半放不下，而滑鼠只有
              // 垂直滾輪，橫向的 Flickable 收不到。
              WheelHandler {
                onWheel: function(event) {
                  recentStickerFlick.contentX = root.stickerTabScroll(
                    recentStickerFlick.contentX, event.angleDelta.y, event.pixelDelta.y,
                    stickerPicker.cell, recentStickerFlick.width,
                    recentStickerFlick.contentWidth)
                }
              }

              Flickable {
                id: recentStickerFlick
                anchors.fill: parent
                clip: true
                contentWidth: recentStickerRow.width
                flickableDirection: Flickable.HorizontalFlick
                boundsBehavior: Flickable.StopAtBounds

                Row {
                  id: recentStickerRow
                  height: stickerPicker.cell

                  Repeater {
                    model: root.recentStickers

                    StickerCell { side: stickerPicker.cell }
                  }
                }
              }
            }

            Rectangle {
              width: stickerColumn.width
              height: 1
              visible: root.recentStickers.length > 0
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.14)
            }

            // 分頁列：貼圖包的名字，照小舖給的順序，橫著捲。⟳ 釘在右邊不跟著
            // 捲走 —— 清單讀壞的時候要按的正是那一顆。
            Item {
              id: stickerTabStrip
              width: stickerColumn.width
              height: Style.spacing.popupRowHeight

              // 滾輪一刻度走的距離：約兩格分頁，捲個幾下就換一屏，又不會一下飛到底。
              readonly property int tabStep: Style.space(96)

              // ‹ 和 › 按一下走一刻度滾輪那麼遠（120 就是一刻度的 angleDelta，
              // 單位 1/8 度）。滑鼠點的和輔助技術按的都走這裡，同一段運算不會
              // 各抄一份、日後只改到其中一份。
              function scrollTabs(notches) {
                stickerTabs.contentX = root.stickerTabScroll(
                  stickerTabs.contentX, notches * 120, 0, stickerTabStrip.tabStep,
                  stickerTabs.width, stickerTabs.contentWidth)
              }

              // 滑鼠的垂直滾輪捲這一列。掛在外層而不是 Flickable 裡面：Flickable
              // 的預設屬性會把子物件塞進 contentItem，handler 就沒掛在誰身上了。
              // 橫向的 Flickable 自己不吃滾輪，事件才冒得上來給這一個。
              WheelHandler {
                onWheel: function(event) {
                  stickerTabs.contentX = root.stickerTabScroll(
                    stickerTabs.contentX, event.angleDelta.y, event.pixelDelta.y,
                    stickerTabStrip.tabStep, stickerTabs.width, stickerTabs.contentWidth)
                }
              }

              // 換包的路有三條（點分頁、←/→、清單剛回來自動選第一包），全部
              // 落在 stickerTab 這一個屬性上，所以捲動也只掛在它身上。
              Connections {
                target: root
                function onStickerTabChanged() { Qt.callLater(stickerTabs.showSelected) }
                function onStickerOpenChanged() { Qt.callLater(stickerTabs.showSelected) }
              }

              Flickable {
                id: stickerTabs
                anchors.left: parent.left
                anchors.right: stickerRefresh.left
                anchors.rightMargin: Style.space(4)
                anchors.verticalCenter: parent.verticalCenter
                height: parent.height
                clip: true
                contentWidth: stickerTabRow.width
                flickableDirection: Flickable.HorizontalFlick
                boundsBehavior: Flickable.StopAtBounds

                // 捲到底還差多少。兩顆箭頭要不要出現看的是這個。
                readonly property real maxX: Math.max(0, contentWidth - width)

                // 把選到的那一包捲進畫面。方向鍵換包時非有不可（選中的那一格
                // 本來就在畫面外），用點的則是把貼在邊上的那半格補齊。
                // 排到這一輪的最後才算：清單剛回來時 Repeater 還沒把格子生出來。
                function showSelected() {
                  var tab = stickerTabRepeat.itemAt(root.stickerTabIndex(root.stickerTab))
                  if (!tab) return
                  stickerTabs.contentX = root.stickerTabInView(
                    stickerTabs.contentX, tab.x, tab.width,
                    stickerTabs.width, stickerTabs.contentWidth)
                }

                Row {
                  id: stickerTabRow
                  height: stickerTabs.height

                  Repeater {
                    id: stickerTabRepeat
                    model: root.stickerPacks

                    Rectangle {
                      id: stickerTab
                      required property var modelData
                      height: stickerTabRow.height
                      width: stickerTabLabel.width + Style.spacing.controlPaddingX * 2
                      color: String(stickerTab.modelData.id || "") === root.stickerTab
                        ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"

                      Text {
                        id: stickerTabLabel
                        anchors.centerIn: parent
                        // 名字長的貼圖包不能把整列撐成一條，認得出來就夠了。
                        width: Math.min(implicitWidth, Style.space(120))
                        text: root.stickerPackName(stickerTab.modelData)
                        color: String(stickerTab.modelData.id || "") === root.stickerTab
                          ? root.foreground : root.dim
                        font.family: root.fontFamily
                        font.pixelSize: root.fontBody
                        elide: Text.ElideRight
                      }

                      MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.stickerTab = String(stickerTab.modelData.id || "")
                      }
                    }
                  }
                }
              }

              // 「這一邊還有」得看得見，不然沒人知道要捲；按下去也是捲，
              // 沒有滾輪的觸控裝置就只剩這條路。疊在列上面而不是把列擠窄：
              // 擠窄會改掉捲到底的位置，箭頭會在自己出現和消失之間來回跳。
              // 底色跟選單同一個，蓋掉的是被邊界切一半的那個名字。
              Rectangle {
                id: stickerTabLeft
                anchors.left: stickerTabs.left
                anchors.top: stickerTabs.top
                anchors.bottom: stickerTabs.bottom
                width: Style.space(20)
                visible: stickerTabs.contentX > 0.5
                color: Color.background

                // 按得下去就得報得出名字：這一列在沒有滾輪的機器上只剩這兩顆，
                // 而讀螢幕的人聽到的本來只有一個「‹」。
                Accessible.role: Accessible.Button
                Accessible.name: "往左捲貼圖包分頁"
                Accessible.onPressAction: stickerTabStrip.scrollTabs(1)

                Text {
                  anchors.centerIn: parent
                  text: "‹"
                  color: stickerTabLeftHover.containsMouse ? Color.accent : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: root.fontBody
                }

                MouseArea {
                  id: stickerTabLeftHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: stickerTabStrip.scrollTabs(1)
                }
              }

              Rectangle {
                id: stickerTabRight
                anchors.right: stickerTabs.right
                anchors.top: stickerTabs.top
                anchors.bottom: stickerTabs.bottom
                width: Style.space(20)
                visible: stickerTabs.contentX < stickerTabs.maxX - 0.5
                color: Color.background

                Accessible.role: Accessible.Button
                Accessible.name: "往右捲貼圖包分頁"
                Accessible.onPressAction: stickerTabStrip.scrollTabs(-1)

                Text {
                  anchors.centerIn: parent
                  text: "›"
                  color: stickerTabRightHover.containsMouse ? Color.accent : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: root.fontBody
                }

                MouseArea {
                  id: stickerTabRightHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: stickerTabStrip.scrollTabs(-1)
                }
              }

              Text {
                id: stickerRefresh
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.controlPaddingX
                anchors.verticalCenter: parent.verticalCenter
                // 清單在 daemon 那邊快取一小時：買了新貼圖包不必等它過期，
                // 也不必重開面板。
                text: root.stickerLoading ? "…" : "⟳"
                color: stickerRefreshHover.containsMouse ? Color.accent : root.dim
                font.family: root.fontFamily
                font.pixelSize: root.fontBody

                MouseArea {
                  id: stickerRefreshHover
                  anchors.fill: parent
                  anchors.margins: -Style.space(4)
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.loadStickers(true)
                }
              }
            }

            // 讀不到、還在讀、這個帳號沒有貼圖包 —— 三種都要說出來，
            // 不然選單就是一片空白，看不出是壞了還是本來就沒有。
            Text {
              id: stickerStatus
              width: stickerColumn.width
              visible: text.length > 0
              leftPadding: Style.spacing.controlPaddingX
              rightPadding: Style.spacing.controlPaddingX
              topPadding: Style.space(6)
              bottomPadding: Style.space(6)
              textFormat: Text.PlainText
              text: root.stickerStatusText()
              color: root.stickerError.length > 0 ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontBody
              elide: Text.ElideRight
            }

            // 只有選到的那一包會生成 delegate：model 就是那一包攤出來的格子，
            // 54 包不會同時掛在場景上。
            GridView {
              id: stickerGrid
              width: stickerColumn.width
              height: root.stickerGridHeight(root.stickerGridModel.length,
                                             stickerGrid.width, stickerPicker.cell, 4)
              cellWidth: stickerPicker.cell
              cellHeight: stickerPicker.cell
              clip: true
              // 每一格都是一次 CDN 下載，只多快取一列：捲動時不必邊捲邊抓，
              // 也不會為了看不見的幾百張把記憶體吃光。
              cacheBuffer: stickerPicker.cell
              boundsBehavior: Flickable.StopAtBounds
              model: root.stickerGridModel
              ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

              delegate: StickerCell { side: stickerGrid.cellWidth }

              // 貼圖格也是同一顆：一包幾百張，最看得出滾輪一格走多遠。
              WheelSpeed { view: stickerGrid }
            }
          }
        }
      }

      // ------------------------------------------------------------- 燈箱

      // 排在最後 = 疊在對話上面。面板是整片的 WlrLayer.Overlay，外部看圖程式
      // 起來也會被蓋在下面，所以圖片改成在面板裡放大；影片跟檔案才把面板收掉
      // 再交給 xdg-open（deliverMedia）。
      Item {
        id: lightboxLayer
        anchors.fill: parent
        visible: !!root.lightbox

        Rectangle {
          anchors.fill: parent
          color: Qt.rgba(0, 0, 0, 0.93)
        }

        // 燈箱蓋住整張卡片，底下的清單／輸入框不該還點得到；點空白處等於關掉。
        MouseArea {
          anchors.fill: parent
          onClicked: root.closeLightbox()
        }

        Item {
          id: lightStage
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: lightCaption.top
          anchors.bottomMargin: Style.space(6)
          clip: true

          CachedImage {
            id: lightImg
            anchors.fill: parent
            remoteSource: root.lightbox ? root.lightbox.source : ""
            asynchronous: true
            cache: false
            fillMode: Image.PreserveAspectFit
            transform: [
              Scale {
                origin.x: lightImg.width / 2
                origin.y: lightImg.height / 2
                xScale: root.lightScale
                yScale: root.lightScale
              },
              Translate { x: root.lightX; y: root.lightY }
            ]
          }

          MouseArea {
            id: lightArea
            anchors.fill: parent
            acceptedButtons: Qt.LeftButton
            cursorShape: root.lightScale > 1 ? Qt.OpenHandCursor : Qt.ArrowCursor

            // grabX/grabY 是上一格的位置（平移用增量），pressX/pressY 是按下的那一點
            // （判斷有沒有拖曳用總位移）—— 兩者不能共用，邊拖邊更新就永遠不會超過門檻。
            property real grabX: 0
            property real grabY: 0
            property real pressX: 0
            property real pressY: 0
            property bool dragged: false

            function applyPan(x, y) {
              var c = root.clampPan(x, y, root.lightScale,
                                    lightImg.paintedWidth, lightImg.paintedHeight, width, height)
              root.lightX = c.x
              root.lightY = c.y
            }

            onPressed: function(mouse) {
              lightArea.grabX = mouse.x
              lightArea.grabY = mouse.y
              lightArea.pressX = mouse.x
              lightArea.pressY = mouse.y
              lightArea.dragged = false
            }
            onPositionChanged: function(mouse) {
              if (root.isDrag(mouse.x - lightArea.pressX, mouse.y - lightArea.pressY))
                lightArea.dragged = true
              if (root.lightScale <= 1) return
              lightArea.applyPan(root.lightX + mouse.x - lightArea.grabX,
                                 root.lightY + mouse.y - lightArea.grabY)
              lightArea.grabX = mouse.x
              lightArea.grabY = mouse.y
            }
            // 只有點在圖外面（背景）才關；拖完放開的那一下也不算點擊，
            // 否則平移一次圖就不見了。
            onClicked: function(mouse) {
              if (lightArea.dragged) return
              if (root.outsidePicture(mouse.x, mouse.y, width, height, root.lightX, root.lightY,
                                      root.lightScale, lightImg.paintedWidth, lightImg.paintedHeight))
                root.closeLightbox()
            }
            onDoubleClicked: function(mouse) {
              // 已經放大就一次縮回 1×（zoomAt 會夾到下限並歸零平移）。
              var z = root.zoomAt(root.lightScale, root.lightX, root.lightY,
                                  mouse.x - width / 2, mouse.y - height / 2,
                                  root.lightScale > 1 ? 0.01 : 2)
              root.lightScale = z.scale
              lightArea.applyPan(z.x, z.y)
            }
            onWheel: function(wheel) {
              var z = root.zoomAt(root.lightScale, root.lightX, root.lightY,
                                  wheel.x - width / 2, wheel.y - height / 2,
                                  wheel.angleDelta.y > 0 ? 1.2 : 1 / 1.2)
              root.lightScale = z.scale
              lightArea.applyPan(z.x, z.y)
            }
          }
        }

        Text {
          id: lightCaption
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: lightHint.top
          horizontalAlignment: Text.AlignHCenter
          elide: Text.ElideMiddle
          text: root.lightboxCaption()
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: root.fontBody
        }

        Text {
          id: lightHint
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          horizontalAlignment: Text.AlignHCenter
          text: "滾輪縮放 · 拖曳平移 · ←/→ 換圖 · o 用外部程式開 · Esc 關閉"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Math.max(1, root.fontBody - 1)
        }
      }

      // --------------------------------------------------------- 右鍵選單

      // 選單寬度取最長那一列的自然寬度。量的東西不能放進下面那個 Column ——
      // Column 的 implicitWidth 是小孩的 width 算出來的，小孩的 width 又綁回
      // Column，就會變成綁定迴圈。
      Text {
        id: menuMetrics
        visible: false
        textFormat: Text.PlainText
        font.family: root.fontFamily
        font.pixelSize: root.fontBody
        text: {
          // 訊息那一組永遠帶著連結那兩項來量（"x" 是假的連結）：寬度不能因為
          // 右鍵剛好沒壓在連結上就縮一圈。
          var items = msgMenu.chat ? root.chatMenuItems(msgMenu.chat)
                                   : root.messageMenuItems("x", msgMenu.msg)
          var longest = ""
          for (var i = 0; i < items.length; i++)
            if (items[i].label.length > longest.length) longest = items[i].label
          return longest
        }
      }

      // 表情列的自然寬度也要量：六個 emoji 排一列比任何一個標籤都寬，
      // 只照標籤算的話那一列會被夾在一個放不下它的選單裡。
      Text {
        id: menuEmojiMetrics
        visible: false
        textFormat: Text.PlainText
        font.family: root.fontFamily
        font.pixelSize: root.fontBody
        text: {
          var out = ""
          for (var i = 0; i < root.reactionTypes.length; i++)
            out += root.reactionEmoji(root.reactionTypes[i])
          return out
        }
      }

      // 掛在 keyCatcher 底下，內容整棵在兩個宿主之間搬家時它才跟著搬。
      // Popup 是場景內彈窗（omarchy 自己的 tailscale 面板同款），三種擺法共用
      // 這一個，不必為了一個選單再開一扇 PopupWindow。
      Popup {
        id: msgMenu
        // 整段本文（複製訊息用）與右鍵當下壓著的連結（空字串代表沒壓到）。
        // msg 是按下去的那一則本身：回覆、表情、收回都要指得到它。
        property string body: ""
        property string link: ""
        property var msg: null
        // 非 null 代表這次右鍵壓的是清單那一列，不是一則訊息 —— 兩組項目、
        // 有沒有表情列、要多寬，全看這一個。
        property var chat: null
        // 表情列每一格的左右留白與格與格之間的距離，量寬度時要一起算進去。
        readonly property real emojiPad: Style.space(8)
        readonly property real emojiGap: Style.space(4)
        readonly property real emojiRowWidth:
          menuEmojiMetrics.implicitWidth
            + msgMenu.emojiPad * root.reactionTypes.length
            + msgMenu.emojiGap * (root.reactionTypes.length - 1)

        padding: 0
        modal: false
        focus: true
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
        // 聊天那一組沒有表情列，就不必為六個 emoji 留寬度 —— 留了的話，
        // 一個四個字的選單會攤成一條又寬又空的橫條。
        width: Math.round(Math.max(menuMetrics.implicitWidth,
                                   msgMenu.chat ? 0 : msgMenu.emojiRowWidth)
                          + Style.spacing.controlPaddingX * 2)
        // 關掉之後焦點不還回去的話，鍵盤會卡在沒有主人的狀態。
        onOpenedChanged: if (!opened && root.opened) root.dropBodyFocus()

        background: BorderSurface {
          color: Color.background
          borderSpec: Border.flat(root.dim, 1)
          radius: Style.cornerRadius
        }

        contentItem: Column {
          id: menuColumn

          // 六個表情排在選單最上面，不做第二層。反應是這裡最常按的一項，
          // 藏進子選單等於每次都要多按一下、還要多瞄一次位置。
          Row {
            id: reactionRow
            // 表情是對訊息按的；清單那一列沒有訊息可以貼表情。
            visible: !msgMenu.chat && root.canActOn(msgMenu.msg)
            height: Style.spacing.popupRowHeight
            leftPadding: Style.spacing.controlPaddingX
            spacing: msgMenu.emojiGap

            Repeater {
              model: root.reactionTypes

              BorderSurface {
                id: emojiCell
                required property string modelData
                // 自己選過的那個描邊，再點一次就是收回。
                readonly property bool mine: root.myReaction(msgMenu.msg) === emojiCell.modelData
                width: Math.round(emojiLabel.implicitWidth + msgMenu.emojiPad)
                height: reactionRow.height
                radius: Style.cornerRadius
                color: emojiHover.containsMouse
                  ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"
                borderSpec: emojiCell.mine ? Border.flat(Color.accent, 1) : Border.none()

                Text {
                  id: emojiLabel
                  anchors.centerIn: parent
                  textFormat: Text.PlainText
                  text: root.reactionEmoji(emojiCell.modelData)
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: root.fontBody
                }

                MouseArea {
                  id: emojiHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: {
                    root.toggleReaction(msgMenu.msg, emojiCell.modelData)
                    msgMenu.close()
                  }
                }
              }
            }
          }

          Repeater {
            model: root.menuItems()

            Rectangle {
              required property var modelData
              width: msgMenu.availableWidth
              height: Style.spacing.popupRowHeight
              color: menuRowHover.containsMouse
                ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"

              Text {
                anchors.fill: parent
                anchors.leftMargin: Style.spacing.controlPaddingX
                anchors.rightMargin: Style.spacing.controlPaddingX
                verticalAlignment: Text.AlignVCenter
                textFormat: Text.PlainText
                text: modelData.label
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: root.fontBody
              }

              MouseArea {
                id: menuRowHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.runMenuAction(modelData.action)
              }
            }
          }
        }
      }
    }
  }
}

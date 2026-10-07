# 架構

[English](architecture.md)

omarchy-line 分成兩半，各自是獨立的 process。這一頁說明兩半怎麼分工，以及睡眠或
斷網之後怎麼恢復。檔案格式與 socket 指令的細節在 [protocol.zh-TW.md](protocol.zh-TW.md)。

## 兩半

- **外掛**是 Omarchy shell 的 QML bar widget：`Panel.qml`、`LinePanel.qml`、
  `LineWindow.qml`、`DraftWriter.qml`、`manifest.json`，以及 `EventLog.js`、
  `PanelKit.js`、`DraftStore.js`、`Strings.js` 這幾個 `.pragma library` 檔。它從不
  直接跟 LINE 溝通，只讀本機的 JSON 檔，並連一個本機 unix socket。`EventLog.js`
  合併事件與訊息，`PanelKit.js` 放純 UI 輔助函式，`DraftStore.js` 管草稿，
  `Strings.js` 放兩種語言的介面文字。`Panel.qml` 負責狀態機、socket 與 `FileView`
  的接線，以及畫面。
- **daemon**（`enil`）是真正登入 LINE 的那一半。它是 Deno 程式：進入點是
  `daemon/daemon.ts`，其餘程式碼在 `daemon/modules/`。LINE 的 refresh token 每次
  登入都會換，所以同一時間只能有一個 process 持有 session。daemon 啟動時會對
  `~/.local/state/enil/lock` 取得 `flock`，同一個 state 目錄上的第二個 daemon 會
  直接結束，不會共用 session。

`enil` 這個名字就是把「LINE」倒過來拼。

daemon 透過 [linejs](https://github.com/evex-dev/linejs) 跟 LINE 溝通，linejs 以
git submodule 的方式放在本專案裡。[vendoring.zh-TW.md](vendoring.zh-TW.md) 說明這個
fork。

## 兩半怎麼溝通

daemon 在 `~/.local/state/enil/`（或 `$XDG_STATE_HOME/enil/`）寫三樣東西，面板讀取：

- `state.json` 存登入狀態、聊天列表和未讀數。daemon 每次都整份重寫，並且每 30 秒
  更新一次 `updatedAt` 心跳。
- `events.json` 是最新 200 筆即時事件的環狀緩衝：新訊息、已讀、表情回應、收回、
  編輯。
- `sock` 是 unix socket。面板每行送一個 JSON 請求，每行收一個 JSON 回應。面板連著
  的時候，daemon 也會把每一筆新事件直接推過 socket，所以新訊息一秒內就會出現。
  socket 斷掉之後，面板靠 `events.json` 補齊。

`state.json` 的 `updatedAt` 超過 3 分鐘沒動，面板就顯示 `DAEMON 離線`。

## 讓 daemon 一直在跑

systemd user unit `daemon/enil.service` 設了 `Restart=always`，所以不管 daemon 怎麼
結束，5 秒後都會再起來。只有 `systemctl --user stop enil` 會讓它停著。面板補上這個
情況和 daemon 卡死的情況：daemon 看起來掛了的時候，面板會自己執行
`systemctl --user restart enil`，最多每 45 秒一次。面板上的「啟動 daemon」按鈕做同樣
的事，防連點間隔 3 秒。

`daemon/enil-run.sh` 是 unit 的 `ExecStart`。只有在編譯好的 `enil` 執行檔是從目前
這份 checkout 建出來的時候，它才會執行那個檔案，否則就用 Deno 跑 `daemon.ts`。它透過
`PATH` 找 `deno`，而且 linejs submodule 跟這份 checkout 釘住的 commit 不一致時，它會
拒絕啟動。
<!-- verify after merge: enil-run.sh resolves deno via PATH and refuses to start on an out-of-date submodule -->

Deno 以明確列出的權限執行 daemon，不再用 `-A`。網路權限仍然很寬，因為 FLEX 訊息
可以指向任何公開 HTTPS 主機上的圖片。
<!-- verify after merge: explicit Deno permissions replace -A in enil-run.sh and deno.json tasks -->

## LINE 限制帳號的時候

LINE 回 `ABUSE_BLOCK`、`BANNED`、`EXCESSIVE_ACCESS`，或帳號層級的
`NOT_AVAILABLE_USER`、`ACCOUNT_NOT_MATCHED` 時，daemon 會停掉所有自動發出的 LINE
流量：不重連、不輪詢、不在背景重新整理。面板會告訴你 LINE 回報了什麼。daemon 不會
想辦法繞過限制再試。
<!-- verify after merge: restriction stop for ABUSE_BLOCK/BANNED/EXCESSIVE_ACCESS/NOT_AVAILABLE_USER/ACCOUNT_NOT_MATCHED, and the panel message -->

## 睡醒與斷線

筆電睡著時 LINE 的 push 連線會半開，核心那邊還是 ESTAB，daemon 卻再也收不到訊息。
所以 daemon 一邊聽 logind 的 `PrepareForSleep`（睡醒後三秒重連），一邊每分鐘檢查
push 有沒有超過三分鐘沒動靜，有就自己重建連線，失敗則以 1 秒起跳、最多 60 秒的
間隔一直重試。另外每五分鐘會保底重抓一次聊天列表。push 連線自己丟出、沒人接的錯誤
會記成 `[unhandled]`：判定是網路問題就當成斷線交給上面的重連流程，daemon 不會因此
被 systemd 重啟；其他錯誤同樣記一行，但照樣讓 daemon 結束、由 systemd 重啟——那是
程式自己的 bug，繼續跑下去只會端出過期的狀態。

**linejs 的 pusher 迴圈整個死掉是另一條路**：它連不上的時候會把兩條共用的 stream 一起
error 掉，`listen()` 內部那個 `for await` 就此結束，之後再也不會有事件進來，除非有人
再呼叫一次 `listen()`（上游 v3.4.1 明講這是呼叫端的事）。daemon 從 `log` 頻道的
`LegyPusherError` 認出這一次，判準是 `poll.islisten`：linejs 在 `finally` 裡把它清掉，
所以只有「迴圈真的結束了」那一次讀到 false。單則訊息解密失敗、或 `InitAndRead` 那種
它自己睡 4 秒再重試的失敗，回報的型別一模一樣但迴圈還活著，跟著重建連線只會去搶
`conns[0]`，所以那兩種只記一行、不動連線。真的死了就把 push 的時鐘歸零，交給上面同一套
watchdog（沒有第二套退避）—— 同一次失敗會寫兩行 `LegyPusherError`（pusher 自己一行，
stream 被 error 掉之後 `for await` 再一行），兩行走同一個退避閘門，加起來只重連一次。
以前這條只能等三分鐘的沒動靜檢查才會被發現。

另外，每一個對 LINE 的請求都有「等回應標頭」的時間上限：一般 30 秒，上傳走的 obs
主機 180 秒（上傳要整包送完才會有回應標頭）。上限只管標頭，不管內容，所以 push 連線
和媒體下載那種一開好幾個小時的 body 不會被砍掉。這層是自己加的，因為 linejs 雖然
自己設了 30 秒 timeout，加密傳輸層卻把請求重建了一次而漏掉那個 signal，等於沒設；
筆電睡醒後那條連線早就死了但核心不知道，一個抓聊天列表的請求就這樣卡了十幾分鐘，
順帶把後面每一次刷新都擋住。現在最多卡 30 秒就會失敗，並在 15 秒後自己重抓一次，
不用等五分鐘的保底輪詢。上限可以用 `ENIL_REQUEST_TIMEOUT_MS`（毫秒）調整。逾時本身
（`TimeoutError`／`AbortError`）算網路問題，跟連線被砍走同一條路：以前它被歸成不明
錯誤，一個逾時的請求沒人接就足以讓 daemon 整個結束、由 systemd 重啟。

上面那兩層都是自動的，但都要等：watchdog 一分鐘才看一次，保底輪詢是五分鐘。不想等就
按清單搜尋框右邊那顆**「同步」**（鍵盤 `r`，或直接點標題下那行「LINE 連線中斷，重連中」）——
它會重建 push 連線並立刻重抓聊天列表，正在看的那間對話也會一起重讀。按下去按鈕會變成
「同步中…」，通常幾秒內變成「已同步 HH:MM」（剛好有一輪重抓在飛的話會多等它一輪，
按鈕會一直維持在「同步中…」）；失敗的話寫的是原因（`同步失敗：連不上 LINE，
稍後重試` 之類），不會默默沒反應。重建連線那段本身要八秒（要先讓 linejs 自己的 pusher
有機會復原，不然兩個迴圈會搶同一條連線），但同步不等它 —— 重抓不需要新的連線，所以
畫面先回來，連線在後面自己修好。

重連紀錄看這裡：

```bash
journalctl --user -u enil | grep '\[push\]'
```

手動同步在 journal 裡是 `[sync] requested`。

平時推播到來的刷新也不再整份重抓：push 本身就指明了哪些聊天室有動，daemon 會把這幾間
記下來，去抖後那一輪只對它們各打一次「取最近訊息」的請求、原列就地更新，不再為了幾列
去掃整份所有的 box。登入、重連、手動同步、已讀回執、改名、一輪爆量（超過 8 間）或
增量輪自己失敗時，才退回完整的 `getMessageBoxes` 重抓——未讀數唯一的伺服端來源在那裡，
全量輪永遠是校正者。這條路可以用環境變數 `ENIL_INCREMENTAL=0` 整條關掉（預設開啟），
關掉之後每一輪都走原本的完整重抓。

push 活著的時候不需要等這些：新訊息、已讀、表情和收回都會在一秒內進到事件環，
面板開著時 daemon 從已連線的 socket 直接推過來（見 [protocol.zh-TW.md](protocol.zh-TW.md#推播幀)），連檔案
寫入節流都不用等；socket 斷線時照舊靠 FileView 讀 `events.json` 補上。斷線
期間發生的事只會留在 LINE
那邊，重連之後靠重抓聊天列表和歷史補回來 —— `events` 只有最近 200 筆，而且 daemon
一重啟就從頭算（`bootId` 會換），所以它是「快」的那條路，不是唯一的那條路。


## 公開圖片

貼圖、貼圖選單和 FLEX 圖片（含燈箱）都由 daemon 下載到
`~/.local/state/enil/media/public-images/`。QML 只讀本機檔案，所以這些圖片請求不會
進到 shell 的 Qt TLS。同一個網址的下載會合併，最多同時 4 個，每個上限 10 MiB、逾時
20 秒。這個快取跟 `media/` 用同一套清理規則。下載失敗不會退回用 QML 走 HTTPS。

daemon 只接受 `https://` 圖片網址，並拒絕解析到私有位址的主機。請求不帶 cookie，
也不帶 LINE token。

## 媒體流程

history 先回文字與媒體欄位；畫面上實際出現的圖片列再向 daemon 要縮圖。影片只有在
LINE 提供真正的 preview URL，或不是加密 chunks 的路徑時才抓縮圖；加密影片不會為了
一張預覽退化成下載整支影片，會維持 📎 附件列。

**大頭貼另外一個快取**：`media/avatars/`，檔名是 `sha1(mid + 那一版的 picture token)`。
帶上 picture token 是因為換了照片就得換檔名，不然舊的會一直留在畫面上。抓的時候
**最多同時四個**（一次冷啟動要一百多張，全部一起打 CDN 就是一場 fetch storm），其餘
排隊；抓不到就是沒有這個欄位，不會擋住聊天列表或訊息 —— 圖是後來才補進 `state.json`
的。哪一個 CDN 主機、要不要加 `/preview`，daemon 第一次抓的時候自己試出來並記在
`avatars.json` 裡，之後就不用再試。這個快取**不看時間**（一個月沒聯絡的人，正是需要
看臉才認得出來的那個），只有 20 MB 上限，滿了先掃最舊的。

**圖片點下去在面板裡放大**（燈箱）：先用縮圖立刻開起來，同時去要原圖，回來再換掉；
原圖抓失敗就繼續顯示縮圖並在上面跳一行提示。滾輪以游標為中心縮放 1×–4×，放大後可以
拖曳平移，雙擊在 1× 和 2× 之間切換；←/→（或 h/l）在同一間聊天室的圖之間走，標題會顯示
「第幾張 / 共幾張」；`o` 用外部程式開這張，Esc 或點圖外的空白處關掉。FLEX（carousel）
的圖是公開 CDN 網址，點下去一樣進燈箱，不必先 `download` 原檔 —— 那條路是給 LINE 的
加密媒體走的，公開網址交給 `image` 抓進快取就好。

**影片和檔案類（📎 那一行）點下去則是先關面板再開外部程式**：面板送一次 `download`，
daemon 回原檔路徑，面板 `close()` 之後才 `xdg-open`。順序不能反 —— 面板是整片的
`WlrLayer.Overlay`，外部視窗只是普通視窗，會被壓在面板底下，看起來像按了沒反應。
開檔走 `Quickshell.execDetached`（argv，不經過 shell），所以第一個檢視器還開著時
再點第二個檔案照樣開得起來。下載中途換到別間聊天室也沒關係，檔案照樣會開起來。

`App window` 模式（見 [usage.zh-TW.md](usage.zh-TW.md#設定)）不會關：那是一般視窗，不是 overlay，檢視器自己就疊在
上面。所以在那個模式下開影片、開檔案、燈箱按 `o`，LINE 都留在原地。

傳檔有兩條路：輸入框打 `/file <路徑>`，或按 `📎` 開系統檔案選擇器。選擇器用的是
**zenity**，Omarchy 不會預裝 —— 沒裝的時候按 `📎` 會跳
「找不到 zenity，請 sudo pacman -S zenity」，裝完立刻可用，不必重啟 shell。
選了檔案又按取消不會有任何提示，這是刻意的。

多人聊天室（`r…` 開頭的 room）不能傳檔，送出前就會被擋下並給訊息。

**送出去的圖片是圖片、影片是影片**，不是一律當附件。daemon 先看檔頭的 magic bytes，
認不出來才看副檔名，然後挑 linejs 的 ObjType：`image`／`gif` 是 IMAGE、`video` 是
VIDEO，其餘 `file`。所以手機那種 `.jpg` 其實是 mp4 的檔案照樣會以影片送出（LINE 只看
我們送的 contentType，根本不看檔名），`.gif` 一樣走 `gif`（帶 `cat=original`，不然收到
的是靜止的那一格），HEIC 與 mp4 都是 ISO 容器、靠 `ftyp` 的 brand 分。**聲音檔一律當
檔案**：LINE 的語音訊息要有長度，而 daemon 沒有 demuxer 量不出來，送成語音就是一則
0:00 的波形。

**太大的檔案在讀進來之前就會被擋**：圖片（含 gif）**20 MB**、影片和檔案**1 GB**，
拒絕的話是「圖片太大（超過 20 MB）」／「影片太大（超過 1 GB）」／「檔案太大（超過
1 GB）」—— 會把上限念出來，因為檔案是使用者自己挑的，只有他挑得出小一點的那個。
上限是我們自己的：LINE 那邊要整包傳完才會拒絕，家用上傳頻寬等於白等好幾分鐘，然後
換來一句沒人能處理的話。圖片的上限跟剪貼簿同一個數字，因為那條路最吃記憶體（整包讀
進來、加密一份，沒給縮圖時 linejs 還會把原檔再上傳一次當 `__ud-preview`）；影片和檔案
只上傳一次，所以放寬到 LINE 自己都不會收的程度。判型要看檔頭，所以 daemon 是先
`Deno.stat` 拿大小、只讀開頭 16 個位元組判 ObjType、擋掉之後才真的把整個檔案讀進來。
**送出的影片會帶預覽圖和長度。** 沒給 preview 的時候 linejs 會把加密後的原檔再上傳
一份當 `__ud-preview`（`base/obs/mod.ts:389`）—— 圖片這樣剛好（它自己就是圖），影片
在對方那邊就是一格空白：客戶端拿 mp4 當 JPEG 畫。所以影片多做兩件事：

- **長度**直接從容器的檔頭讀：ISO base media 的 `moov/mvhd`（version 0 是 32 bit、
  version 1 是 64 bit）、Matroska 的 `Segment/Info/Duration`（乘上
  `TimestampScale`）。只讀走到的那幾個 box 的檔頭 —— 手機常把 `moov` 寫在幾 GB 的
  `mdat` **後面**，所以是照 box 宣告的大小跳過去，不是掃過去。讀不出來（例如 AVI）
  就是沒有長度，不影響送出。
- **預覽圖**要有 `ffmpegthumbnailer` 或 `ffmpeg`（照這個順序挑 PATH 上第一個有的，
  Omarchy 兩個都不預裝）：抓第 1 秒的一格，存成寬 640 的 JPEG。不到兩秒的短片改抓
  正中間 —— 抓超過長度那兩支都不會產生任何一格。**兩個都沒裝就跟以前一樣送出**，
  只是沒有預覽圖；`journalctl --user -u enil | grep 'preview skipped'` 會說是哪一種
  情形（沒裝、跑失敗、或是產出的不是完整的 JPEG）。整個縮圖步驟最多等 10 秒，
  失敗絕不會讓送出失敗。

長度是加在訊息 contentMetadata 的 `DURATION`（毫秒）：那份 metadata 是
`uploadMediaByE2EE` 自己組的，所以 fork 給它多開了一個 `durationMs` 參數（pin
`4d6aa18`），daemon 量到長度就一起交下去、量不到就整個不帶。走 E2EE 的時候 obs 只
看得到加密後的 blob，容器裡的長度它自己讀不出來（一般的 `uploadObjTalk` 是自己讀的），
所以非得由呼叫端給不可。

**剪貼簿裡的圖片可以直接送**：`probeClipboardImage {chat}` 一進來，daemon 就用
`wl-paste --list-types` 看有沒有 `image/png`／`image/jpeg`／`image/webp`／`image/gif`
（有多個就照這個順序挑），再 `wl-paste --no-newline --type <mime>` 把位元組讀進來 ——
`--no-newline` 不能省，wl-paste 預設會在結尾補一個換行，PNG 後面多一個位元組就是壞檔。
上限 **20 MB**（讀進記憶體、加密一份、還會被 linejs 上傳兩次），成功時把這一份快照
暫存在 `media/` 並回傳受限的 `stage` 名稱；面板接著才送
`sendClipboardImage {chat, stage, requestId}`，daemon 走跟 `sendFile` 同一支函式並在成功或
失敗後刪掉暫存檔。貼上的截圖和選檔案送出的圖片，判型、命名、拒絕全部同一套。

失敗都有話說，不會只是「送出失敗」：沒有 wl-clipboard 是
「找不到 wl-paste，請 sudo pacman -S wl-clipboard」；剪貼簿裡是文字是「剪貼簿裡沒有
圖片」；是我們送不出去的圖片格式會把格式念出來（「剪貼簿的圖片格式不支援:
image/tiff」）；太大是「剪貼簿的圖片太大（超過 20 MB）」。daemon 是 systemd user
unit，**如果它比 compositor 早起來就沒有 `WAYLAND_DISPLAY`**，那時 wl-paste 連不上
顯示，回的是「連不上 Wayland，請 systemctl --user restart enil」—— 這跟剪貼簿是空的
不是同一件事，所以話也不一樣。wl-paste 卡住最多等 5 秒，之後回「讀不到剪貼簿」，
原因寫進 journal。

**面板這一邊就是輸入框裡的 `Ctrl+V`。** 剪貼簿在 daemon 那一頭（`wl-paste` 在那裡跑），
面板自己讀不到，所以按下去先送不會產生訊息的 `probeClipboardImage`。它會在 daemon 端
一次讀完並固定成暫存快照；回來剛好是「剪貼簿裡沒有圖片」那一句，才知道剪貼簿裡是文字、
改讓輸入框自己貼。只有探測成功後才送帶 `requestId` 的 `sendClipboardImage`，因此探測
失敗或斷線不會留下沒有歷史訊息可對帳的 token，也不會在兩階段間重讀已改變的剪貼簿。
所以複製一段文字按 Ctrl+V 照樣是貼字，只是慢了一次 socket 來回；
複製一張圖按 Ctrl+V 就直接送出去，輸入框裡打到一半的字原封不動。上傳那幾秒橫幅寫
「傳送中…」，跟按 `📎` 一樣；泡泡不先畫 —— 按下去的那一刻還不知道剪貼簿裡是不是圖片，
先畫一顆再為了一次貼字收回來，等於每貼一段文字都閃一顆泡泡，真的那則等 LINE 推回來
（跟 `📎` 送出的檔案同一條路）。其餘每一句拒絕都留在橫幅上，不會變成一次貼字：沒裝
wl-clipboard、連不上 Wayland、太大、格式送不出去、room 傳不了檔，看到的都是上面那幾句
原話。按下去到探測回話前若換了聊天室，圖片仍送往按下 `Ctrl+V` 時捕捉的原聊天室；若
剪貼簿是文字則不會貼進另一間的輸入框，錯誤也不會跳到那一間去。第二階段請求若無法排入
socket，面板才送 `discardClipboardImage` 釋放暫存。**還在等回話的時候按第二次不算數**
（按住 Ctrl+V 會自動重複，而上傳要好幾秒）：那一下會被收下來、什麼都不做，跟 `📎` 的
選檔器還開著時再按一次一樣 —— 送第二次就是送出兩張一模一樣的圖，剪貼簿裡是文字的話
就是同一段字貼兩次。回話一到（不管是送成功或拒絕），Ctrl+V 立刻又能按。

**打不開的附件會說原因，不再一律「下載失敗」**。對方收回的訊息 LINE 還是照送，
contentType 仍是 `FILE`／`IMAGE`，只是沒有內容 —— daemon 把它標成 `mediaState:
"unsent"`、`hasMedia: false`，`text` 換成「已收回訊息」（清單預覽也是），點下去回
「訊息已收回」，完全不會去要檔案。聊天室的檔案 LINE 只保留 **7 天**（metadata 的
`FILE_EXPIRE_TIMESTAMP`，寫進 `expiresAt`），過期的是 `mediaState: "expired"`，點下去回
「檔案已過期（LINE 只保留 7 天）」，一樣不打網路。真的去要了才失敗的分兩種：物件已經
不在（HTTP 404／410、`ObsError`，或上游 linejs 會先在解密那層炸出來的
`encrypted data too short` ／ `HMAC verification failed`）回「檔案已過期或已被刪除」，
其他才是「下載失敗」。面板照著這兩個欄位畫：收回的那則是一行灰斜體「已收回訊息」，
貼圖、FLEX 圖、縮圖、📎 全部收掉；過期的檔案 📎 那行的檔名後面接「（已過期）」，
兩種都點不下去，燈箱的 ←/→ 也不會停在上面。

每一個回 `{ok:false}` 的指令都會在 journal 留一行
`[cmd] <cmd> failed: <錯誤類別>: <訊息>`（訊息截到 120 字，mid 換成 `<mid>`，請求內容
一律不寫）。`journalctl --user -u enil | grep '\[cmd\]'` 就是失敗紀錄。訊息裡夾著路徑的
拒絕**只回給面板、不進 journal**：`sendFile` 找不到檔案時面板看到
`找不到檔案: <路徑>`（路徑是使用者自己選的），journal 只有「找不到檔案」。


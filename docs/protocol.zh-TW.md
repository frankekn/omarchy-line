# daemon 與面板的協定

[English](protocol.md)

這一頁是 daemon（`enil`）與面板之間契約的參考資料：state 目錄裡的檔案、socket
指令、推播幀，以及訊息的格式。想先了解兩半怎麼搭在一起，請先看
[architecture.zh-TW.md](architecture.zh-TW.md)。

任何程式只要照這份契約寫檔案、提供這個 socket，就能驅動面板。
[`daemon/stub.py`](development.zh-TW.md#用-stub-跑面板) 就是這樣的程式。

## State 目錄

兩邊都在 `~/.local/state/enil/`（或 `$XDG_STATE_HOME/enil`）：

| 路徑 | 用途 |
|---|---|
| `state.json` | 登入狀態、聊天室清單、未讀數（原子寫入，外掛用 `FileView` 監看） |
| `events.json` | 即時事件環（原子寫入，外掛用 `FileView` 監看），見下 |
| `sock` | unix socket，一行一個 JSON 請求／回應；連線中的面板也從這裡收推播幀 |
| `storage.json` | LINE 憑證與 E2EE 金鑰（`chmod 600`，daemon 專用） |
| `lock` | 單一實例鎖：執行中的 daemon 對它持有 `flock`，第二個 daemon 會直接退出、不共用同一個 session（空檔，daemon 專用） |
| `media/` | 下載過的圖片／影片縮圖快取（14 天或 500 MB 到就掃掉舊的） |
| `media/avatars/` | 大頭貼快取（**不看時間**，只有 20 MB 上限，滿了先掃最舊的） |
| `media/public-images/` | 貼圖與 FLEX 圖片快取（公開 CDN 網址，掃法跟 `media/` 同一套） |
| `avatars.json` | 哪個 mid 的哪一版大頭貼已經處理過，重開不用重抓（daemon 專用） |
| `hidden.json` | 被隱藏的聊天室 mid，`{"mids":[…]}`（原子寫入，daemon 專用，上限 1000） |
| `panel-stickers.json` | 最近用過的貼圖，照帳號分（**外掛**寫的，原子寫入；daemon 不讀） |
| `qr-<ts>.png` | 登入 QR；每次產生都換檔名（同名檔 QML `Image` 不會重載） |

`state.json`（整份每次重寫，沒有增量更新）：

```jsonc
{
  "updatedAt": 1735000000000,          // 心跳，每 30 秒；超過 180 秒算 offline
  "bootId": "…",                       // 這次 daemon 啟動的 id，重啟就換
  "me": { "mid": "u…", "displayName": "…" },   // 未登入時是 {}
  "login": {
    "status": "idle",                  // idle|starting|qr|pin|ok|error
    "qrPng": "…/qr-<ts>.png",          // 只有 status=qr
    "pin": "…",                        // 只有 status=pin
    "error": "…",                      // 只有 status=error，給人看的訊息
    "reason": "…",                     // 選用，status=error 時的分類
    "attempt": "logout",               // 選用；logout|resume|manual，這次狀態屬於哪一種嘗試
    "settled": true                     // 選用；true 代表登入／登出收尾已完成
  },
  "chats": [                           // 未讀在前，其次照 lastTime
    { "mid": "u…", "name": "…", "unread": 0,
      "lastText": "…", "lastTime": 1735000000000, "lastFrom": "u…",
      "avatarPath": "…/media/avatars/<sha1>.jpg",    // 選用，沒有就是沒設大頭貼
      "hidden": true }                               // 選用，只有被隱藏的那幾間才有
  ],
  "chatsRevision": 12,                 // chats／chatList 有變才遞增；心跳不動
  "chatList": { "complete": true, "loaded": 80 }, // 選用；false 代表伺服器還有下一頁
  "timings": {                         // 選用；最近 64 次的 daemon 延遲統計
    "chats.refresh": { "samples": 18, "lastMs": 241.3,
                       "p50Ms": 205.1, "p95Ms": 390.8, "maxMs": 411.2 },
    "cmd.history": { "samples": 6, "lastMs": 92.4,
                     "p50Ms": 88.0, "p95Ms": 131.7, "maxMs": 131.7 }
  },
  "stateBytes": {                      // 選用；state.json 最近 64 次寫入的大小統計
    "samples": 64, "last": 253412,
    "p50": 251190, "p95": 258871, "max": 260112,
    "chats": 80                        // 這份檔案序列化時的 chats 列數
  },
  "link": { "push": "up", "since": 1735000000000 },  // 選用，push 連線狀態
  "refresh": { "at": 1735000000000, "failures": 0,   // 選用，聊天室清單的新鮮度
               "reason": "network" },                //   reason 只在 failures > 0 才有
  "wanted": { "chat": "u…", "at": 1735000000000, "seq": 1 }  // 選用，見下
}
```

`login.reason`、`login.attempt`、`login.settled`、`link`、`refresh` 和 `wanted` 都是選用的：舊的 daemon 不會寫，面板
缺了它們也要照樣畫得出來（`link.push` 是 `"up"` 或 `"down"`，`since` 是這個狀態
從哪一刻開始的毫秒時間戳）。`login.settled: true` 只在登入或登出的 teardown 已完成時
出現；啟動／resume 中途的暫態不帶它，consumer 不可把暫態當成 session 已結束。
`login.attempt` 是 `logout`（使用者按登出後的收尾）、`resume`（開機從 storage 恢復
失敗）或 `manual`（按「登入 LINE」的 QR 嘗試失敗）。凡是 `settled: true` 的終局
teardown，包括登出、任何走到底的 resume（不論失敗原因是 `token_expired`，還是開機時
storage 裡根本沒有 token）、或已建立又失敗的 manual，面板都會清掉上個帳號的
durable 草稿；可重試的暫態失敗（`network`／未分類，或還沒建立就失敗的 manual）則
保留草稿，等下一次登入接續。

`refresh` 說的是**聊天室清單那條路**（talk 請求），跟 `link`（push 連線）是兩件事，
兩者可以一好一壞，所以不併進 `link`，不然又看不出來。`at` 是最後一次
`getMessageBoxes` 成功、`chats` 寫進檔案的毫秒時間戳；`failures` 是從那之後連續
失敗的次數，成功就歸 0；`reason` 只在 `failures > 0` 時存在，分類跟 `login.reason`
同一套（`network`／`token_expired`／`unknown`）。失敗只在進入連錯的那一刻寫進檔案一次
（跟 `link` 的邊寫同一個形狀），之後的計數靠 30 秒心跳帶上去；面板在
`failures >= 2` 時把「清單可能過期」印在清單標題下那一行（一次 30 秒的 timeout
手機熱點下就會發生，單次不跳字），未讀徽章不受影響。登入前沒有這個欄位，登出
會拿掉。stub 每次寫檔都算一次成功，另有一個真 daemon 沒有的 `fail-refresh` 指令
（跟 `poke` 同一個性質）把 `failures` 推上去，讓面板那句話不用等真的斷網也看得到。

`chatsRevision` 只在 `chats` 內容或清單完整性改變時遞增，30 秒心跳不會動它。
`chatList.complete === false` 代表 LINE 回覆 `hasNext`，但目前版本尚未確認
`minChatId`／`maxChatId` 的安全翻頁語意；面板會明確說明只顯示及搜尋已載入的
`loaded` 間聊天室，不會把一次成功刷新誤報成完整清單。

`timings` 是 daemon 記憶體裡的滾動診斷資料，每個項目最多保留最近 64 次，單位都是
毫秒。`chats.refresh` 是完整聊天室刷新，`state.write` 是 state.json 的原子寫入，
`cmd.<name>` 是 socket 指令從讀到完整一行、等候前一條一般指令或共享媒體佇列，到回覆
寫回的總時間。統計在 state 真正寫到磁碟時才取樣，只搭下一次原本就會發生的寫入，
不會為了量測額外喚醒面板；daemon 重啟後重新累積。

`stateBytes` 是同一個滾動視窗量在**序列化後的 byte 數**上：單位是 UTF-8 位元組，
不是毫秒，所以欄位名不帶 `Ms`。取樣在 state 真正寫到磁碟、整份 JSON 文字產生的
那一刻，一次寫入只取樣一次（心跳、刷新、推播摘要全走同一個 `writeState`，不會為了
量測多序列化一份）；跟 `timings` 同一拍，這次寫入自己的大小要等下一次寫入才會
上榜，daemon 重啟後重新累積，剛啟動、視窗還空時整個區塊不存在。`chats` 則是**這份
檔案自己**序列化當下的 chats 列數（含被隱藏的那幾間，它們仍留在檔案裡），跟
滾動統計不同拍，讀的時候當「這份檔案的現況」。要對寫入做任何減量（欄位 diff、
分檔）之前，部署端直接讀這一區塊，拿到的就是實際數字。

`timings` 和 `stateBytes` 都是**選用欄位**：舊 daemon 不會寫，面板對 state.json 的
契約本來就是只讀自己認得的鍵、未知欄位忽略，所以舊面板不受影響。

聊天室那一列的 `hidden` 同理：**只有被隱藏的那幾間才有這個鍵**，沒隱藏的整個不存在
（不是 `false`），舊的面板照樣畫得出來。被隱藏的聊天**仍然留在 `chats` 裡**，因為面板
要靠它做搜尋，只是平常不畫。daemon 在每次寫 state 的當下才蓋上這個鍵，來源是
`hidden.json`；聊天摘要本身的快取不帶它，不然隱藏之後那份快取會一直說著舊答案。

## `wanted`：從通知點進來的聊天室

點桌面通知的時候，daemon 會先寫一筆 `wanted`，再叫 shell 把面板打開。shell 的
IPC 只會 open／close／toggle，沒辦法帶參數，所以「要開哪一間」是走面板本來就在監看的
`state.json`。

- `chat` 是聊天室 mid，`at` 是點下去的毫秒時間戳。
- `seq` 跟 `events` 的一樣，**在同一個 daemon 行程裡嚴格遞增**：面板記住自己處理過的
  那一個，只認比它大的。同一間聊天室連點兩次也是兩筆（`seq` 不同），不會被當成重複。
  `bootId` 換了就代表計數從頭開始。
- 登出會把整個欄位拿掉：指向一間已經開不起來的聊天室，只會讓面板跳到空的對話。
- 欄位不會自己消失，所以面板不能只看「有沒有」，要看 `seq`。

## `events.json`：即時事件

`events.json` 是一個環狀緩衝，**只留最近 200 筆**，跟 `state.json` 分檔寫入。
事件爆量的時候重寫的是這份小檔，`state.json` 不必跟著長大或一直被重讀。
面板記住自己處理到哪個 `seq`，之後只吃比它大的，就不用為了一則新訊息重抓
整頁歷史。

```jsonc
{
  "updatedAt": 1735000000000,
  "bootId": "…",                       // 跟 state.json 的同一個，重啟就換
  "events": [                          // seq 由小到大
    { "seq": 1, "at": 1735000000000, "kind": "message", "chat": "u…",
      "message": { /* 跟 history 回傳的同一個形狀 */ } }
  ]
}
```

- `seq` 在**同一個 daemon 行程裡**嚴格遞增，不重複也不回頭。重啟會從 1 重來，
  所以 `bootId` 換了就代表「這是新的一輪」，面板要把 watermark 歸零。
- `at` 是毫秒時間戳，`chat` 是聊天室 mid（每一種 `kind` 都有，面板可以先照它篩掉
  不是現在這間的事件，不必看 payload）。
- 事件寫檔會**合併**：最密 250 毫秒一次（每秒 ≤ 4 次），一次進來一整串（相簿、
  被拆開的長句）不會讓面板重讀 20 次 events.json。
- 登出會把 `events` 清空（`seq` 不歸零，因為同一個 `bootId` 裡倒退的 seq 是面板唯一
  沒辦法解釋的情況）。
- 檔案只是**補齊**用的慢路：面板連著 socket 的時候，每筆事件先以 `{"event":…,"boot":…}`
  推播幀直接送達（見下），檔案隨後才寫入；斷線期間漏掉的，重連後靠讀檔
  補齊。

| `kind` | 欄位 | 什麼時候發 |
|---|---|---|
| `message` | `message`（跟 `history` 一則訊息完全同一個形狀，已解密、含 mentions／mediaState） | 收到新訊息，或自己送出（LINE 會把自己送出的也推回來，別的裝置送的一樣） |
| `read` | `by`（讀的人 mid）、`upTo`（他讀到的最新訊息 id） | 對方已讀，或自己在別的裝置上讀了 |
| `reaction` | `messageId`、`reactions`（**整串新的**，不是差異） | 有人加、換或收回表情 |
| `unsend` | `messageId` | 有人收回訊息（自己或對方） |
| `edit` | `message`（編輯後的完整訊息） | 訊息被編輯 |
| `history` | `messages`（重新驗證過的整頁） | 本機的訊息庫先回了舊頁、對帳後補上新頁。一筆就是一頁的量，所以同一間聊天室在環裡只留最新一筆，舊的直接丟掉 |

`reaction` 給的是整串而不是差異，因為 LINE 的 op 一次只講一個人的新選擇；daemon 自己
留一份「這則訊息誰選了什麼」，從歷史載入時的 `raw.reactions` 起算，再照 op 移動。
沒被載入過的訊息只能從空的開始算（面板下次載入歷史就會校正回來）。

## Socket 指令

socket 指令（請求一行 JSON，回應一行 `{ok, data?, error?}`）：

| cmd | 參數 | 成功時的 `data` |
|---|---|---|
| `history` | `chat`, `count`（1–200，超界夾住、非數字當 30）, `before?`（往前翻頁的訊息 id）, `markRead?` | 訊息陣列，舊的在前 |
| `send` | `chat`, `text`, `mentions?`, `requestId?` | 無 |
| `reply` | `chat`, `text`, `replyTo`（要回覆的訊息 id）, `mentions?`, `requestId?` | 無 |
| `react` | `chat`, `messageId`, `type` | 無 |
| `unsend` | `chat`, `messageId` | 無 |
| `members` | `chat` | `[{ "mid": "u…", "name": "…" }]`，照名字排序 |
| `sendFile` | `chat`, `path`, `requestId?` | 無（檔案太大或聊天室不支援時回拒絕訊息，見 [usage.zh-TW.md](usage.zh-TW.md#傳檔案與圖片)） |
| `probeClipboardImage` | `chat` | `{ "stage": "clipboard-….png" }`（沒有可送圖片時回中文拒絕） |
| `sendClipboardImage` | `chat`, `stage`, `requestId?` | 無 |
| `discardClipboardImage` | `stage` | 無（探測成功、但第二階段請求無法排入 socket 時釋放暫存） |
| `download` | `chat`, `messageId` | `{ "path": "…" }`（原檔，非縮圖） |
| `preview` | `chat`, `messageId` | `{ "path": "…" }`（畫面上可見圖片的本機縮圖） |
| `image` | `url`（`https://` 的公開圖片） | `{ "path": "…" }`（本機快取檔） |
| `stickers` | `refresh?` | `{ "packages": [ … ] }`，見下 |
| `sendSticker` | `chat`, `packageId`, `stickerId`, `version?`, `requestId?` | 無 |
| `hide` | `chat` | 無（把那一間從清單上拿掉，記在 `hidden.json`） |
| `unhide` | `chat` | 無 |
| `login` | 無 | 無 |
| `logout` | 無 | 無 |
| `sync` | 無 | `{ chats, link, at }` |

## 推播幀

面板連著 socket 的時候，daemon 會主動寫兩種**推播幀**。推播幀沒有 `id`、不對應任何
請求，跟回覆共用同一條序列化寫入通道，所以一行永遠完整：

- `{"event": <event>, "boot": "<bootId>"}`：事件環裡的一筆新事件（`history`
  事件也在裡面）。client 拿 `seq` 對自己的 watermark 去重；`boot` 跟已知的
  `bootId` 不同代表 daemon 重啟過，歸零後從 `events.json` 重新補齊。
- `{"chat": <row>, "chatsRevision": N, "boot": "<bootId>"}`：單一聊天室列
  欄位變動（新訊息的預覽、收回、頭像補上）時整列推過來。`chatsRevision` 是它的
  水位線。同一欄位的檔案寫入如果帶著更舊的 revision 抵達，直接丟掉，不能
  蓋回已推播的新值。整列重建（refresh 輪、登出）不推，照舊由 `state.json` 收口。
  這種幀不進事件環、不帶 `seq`。

不認得推播幀的舊 client 只讀 `id` 對應的回覆，多出的行被忽略，行為不變。推播寫
不出去或對端讀太慢時 daemon 直接關掉這條連線，面板重連後靠 `events.json` 和
`state.json` 補齊。

未登入時除了 `login`、`logout`、`hide`、`unhide`、`discardClipboardImage` 以外都回
`{ok:false, error:"尚未登入"}`；認不得的 cmd 回 `unknown cmd: <cmd>`。
`hide`／`unhide` 在門檻之前：它只寫我們自己的檔案、不碰 LINE，沒有理由因為 session
還沒接上就拒絕。兩個都是**冪等**的（已經隱藏的再隱藏一次照樣 `{ok:true}`，只是不寫
檔），`chat` 是空的則回 `{ok:false, error:"沒有指定是哪一間聊天室"}`。

`history` 先回文字與訊息資訊，不等待圖片下載；ListView 建立到畫面附近的圖片列時才送
`preview`。`image`、`preview` 與原檔 `download` 共用全 daemon 最多四筆的背景通道，回覆仍靠 `id`
對應，所以可能比後送出的互動指令晚回來。傳訊息、回覆、收回等會改變狀態的指令仍照
接收順序執行。

五個傳送指令的 `requestId` 是選用的非空字串。daemon 會把它放進 LINE 訊息的
`contentMetadata`，並在之後的 history 或 message event 以同名欄位原樣回傳。面板替每次
傳送產生唯一值；socket 在 LINE 已接受訊息後斷線時，就能用這個值精確確認結果，不以
相同文字或時間猜測。其他 client 可以省略，省略時 history 訊息也沒有這個欄位。

## 草稿與未確認的傳送

未送出的文字、提及、回覆目標與游標位置存於
`$XDG_STATE_HOME/enil/panel-drafts.json`，以帳號及聊天室分開；每次編輯立即排入原子寫入，
寫入進行中時只保留後續最新快照，切換聊天室、關面板或重啟 shell 都能還原。斷線後尚未確認的 `requestId` 與樂觀
訊息也存在同一檔案，切換聊天室或重啟面板後仍會顯示並繼續精確核對。收到送出成功的
回覆，或斷線後在 history／message event 看到完全相同的 `requestId`，才刪除該次傳送
對應的草稿；送出失敗或尚未精確確認時仍保留。daemon 重啟期間的 `starting` 與可重試的
網路 `error` 不會被當成登出；明確進入 `idle`，或已結束且無法重試的 session 錯誤，
才會清除該帳號的草稿與未確認傳送。

## 指令細節

回應**一定寫得完整**：daemon 是用 `writeAll` 一路寫到最後一個位元組，不是靠一次
`conn.write`。unix socket 一次只吃得下緩衝區塞得下的量（實測 219264 位元組），
`stickers` 這種十幾萬位元組的回應會被截斷，而且不會有任何錯誤，面板只會等一個永遠
不會來的換行。萬一回應本身編不成 JSON（例如混進 BigInt 或循環參照），daemon 會回
`{ok:false, error:"回覆無法編碼"}` 並在 journal 留一行
`[cmd] <cmd> reply unserializable: <錯誤類別>`，值本身不進 journal。

`sync` 是手動同步：重建 push 連線（不等它完成）並重抓聊天列表。回報的一定是**收到這個
請求之後**才跑完的那一輪，剛好有一輪在飛就先等它結束。`chats` 是抓回來的
聊天室數量、`link` 是**同步開始當下**的 push 狀態（`"up"`／`"down"`；重建一開始就會把
狀態設成 down，回報之後的值等於每次都說 down）、`at` 是完成時間的毫秒時間戳。抓失敗時
回 `{ok:false, error:"同步失敗：…"}`，後半是給人看的原因。

`members` 是 @ 用的群組成員名單，只有群組（`c…`）和 room（`r…`）能問；1:1（`u…`）回
`{ok:false, error:"這不是群組，沒有成員名單"}`。名單裡不含自己。daemon 快取十分鐘，
所以同一間聊天室來回開關只會真的抓一次。room 的名單多半拿不到，那時回
`{ok:false, error:"多人聊天室（room）拿不到成員名單"}`。面板不跳橫幅，等使用者真的
打了 `@` 才在選單裡說原因。

`image` 拿的是一張**公開**圖片的本機檔：daemon 抓進 `media/public-images/`（合併、
上限與清掃見 [architecture.zh-TW.md](architecture.zh-TW.md#公開圖片)），回 `{ "path": "…" }`，面板只讀 `file://`。只收
`https://`、不帶帳號密碼、回應的內容型別要是 `image/`，重導最多五次而且每一跳都得是
`https://`；任何一項不成立或抓不回來都回 `{ok:false, error:"圖片下載失敗"}`。面板
不會改成自己去連 HTTPS，那正是這支指令要避開的那條路。

`send`／`reply` 不指定要不要加密，交給 LINE 決定：先照明文送，對方要求加密時才由
linejs 自己改用 E2EE 重送一次（`mentions` 和引言都跟著過去）。反過來硬指定加密的話，
對方把 Letter Sealing 關掉時金鑰查詢會直接回 `E2EE_RETRY_PLAIN`，訊息連送都送不出去。

`reply` 就是帶引言的 `send`：一樣的 `mentions` 驗證、一樣的加密、一樣的拒絕，只多一個
`replyTo`。少了它回 `{ok:false, error:"沒有指定要回覆哪一則訊息"}`。不擋的話訊息還是
送得出去，只是變成沒有引言的普通訊息，等於默默吃掉使用者挑的那一則。

`react` 的 `type` 是 LINE 的六個預設表情
`NICE`／`LOVE`／`FUN`／`AMAZING`／`SAD`／`OMG`，外加把自己的收回來的 `UNDO`；
其他一律回 `{ok:false, error:"不支援的表情"}`。一個人在同一則訊息上只會有一個表情，
再送一次就是換掉，不是疊加。

## 貼圖

`stickers` 是這個帳號**自己擁有**的貼圖包，照貼圖小舖給的順序，最多 100 個：

```jsonc
{ "packages": [
  { "id": "1",                      // 貼圖包編號（十進位）
    "name": "饅頭人&詹姆士",
    "version": 3,                   // STKVER；小舖沒給就是 0
    "stickers": [
      { "id": "4",
        "url": "https://stickershop.line-scdn.net/stickershop/v1/sticker/4/android/sticker.png",
        "animated": false }
    ] }
] }
```

daemon 快取一小時，`{"cmd":"stickers","refresh":true}` 會重抓（同一刻只會有一輪在跑，
兩個面板同時開不會變成兩倍的請求）。清單來自 LINE 貼圖小舖的
`getOwnedProductSummaries`，但**那支 API 不回貼圖 id**，所以每個貼圖包的貼圖是再去抓
公開的 `productInfo.meta`（不需要登入）。抓不到的那個貼圖包 `stickers` 會是**空陣列**。
帳號確實有這個貼圖包，只是這次讀不到，讓它從清單裡消失只會更難解釋。`animated` 是
**整包**的性質不是單張的：LINE 的 JSON 沒有逐張的旗標，收到的貼圖也只有 `STKOPT`。
`url` 跟收到的貼圖走同一條 CDN 路徑，面板兩邊可以共用同一段畫圖的程式。登出會把快取
清掉，因為換一個帳號就是換一批貼圖包。

小舖那邊出事分兩句：請求本身失敗（連不上、Thrift 丟例外）是
`{ok:false, error:"貼圖清單讀不到：<原因>"}`；回來的東西**根本不是一份清單**（該有
list 的欄位不是陣列、或整包不是物件也不是陣列）是
`{ok:false, error:"貼圖清單格式不對"}`，`sendSticker` 也用同樣兩句。分兩句是因為
「讀不到」會讓人去看自己的 Wi-Fi，而那時候封包其實好好地回來了。**欄位不存在不算
出事**：Thrift 沒東西可放的欄位是整個省略的，所以一個貼圖包都沒有的帳號、以及剛好
滿頁之後的下一頁，回來的都是「沒有那個欄位」的物件，那是空的一頁不是壞掉的小舖。
以前這兩種一律當成空清單，結果是選單開起來空的、還被快取一小時，而且哪裡都沒有一句
話。

`sendSticker` 送出一張貼圖。`packageId`／`stickerId` 是十進位編號，`version` 選用
（不給就用清單裡那一包的 `version`）。編號形狀不對回
`{ok:false, error:"貼圖編號不對"}`，貼圖包不在自己的清單裡回
`{ok:false, error:"這個貼圖包不在你的貼圖清單裡"}`。LINE 對 metadata 照單全收，
擋不下來的話對方收到的是一顆放不出圖的空泡泡，而且收不回來。**不檢查**那張貼圖在不在
那一包裡：`stickers` 是空的那幾包本來就沒得檢查，擋下來等於把 daemon 讀不到清單這件事
算在使用者頭上。貼圖**不走 E2EE**（內容就是 metadata，而 metadata 本來就不加密），
送出之後跟 `send` 一樣由 LINE 把自己送出的推回來，面板收到的是 `message` 事件。
整包是動態的（`animated`）就多帶一個 `STKOPT: "A"`，靜態的那幾包整個欄位不帶。
linejs 的 `getStickerURL()` 只有看到這個值才給 `sticker_animation.png`，不帶的話連
自己推回來的那則都是不會動的那一格。面板畫的時候再換回靜態網址：APNG 在 Qt 裡只
畫得出第一格，一張卻要幾百 KB。

`unsend` 只收得回**自己傳的**訊息，別人的回
`{ok:false, error:"只能收回自己傳的訊息"}`；daemon 是從自己的游標表看送出者的，
不必為了拒絕先去問 LINE。沒在快取裡的回「訊息不在快取裡」。收回成功之後 LINE 會把
`DESTROY_MESSAGE` 推回來，面板收到的是 `unsend` 事件，daemon 不會自己補一筆。

`send` 的 `mentions` 是選用的，`[{ start, end, mid }]` 或 `[{ start, end, all: true }]`：

- **`start`／`end` 是 `text` 的 UTF-16 code unit 位移，半開區間 `[start, end)`。**
  一個中日韓字算 1，BMP 以外的表情符號（surrogate pair）算 2，也就是 JavaScript
  `String` 的 `length` 和 `substring` 用的那個單位，兩邊都是 JS，誰都不用換算。
  這是 LINE 自己的單位：linejs 用 `parseInt` 讀 `MENTIONEES` 的 `S`／`E` 再交給
  `String.prototype.substring`。
- `mid` 是 `u` + 32 個小寫十六進位字；`all: true` 是 @全部，不帶 mid。
- daemon 會驗：不是整數、超出 `text` 範圍、頭尾顛倒、mid 形狀不對、或跟前一段重疊的
  **整筆丟掉**，其餘照送。壞掉的 mention 只賠上自己那一個標記，不會害整句話送不出去。
- daemon 把它組成 LINE 的 `contentMetadata.MENTION`。這段 metadata **不加密**（E2EE
  只加密本文），所以位移描述的是對方解密後看到的那串字。

## 訊息格式

`history` 回傳的訊息（欄位沒值時是整個不存在，不是 `null`）：

| 欄位 | 型別 | 何時有 |
|---|---|---|
| `id` | string | 一律 |
| `chat` | string | 一律，就是請求裡的 `chat` |
| `from` | string | 一律，送出者 mid（來源缺漏時是空字串） |
| `fromName` | string | 一律，解不出名字就退回 mid |
| `text` | string | 一律；解不開的 E2EE 是空字串 |
| `time` | number | 一律，毫秒 |
| `contentType` | string | 一律；`NONE`／`IMAGE`／`VIDEO`／`STICKER`／`FLEX`… |
| `decryptFailed` | boolean | 一律；E2EE 沒解開時為 `true` |
| `hasMedia` | boolean | 一律；已收回的訊息一律 `false` |
| `unsent` | boolean | 一律；對方收回的訊息為 `true`，`text` 是「已收回訊息」 |
| `mediaState` | string | 一律；`ok`／`unsent`／`expired`，附件打不開的原因 |
| `expiresAt` | number | `FILE` 的 metadata 有 `FILE_EXPIRE_TIMESTAMP`；毫秒 |
| `previewable` | boolean | 附件可用低成本縮圖；目前是 `IMAGE` 與有獨立縮圖的 `VIDEO`。縮圖不隨 history 走：可預覽的那幾則由面板再送 `preview` 換本機路徑 |
| `altText` | string | `FLEX` 且拆得出版面 |
| `flexImages` | string[] | 同上，只收絕對 `https://` 圖片 |
| `stickerUrl` | string | `STICKER` 且 metadata 有 `STKID` |
| `fileName` | string | metadata 有 `FILE_NAME` |
| `fileSize` | number | metadata 有 `FILE_SIZE` |
| `mentions` | object[] | 訊息 metadata 有 `MENTION`；`{ start, end, name, mid? , all? }`，位移單位同上，`all` 的 `name` 是「全部」 |
| `replyTo` | object | 這則是回覆（`messageRelationType` 是 `REPLY`）；`{ id, fromName?, text? }` |
| `reactions` | object[] | 這則有表情；`[{ type, count, mine }]`，照 LINE 列舉的順序 |
| `readBy` | object | **只有自己傳的**訊息才有；`{ count, all }` |
| `fromAvatar` | string | 送出者有大頭貼而且已經抓下來了；本機檔案路徑 |
| `requestId` | string | 傳送請求帶了非空 `requestId`，而且 LINE 保留了該 metadata |

`replyTo` 的 `fromName`／`text` 是**盡力而為**：LINE 不會把被引用的那則跟著送過來，
每一則都去補抓等於一個泡泡一趟往返，所以 daemon 只從自己這輪渲染過的訊息裡查
（最近 500 則，`text` 截到 200 字）。查不到就只有 `id`，面板照樣要畫得出來
（畫成一行「回覆訊息」就好）。

`reactions` 的 `mine` 是「自己有沒有選這一個」。同一則訊息上一個人只算一次，
所以 `count` 加起來就是有多少人按過。

`readBy` 的 `count` 是「除了自己以外，已經讀到這則的人數」，`all` 是「daemon 知道的
人都讀到了」。1:1 就是對方讀了（畫成「已讀」），群組是還沒到齊（畫成「已讀 N」）。
分母是 `getMessageReadRange` 回報有 range 的成員（扣掉自己）。什麼都不知道的時候
**整個欄位不存在**，不是 `count: 0`，因為不能把「不知道」畫成「沒人讀」。開聊天室時抓
一次，之後靠 `read` 事件更新。

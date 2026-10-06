# LINE for Omarchy

[![ci](https://github.com/frankekn/omarchy-line/actions/workflows/ci.yml/badge.svg)](https://github.com/frankekn/omarchy-line/actions/workflows/ci.yml)

[English](README.md)

Bar 上的 LINE 未讀數，點開可以搜尋聊天室、讀訊息、回訊息、傳檔案。

| ![中文介面與對話——mention、表情、已讀、收回、過期檔案](docs/screenshot-zh.png) | ![英文介面——FLEX 部署卡、引言回覆、檔案與影片附件](docs/screenshot-en.png) |
| :-: | :-: |
| 中文介面與對話 — mention、表情、已讀、收回、過期檔案 | 英文介面 — FLEX 部署卡、引言回覆、檔案與影片附件 |

這個 repo 有兩半：

- **外掛**（`Panel.qml`、`LinePanel.qml`、`LineWindow.qml`、`manifest.json`，加上
  `EventLog.js`／`PanelKit.js`／`DraftStore.js` 三個 `.pragma library`）—— omarchy
  bar 的 QML widget，不碰 LINE，只讀一個本機 JSON 檔和連一個本機 unix socket。
  事件/訊息合併邏輯在 `EventLog.js`，純 UI 輔助函式在 `PanelKit.js`，草稿存取在
  `DraftStore.js`；`Panel.qml` 本身只剩狀態機、socket/FileView 接線和畫面。
- **daemon**（`daemon/daemon.ts`）—— 真正登入 LINE 的那一半。LINE 的 refresh token
  每次登入都會換，所以同時只能有一個 process 拿著它。

daemon 沒在跑的時候，面板顯示 `DAEMON OFFLINE`（判準是 `state.json` 的 `updatedAt`
超過 3 分鐘沒更新）。

> 這是非官方 client（走 `@evex/linejs`）。LINE 沒有開放個人帳號的 API，用它有帳號
> 被限制的風險，自己斟酌。

## 安裝

外掛：

```bash
omarchy plugin add https://github.com/frankekn/omarchy-line.git --enable
```

裝好之後 repo 就在 `~/.config/omarchy/plugins/io.github.frankekn.line/`，daemon 在
它底下的 `daemon/`。

**接著一定要補這一行。** LINE 協定那半是本 repo 自己的 linejs fork，放在
`daemon/vendor/linejs`（git submodule，理由見[這個 repo 的改動](#這個-repo-的改動)），
而 `omarchy plugin add` 只是一次普通的 `git clone`，不帶 submodule：

```bash
git -C ~/.config/omarchy/plugins/io.github.frankekn.line submodule sync -- daemon/vendor/linejs
git -C ~/.config/omarchy/plugins/io.github.frankekn.line submodule update --init
```

第一行同步 submodule 的 remote 設定；第二行抓取 pin 住的版本（公開 fork `frankekn/linejs`）。
沒補的話 daemon 一起手就是 `Module not found ".../vendor/linejs/..."`。
`omarchy plugin update` 同樣只 fast-forward 主 repo，所以每次更新後都要再跑這兩行。

貼圖、貼圖選擇器與 FLEX 圖片（含燈箱）由 daemon 下載到
`$XDG_STATE_HOME/enil/media/public-images`（預設 `~/.local/state/enil/media/public-images`），
QML 只讀本機圖片，避免這些圖片請求進入 quickshell 的 Qt TLS。
同一網址的下載會合併，最多同時下載 4 張，每張上限 10 MiB、逾時 20 秒，
快取沿用媒體的定期清理政策。下載失敗不退回 QML HTTPS。
更新時須一併更新面板與 daemon，並重新啟動 daemon 及重新載入外掛。

daemon 需要 [Deno](https://deno.com) 2（`sudo pacman -S deno`）。相依套件寫在
`daemon/deno.json` 的 import map，第一次執行會自己抓：

| 套件 | 用途 |
|---|---|
| `daemon/vendor/linejs`（submodule） | LINE 協定、登入、E2EE —— 本 repo 的 linejs fork |
| `jsr:@std/streams` | socket 的逐行讀取 |
| `npm:qrcode` | 把登入 QR 寫成 PNG |
| `npm:thrift`、`npm:crypto-js`、`npm:tweetnacl` 等 | fork 自己的相依，版本照抄它的 `deno.json` |

fork 的 bare import 是拿**進入點**的設定檔來解的，所以那串相依要寫在
`daemon/deno.json` 裡，不是 fork 裡那份。`nodeModulesDir` 是 `"none"`：npm 那幾個直接
從 deno 的全域快取解，外掛資料夾裡不會多出 `daemon/node_modules/`。fork 自己的設定寫
`"auto"`，但那是給它的 workspace 用的，我們這邊不需要 —— 整包 client（含 thrift、
crypto-js 那些 CommonJS）在 `"none"` 底下 import 得起來。

先在前景跑一次確認能動：

```bash
cd ~/.config/omarchy/plugins/io.github.frankekn.line/daemon
deno run -A daemon.ts
```

沒問題就交給 systemd user unit：

```bash
cp ~/.config/omarchy/plugins/io.github.frankekn.line/daemon/enil.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now enil
```

unit 的 `WorkingDirectory` 指到**安裝目錄**底下的 `daemon/`，所以

`ExecStart` 跑的是 `enil-run.sh`：它先看同目錄有沒有 `deno task build`
產生的 `enil` 執行檔，而且 `enil.rev` 裡的 commit 要跟現在的 checkout 一致、
`daemon.ts` 不能比 binary 新，才用編譯好的那隻；否則一律退回
`deno run -A daemon.ts`。所以 `omarchy plugin update` 之後絕對不會吃到舊
binary —— 它只是退回解譯模式，等你下次 build 再快起來。

編譯是**選配**（機器上還是要有 Deno 才能 build）：

```bash
cd ~/.config/omarchy/plugins/io.github.frankekn.line/daemon
deno task build    # 產生 ./enil（約 114MB）+ ./enil.rev
```

好處是重啟快 ~20ms、跑起來後不依賴 Deno runtime；不 build 也完全能用，行為
一模一樣。
`omarchy plugin update` 會一起更新外掛和 daemon，不必再複製一次。日誌：

```bash
journalctl --user -u enil -f
```

### 從零安裝 checklist

一台乾淨的機器照這個順序走，中間任何一步失敗都不要跳過：

1. Omarchy 的 bar 在跑，而且你人在圖形 session 裡 —— systemd **user** unit 要有它才起得來。
2. `deno --version` 有輸出（Deno 2）。沒有就 `sudo pacman -S deno`。
3. `command -v zenity` 有輸出。沒有就 `sudo pacman -S zenity` —— 傳檔用的檔案選擇器，
   Omarchy 不會預裝。順便（可裝可不裝）：`ffmpegthumbnailer` 或 `ffmpeg` 讓送出的
   影片有預覽圖，`wl-clipboard` 讓剪貼簿裡的圖片可以直接送。兩者都是沒裝就少那個
   功能，不會擋住任何東西。
4. `omarchy plugin add https://github.com/frankekn/omarchy-line.git --enable`。
5. `git -C ~/.config/omarchy/plugins/io.github.frankekn.line submodule sync -- daemon/vendor/linejs`，接著執行
   `git -C ~/.config/omarchy/plugins/io.github.frankekn.line submodule update --init`
   —— 這步要連得上 GitHub。做完 `daemon/vendor/linejs/packages/` 底下要有檔案，
   空的就是沒抓到，別往下走。
6. `omarchy plugin validate ~/.config/omarchy/plugins/io.github.frankekn.line` exit 0。
7. 第一次 `deno run -A daemon.ts` 需要連得上網 —— 相依套件是那時候才從 JSR／npm 抓的。
8. 前景跑起來後確認 `~/.local/state/enil/` 出現了，`state.json` 的 `updatedAt` 在動。
9. 目錄權限：state 目錄 700、`storage.json` 600。不對就 `chmod 700 ~/.local/state/enil`、
   `chmod 600 ~/.local/state/enil/storage.json`。
10. 手機拿在手上，再按面板的「登入 LINE」—— QR 有時效，沒人掃就只是留下沒用的憑證。
11. 掃完輸入面板顯示的 PIN，`login.status` 變 `ok`，bar 圖示的 `!` 消失。
12. Ctrl-C 收掉前景那隻，改用 systemd unit（上面那三行），`journalctl --user -u enil` 看一次沒有紅字。

### 解除安裝

```bash
systemctl --user disable --now enil
rm ~/.config/systemd/user/enil.service && systemctl --user daemon-reload
rm -rf ~/.local/state/enil          # 憑證、快取、state 都在這裡
omarchy plugin remove io.github.frankekn.line
```

刪掉 state 目錄等於在這台機器上登出，下次要重掃 QR。手機端的「登入中的裝置」清單
要另外自己去移除。

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
去掃整份 122+ 個 box。登入、重連、手動同步、已讀回執、改名、一輪爆量（超過 8 間）或
增量輪自己失敗時，才退回完整的 `getMessageBoxes` 重抓——未讀數唯一的伺服端來源在那裡，
全量輪永遠是校正者。這條路可以用環境變數 `ENIL_INCREMENTAL=0` 整條關掉（預設開啟），
關掉之後每一輪都走原本的完整重抓。

push 活著的時候不需要等這些：新訊息、已讀、表情和收回都會在一秒內進到事件環，
面板開著時 daemon 從已連線的 socket 直接推過來（見「契約」的推播幀），連檔案
寫入節流都不用等；socket 斷線時照舊靠 FileView 讀 `events.json` 補上。斷線
期間發生的事只會留在 LINE
那邊，重連之後靠重抓聊天列表和歷史補回來 —— `events` 只有最近 200 筆，而且 daemon
一重啟就從頭算（`bootId` 會換），所以它是「快」的那條路，不是唯一的那條路。

## 登入與登出

第一次登入不需要終端機。面板未登入時會出現「登入 LINE」按鈕 —— 按下去 daemon 才產生
QR（QR 需要有人拿手機在旁邊，自動產生只會留下沒人掃的憑證），面板直接顯示 PNG，
手機掃完再顯示要輸入的 PIN 碼。

登出在面板裡按「登出」。它會關掉 session 並刪掉憑證，下次要重掃 QR。

憑證與 E2EE 金鑰存在 `~/.local/state/enil/storage.json`（`chmod 600`，整個 state 目錄
`chmod 700`）。**這個檔案等於你的 LINE 帳號，不要備份到任何地方。**

## 功能

- Bar 圖示顯示未讀總數，顏色跟隨 bar 的其他圖示；未登入時顯示 `!`
- 聊天室清單，未讀在前，**打字即搜尋**（開啟時焦點就在搜尋框），搜尋也比對訊息預覽
- 對話檢視：E2EE 已解密、圖片直接顯示（點擊用 `xdg-open` 開原圖）、貼圖當圖片顯示、
  影片縮圖、FLEX 版面顯示 `ALT_TEXT` 與 carousel 圖片、系統事件與日期分隔線
- **訊息可以選取、複製，連結可以點**：拖曳選字、Ctrl+C 複製選取的部分、右鍵選單複製
  整則或複製／開啟連結，連結是強調色加底線、滑過去變成手指游標
- 回訊息：Enter 送出、Shift+Enter 換行；`📎` 或 `/file <路徑>` 傳檔案，
  `Ctrl+V` 把剪貼簿裡的圖片直接送出（裡面是文字就照樣貼進輸入框）
- **群組裡打 `@` 會跳出成員選單**：邊打邊篩、↑↓ 選、Enter／Tab 或滑鼠點下去插入
  `@顯示名稱`，Esc 收掉。送出時會帶上 LINE 的 mention metadata，被 @ 的人手機上是
  真的通知。收到的訊息裡被 @ 到的名字（含 `@All`）用強調色標出來。1:1 沒有這個選單。
- **新訊息會自己出現**（面板開著時是即時）：連著 socket 的面板直接收 daemon
  推來的事件幀；離線追上靠讀 `events.json`，只吃比自己 watermark 新的那幾筆，
  不再為了一則訊息重抓整頁歷史。daemon 重啟過、或事件多到把環狀緩衝繞過去了，
  面板才會重抓一次補齊。
- **自己傳的訊息底下會顯示已讀**：1:1 是「已讀」，群組是「已讀 3」，人都讀完了才變成
  「已讀」。什麼都還不知道的時候那一行不存在 —— 不會把「不知道」畫成「沒人讀」。
- **回覆某一則**：右鍵選單的「回覆」，輸入框上面會出現一條引言（✕ 或 Esc 收掉，
  打到一半的字留著），送出時對方看到的就是帶引言的回覆。收到的回覆泡泡上面會有一行
  灰色引言，點下去跳回原訊息（不在這一頁就說一聲）。
- **表情反應**：右鍵選單最上面一排六個 emoji，對應 LINE 的
  `NICE`／`LOVE`／`FUN`／`AMAZING`／`SAD`／`OMG`（👍 ❤️ 😆 😲 😢 😱）。點下去就送出，
  訊息底下會出現一排「emoji 數字」；自己選的那個描邊，再點一次就是收回。一個人在同一則
  訊息上只會有一個表情，換一個就是換掉。
- **收回自己傳的**：右鍵選單的「收回」（只有自己的訊息才有這一項），收回後那一則當場
  變成斜體的「已收回訊息」，附件、貼圖、表情一起消失。LINE 只讓收回 24 小時內的，
  超過的話 daemon 的拒絕會顯示在橫幅上。
- **面板關著的時候有新訊息會發桌面通知，而且長得像一則聊天通知**：圖示是對方（群組
  就是群組）的大頭貼，**點下去會把面板打開並直接跳進那間聊天室**。同一間聊天室兩秒內
  只發一則，自己送的訊息不發。面板認的是 `wanted` 的 `seq`：同一次點擊只跳一次
  （心跳會把同一份 state 重寫很多遍），同一間連點兩次是兩次跳。寫檔通常比 shell 的
  「開面板」早到，那一刻面板還沒開就先記著，等面板真的開了再跳。詳見下面的「通知」。
- **清單和訊息泡泡有大頭貼**：daemon 抓聊天列表或訊息的時候順便把圖抓回本機快取，
  欄位是 `avatarPath`／`fromAvatar`。畫成圓形；沒設大頭貼、還沒抓到（欄位整個不存在）
  或檔案已經不在了，就退成一顆寫著名字第一個字的圓，底色照 mid 挑 —— 同一個人每次
  都是同一個顏色。群組裡別人的訊息只有「同一個人連著講的那一串的第一則」旁邊有臉，
  自己送的和 1:1 都不畫。
- **隱藏聊天**：在清單那一列按右鍵 →「隱藏聊天」，那一列就從清單上消失；再要找它，
  **在搜尋框打字**，它會出現在結果最後面並標一行「已隱藏」，同一個右鍵選單這時變成
  「取消隱藏」。隱藏之後那間聊天**有新訊息也不會自己跑回來**、**不發桌面通知**、
  未讀也不算進 bar 圖示上的數字 —— 要回到清單只有手動取消隱藏一條路。搜尋結果裡的
  那一列**左鍵照樣點得開**，開了就待到自己離開為止（不然搜尋等於找得到打不開）；
  「正在看的那間被隱藏會退回清單」指的是停在裡面的時候才被隱藏的那一種。
  隱藏是**這台機器上的偏好**，不上傳 LINE：LINE 的 `updateChat` 沒有這一格
  （ChatAttribute 只有名稱、圖片、通知設定、我的最愛），所以協定上根本沒有地方放它，
  手機上不會跟著隱藏。daemon 記在 `~/.local/state/enil/hidden.json`。
  （不是「退出聊天」—— 那是 `deleteSelfFromChat`，會真的離開群組，每台裝置都退。）
- 進入聊天室自動標為已讀（正在看的聊天室收到新訊息也會即時標掉）
- **貼圖選單**：輸入框旁邊的 `😊` 打開，上面一排是最近用過的 16 張，接著是自己
  帳號的貼圖包分頁（照貼圖小舖給的順序），底下是那一包的貼圖格子（最多四列，
  再多就在格子裡捲）。點一張就送出，選單跟著收起來，泡泡當場出現。`Esc` 或
  點選單以外的地方收掉，`⟳` 叫 daemon 重抓一次清單（買了新貼圖包不必重開面板）。
  五十幾個貼圖包一列放不下，所以**分頁列跟最近用過的那一排都吃滾輪**，垂直滾輪
  橫著捲（橫向的 Flickable 自己不吃滾輪，滑鼠又沒有橫向手勢，2.7.0 只有用拖的
  捲得動 —— 等於右邊那些貼圖包都點不到）。放不下的時候兩端會出現 `‹` `›`，按下去
  捲一格，沒有滾輪的裝置走這條。換貼圖包（點分頁、`←`／`→`）之後那一格一定會被
  捲進畫面裡。
  動態貼圖一律畫靜態那張（選單、自己送出的泡泡、收到的那些都是）：APNG 在 Qt 裡
  本來就只畫得出第一格，而一張要幾百 KB。會動的是收到的人那邊 —— daemon 送出時
  帶 `STKOPT`。最近用過的那一排**記在 `~/.local/state/enil/panel-stickers.json`**
  且照帳號分開，換帳號就是換一排。收到的貼圖一樣直接當圖片顯示
  （`stickers`／`sendSticker` 兩個指令見「契約」）。
- **捲到頂自動載入更舊的訊息**，捲動位置不會跳
- 訊息用 `ListView` 畫，只生成看得見的那幾則，幾百則的聊天室也捲得順；日期分隔線是
  「今天／昨天／9月5日／2025年12月31日」，開聊天室時還沒讀的那一則之上會有一條
  **未讀訊息** 分隔線

## 通知

面板**沒開**的時候才發（面板開著等於訊息已經在畫面上了），一間聊天室兩秒內只發一則
（相簿、被拆開的長句都是一次進來一串），自己送的不發。

通知長成這樣：

- **標題**是聊天室（1:1 就是對方），**內文**在群組裡是「誰：說了什麼」，1:1 就直接是
  內容；非文字的用 `[圖片]`／`[貼圖]`／`[影片]`／`[語音]`／`[檔案]` 代替。
- **圖示**是那間聊天室的大頭貼。還沒抓到的話最多等三秒就先發出去，寧可沒有圖示也不要
  讓通知遲到。
- **點下去會開面板並跳進那間聊天室**。做法是 `notify-send --action=default=開啟`：
  omarchy 的通知外掛在點擊時會去叫名字剛好是 `default` 的那個 libnotify action
  （`shell/plugins/notifications/Service.qml:376`），叫不到才退回「用視窗 class 去
  focus 送通知的程式」—— 而這個面板是 layer surface，根本沒有視窗可以 focus。
  daemon 收到點擊之後寫一筆 `state.wanted`（見「契約」），再 `omarchy-shell
  io.github.frankekn.line open`。
- libnotify 的 action 只有在**送通知的行程還活著**的時候叫得動，所以 `notify-send`
  會一直留著（`--action` 本來就隱含 `--wait`），直到通知被關掉為止；十分鐘沒動靜就
  自己收掉，免得一則沒人理的通知留下一個永遠不死的行程。

`notify-send` 不在的話，第一次就會在 journal 留一行
`[notify] notify-send not found; notifications disabled`，之後不再重複，其他功能不受
影響（`libnotify` 套件，Omarchy 預設有）。通知的內容**不會**進 journal。

## 鍵盤操作

```
清單    打字搜尋   ↑↓ 選取   Enter 進入
        Esc 清空搜尋，搜尋框空的時候 Esc 離開輸入框，再 Esc 關閉面板
        離開輸入框後 L 選到「登出」，再 Enter／空白才真的登出
        離開輸入框後 r 立刻同步（等同按「同步」，不用再確認）
聊天室  焦點在輸入框   Enter 送出   Shift+Enter 換行   /file <路徑> 傳檔案
        Ctrl+V 剪貼簿裡是圖片就直接送出，是文字才貼進輸入框
        Esc 一層一層退：先關貼圖選單，再關 @選單，再收掉引言（草稿留著），再離開輸入框
        離開輸入框後 / 回清單搜尋，或再 Esc 回清單；r 一樣可以同步
@選單   在群組裡打 @ 就會跳出來，繼續打字就是篩選（比對顯示名稱，不分大小寫）
        ↑↓ 選人   Enter 或 Tab 插入   Esc 收掉選單（打到一半的字留著）
貼圖    😊 開關（再按一次收起來）   點一張就送出   Esc 或點選單以外的地方收掉
        滾輪橫著捲分頁列（放不下時兩端有 ‹ ›，按了也是捲）   ⟳ 重新抓一次貼圖清單
        離開輸入框後 ←→（或 h/l）換貼圖包，↑↓ 一樣是捲訊息的；焦點還在輸入框
        的時候 ←→ 是移游標，選單只收 Esc
訊息    在訊息上按住左鍵拖曳選字   Ctrl+C 複製選取   Ctrl+Shift+C 複製整則
        Esc 焦點回到回訊息的框（反白跟著消失）
燈箱    ←→（或 h/l）上一張／下一張   滾輪縮放   拖曳平移   雙擊 1×/2×
        o 用外部程式開（面板會關掉；`App window` 模式不會）   Esc 或點空白處關閉燈箱
```

滑鼠：訊息上左鍵拖曳選字，點連結用預設瀏覽器開（`xdg-open`），右鍵開選單
（六個表情排在最上面一列，然後是複製訊息／複製連結／開啟連結／回覆／收回；連結那兩項
只有右鍵真的壓在連結上才出現，回覆只有真的指得到一則訊息才有，收回只有自己傳的才有）。
圖片、貼圖、附件那幾種沒有文字泡泡的訊息，右鍵一樣按得出這個選單。訊息底下的表情點下去
是加、點自己那個是收回；回覆泡泡上面的引言點下去跳回原訊息。點訊息以外的
空白處會把反白清掉、焦點還給回訊息的框，所以選過字之後可以直接繼續打字。開連結跟開檔案
同一條規則：貼齊 bar 和置中這兩種 overlay 會先把面板收掉（不然瀏覽器會被壓在下面），
`App window` 模式不會。只有 `http://` 和 `https://` 會開，其他一律拒絕並顯示
「這個連結打不開」。

複製用的是 **wl-copy**（`wl-clipboard` 套件）：訊息內容只走 stdin，不會變成命令列的
一部分。它不在 `omarchy` 的相依清單裡，但 omarchy 自己的剪貼簿外掛和網路面板都在用，
所以正常環境都有；真的缺了的話按複製會顯示「複製失敗：系統裡找不到 wl-copy」，
`sudo pacman -S wl-clipboard` 裝完立刻可用。

貼圖選單開著的時候 Esc 只收選單，聊天室不會跟著退回清單 —— 它是疊在最上面的
那一塊（燈箱除外）。換聊天室、離開對話、登出都會把它收掉：挑到一半換了聊天室，
下一張就會送錯間。

燈箱開著的時候 Esc 只關燈箱，聊天室不會跟著退回清單；關掉之後焦點會回到原本的
輸入框（對話是回訊息的框，清單是搜尋框）。燈箱開著時只有 `o` 有作用，`r` 也不會穿透
過去 —— 先關掉燈箱再同步。

`/`、`L` 和 `r` 只在焦點不在輸入框時有效（也就是按過 Esc 之後）—— 否則它們就只是一個字元。
`r` 不像 `L` 要先選到再確認：同步壞不了東西，多按一次只是多抓一輪。

## 媒體與傳檔

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

`App window` 模式（見「設定」）不會關：那是一般視窗，不是 overlay，檢視器自己就疊在
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

## 設定

介面語言（`language`）有 `System`、`繁體中文`、`English` 三個值。`System` 跟著
系統語系走 —— zh* 是繁體中文，其他是英文 —— 所以英文系統要用繁中，明確選
`繁體中文` 就好：

```bash
omarchy bar set io.github.frankekn.line language "English"
```

daemon 回來的錯誤訊息和訊息佔位字在顯示時也會跟著這個設定換；線上協定的
字串本身不變。

面板搜尋框右邊的 `A−` `A+` 直接調字級（80–160，每次 10）。它會寫回 shell.json，
所以重開機也還在。

也可以用指令：

```bash
omarchy bar set io.github.frankekn.line textScale 130
```

同一排的 `捲動 1×` 是滾輪速度（`scrollSpeed`，%），按一下換下一段
（0.5× → 0.75× → 1× → 1.5× → 2× → 3× → 0.5×）。聊天清單、對話和貼圖選單三個地方
一起變，`1×` 是預設（一格約 60px，跟以前那一格差不多）：

```bash
omarchy bar set io.github.frankekn.line scrollSpeed 150
```

50–300 之間的任何數字都收，不限那六段；按鈕會顯示你設的倍率，再按一下跳到比它大的
下一段。Qt 的 `Flickable` 沒有「滾輪一格捲多少」可以設（步距寫死在裡面），所以面板
自己接下滾輪算距離：一般滑鼠一格 60px（跟著主題的間距縮放）× 倍率，觸控板照它回報的實際位移 × 倍率
（所以調快不會讓觸控板變成一滑一頁）。貼圖選單裡橫著捲的那兩排（分頁列、最近用過）走
同一套，只是一格是它們自己那一步（約兩格分頁、一格貼圖）。拖曳、觸控、捲動條和鍵盤的
`j`／`k` 都沒有改。

再過去的 `讀取 60` 是一次跟 daemon 要幾則（`historyPage`），按一下換下一段
（30 → 60 → 100 → 150 → 30）。**開聊天室的第一頁和往上翻的每一頁都是這個數字**：

```bash
omarchy bar set io.github.frankekn.line historyPage 100
```

20–200 之間的任何數字都收，不限那四段（跟捲動速度同一套：按鈕找的是「比現在大的
下一段」，所以手改成 37 也接得上）。上限 200 是 daemon 那邊也認的數字 ——
socket 收到的 `count` 在 daemon 裡一樣被夾在 1–200，不是數字就當沒指定（預設 30）。

調大的代價是開聊天室的第一次載入慢一點，換來的是往上翻的時候少跑幾趟。預設是 60：
30 則大概只有一個畫面多一點，於是每往上翻一次就撞一次網路來回。

翻舊訊息不用等捲到最頂：**離頂端還有一個畫面高就先去要下一頁**，捲到頂的時候上一頁
通常已經接上了，不會停在頂端等。一次只有一趟在飛，而且翻到最舊的一則之後就不再問
（daemon 回一頁空的就是「沒有更舊的了」）—— 重開那間聊天室或按「同步」會重新開始算。

面板位置（`placement`）有三種。搜尋框右邊那顆按鈕會顯示**現在是哪一種**，
按一下換下一種（貼齊 bar → 置中 → 視窗 → 貼齊 bar），一樣寫回 shell.json：

| 值 | 版面 | 適合 |
|---|---|---|
| `Below the bar`（預設） | 吊在 bar 圖示下方，單欄，清單與對話互相切換 | 只是瞄一下未讀 |
| `Center of screen` | 開在螢幕正中央，左清單右對話同時看得到（跟 TUI 一樣） | 回幾則訊息 |
| `App window` | 一個一般的 Hyprland 視窗，兩欄 | 一直開著當聊天軟體用 |

```bash
omarchy bar set io.github.frankekn.line placement "App window"
```

前兩種是 `WlrLayer.Overlay`，永遠蓋在所有視窗上面，也不歸 Hyprland 的視窗規則管。
`App window` 是真的 toplevel 視窗：會照你的規則平鋪或浮動、alt-tab 切得到、
可以放到別的工作區，開圖開影片時外部檢視器也是正常疊在上面（不用先關面板）。
視窗的 class 是 `org.quickshell`、title 是 `LINE`（omarchy 自己的 dev gallery
也是同一個 class）。想讓它浮動的話：

```bash
# ~/.config/hypr/windows.conf（或你放 windowrule 的地方）
windowrule = float, class:^(org\.quickshell)$, title:^(LINE)$
windowrule = size 1040 720, class:^(org\.quickshell)$, title:^(LINE)$
```

視窗大小會自己記起來（浮動視窗停手 0.8 秒後寫回 `windowWidth` / `windowHeight`；平鋪時大小由版面決定，重排不會記），
下次開一樣大。也可以直接指定：

```bash
omarchy bar set io.github.frankekn.line windowWidth 1280
omarchy bar set io.github.frankekn.line windowHeight 860
```

三種模式的鍵盤操作完全一樣（Esc 一路退到關閉、`/`、`L`、`r`、燈箱都在）。
唯一的差別是 Tab：那是「換到 bar 上隔壁那個面板」，`App window` 模式下不是
bar 面板，所以什麼都不做。

## daemon ↔ 外掛的契約

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
  "chatList": { "complete": true, "loaded": 122 }, // 選用；false 代表伺服器還有下一頁
  "timings": {                         // 選用；最近 64 次的 daemon 延遲統計
    "chats.refresh": { "samples": 18, "lastMs": 241.3,
                       "p50Ms": 205.1, "p95Ms": 390.8, "maxMs": 411.2 },
    "cmd.history": { "samples": 6, "lastMs": 92.4,
                     "p50Ms": 88.0, "p95Ms": 131.7, "maxMs": 131.7 }
  },
  "stateBytes": {                      // 選用；state.json 最近 64 次寫入的大小統計
    "samples": 64, "last": 253412,
    "p50": 251190, "p95": 258871, "max": 260112,
    "chats": 122                       // 這份檔案序列化時的 chats 列數
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
teardown——登出、任何走到底的 resume（不論失敗原因是 `token_expired`，還是開機時
storage 裡根本沒有 token）、或已建立又失敗的 manual——面板都會清掉上個帳號的
durable 草稿；可重試的暫態失敗（`network`／未分類，或還沒建立就失敗的 manual）則
保留草稿，等下一次登入接續。

`refresh` 說的是**聊天室清單那條路**（talk 請求），跟 `link`（push 連線）是兩件事，
兩者可以一好一壞 —— 所以不併進 `link`，不然又看不出來。`at` 是最後一次
`getMessageBoxes` 成功、`chats` 寫進檔案的毫秒時間戳；`failures` 是從那之後連續
失敗的次數，成功就歸 0；`reason` 只在 `failures > 0` 時存在，分類跟 `login.reason`
同一套（`network`／`token_expired`／`unknown`）。失敗只在進入連錯的那一刻落檔一次
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
寫回的總時間。統計在 state 寫入真正輪到磁碟時才取樣，只搭下一次原本就會發生的寫入，
不會為了量測額外喚醒面板；daemon 重啟後重新累積。

`stateBytes` 是同一個滾動視窗量在**序列化後的 byte 數**上：單位是 UTF-8 位元組，
不是毫秒，所以欄位名不帶 `Ms`。取樣在 state 寫入真正輪到磁碟、整份 JSON 文字產生的
那一刻，一次寫入只取樣一次（心跳、刷新、推播摘要全走同一個 `writeState`，不會為了
量測多序列化一份）；跟 `timings` 同一拍——這次寫入自己的大小要等下一次寫入才會
上榜，daemon 重啟後重新累積，剛啟動、視窗還空時整個區塊不存在。`chats` 則是**這份
檔案自己**序列化當下的 chats 列數（含被隱藏的那幾間——它們仍留在檔案裡），跟
滾動統計不同拍，讀的時候當「這份檔案的現況」。要對寫入做任何減量（欄位 diff、
分檔）之前，部署端直接讀這一區塊，拿到的就是實際數字。

`timings` 和 `stateBytes` 都是**選用欄位**：舊 daemon 不會寫，面板對 state.json 的
契約本來就是只讀自己認得的鍵、未知欄位忽略，所以舊面板不受影響。

聊天室那一列的 `hidden` 同理：**只有被隱藏的那幾間才有這個鍵**，沒隱藏的整個不存在
（不是 `false`），舊的面板照樣畫得出來。被隱藏的聊天**仍然留在 `chats` 裡** —— 面板
要靠它做搜尋，只是平常不畫。daemon 在每次寫 state 的當下才蓋上這個鍵，來源是
`hidden.json`；聊天摘要本身的快取不帶它，不然隱藏之後那份快取會一直說著舊答案。

### `wanted`：從通知點進來的聊天室

點桌面通知的時候，daemon 會先寫一筆 `wanted`，再叫 shell 把面板打開 —— shell 的
IPC 只會 open／close／toggle，沒辦法帶參數，所以「要開哪一間」是走面板本來就在監看的
`state.json`。

- `chat` 是聊天室 mid，`at` 是點下去的毫秒時間戳。
- `seq` 跟 `events` 的一樣，**在同一個 daemon 行程裡嚴格遞增**：面板記住自己處理過的
  那一個，只認比它大的。同一間聊天室連點兩次也是兩筆（`seq` 不同），不會被當成重複。
  `bootId` 換了就代表計數從頭開始。
- 登出會把整個欄位拿掉：指向一間已經開不起來的聊天室，只會讓面板跳到空的對話。
- 欄位不會自己消失，所以面板不能只看「有沒有」，要看 `seq`。

### `events.json`：即時事件

`events.json` 是一個環狀緩衝，**只留最近 200 筆**，跟 `state.json` 分檔寫入 —
— 事件爆量的時候重寫的是這份小檔，`state.json` 不必跟著長大或一直被重讀。
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

- `seq` 在**同一個 daemon 行程裡**嚴格遞增，不重複也不回頭。重啟會從 1 重來 ——
  所以 `bootId` 換了就代表「這是新的一輪」，面板要把 watermark 歸零。
- `at` 是毫秒時間戳，`chat` 是聊天室 mid（每一種 `kind` 都有，面板可以先照它篩掉
  不是現在這間的事件，不必看 payload）。
- 事件寫檔會**合併**：最密 250 毫秒一次（每秒 ≤ 4 次），一次進來一整串（相簿、
  被拆開的長句）不會讓面板重讀 20 次 events.json。
- 登出會把 `events` 清空（`seq` 不歸零 —— 同一個 `bootId` 裡倒退的 seq 是面板唯一
  沒辦法解釋的情況）。
- 檔案只是**補齊**用的慢路：面板連著 socket 的時候，每筆事件先以 `{"event":…,"boot":…}`
  推播幀直接送達（見下），檔案隨後才落；斷線期間漏掉的，重連後靠讀檔
  補齊。

| `kind` | 欄位 | 什麼時候發 |
|---|---|---|
| `message` | `message`（跟 `history` 一則訊息完全同一個形狀，已解密、含 mentions／mediaState） | 收到新訊息，或自己送出（LINE 會把自己送出的也推回來，別的裝置送的一樣） |
| `read` | `by`（讀的人 mid）、`upTo`（他讀到的最新訊息 id） | 對方已讀，或自己在別的裝置上讀了 |
| `reaction` | `messageId`、`reactions`（**整串新的**，不是差異） | 有人加、換或收回表情 |
| `unsend` | `messageId` | 有人收回訊息（自己或對方） |
| `edit` | `message`（編輯後的完整訊息） | 訊息被編輯 |
| `history` | `messages`（重新驗證過的整頁） | 本地庫先回了舊頁、對帳後補上新頁。一筆就是一頁的量，所以同一間聊天室在環裡只留最新一筆，舊的直接丟掉 |

`reaction` 給的是整串而不是差異，因為 LINE 的 op 一次只講一個人的新選擇；daemon 自己
留一份「這則訊息誰選了什麼」，從歷史載入時的 `raw.reactions` 起算，再照 op 移動。
沒被載入過的訊息只能從空的開始算（面板下次載入歷史就會校正回來）。

socket 指令（請求一行 JSON，回應一行 `{ok, data?, error?}`）：

| cmd | 參數 | 成功時的 `data` |
|---|---|---|
| `history` | `chat`, `count`（1–200，超界夾住、非數字當 30）, `before?`（往前翻頁的訊息 id）, `markRead?` | 訊息陣列，舊的在前 |
| `send` | `chat`, `text`, `mentions?`, `requestId?` | 無 |
| `reply` | `chat`, `text`, `replyTo`（要回覆的訊息 id）, `mentions?`, `requestId?` | 無 |
| `react` | `chat`, `messageId`, `type` | 無 |
| `unsend` | `chat`, `messageId` | 無 |
| `members` | `chat` | `[{ "mid": "u…", "name": "…" }]`，照名字排序 |
| `sendFile` | `chat`, `path`, `requestId?` | 無（太大或不支援的聊天室回中文拒絕，見上） |
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
| `login` | —— | 無 |
| `logout` | —— | 無 |
| `sync` | —— | `{ chats, link, at }` |

面板連著 socket 的時候，daemon 會主動寫兩種**推播幀** —— 沒有 `id`、不對應任何
請求，跟回覆共用同一條序列化寫入通道，所以一行永遠完整：

- `{"event": <event>, "boot": "<bootId>"}` —— 事件環裡的一筆新事件（`history`
  事件也在裡面）。client 拿 `seq` 對自己的 watermark 去重；`boot` 跟已知的
  `bootId` 不同代表 daemon 重啟過，歸零後從 `events.json` 重新補齊。
- `{"chat": <row>, "chatsRevision": N, "boot": "<bootId>"}` —— 單一聊天室列
  欄位變動（新訊息的預覽、收回、頭像補上）時整列推過來。`chatsRevision` 是它的
  水位線 —— 同一欄位的檔案寫入如果帶著更舊的 revision 抵達，直接丟掉，不能
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

未送出的文字、提及、回覆目標與游標位置存於
`$XDG_STATE_HOME/enil/panel-drafts.json`，以帳號及聊天室分開；每次編輯立即排入原子寫入，
寫入進行中時只保留後續最新快照，切換聊天室、關面板或重啟 shell 都能還原。斷線後尚未確認的 `requestId` 與樂觀
訊息也存在同一檔案，切換聊天室或重啟面板後仍會顯示並繼續精確核對。收到送出成功的
回覆，或斷線後在 history／message event 看到完全相同的 `requestId`，才刪除該次傳送
對應的草稿；送出失敗或尚未精確確認時仍保留。daemon 重啟期間的 `starting` 與可重試的
網路 `error` 不會被當成登出；明確進入 `idle`，或已結束且無法重試的 session 錯誤，
才會清除該帳號的草稿與未確認傳送。

回應**一定寫得完整**：daemon 是用 `writeAll` 一路寫到最後一個位元組，不是靠一次
`conn.write` —— unix socket 一次只吃得下緩衝區塞得下的量（實測 219264 位元組），
`stickers` 這種十幾萬位元組的回應會被截斷，而且不會有任何錯誤，面板只會等一個永遠
不會來的換行。萬一回應本身編不成 JSON（例如混進 BigInt 或循環參照），daemon 會回
`{ok:false, error:"回覆無法編碼"}` 並在 journal 留一行
`[cmd] <cmd> reply unserializable: <錯誤類別>` —— 值本身不進 journal。

`sync` 是手動同步：重建 push 連線（不等它完成）並重抓聊天列表 —— 回報的一定是**收到這個
請求之後**才跑完的那一輪，剛好有一輪在飛就先等它結束。`chats` 是抓回來的
聊天室數量、`link` 是**同步開始當下**的 push 狀態（`"up"`／`"down"`；重建一開始就會把
狀態設成 down，回報之後的值等於每次都說 down）、`at` 是完成時間的毫秒時間戳。抓失敗時
回 `{ok:false, error:"同步失敗：…"}`，後半是給人看的原因。

`members` 是 @ 用的群組成員名單，只有群組（`c…`）和 room（`r…`）能問；1:1（`u…`）回
`{ok:false, error:"這不是群組，沒有成員名單"}`。名單裡不含自己。daemon 快取十分鐘，
所以同一間聊天室來回開關只會真的抓一次。room 的名單多半拿不到，那時回
`{ok:false, error:"多人聊天室（room）拿不到成員名單"}` —— 面板不跳橫幅，等使用者真的
打了 `@` 才在選單裡說原因。

`image` 拿的是一張**公開**圖片的本機檔：daemon 抓進 `media/public-images/`（合併、
上限與清掃見上面「安裝」那一段），回 `{ "path": "…" }`，面板只讀 `file://`。只收
`https://`、不帶帳號密碼、回應的內容型別要是 `image/`，重導最多五次而且每一跳都得是
`https://`；任何一項不成立或抓不回來都回 `{ok:false, error:"圖片下載失敗"}` —— 面板
不會改成自己去連 HTTPS，那正是這支指令要避開的那條路。

`send`／`reply` 不指定要不要加密，交給 LINE 決定：先照明文送，對方要求加密時才由
linejs 自己改用 E2EE 重送一次（`mentions` 和引言都跟著過去）。反過來硬指定加密的話，
對方把 Letter Sealing 關掉時金鑰查詢會直接回 `E2EE_RETRY_PLAIN`，訊息連送都送不出去。

`reply` 就是帶引言的 `send`：一樣的 `mentions` 驗證、一樣的加密、一樣的拒絕，只多一個
`replyTo`。少了它回 `{ok:false, error:"沒有指定要回覆哪一則訊息"}` —— 不擋的話訊息還是
送得出去，只是變成沒有引言的普通訊息，等於默默吃掉使用者挑的那一則。

`react` 的 `type` 是 LINE 的六個預設表情
`NICE`／`LOVE`／`FUN`／`AMAZING`／`SAD`／`OMG`，外加把自己的收回來的 `UNDO`；
其他一律回 `{ok:false, error:"不支援的表情"}`。一個人在同一則訊息上只會有一個表情，
再送一次就是換掉，不是疊加。

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
公開的 `productInfo.meta`（不需要登入）。抓不到的那個貼圖包 `stickers` 會是**空陣列**
—— 帳號確實有這個貼圖包，只是這次讀不到，讓它從清單裡消失只會更難解釋。`animated` 是
**整包**的性質不是單張的：LINE 的 JSON 沒有逐張的旗標，收到的貼圖也只有 `STKOPT`。
`url` 跟收到的貼圖走同一條 CDN 路徑，面板兩邊可以共用同一段畫圖的程式。登出會把快取
清掉 —— 換一個帳號就是換一批貼圖包。

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
`{ok:false, error:"這個貼圖包不在你的貼圖清單裡"}` —— LINE 對 metadata 照單全收，
擋不下來的話對方收到的是一顆放不出圖的空泡泡，而且收不回來。**不檢查**那張貼圖在不在
那一包裡：`stickers` 是空的那幾包本來就沒得檢查，擋下來等於把 daemon 讀不到清單這件事
算在使用者頭上。貼圖**不走 E2EE**（內容就是 metadata，而 metadata 本來就不加密），
送出之後跟 `send` 一樣由 LINE 把自己送出的推回來，面板收到的是 `message` 事件。
整包是動態的（`animated`）就多帶一個 `STKOPT: "A"`，靜態的那幾包整個欄位不帶 ——
linejs 的 `getStickerURL()` 只有看到這個值才給 `sticker_animation.png`，不帶的話連
自己推回來的那則都是不會動的那一格。面板畫的時候再換回靜態網址：APNG 在 Qt 裡只
畫得出第一格，一張卻要幾百 KB。

`unsend` 只收得回**自己傳的**訊息，別人的回
`{ok:false, error:"只能收回自己傳的訊息"}`；daemon 是從自己的游標表看送出者的，
不必為了拒絕先去問 LINE。沒在快取裡的回「訊息不在快取裡」。收回成功之後 LINE 會把
`DESTROY_MESSAGE` 推回來，面板收到的是 `unsend` 事件，daemon 不會自己補一筆。

`send` 的 `mentions` 是選用的，`[{ start, end, mid }]` 或 `[{ start, end, all: true }]`：

- **`start`／`end` 是 `text` 的 UTF-16 code unit 位移，半開區間 `[start, end)`。**
  一個中日韓字算 1，BMP 以外的表情符號（surrogate pair）算 2 —— 也就是 JavaScript
  `String` 的 `length` 和 `substring` 用的那個單位，兩邊都是 JS，誰都不用換算。
  這是 LINE 自己的單位：linejs 用 `parseInt` 讀 `MENTIONEES` 的 `S`／`E` 再交給
  `String.prototype.substring`。
- `mid` 是 `u` + 32 個小寫十六進位字；`all: true` 是 @全部，不帶 mid。
- daemon 會驗：不是整數、超出 `text` 範圍、頭尾顛倒、mid 形狀不對、或跟前一段重疊的
  **整筆丟掉**，其餘照送。壞掉的 mention 只賠上自己那一個標記，不會害整句話送不出去。
- daemon 把它組成 LINE 的 `contentMetadata.MENTION`。這段 metadata **不加密**（E2EE
  只加密本文），所以位移描述的是對方解密後看到的那串字。

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
人都讀到了」—— 1:1 就是對方讀了（畫成「已讀」），群組是還沒到齊（畫成「已讀 N」）。
分母是 `getMessageReadRange` 回報有 range 的成員（扣掉自己）。什麼都不知道的時候
**整個欄位不存在**，不是 `count: 0` —— 不能把「不知道」畫成「沒人讀」。開聊天室時抓
一次，之後靠 `read` 事件更新。

只要有東西照這個契約寫檔案與監聽 socket，這個外掛就能用 —— 不一定要是這個 daemon。
`daemon/stub.py` 就是這樣一個東西：純標準庫的假 daemon，餵假資料給面板，讓人不用真的
LINE session 也能改 UI。

```bash
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py              # 已登入
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py --logged-out # 未登入，可以試 QR 流程
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py --fixture busy
```

`--fixture` 有四個：`default`（`u`／`c`／`r` 各一個以上的聊天室，訊息涵蓋純文字、
多行、E2EE 解密失敗、圖片、影片、檔案、貼圖、FLEX、系統事件、自己發的、收回的、
過期的檔案）、`empty`（空清單）、`busy`（200 個聊天室，看清單捲動與搜尋）、
`notify`（就是 `default`，但開起來就已經有一筆 `wanted`，直接看「從通知點進來」
長什麼樣）。`history`
會照 `before` 翻頁，`markRead` 會清未讀，`send` 會回一則 echo（`mentions` 照 daemon
那套驗過再掛回去），`sendFile` 對 `r…` 回跟 daemon 一樣的中文錯誤，`download` 對收回／
過期的訊息也是。`members` 對群組回假名單、對 1:1 和 room 回跟 daemon 一樣的中文拒絕；
`default` 裡有一則帶 @全部和 @某人的訊息，前面還放了一個表情符號，位移才會真的踩到
UTF-16 那個單位。

兩階段剪貼簿指令也在：stub 沒有剪貼簿，所以 `probeClipboardImage` 一律回一張畫出來的
假 PNG 的 `stage`，再交給 `sendClipboardImage` 送出（IMAGE，縮圖走 `preview`）；
探測時多加
一個真 daemon **沒有**的 `empty: true` 才回「剪貼簿裡沒有圖片」——
不然面板那條「沒東西可以貼」的路只能靠清空真的剪貼簿才走得到。`sendFile` 的
`contentType` 也照 daemon 那套從副檔名判（IMAGE／VIDEO／FILE），影片不給 `mediaPath`，
太大的那三句拒絕也一模一樣 —— 這是唯一不用真的準備一個 1 GB 檔案就能看到那句話的地方
（測試用的是 sparse 檔）。

`reply`／`react`／`unsend` 三個指令也都在，而且會照樣寫 `events`：`send` 和 `reply`
會補一筆 `message` 事件（真的 daemon 是 LINE 把自己送出的訊息推回來），兩秒後再補一筆
`read` 並把 `readBy` 掛上去 —— 沒有這個「假的對方」，面板的「已讀」根本沒東西可以測。
`react` 換的是整串 `reactions`（不是差異），`unsend` 只肯收回 `ME` 送的那幾則。
fixture 裡本來就有帶 `replyTo`（含一則只有 `id`、引不到原文的）、`reactions` 和
`readBy` 的訊息。

貼圖也在：`stickers` 回兩個假的貼圖包（一包靜態、一包動態，`url` 是真的 CDN 路徑），
`sendSticker` 的兩句拒絕跟 daemon 一模一樣，送出去會是一則 `contentType: "STICKER"`、
帶 `stickerUrl` 的訊息事件。

`image` 也在，而且非有不可：面板只讀本機檔，少了它貼圖格、貼圖選單、FLEX 預覽和燈箱
在 stub 底下全是破圖。stub 沒有網路，所以圖是畫出來的 —— 一個網址一個檔（sha256 命名、
跟 daemon 同樣放 `media/public-images/`、不帶副檔名），問幾次都是同一條路徑，`#` 後面
那半跟 daemon 一樣先丟掉。不是 `https://`、帶帳號密碼、或解析不出來的網址，回的是跟
daemon 一字不差的 `圖片下載失敗`。

大頭貼也在：一部分聊天室和送出者有 `avatarPath`／`fromAvatar`（`media/avatars/` 底下
畫出來的假圖），一部分故意沒有 —— 沒有大頭貼的那一列面板一樣要畫得出來。

`hide`／`unhide` 也在（跟 daemon 一樣不看有沒有登入），被隱藏的那幾間會在寫 state 的
當下帶上 `hidden: true`：沒有它，右鍵選單、搜尋才找得回來、以及「隱藏之後不算未讀」
這幾條路在沒有 LINE session 的時候一條都走不完。stub 記在記憶體裡（它跟著暫存的
state 目錄一起丟掉），不寫 `hidden.json`。

stub 多一個真 daemon **沒有**的指令 `poke`：`{"cmd":"poke","chat":"<mid>"}` 會寫一筆
`state.wanted`，等同於「使用者點了那間聊天室的通知」。真的 daemon 是從 `notify-send`
的 action 走到這一步的，需要通知伺服器、一則通知和一個人去點它，開發時驅動不了。

`python3 daemon/stub_test.py` 把這些形狀釘在上面的契約上（純標準庫，跑在自己的暫存
`XDG_STATE_HOME` 裡）。

**別讓 stub 指到真的 state 目錄** —— 它會蓋掉 `state.json`。

## 這個 repo 的改動

原始外掛作者 Unayung（MIT）；本 repo 為 fork，已與上游分離。

daemon 原本是另一個 repo，現在收進來（改寫成單檔 Deno），並加了：

- 多行訊息：Shift+Enter 換行
- 面板關著時發桌面通知
- 清單預覽自己發的訊息顯示「我:」
- 貼圖當圖片顯示，不再是空白
- 對話裡顯示系統事件（加入／退出／改名）與日期分隔線
- 面板內登出
- 送出失敗時把文字還回輸入框，不會直接吞掉
- 每次送出只 refresh 一次聊天室清單（原本兩次）
- `twoPane` 版面按 Esc 保留右邊那欄，不會整個收掉
- 重開聊天室吃 history 快取，不用等網路
- 介面字串雙語化 —— 繁體中文與英文
- 搜尋同時比對訊息預覽，不只聊天室名稱
- 影片縮圖（非 E2EE）
- 媒體快取上限 14 天／500 MB，自動掃
- room 傳檔給明確錯誤訊息，不再冒出 `Invalid mid`
- `refreshChats` 快取聯絡人名稱，少打很多次 API
- 抓到全部 122 個聊天室（原本 50，而且 1:1 聊天全被 group 擠掉）
- `agoText` 防呆，`lastTime` 缺漏時不再顯示 `NaN`

### linejs 用自己的 fork

daemon 不匯入 `jsr:@evex/linejs`，而是匯入 `daemon/vendor/linejs` 這個 submodule，
它指向公開 fork `frankekn/linejs` 的 `omarchy-vendor` 分支。daemon 需要的修正都在
LINE 的協定層，daemon 這邊繞不過去，所以放在 fork 裡。

pin 住的 commit 是 `4d6aa18`，在上游之上疊了三個 commit：

| commit | 是什麼 |
|---|---|
| `802f4c7` | 上游 `evex-dev/linejs` 的「fix: E2EE key registration and client message handling (#226)」，是 `omarchy-vendor` 的基底 |
| `a677741` | 「vendor: omarchy patch set」。一個 squash commit，內容是 omarchy 對 `packages/linejs` 與 `packages/types` 的補丁 |
| `4d6aa18` | 把 fork 根目錄的 `README.md` 從 symlink 改成真檔案，`omarchy plugin validate` 才會過（見[開發](#開發)） |

`a677741` 改了這些部分：

- **型別。** `@evex/loose-types` 的 `LooseType` 只留在 Thrift 讀寫程式碼、
  `base/push/connManager.ts` 與 `types/thrift.ts`，其他地方都換成具體型別。型別
  套件以 `@frankekn/linejs-types` 的名稱發佈。
- **請求與 LEGY。** 預設的加密端點是 `legy.line-apps.com`，不再是
  `gf.line.naver.jp`。`x-lal` header 跟著 client 的 locale，不再固定為 `ja_JP`。
  呼叫端的 `AbortSignal` 會傳到加密請求上，所以請求 timeout 對加密呼叫也有效。
  以前睡眠時斷掉的 keep-alive 連線可能永遠掛著。
- **E2EE。** 群組訊息用它的 `groupKeyId` 指定的那一代 shared key 解密，金鑰也照
  代數分開快取。以前群組換過金鑰之後，較舊的訊息全部解不開。
- **媒體。** OBS 下載收到非 2xx 回應時丟出 `ObsError`，不再拖到後面變成「HMAC
  verification failed」。`uploadMediaByE2EE` 接受 `durationMs`，E2EE 影片在對方那邊
  不再顯示 0:00。它也接受額外的 `contentMetadata`，但呼叫端不能覆寫 `DURATION`、
  `DOWNLOAD_URL` 或 `PREVIEW_URL`。媒體下載接受 `AbortSignal`。
- **Push 與 polling。** push 連線失敗或 listen 迴圈失敗時，錯誤會回報給呼叫端，
  不再變成 unhandled rejection 把整個 process 打死。
- **其他。** 新的相簿（`moa`）service、通話功能的修改、帶連線 timeout 的 Node
  fetch（`base/core/node_fetch.ts`），以及大量新測試。workspace 只剩
  `packages/linejs` 與 `packages/types`。

上游在 `802f4c7` 之後繼續前進，合併的 PR 包括來自本 fork 分支的 #239 與 #240。

fork 的測試在 fork 裡跑：在它的根目錄執行 `deno test -A`（在 `4d6aa18` 上 382 個
測試通過）。這一跑會在 fork 裡產生 `node_modules/` 與 `deno.lock`，跑
`omarchy plugin validate` 之前要把兩個都刪掉，因為它拒絕 `node_modules/` 裡的
symlink。本 repo 的 `deno task test` 把 `vendor/` 排除掉，只跑自己的測試。

要改 linejs，就在 `omarchy-vendor` 上改，再移動本 repo 的 pin：

```bash
git submodule sync -- daemon/vendor/linejs
git submodule update --init daemon/vendor/linejs
cd daemon/vendor/linejs
git switch omarchy-vendor             # 追蹤 origin/omarchy-vendor
git pull --ff-only
# 在這裡 commit 你的改動
deno test -A                          # 確認 fork 還站得住
git push origin omarchy-vendor
cd ../../..
git add daemon/vendor/linejs          # 主 repo 的 pin 要跟著動，這步漏了等於沒升級
cd daemon && deno task check && deno task test
```

要拿上游的改動，把它 merge 進 `omarchy-vendor`，不要 rebase：

```bash
cd daemon/vendor/linejs
git remote add upstream https://github.com/evex-dev/linejs.git   # 只需一次
git fetch upstream
git merge upstream/main
```

接著照上面的步驟測試、push、移動 pin。不要 rebase 或 force-push
`omarchy-vendor`。本 repo 過去的每一個 commit 都 pin 住那個分支上的某個 commit，
分支被改寫之後，那些 commit 就不在任何分支上，舊 checkout 重新
`git submodule update` 時可能抓不到。

`.gitmodules` 寫了分支名稱，所以 `git submodule update --remote daemon/vendor/linejs`
會把 submodule 移到 `origin/omarchy-vendor` 的最新 commit。用同樣的方式 stage 並
測試這個 pin。

哪天這些都進了上游，就把 submodule 拿掉、import map 換回 `jsr:@evex/linejs`。

## 已知限制

- 非官方 client，有帳號風險（見[免責聲明](#免責聲明)）
- 多人聊天室（`r…` 開頭）不能傳檔案 —— linejs 的 `uploadMediaByE2EE` 只收 `u`／`c`
- E2EE 影片顯示 📎 而不是縮圖：縮圖也是加密的，要抓整支影片才拿得到
- 送出的影片要有預覽圖得裝 `ffmpegthumbnailer` 或 `ffmpeg`；兩個都沒有就是送出去
  沒有預覽圖（見「媒體與傳檔」），這是刻意不把解碼器變成必要相依
- 送出的影片沒有帶解析度（`WIDTH`／`HEIGHT`）：那得真的解一格畫面才知道，而縮圖
  那一步是可以不在的
- AVI 讀不出長度：`RIFF` 的長度不在檔頭的固定位置，而 LINE 也不會自己算

## 開發

CI 使用自架 AWS `x64-ci` pool，只測試 main 分支的 push 和本 repo 分支的 PR。
PR workflow 透過 `pull_request_target` 使用 base 分支的定義，先檢查信任來源，才 checkout PR 的精確 head。
Fork PR 會在 checkout 前明確失敗；維護者必須先審查變更並移到受信任分支，CI 才會跑測試。
結果會以 `ci / checks` 發佈到 PR head；workflow 變更進 main 前，可手動測試受信任分支。
所有外部貢獻者的 fork workflow 都需要在 GitHub 核准。

改完一定要跑：

```bash
omarchy plugin validate .
qmllint -I /usr/share/omarchy/shell Panel.qml LinePanel.qml LineWindow.qml
(cd daemon && deno task check)
```

`omarchy plugin validate` 拒絕外掛資料夾裡的**任何** symlink（只跳過 `.git`）。有兩個
決定就是為了讓它在 submodule 補完之後照樣 exit 0：`nodeModulesDir` 設 `"none"`（設
`"auto"` 會在 `daemon/node_modules/` 生出六百多條），以及 fork 的根 `README.md` 是真檔案
而不是指向 `packages/linejs/README.md` 的 symlink。要改這兩個之前先想一下這一行。

三個都要 exit 0，但**證明不了畫面長得對**。行為則由 repo 內建的測試證明——不需要
daemon、socket 或 state 目錄，`node tests/qml/run.js` 直接從 `Panel.qml` 切出函式本體
跑；`tests/qml/keytest/run.sh` 用離屏 `qmltestrunner` 驗清單檢視的按鍵路徑（沒裝
qmltestrunner 就跳過並回 0）；`cd daemon && deno task test` 直接匯入
`panelserver.ts` 測 socket 分派，仍與 daemon 緊密耦合的純函式則從 `daemon.ts` 的
`// enil:*` 標記之間切出來測：

```bash
node tests/qml/run.js
tests/qml/keytest/run.sh
python3 daemon/stub_test.py
cd daemon && deno task fmt && deno task check && deno task no-any && deno task lint && deno task test
```

這些檢查全部在本機跑。submodule 是公開 fork，CI 直接 `submodules: true` 取得；`omarchy plugin validate` 和 `qmllint` 也需要本機的 omarchy shell
QML modules。實機驗證：

```bash
omarchy restart shell                 # 改 QML 之後
systemctl --user restart enil         # 改 daemon 之後
```

## 安全紅線

見 [SAFETY.zh-TW.md](SAFETY.zh-TW.md) — EasyMigration/帳號轉移永久禁止,以及其他不可碰的操作。

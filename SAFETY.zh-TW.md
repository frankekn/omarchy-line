# 安全：你的帳號與你的資料

[English](SAFETY.md)

這一頁列出 omarchy-line 會拿你的 LINE 帳號做什麼，以及它在你電腦上存了哪些資料。
使用非官方 client 本身的風險，請先看[免責聲明](README.zh-TW.md#免責聲明)。要回報
安全問題，請照 [SECURITY.zh-TW.md](SECURITY.zh-TW.md) 的步驟。

## 目前的程式碼不做的事

下面這些描述的是 `main` 上現在的程式碼。任何改動只要讓其中一條不再成立，就必須在同
一個 commit 裡更新這一頁。

- **不轉移你的帳號。** daemon 以次要裝置的身分用 QR 碼登入。它從不啟動 LINE 的帳號
  轉移流程，因為那個流程可能讓你的手機被登出。你的手機一直是主要裝置。
- **不自己送東西。** 訊息、檔案、貼圖、表情回應或收回，只有你在面板或
  [網頁版](docs/web.zh-TW.md)上操作時才會送到 LINE。已讀只會送給你正在看的那個聊天室。在 `Center of screen` 和
  `App window` 位置，按 Esc 回到清單後，聊天室還會留在右欄，但在你再次看它之前，
  它不會送出已讀。點進它的回覆框就算在看，並會為這段期間進來的訊息送出一次已讀。
- **不繞過限制重試。** LINE 對任何請求回 `ABUSE_BLOCK`、`BANNED` 或
  `EXCESSIVE_ACCESS` 時，在你操作之前，daemon 不會自己發出任何 LINE 請求。它會
  結束 push 迴圈，不只是忽略收到的事件。面板會顯示
  `LINE 限制了這個帳號（<代碼>），已暫停連線，點此重試`。只有你點那一行（會執行一次
  手動同步）或重新登入，自動流量才會恢復。你自己傳的訊息還是會送到 LINE，LINE 拒絕
  的話，面板會顯示 LINE 的錯誤。其他錯誤，例如 `MAINTENANCE_ERROR`，不會讓 daemon 停下來。細節見
  [LINE 限制帳號的時候](docs/architecture.zh-TW.md#line-限制帳號的時候)。
- **daemon 請求公開圖片時不會送出 LINE token。** daemon 用 token 跟 LINE 溝通，並把
  訊息和檔案送到 LINE。網頁版會先把操作和上傳檔案傳給 daemon。在你自己的電腦上，
  桌面通知會把聊天室名稱、傳送者和訊息預覽交給你的通知程式，通知程式可能會把它們
  留在通知紀錄裡。
- **沒開網頁版，就不會把訊息提供給網路。** 網頁版要設定 `ENIL_WEB_ADDR` 才會開啟。開啟
  之後，任何連得到那個位址、又有 web key 或有效瀏覽器 cookie 的人，都能讀你的訊息、
  替你傳訊息。請綁在 Tailscale 位址上，不要用 `0.0.0.0`。細節見
  [docs/web.zh-TW.md](docs/web.zh-TW.md)。
- **不把憑證放進 repo。** LINE session token 與金鑰存在
  `~/.local/state/enil/storage.json`（或 `$XDG_STATE_HOME/enil/` 下）。瀏覽器
  另外持有網頁版 cookie。

## daemon 被允許做的事

Deno 用 `daemon/enil-flags.sh` 裡一份固定的權限清單執行 daemon，清單以外的事一律
拒絕。`deno run` 和編譯好的執行檔用的是同一份清單。

| 權限 | 允許的範圍 | 原因 |
|---|---|---|
| 網路 | 任何主機 | FLEX 訊息和連結預覽可以指向任何 HTTPS 主機上的圖片，事先不知道會是哪些主機。 |
| 讀檔 | 任何路徑 | 你可以傳送任何你選的檔案，縮圖程式直接在原位置讀它。 |
| 寫檔 | 只有 state 目錄 | daemon 寫的所有東西，包括暫存檔，都在 `~/.local/state/enil/` 裡。 |
| 執行程式 | `dbus-monitor`、`wl-paste`、`ffmpegthumbnailer`、`ffmpeg`、`omarchy-shell` 和 `notify-send` | 偵測睡醒、剪貼簿圖片、影片縮圖和通知。 |
| 環境變數 | `HOME`、`XDG_STATE_HOME`、`ENIL_*` 變數、`Q_DEBUG` 和 `NODE_DEBUG` | daemon 的設定，加上兩個相依套件啟動時會讀的名稱。 |
| 系統資訊 | 無 | |

## 其他網路請求

- 貼圖、大頭貼和媒體來自 LINE 的主機，或 LINE 交給 daemon 的網址。
- FLEX 訊息可以指向任何公開 HTTPS 主機上的圖片，daemon 會把它們下載下來給面板顯示。
  那台主機看得到你的 IP 位址，也大致知道圖片是什麼時候被抓的。這個請求是單純的
  `GET`，不帶 cookie，也不帶 LINE token。daemon 拒絕 `http:` 網址，也拒絕解析到私有
  位址的主機。
- 網頁版直接從 HTTPS 網址載入貼圖和 FLEX 圖片。那些主機看得到瀏覽器的 IP 位址和
  請求的網址；瀏覽器本身的第三方 cookie 設定也會生效。
- `daemon/install.sh` 會以 git submodule 的方式從 GitHub 下載 linejs fork。
- daemon 第一次從原始碼啟動時，Deno 會從 JSR 和 npm 下載 `daemon/deno.json` 列出的
  相依套件，版本以 `daemon/deno.lock` 鎖定的為準，存進 Deno 的快取（預設是
  `~/.cache/deno`）。`install.sh` 最後會啟動 daemon，所以這一步發生在安裝的最後。
  之後再啟動都用快取。外掛更新後，Deno 只下載快取裡還沒有的版本。
  `deno task build` 會在建置時下載，編譯出來的 `enil` 執行檔已經包含這些套件，所以
  執行檔啟動時不會下載任何東西。

## 存在磁碟上的資料

下列 daemon 檔案都在 `~/.local/state/enil/`（或 `$XDG_STATE_HOME/enil/`）。daemon
以 `0700` 建立這個目錄，每次啟動時都把目錄設回 `0700`、把 `storage.json` 設回
`0600`。這些權限能擋住這台電腦上的其他使用者，但擋不住以你的身分執行的程式。

| 路徑 | 內容 |
|---|---|
| `storage.json` | 你的登入 token、refresh token、E2EE 金鑰與登入憑證。**這個檔案就是你的 LINE 帳號。** |
| `storage.json.corrupt-<時間>` | daemon 讀不了而移到一旁的 session 檔，裡面可能還有你的金鑰。 |
| `messages/<你的-mid>/<聊天室-mid>.jsonl` | daemon 看過的每一則訊息，一個聊天室一個檔案。不會自動清理。 |
| `media/` | 你打開過的檔案與圖片的解密原檔、縮圖，以及等著送出的 `clipboard-*` 圖片。 |
| `media/avatars/` | 大頭貼。 |
| `media/web-uploads/` | 從網頁版上傳的檔案。daemon 回覆傳送結果後，bridge 會嘗試刪除；殘留檔案超過 24 小時後，會在啟動時或之後每小時清掃。daemon 停止或刪除失敗時可能留得更久。 |
| `media/public-images/` | 貼圖與 FLEX 圖片。 |
| `state.json` | 聊天列表，以及每個聊天室最後一則訊息的預覽。 |
| `events.json` | 最新 200 筆即時事件，包含最近訊息的完整內容。 |
| `panel-drafts.json` | 打了但還沒送出的文字。 |
| `panel-stickers.json` | 最近用過的貼圖。 |
| `avatars.json` | 哪些版本的大頭貼已經下載過。 |
| `hidden.json` | 你隱藏的聊天室。 |
| `sock` | 面板連線用的 socket。 |
| `lock` | 空檔案，防止第二個 daemon 啟動。 |
| `qr-<時間>.png` | 登入用的 QR 碼。登入後最後一張會留著。 |

每個瀏覽器也會存網頁登入 cookie、本機草稿、回覆目標、mention 和未確認的傳送，
並可能快取媒體。「離開網頁」會清除 cookie，但不會清除那些草稿或撤銷已複製的
cookie。請在每個裝置的瀏覽器清除該網站資料與瀏覽器快取，才能移除本機資料；要撤銷
已複製的 cookie，請更換 web key 並重啟 daemon。

訊息怎麼存：

- daemon 執行期間收到的訊息會以解密後的內容儲存，開啟 Letter Sealing（端對端加密）
  的聊天室也一樣。
- 你往回捲時 daemon 抓回來的舊訊息，照 LINE 傳來的樣子儲存。開啟 Letter Sealing 的
  聊天室存的是密文，但能解開它的金鑰就在同一個目錄的 `storage.json` 裡。
- 有人收回訊息時，daemon 會把它標成已收回，原本的內容還留在磁碟上。

`media/` 和 `media/public-images/` 裡超過 14 天的檔案會被 daemon 刪掉；資料夾超過
500 MB 時，最舊的檔案會先被刪。`media/avatars/` 沒有天數限制，上限 20 MB。
`clipboard-*` 圖片在送出之後就會被 daemon 刪掉，不管送出成功或失敗。

外掛不加密這些檔案。任何能以你的身分讀這個目錄的人，都讀得到你的訊息。請把它排除在
備份與檔案同步之外。

在本機保留歷史紀錄是刻意的取捨。面板的行為跟桌面版 client 一樣：重開之後歷史紀錄還在，
媒體也不必再跟 LINE 要一次。代價是訊息內容跟能拿到這些訊息的 session 金鑰放在同一顆
磁碟上。

## 移除你的資料

- **在面板或網頁登出 LINE** 就會結束 session。daemon 會請 LINE 結束 session，並從
  `storage.json` 刪掉登入 token 相關的欄位（`.auth`、`refreshToken`、`expire`）。
  E2EE 金鑰、登入憑證、訊息歷史和媒體都還留在磁碟上。
- **要全部移除**，先登出。在 Omarchy 上照[解除安裝](README.zh-TW.md#解除安裝)的步驟
  停掉 daemon 並刪掉 state 目錄。在 Mac 上依 [docs/web.zh-TW.md](docs/web.zh-TW.md#在-mac-上執行)
  停掉 launchd agent，再刪除 `~/Library/LaunchAgents/io.github.frankekn.enil.plist`、
  `~/Library/Logs/enil/` 和它的 state 目錄。請清除各裝置的網站資料和瀏覽器快取，
  並在手機 LINE 的已登入裝置清單裡移除這台裝置。
- **只想清掉訊息歷史**，要先停掉 daemon。daemon 會把最近的聊天室留在記憶體裡，可能會
  再寫回去。在 Omarchy 使用預設 state 目錄時：

  ```bash
  systemctl --user stop enil
  rm -rf ~/.local/state/enil/messages
  systemctl --user start enil
  ```

  在 Mac 上，先依 [docs/web.zh-TW.md](docs/web.zh-TW.md#在-mac-上執行) 停止
  launchd agent，刪除它的 state 目錄中的 `messages/`，再重新執行 bootstrap 和
  kickstart。daemon 會重新跟 LINE 抓歷史紀錄，從頭建立新的本機副本。

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
- **不自己送東西。** 訊息、檔案、貼圖、表情回應或收回，只有你在面板上操作時才會送到
  LINE。已讀只會送給你正在面板裡看的那個聊天室。
  <!-- verify after merge: read receipts only for the chat being viewed -->
- **不繞過限制重試。** LINE 回報帳號或裝置受到限制時，daemon 會停掉所有自動發出的
  LINE 流量，並在面板上告訴你。
  <!-- verify after merge: restriction stop for ABUSE_BLOCK/BANNED/EXCESSIVE_ACCESS/NOT_AVAILABLE_USER/ACCOUNT_NOT_MATCHED -->
- **除了 LINE 的伺服器，不把你的資料送到其他伺服器。** daemon 只拿你的登入 token
  跟 LINE 的伺服器溝通，你的訊息和檔案也只送到 LINE。在你自己的電腦上，桌面通知會把
  聊天室名稱、傳送者和訊息預覽交給你的通知程式，通知程式可能會把它們留在通知紀錄裡。
- **不把憑證放進 repo。** session token 與金鑰只存在
  `~/.local/state/enil/storage.json`。

## 不帶任何你的資料的網路請求

- 貼圖、大頭貼和媒體來自 LINE 的主機，或 LINE 交給 daemon 的網址。
- FLEX 訊息可以指向任何公開 HTTPS 主機上的圖片，daemon 會把它們下載下來給面板顯示。
  那台主機看得到你的 IP 位址，也大致知道圖片是什麼時候被抓的。這個請求是單純的
  `GET`，不帶 cookie，也不帶 LINE token。daemon 拒絕 `http:` 網址，也拒絕解析到私有
  位址的主機。
- 安裝與更新時會從 JSR 和 npm 下載 daemon 的相依套件，並從 GitHub 下載 linejs fork。

## 存在磁碟上的資料

全部都在 `~/.local/state/enil/`（或 `$XDG_STATE_HOME/enil/`）。daemon 以 `0700` 建立
這個目錄，每次啟動時都把目錄設回 `0700`、把 `storage.json` 設回 `0600`。這些權限能擋住
這台電腦上的其他使用者，但擋不住以你的身分執行的程式。

| 路徑 | 內容 |
|---|---|
| `storage.json` | 你的登入 token、refresh token、E2EE 金鑰與登入憑證。**這個檔案就是你的 LINE 帳號。** |
| `storage.json.corrupt-<時間>` | daemon 讀不了而移到一旁的 session 檔，裡面可能還有你的金鑰。 |
| `messages/<你的-mid>/<聊天室-mid>.jsonl` | daemon 看過的每一則訊息，一個聊天室一個檔案。不會自動清理。 |
| `media/` | 你打開過的檔案與圖片的解密原檔、縮圖，以及等著送出的 `clipboard-*` 圖片。 |
| `media/avatars/` | 大頭貼。 |
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

- **在面板登出**就會結束 session。daemon 會請 LINE 結束 session，並從 `storage.json`
  刪掉登入 token 相關的欄位（`.auth`、`refreshToken`、`expire`）。E2EE 金鑰、登入
  憑證、訊息歷史和媒體都還留在磁碟上。
- **要全部移除**，先登出，再照[解除安裝](README.zh-TW.md#解除安裝)的步驟做。它會停掉
  daemon 並刪掉 state 目錄。接著在手機 LINE 的已登入裝置清單裡移除這台裝置。
- **只想清掉訊息歷史**，要先停掉 daemon。daemon 會把最近的聊天室留在記憶體裡，可能會
  再寫回去。

  ```bash
  systemctl --user stop enil
  rm -rf ~/.local/state/enil/messages
  systemctl --user start enil
  ```

  daemon 會重新跟 LINE 抓歷史紀錄，從頭建立新的本機副本。

# 安全：你的帳號與你的資料

[English](SAFETY.md)

這一頁列出外掛怎麼對待你的 LINE 帳號，以及它留在你電腦上的資料。使用非官方
client 本身的風險，請先看 [免責聲明](README.zh-TW.md#免責聲明)。要回報安全問題，
請照 [SECURITY.zh-TW.md](SECURITY.zh-TW.md) 的步驟。

貢獻者與維護者另外遵守 [docs/MAINTAINERS-SAFETY.zh-TW.md](docs/MAINTAINERS-SAFETY.zh-TW.md)
裡的紅線。

## 外掛永遠不做的事

- **永遠不轉移你的帳號。** daemon 以次要裝置的身分掃 QR 碼登入。它永遠不啟動
  LINE 的帳號轉移流程（EasyMigration、「搬移帳號」，或「要使用這個裝置做為主要
  裝置嗎？」那個選項），因為那個流程可能讓你的手機被登出。你的手機一直是主要裝置。
- **永遠不自己送東西。** 訊息、檔案、貼圖、表情回應或收回，只有你在面板上操作
  時才會送到 LINE。已讀回條只會送給你在面板裡打開的那個聊天室。
- **除了 LINE，永遠不把你的資料送到別的地方。** daemon 只拿你的登入 token 跟
  LINE 的伺服器溝通，你的訊息和檔案也只送到 LINE。不共享、不同步，也不上傳到
  任何其他地方。
- **永遠不把憑證放進 repo。** session token 與金鑰只放在
  `~/.local/state/enil/storage.json`。

daemon 另外還會發出一些不帶任何你的資料的網路請求：

- 貼圖、大頭貼和媒體來自 LINE 的主機，或 LINE 交給 daemon 的網址。
- FLEX 訊息可以指向任何公開 HTTPS 主機上的圖片，daemon 會把它們下載下來給面板
  顯示。那台主機看得到你的 IP 位址。這個請求是單純的 `GET`，不帶 cookie，也不帶
  LINE token。daemon 拒絕 `http:` 網址，也拒絕解析到私有位址的主機。
- 第一次 `deno run` 會從 JSR 與 npm 下載 daemon 的相依套件。`git submodule update`
  會從 GitHub 下載 linejs fork。

## 落在磁碟上的東西

全部都在 `~/.local/state/enil/`（或 `$XDG_STATE_HOME/enil/`）。daemon 以 `0700`
建立這個目錄，每次啟動時都把它設回 `0700`，並把 `storage.json` 設回 `0600`。這台
電腦上除了 root 之外，沒有其他使用者能打開裡面的任何東西。

- `storage.json` 存你的登入 token 與 E2EE 金鑰。**這個檔案就是你的 LINE 帳號。
  永遠不要備份或複製到任何地方。**
- `messages/<你的 mid>/<聊天室 mid>.jsonl` 保存 daemon 看過的每一則訊息，一間
  聊天室一個檔案，直到你刪掉為止。每一行是 LINE 送來的原樣訊息，另外還有收回與
  表情回應的紀錄。
- `state.json` 與 `events.json` 以可讀形式存聊天室清單、訊息預覽與最近的訊息。
- `media/` 存下載的圖片、影片縮圖、大頭貼、貼圖與 FLEX 圖片。
- `panel-drafts.json` 存你打了但還沒送出的文字。

外掛不加密這些檔案。letter-sealed（E2EE）聊天室存的是 LINE 送來的密文，但解開
它們的金鑰就在同一個目錄的 `storage.json` 裡。LINE 不 letter-seal 的聊天室存的是
可讀文字。任何能以你的身分讀這個目錄的人，都讀得到你的訊息。

本地歷史是刻意的取捨。面板因此像桌面 client 一樣運作：歷史撐得過重啟，預覽媒體
不必再問一次 LINE。代價是訊息內容放在同一顆磁碟上，而這顆磁碟本來就存著能抓取
這些訊息的 session 金鑰。

## 移除你的資料

- 在面板按 **登出** 結束 session。daemon 會請 LINE 結束這個 session，並從
  `storage.json` 刪掉登入 token。E2EE 金鑰、訊息歷史與媒體快取會留在磁碟上。
- 要全部移除，先登出、停掉 daemon，再刪掉 state 目錄。指令在
  [解除安裝](README.zh-TW.md#解除安裝) 一節。接著打開手機上的登入中裝置清單，
  如果這台裝置還在，就把它移除。
- 只想丟掉訊息歷史，執行 `rm -rf ~/.local/state/enil/messages`。daemon 會重新向
  LINE 抓歷史，並開始新的本地副本。

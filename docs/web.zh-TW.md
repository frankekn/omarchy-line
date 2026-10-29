# 網頁版

[English](web.md)

daemon 也可以用網頁提供 LINE。一台機器執行 daemon、持有 LINE session，tailnet
裡的任何瀏覽器都可以使用它。這些瀏覽器共用 daemon 的那一個 LINE 登入，不會在你的
LINE 帳號裡多出裝置。

![打開群組聊天室的網頁版](images/web-zh.png)

網頁版預設關閉，設定 `ENIL_WEB_ADDR` 才會啟動。

| 變數 | 作用 |
|---|---|
| `ENIL_WEB_ADDR` | 要監聽的 `host:port`。請用這台機器的 Tailscale IP，例如 `100.64.0.1:3440`。不要用 `0.0.0.0`：這個位址是唯一的網路邊界。 |
| `ENIL_WEB_KEY` | 登入用的 key：16 個以上的 `A-Z a-z 0-9 - . _ ~`。沒設定時，每次啟動都會產生新的 key。 |

daemon 啟動時會記錄 `[web] sign in: http://<addr>/?key=<key>`。每個瀏覽器開一次
這個連結，或開位址後輸入 key。之後瀏覽器會保留 cookie 400 天。換掉 key 就會讓
所有瀏覽器登出。

如果位址還不存在（Tailscale 還在啟動），daemon 每 10 秒重試一次，LINE 本身照常運作。

## 網頁版能做和不能做的事

網頁送出的指令和 panel 相同，透過 WebSocket 轉到 daemon 自己的 socket。和 panel
不同的地方：

- 檔案要先從瀏覽器上傳，再傳送。上傳的檔案放在 `media/web-uploads/`，LINE 收到後
  就刪除，最多保留一天。
- 剪貼簿指令一律拒絕，因為它們讀的是 daemon 那台機器的剪貼簿，不是瀏覽器的。
  要傳圖片，請直接貼到網頁裡。
- 網頁只能讀 media 快取和登入 QR，讀不到 `storage.json` 或其他檔案。
- 只有圖片和 MP4 會在瀏覽器裡開啟，其他檔案一律下載。

## 在 Mac 上執行

同一個 LINE session 只能有一台機器持有。先停掉另一台的 daemon
（`systemctl --user disable --now enil`），兩台絕不能同時執行。

1. 安裝 Deno 和 FFmpeg：`brew install deno ffmpeg`。
2. 用 `--recurse-submodules` clone 這個 repo。
3. 把 `daemon/enil.plist` 複製到
   `~/Library/LaunchAgents/io.github.frankekn.enil.plist`，替換
   `@CHECKOUT@`、`@HOME@`、`@TAILSCALE_IP@` 和 `@WEB_KEY@`。
4. `mkdir -p ~/Library/Logs/enil`，然後
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.frankekn.enil.plist`。
5. 開 `http://<tailscale-ip>:3440/?key=<key>`，用 QR 登入 LINE。

在 macOS 上 daemon 沒有桌面通知，也沒有休眠事件。watchdog 仍然會重建停滯的
push 連線。

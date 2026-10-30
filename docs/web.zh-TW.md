# 網頁版

[English](web.md)

daemon 也可以用網頁提供 LINE。一台機器執行 daemon、持有 LINE session，tailnet
裡的任何瀏覽器都可以使用它。這些瀏覽器共用 daemon 的那一個 LINE 登入，不會在你的
LINE 帳號裡多出裝置。

![打開群組聊天室的網頁版](images/web-zh.png)

網頁版預設關閉，設定 `ENIL_WEB_ADDR` 才會啟動。

| 變數 | 作用 |
|---|---|
| `ENIL_WEB_ADDR` | 要監聽的 `host:port`。請用這台機器的 Tailscale IP，例如 `100.64.0.1:3440`。不要用 `0.0.0.0`：對機器實際 IP 的請求會被拒絕。 |
| `ENIL_WEB_KEY` | 登入用的 key：16 個以上的 `A-Z a-z 0-9 - . _ ~`。沒設定或格式不對時，每次啟動都會產生新的 key。 |

daemon 啟動時會記錄 `[web] sign in: http://100.64.0.1:3440/?key=<ENIL_WEB_KEY>`。
log 不會顯示由 `ENIL_WEB_KEY` 設定的 key；daemon 自行產生新 key 時，這行才會顯示
那個 key。在每個瀏覽器開啟位址後，輸入 key。之後瀏覽器最多保留 cookie 400 天。
能連到位址且持有 key 或有效 cookie 的人都能讀取和傳送訊息。換掉 key 並重啟
daemon，會讓所有瀏覽器登出。「離開網頁」只清除該瀏覽器的 cookie，不會撤銷已複製的
cookie，也不會登出 LINE。如果 cookie 或 key 可能外洩，請更換 key。網頁使用
HTTP，因此 cookie 沒有 `Secure` 屬性。請使用可信任的 Tailscale 網路，並保護登入
連結。

連結登入和表單登入各有獨立的鎖定，適用於整個 web server。任一方式在十分鐘內收到
十次錯誤 key，就會暫時阻止該方式登入，正確 key 也受阻，直到其中一次錯誤超過十分鐘。
若只有連結被鎖定，請在登入頁面輸入 key；若只有表單被鎖定，仍可使用登入連結。
兩種方式合計最多允許十分鐘內輸入 20 次錯誤 key。
`Host` 與 `ENIL_WEB_ADDR` 不符的請求會回 421。帶有
`Sec-Fetch-Site: cross-site` 或 `same-site` 的登入請求會回 403，且不計入鎖定次數。
帶有 `Origin` 的 POST 和 WebSocket 請求必須與網頁同源；沒有 `Origin` 的請求也會允許，以支援非
瀏覽器 client。這項檢查不取代身分驗證。伺服器最多同時接受 32 條 WebSocket 連線。

瀏覽器的 local storage 會存草稿、回覆目標、mention 和未確認的傳送，也可能快取媒體。
「離開網頁」不會清除這些資料。要刪除它們，請清除瀏覽器的網站資料與快取；這也會清除
cookie。網頁收到 LINE 登出狀態時，會清除該帳號的草稿。

如果位址還不存在（Tailscale 還在啟動），daemon 每 10 秒重試一次，LINE 本身照常運作。

## 網頁版能做和不能做的事

網頁送出的指令和 panel 相同，透過 WebSocket 轉到 daemon 自己的 socket。和 panel
不同的地方：

- 檔案要先從瀏覽器上傳，再傳送。上傳的檔案放在 `media/web-uploads/`；daemon 回覆
  傳送結果後，bridge 會嘗試刪除，不論成功或失敗。殘留的上傳檔（包括未送出或回覆
  遺失的檔案）超過 24 小時後，會在啟動時或之後每小時的清掃中刪除；daemon 停止或
  刪除失敗時可能留得更久。上傳檔共用 1 GiB 儲存上限，最多同時進行四個上傳。上傳
  連續 30 秒沒有資料，或總時間超過一小時，就會停止。
- 剪貼簿指令一律拒絕，因為它們讀的是 daemon 那台機器的剪貼簿，不是瀏覽器的。
  要傳圖片，請直接貼到網頁裡。
- WebSocket 只轉送網頁本身會送出的指令，其他 daemon 指令一律拒絕。
- 網頁只能讀 media 快取和登入 QR。這個邊界假設 state 目錄沒有被不可信任的本機程式
  更動。以 daemon 使用者身分執行的程式本來就能直接讀取 `storage.json`。
- 伺服器可直接顯示 JPEG、PNG、GIF、WebP 和有 ISO-BMFF `ftyp` 標記的檔案；其他
  檔案會下載。能否播放取決於瀏覽器。
- 圖片和 GIF 上限為 20 MiB，影片和檔案上限為 1 GiB；網頁會在上傳前檢查內容和檔名。
- 瀏覽器直接從 HTTPS 網址載入貼圖和 FLEX 圖片。那些主機看得到瀏覽器的 IP 位址與
  請求的網址。

側欄標題列顯示目前可見的聊天數，並提供「同步」，可更新聊天清單和目前的聊天室。
LINE 連線中斷與帳號受限提示也提供重試。搜尋會比對聊天名稱、發話者和訊息預覽。
要取消隱藏，請搜尋並開啟標示「已隱藏」的結果，再按「取消隱藏」。已載入的歷史中若能
辨識第一則未讀訊息，就會在它前面顯示分隔線。點引言可跳到已載入的原訊息。圖片檢視器
可用箭頭切換圖片，並用滾輪、雙擊、雙指或按鈕縮放。

停在底部跟著新訊息時，頁面可能移除較舊的已載入訊息，保留約 500 則已確認訊息；
往上捲可以嘗試再次載入，請留意下方的稀疏快取限制。往上閱讀時會保留已載入的歷史；
若移除會影響未讀分隔線、選取、焦點或媒體，頁面會延後移除。

未確認的傳送會保留，讓你查看或手動重試。如果結果未知，重試可能會送出兩次。最近已
確認的傳送會留在畫面上等待對應的 echo；重新載入頁面會清除這份暫存。

圖片檢視器關閉、焦點在聊天清單或訊息區時，`/` 會回到清單並聚焦搜尋框，`r`
會同步，`j`／`k` 可以選擇聊天或捲動訊息。這些單字元快捷鍵在其他控制項上不會
作用。工作區首次顯示時，若 viewport 寬於 700 px、主要指標不是 coarse，且沒有其他
焦點，就會聚焦聊天清單。點擊空白處可能讓焦點回到頁面 body；這些快捷鍵會停止，直到
重新聚焦清單或訊息區。

焦點不在輸入欄時，也可用上下鍵導航；在清單導航時，焦點在清單、聊天列或頁面 body，
Enter 可開啟選中的聊天。Esc 會先關閉 reaction 選單，訊息輸入框也適用。焦點不在輸入欄時，
之後會依序關閉貼圖或 mention 選單、取消回覆、回到清單或清空搜尋。訊息輸入框內的
Esc 也可以關閉 mention 選單。這些快捷鍵只在聊天工作區開啟時作用，並忽略 Ctrl、
Alt、Command 及輸入法組字；上下鍵、`j`／`k`、`/` 和 `r` 不要搭配 Shift。

訊息輸入框有 mention 選項時，Enter 會選擇該選項。否則只有在 viewport 寬至少
701px 且主要指標精細時，Enter 才會送出；其他情況會換行。Shift+Enter 換行。
圖片檢視器用左右鍵切換圖片、`+`／`=` 和 `-` 縮放、Shift 加方向鍵平移，Esc 關閉。
放大的圖片也可以拖曳。

重連時若發現網頁 cookie 已失效，會停止重連並顯示提示及登入連結。頁面和輸入框會
保留，你可以先複製草稿再登入。已存入瀏覽器儲存空間的草稿，重新登入後仍可使用。

## 已知限制

- 網頁只能透過 `ENIL_WEB_ADDR` 設定的位址連到 daemon。請用該 IP 開啟，不要用
  MagicDNS 或其他主機名稱；使用其他主機名稱的請求會被拒絕。
- 不要在同一個 IP 位址上執行其他 HTTP 服務。瀏覽器不按 port 區分 cookie，所以同一
  位址上其他 port 提供的網頁可以讀取並送出 enil 登入 cookie。cookie 有 `HttpOnly`
  屬性：這裡的「讀取」是指其他服務會從 HTTP 請求收到它；頁面的 script 無法透過
  `document.cookie` 直接讀取。
- 帶有 `?key=` 的登入連結會留在瀏覽器歷史紀錄。建議在登入頁面輸入 key。若使用登入
  連結，請從網址列或終端機直接開啟。瀏覽器送出 `Sec-Fetch-Site: cross-site` 或
  `same-site` 時，從其他網站開啟的連結會被拒絕。瀏覽器在一般 HTTP 上（包括
  Tailscale IP）可能不送這個標頭，此時登入可能成功，錯誤 key 會計入連結登入鎖定。
  不要依賴這項檢查阻擋其他網站的連結。表單有獨立的鎖定。
- HTTP cookie 沒有 `Secure` 屬性。瀏覽器通知通常需要 HTTPS 或其他安全來源，而這個
  網頁目前沒有實作瀏覽器通知。daemon 的桌面通知是另一項功能。
- 每個十次錯誤 key 造成的登入鎖定都適用於該 web server 的所有瀏覽器。鎖定期間，
  正確 key 也不能使用被鎖定的方式登入，直到錯誤次數過期。
- cookie 不能逐一撤銷。換 key 並重啟 daemon，會使所有 cookie 失效。
- `/api/file` 的媒體可能在瀏覽器快取保留最多 24 小時。換 web key 會讓所有瀏覽器
  登出，但不會刪除瀏覽器已快取的媒體。登入 QR 回應有相同的快取時效；過期副本仍可能
  留在瀏覽器儲存空間，直到被清除或淘汰。
- 從快取載入歷史首頁時，如果 LINE 的 history 回覆較慢，可能暫時顯示編輯前的舊內容。
  背景重新驗證也可能失敗。
- 無法向聊天室 ID 以 `r` 開頭的多人聊天室傳檔案。
- 瀏覽器的頁面搜尋（包括 Ctrl+F）只搜尋目前已載入的訊息。
- daemon 的本地訊息快取若有缺口，從頁面視窗裁掉的訊息可能無法往上載回。例如 daemon
  在待寫入的快取資料 flush 前中斷，就可能發生這個情況。
- 已登入的瀏覽器可以送出最大約 64 MiB 的 WebSocket frame，伺服器會先把整個 frame
  收進記憶體，之後 1 MiB 的檢查才會拒絕它。

## 在 Mac 上執行

同一個 LINE session 只能由一個 daemon 持有。先停掉另一台的 daemon
（`systemctl --user disable --now enil`）。另一個裝置上的官方 LINE 可以保持登入。

安裝 Deno 和 FFmpeg，並 clone repo 與 linejs：

```sh
brew install deno ffmpeg
git clone --recurse-submodules \
  https://github.com/frankekn/omarchy-line.git "$HOME/omarchy-line"
```

如果 checkout 已經存在，請先更新它並跳過 clone。若舊 agent 已載入，替換 plist 前
請先執行下方的 `launchctl bootout` 指令。下方指令會產生新的 web key，因此原有的
瀏覽器都需要重新登入。

先把下方的 `100.64.0.1` 換成這台 Mac 的 Tailscale IPv4 位址，再在 Mac 的終端機
執行這些指令。指令會產生新的隨機 web key，並填入 plist 的四個佔位值。log 目錄和
plist 都設為私人權限，因為兩者都可能包含 web key。plist 的 `NumberOfFiles` 軟、
硬限制都設為 8192。

```sh
checkout="$HOME/omarchy-line"
plist="$HOME/Library/LaunchAgents/io.github.frankekn.enil.plist"
tailscale_ip=100.64.0.1
web_key="$(openssl rand -hex 32)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/enil"
chmod 700 "$HOME/Library/Logs/enil"
cp "$checkout/daemon/enil.plist" "$plist"
chmod 600 "$plist"
plutil -remove ProgramArguments.1 "$plist"
plutil -insert ProgramArguments.1 \
  -string "$checkout/daemon/enil-run.sh" "$plist"
plutil -replace WorkingDirectory -string "$checkout/daemon" "$plist"
plutil -replace EnvironmentVariables.HOME -string "$HOME" "$plist"
plutil -replace EnvironmentVariables.ENIL_WEB_ADDR \
  -string "${tailscale_ip}:3440" "$plist"
plutil -replace EnvironmentVariables.ENIL_WEB_KEY -string "$web_key" "$plist"
plutil -replace StandardOutPath \
  -string "$HOME/Library/Logs/enil/enil.log" "$plist"
plutil -replace StandardErrorPath \
  -string "$HOME/Library/Logs/enil/enil.log" "$plist"
plutil -lint "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart "gui/$(id -u)/io.github.frankekn.enil"
```

log 不會顯示這個 key。可在同一個終端機用 `echo "$web_key"` 印出，或用
`plutil -extract EnvironmentVariables.ENIL_WEB_KEY raw "$plist"` 從 plist 讀出。
在 tailnet 裡的裝置開啟 `http://<Tailscale-IP>:3440/` 並輸入 key，再用 QR 登入
LINE：

```sh
tail -f "$HOME/Library/Logs/enil/enil.log"
```

要在這次登入期間停止 agent：

```sh
launchctl bootout "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/io.github.frankekn.enil.plist"
```

下次登入時 plist 會再載入。要提早啟動，請執行上面的 bootstrap 和 kickstart
指令。

Linux systemd unit 設有 `LimitNOFILE=8192`。更新已安裝的 plugin 後，執行它的
`daemon/install.sh`，安裝更新過的 unit 並重啟服務。檔案描述符耗盡時 daemon 會繼續
運作，listener 會重試；描述符可用後就能再接受連線。

launchd 設定沒有 macOS 原生通知或休眠整合。缺少 `notify-send` 和 `dbus-monitor`
時，通知和休眠事件不會作用；watchdog 仍然會重建停滯的 push 連線。

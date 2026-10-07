# 開發

[English](development.md)

這一頁寫給要改程式的人。兩半怎麼搭在一起請看 [architecture.zh-TW.md](architecture.zh-TW.md)，
兩半之間的契約請看 [protocol.zh-TW.md](protocol.zh-TW.md)。pull request 的規則在
[CONTRIBUTING.zh-TW.md](../CONTRIBUTING.zh-TW.md)。

## 準備 checkout

```bash
git clone https://github.com/frankekn/omarchy-line.git
cd omarchy-line
git submodule sync -- daemon/vendor/linejs
git submodule update --init
```

daemon 需要 [Deno](https://deno.com) 2。面板的測試需要 Node.js。按鍵測試需要
`qt6-declarative` 裡的 `qmltestrunner`，沒裝的話會直接跳過。

## 跑檢查

開 pull request 之前，在 repo 根目錄跑下面這些。每一個都必須以 0 結束。

```bash
(cd daemon && deno task check && deno task no-any && deno task lint && deno task fmt && deno task test)
node tests/qml/run.js
tests/qml/keytest/run.sh
python3 daemon/stub_test.py
omarchy plugin validate .
qmllint -I /usr/share/omarchy/shell Panel.qml LinePanel.qml LineWindow.qml
```

- `deno task check` 做 daemon 的型別檢查。`deno task no-any` 和 `deno task lint`
  不允許 `any`。`deno task fmt` 檢查格式。`deno task test` 跑 daemon 的測試：它
  import `panelserver.ts` 測 socket 分派，還留在 daemon 程式碼裡的純函式則用
  `// enil:*` 標記切出來單獨測。
- `node tests/qml/run.js` 從 `Panel.qml` 切出函式本體來跑，不需要 daemon、socket 或
  state 目錄。
- `tests/qml/keytest/run.sh` 在 offscreen 的 `qmltestrunner` 下跑列表的按鍵路徑。
- `python3 daemon/stub_test.py` 拿 stub 對照協定，在自己的暫存 `XDG_STATE_HOME` 裡跑。
- `omarchy plugin validate .` 和 `qmllint` 需要本機的 Omarchy shell。

這些都證明不了畫面是對的。改完之後要在實機上確認：

```bash
omarchy restart shell                 # 改了 QML 之後
systemctl --user restart enil         # 改了 daemon 之後
```

`omarchy plugin validate` 不接受外掛資料夾裡有任何 symlink。有兩個決定讓 submodule
放進來之後它仍然能通過：`daemon/deno.json` 把 `nodeModulesDir` 設成 `"none"`，所以
不會出現 `daemon/node_modules/` 的 symlink；fork 根目錄的 `README.md` 是真正的檔案，
不是 symlink。要動其中任何一個之前先想到這一點。

## 用 stub 跑面板


只要有東西照這個契約寫檔案與監聽 socket，這個外掛就能用，不一定要是這個 daemon。
`daemon/stub.py` 就是這樣一個東西：純標準庫的假 daemon，餵假資料給面板，讓人不用真的
LINE session 也能改 UI。

```bash
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py              # 已登入
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py --logged-out # 未登入，可以試 QR 流程
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py --fixture busy
```

`--fixture` 有六個：`default`（`u`／`c`／`r` 各一個以上的聊天室，訊息涵蓋純文字、
多行、E2EE 解密失敗、圖片、影片、檔案、貼圖、FLEX、系統事件、自己發的、收回的、
過期的檔案）、`empty`（空清單）、`busy`（200 個聊天室，看清單捲動與搜尋）、
`notify`（就是 `default`，但開起來就已經有一筆 `wanted`，直接看「從通知點進來」
長什麼樣），以及 `demo-en` 和 `demo-zh`（README 的截圖，見[截圖](#截圖)）。`history`
會照 `before` 翻頁，`markRead` 會清未讀，`send` 會回一則 echo（`mentions` 照 daemon
那套驗過再掛回去），`sendFile` 對 `r…` 回跟 daemon 一樣的中文錯誤，`download` 對收回／
過期的訊息也是。`members` 對群組回假名單、對 1:1 和 room 回跟 daemon 一樣的中文拒絕；
`default` 裡有一則帶 @全部和 @某人的訊息，前面還放了一個表情符號，位移才會真的踩到
UTF-16 那個單位。

兩階段剪貼簿指令也在：stub 沒有剪貼簿，所以 `probeClipboardImage` 一律回一張畫出來的
假 PNG 的 `stage`，再交給 `sendClipboardImage` 送出（IMAGE，縮圖走 `preview`）；
探測時多加一個真 daemon **沒有**的 `empty: true` 才回「剪貼簿裡沒有圖片」，
不然面板那條「沒東西可以貼」的路只能靠清空真的剪貼簿才走得到。`sendFile` 的
`contentType` 也照 daemon 那套從副檔名判（IMAGE／VIDEO／FILE），影片不給 `mediaPath`，
太大的那三句拒絕也一模一樣。這是唯一不用真的準備一個 1 GB 檔案就能看到那句話的地方
（測試用的是 sparse 檔）。

`reply`／`react`／`unsend` 三個指令也都在，而且會照樣寫 `events`：`send` 和 `reply`
會補一筆 `message` 事件（真的 daemon 是 LINE 把自己送出的訊息推回來），兩秒後再補一筆
`read` 並把 `readBy` 掛上去。沒有這個「假的對方」，面板的「已讀」根本沒東西可以測。
`react` 換的是整串 `reactions`（不是差異），`unsend` 只肯收回 `ME` 送的那幾則。
fixture 裡本來就有帶 `replyTo`（含一則只有 `id`、引不到原文的）、`reactions` 和
`readBy` 的訊息。

貼圖也在：`stickers` 回兩個假的貼圖包（一包靜態、一包動態，`url` 是真的 CDN 路徑），
`sendSticker` 的兩句拒絕跟 daemon 一模一樣，送出去會是一則 `contentType: "STICKER"`、
帶 `stickerUrl` 的訊息事件。

`image` 也在，而且非有不可：面板只讀本機檔，少了它貼圖格、貼圖選單、FLEX 預覽和燈箱
在 stub 底下全是破圖。stub 沒有網路，所以圖是畫出來的。一個網址一個檔（sha256 命名、
跟 daemon 同樣放 `media/public-images/`、不帶副檔名），問幾次都是同一條路徑，`#` 後面
那半跟 daemon 一樣先丟掉。不是 `https://`、帶帳號密碼、或解析不出來的網址，回的是跟
daemon 一字不差的 `圖片下載失敗`。

大頭貼也在：一部分聊天室和送出者有 `avatarPath`／`fromAvatar`（`media/avatars/` 底下
畫出來的假圖），一部分故意沒有，因為沒有大頭貼的那一列面板一樣要畫得出來。

`hide`／`unhide` 也在（跟 daemon 一樣不看有沒有登入），被隱藏的那幾間會在寫 state 的
當下帶上 `hidden: true`：沒有它，右鍵選單、搜尋才找得回來、以及「隱藏之後不算未讀」
這幾條路在沒有 LINE session 的時候一條都走不完。stub 記在記憶體裡（它跟著暫存的
state 目錄一起丟掉），不寫 `hidden.json`。

stub 多一個真 daemon **沒有**的指令 `poke`：`{"cmd":"poke","chat":"<mid>"}` 會寫一筆
`state.wanted`，等同於「使用者點了那間聊天室的通知」。真的 daemon 是從 `notify-send`
的 action 走到這一步的，需要通知伺服器、一則通知和一個人去點它，開發時驅動不了。

`python3 daemon/stub_test.py` 把這些形狀釘在 [protocol.zh-TW.md](protocol.zh-TW.md) 的契約上（純標準庫，跑在自己的暫存
`XDG_STATE_HOME` 裡）。

**別讓 stub 指到真的 state 目錄**，它會蓋掉 `state.json`。

## 截圖

文件用的截圖一律對著 stub 拍，不要用真的帳號。真實截圖會拍到沒同意公開的人的名字、
大頭貼和訊息。

README 的截圖來自 `demo-en` 和 `demo-zh` 這兩個 fixture。每一個都是六個看起來像真實
帳號的聊天室，涵蓋面板會畫的東西：未讀徽章、提及、表情回應、已讀人數、引用回覆、
貼圖、FLEX 卡片、照片、檔案、收回的訊息和過期的檔案。`daemon/stub.py` 裡同一個函式
從兩張表建出這兩個 fixture，所以一種語言不會少掉另一種語言有的功能。要自己看其中
一個：

```bash
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py --fixture demo-en
```

`tools/demo_assets.py` 把這些 fixture 用到的圖畫到 `docs/images/demo/`：`DEMO_PEOPLE`
裡每個人和每個聊天室的縮寫大頭貼、三張像照片的風景、一組兩張卡片的 FLEX 輪播，以及
一張貼圖。它用 ImageMagick（`magick`）和 Noto Sans CJK TC 字型，從形狀和漸層畫出這些
圖，所以沒有授權問題。每次跑出來的結果都一樣。改了 `DEMO_PEOPLE` 之後要再跑一次。

`tools/demo-screenshots.sh` 會寫出 `docs/images/panel-en.png`、
`docs/images/panel-zh.png` 和 `docs/images/bar-badge.png`：

```bash
tools/demo-screenshots.sh       # 兩種語言
tools/demo-screenshots.sh zh    # 只拍一種語言
```

這個腳本需要一個正在跑的 Hyprland 0.56 或更新版本的 session，因為它用到 Lua
dispatcher。另外還需要 `omarchy-shell`、`quickshell`、`grim`、`hyprctl`、`jq`、
`magick` 和 `python3`。每一種語言，它都做這些步驟：

1. 用 `--fixture demo-<語言>` 在一個暫時的 state 目錄裡啟動 stub。
2. 在你的 shell 旁邊，用一個暫時的 `HOME` 啟動第二個暫時的 shell。那個 shell 的 bar
   上只有這個外掛，從你的 checkout 連過去，設成 `App window`。它有自己的
   `OMARCHY_PATH`，裡面沒有全域快捷鍵檔，所以不會搶你 shell 的 IPC socket 或快捷鍵。
   一個什麼都不做的 `systemctl` 讓它不會去重啟你真正的 daemon。
3. 只在第一種語言時，拍下帶未讀數的 bar 圖示。
4. 把面板開成 1040×860 的浮動視窗，打開示範聊天室，等 4 秒讓圖片載入，再拍下視窗。
5. 停掉 stub 和第二個 shell，刪掉暫時目錄。有步驟失敗的話，會留下目錄方便看 log。

第二個 shell 的 bar 會在它執行的那幾秒出現在你的 bar 下方。你的設定、state 和 daemon
都不會被動到。超過 400 KB 的截圖會改存成 256 色。`DEMO_OUT`、`DEMO_WIDTH`、
`DEMO_HEIGHT` 和 `DEMO_SETTLE` 可以改輸出目錄、視窗大小和等待時間。

## CI

`.github/workflows/ci.yml` 在 GitHub 提供的 `ubuntu-24.04` runner 上跑，對象是推到
`main` 的 commit，以及每一個 pull request（包括從 fork 來的 pull request）。它不用任何
secret，對 repo 只有唯讀權限。它跑上面那些檢查，但不跑需要 Omarchy shell 的
`omarchy plugin validate` 和 `qmllint`。另外還跑 `sh -n daemon/enil-run.sh`，
以及檢查 `manifest.json` 有沒有 `id`、`name` 和 `version`。

## 調校用的環境變數

daemon 會讀下面這些環境變數。要替 systemd unit 設定，執行 `systemctl --user edit enil`
並加一行 `Environment=`。數字不合法時會被忽略，journal 會留一行 `[env] <名稱> ignored`。

| 變數 | 預設 | 作用 |
|---|---|---|
| `ENIL_REQUEST_TIMEOUT_MS` | `30000` | 等 LINE 回應標頭的時間。上傳用 180 秒。 |
| `ENIL_PUSH_STALE_MS` | `180000` | push 連線安靜多久之後，watchdog 會重建它。 |
| `ENIL_CHAT_LIMIT` | `500` | 一次聊天列表請求要幾個聊天室。 |
| `ENIL_INCREMENTAL` | 開 | 設成 `0` 會讓每一次重新整理都整份重抓聊天列表。 |

`ENIL_DEVICE` 會覆寫 daemon 註冊時用的裝置類型，預設是 `ANDROIDSECONDARY`。這是開發
用的參數，不在支援範圍內：換成別的裝置類型會改變 LINE 允許的事，有些類型還會少掉
功能，例如查詢聯絡人名稱。

## 編譯執行檔

編譯 daemon 是選用的：

```bash
cd daemon
deno task build    # 產生 ./enil 和 ./enil.rev
```

只有 `enil.rev` 跟 checkout 的 `HEAD` 一致，而且 `daemon.ts` 沒有比執行檔新的時候，
`enil-run.sh` 才會用 `./enil`。否則它用 Deno 跑 `daemon.ts`，所以更新之後不會有舊的
執行檔繼續在跑。

## 效能測試

```bash
cd daemon
deno task bench:startup
deno task bench:thrift
```

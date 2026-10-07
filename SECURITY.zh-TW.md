# 安全政策

[English](SECURITY.md)

omarchy-line 是 Omarchy 上的非官方 LINE 面板。本機的 daemon 持有 LINE session 和它
看過的訊息，所以這裡的漏洞可能讓別人拿到一個人的帳號和聊天內容。

## 支援的版本

只有 `main` 上最新的 commit 會收到安全修正。回報問題之前，請先確認它在最新的
`main` 上還會發生。

## 私下回報漏洞

安全問題不要開公開 issue，請改用 GitHub 的私下漏洞回報：

1. 打開 repo 頁面 <https://github.com/frankekn/omarchy-line>。
2. 點 **Security**。
3. 點 **Report a vulnerability**。
4. 描述問題、你測試的 commit，以及重現的步驟。

只有維護者和維護者加進 advisory 的人看得到這份回報。

這是志願維護的專案，回應只能盡力而為。回報 30 天內沒有任何回覆的話，你可以公開
揭露。

## 安全港

只對你自己的安裝和你自己的 LINE 帳號做測試。只要你是善意測試，並且在這裡回報結果，
維護者不會對你採取任何行動。本專案無權授權任何人測試 LINE 的伺服器或其他人的帳號，
那部分仍然受 LINE 的條款和法律約束。

## 哪些算安全問題

- LINE session 外洩：`storage.json` 裡的登入 token、refresh token 或 E2EE 金鑰，經由
  log、檔案、socket 或面板流出去。
- 本機檔案權限讓這台電腦上的其他使用者讀得到 state 目錄、`storage.json`、訊息歷史或
  socket。預期的權限寫在 [SAFETY.zh-TW.md](SAFETY.zh-TW.md#存在磁碟上的資料)。
- 任何把你的資料送到 LINE 伺服器以外地方的路徑，或沒有你的操作就送出訊息、表情回應
  或已讀的路徑。
- 收到的訊息、FLEX 卡片或檔案能讓 daemon 或面板執行程式碼、寫入你沒要求的檔案，或
  連到私有網路位址。
- `.github/workflows/` 底下的 CI workflow 外洩 repo 的 secret，或讓不受信任的程式碼
  拿到 secret。
- 本專案釘住的那個 commit 上，內附的 linejs 的問題。上游 linejs 本身的問題請回報到
  [evex-dev/linejs](https://github.com/evex-dev/linejs)。

## 不在範圍內

- [SAFETY.zh-TW.md](SAFETY.zh-TW.md) 已經寫明的行為。例如 FLEX 圖片的主機看得到你的
  IP 位址，以及安裝時會從 JSR、npm 和 GitHub 下載相依套件。
- 需要 root，或需要已經以你的身分執行的程式碼才能做到的攻擊。這種程式碼本來就讀得到
  你的檔案。
- LINE 對非官方 client 施加的帳號限制。這是已知風險，[免責聲明](README.zh-TW.md#免責聲明)
  已經說明。

## 送出任何東西之前先遮蔽

回報、issue 或 log 片段裡絕對不能出現下面這些東西，私下回報也一樣。

- `storage.json` 的任何一部分。把整個檔案當成你的 LINE 密碼。
- mid。mid 是 LINE 使用者、群組或多人聊天室的 id：`u`、`c` 或 `r` 後面接 32 個十六
  進位字元。每一個都換成像 `u<redacted-1>` 這樣的佔位字串。
- 聊天裡的訊息文字、顯示名稱、大頭貼和檔案。
- `journalctl --user -u enil`、`state.json`、`events.json` 或 `messages/` 檔案的內容，
  除非你已經先把每一個 mid、名稱、token 和訊息文字都拿掉。daemon 大多數的錯誤訊息會
  把 mid 換成 `<mid>`，但不是全部。貼上之前每一行都要自己檢查。
- 拍到聊天、名稱或大頭貼的截圖。
- 登入時的 QR 碼和 PIN 碼。

如果需要真實資料才能重現，請在回報裡說明，維護者會告訴你需要哪些資料。

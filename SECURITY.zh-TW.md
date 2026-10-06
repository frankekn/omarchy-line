# 安全政策

[English](SECURITY.md)

## 支援的版本

只有 `main` 上最新的 commit 會收到安全修正。回報之前，請先確認問題在最新的 `main`
上還會發生。

## 私下回報漏洞

安全問題不要開公開 issue。請改用 GitHub 的私下漏洞回報：

1. 打開 repo 頁面 <https://github.com/frankekn/omarchy-line>。
2. 點 **Security**。
3. 點 **Report a vulnerability**。
4. 描述問題、你測試的 commit，以及重現的步驟。

只有 repo 的維護者看得到這份回報。

## 什麼算安全問題

- LINE session 外洩：`storage.json` 裡的登入 token、refresh token 或 E2EE 金鑰，
  經由 log 行、檔案、socket 或面板外流。
- 本機檔案權限讓這台電腦上的其他使用者讀得到 state 目錄、`storage.json`、訊息
  歷史或 socket。應有的權限寫在 [SAFETY.zh-TW.md](SAFETY.zh-TW.md#落在磁碟上的東西)。
- 任何把你的資料送到 LINE 伺服器以外地方的路徑，或是沒有你的操作就送出訊息、
  表情回應或已讀回條的路徑。
- 收到的訊息、FLEX 卡片或檔案能讓 daemon 或面板執行程式碼、寫出你沒要求的檔案，
  或連到私有網路位址。
- `.github/workflows/` 底下的 CI workflow 外洩 repo secret，或在拿得到 secret 的
  情況下執行不受信任的程式碼。

LINE 對非官方 client 施加的帳號限制是已知風險，不是漏洞。
[免責聲明](README.zh-TW.md#免責聲明) 有說明。

## 送出任何東西之前先遮蔽

回報、issue 或 log 摘錄永遠不可以包含下列內容。私下回報也一樣。

- `storage.json` 的任何部分。把整個檔案當成你的 LINE 密碼。
- mid。mid 是 LINE 的使用者、群組或聊天室 id：`u`、`c` 或 `r` 後面接 32 個
  十六進位字元。每一個都換成佔位字，例如 `u<redacted-1>`。
- 聊天裡的訊息文字、顯示名稱與檔案。
- `journalctl --user -u enil`、`state.json`、`events.json` 或 `messages/` 檔案裡的
  行，除非你已經先把裡面每一個 mid、名稱、token 與訊息文字都拿掉。daemon 在錯誤
  行裡會把 mid 換成 `<mid>`，但貼上之前請自己逐行檢查。
- 登入時的 QR 碼與 PIN 碼。

如果回報需要真實資料才能重現，請在回報裡說明。維護者會再詢問需要哪些資料。

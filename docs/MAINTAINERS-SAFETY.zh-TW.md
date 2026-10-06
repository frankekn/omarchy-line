# 維護者安全紅線

[English](MAINTAINERS-SAFETY.md)

這些規則約束每一個在本 repo 上工作的人與程式：每一位貢獻者、每一個 session，以及
每一支腳本或自動化工作。它們永久有效。外掛怎麼對待帳號與資料，給使用者看的摘要在
[SAFETY.zh-TW.md](../SAFETY.zh-TW.md)。

## 1. 永不使用 EasyMigration 或帳號轉移

永不研究、實作或呼叫 LINE 的帳號轉移流程（EasyMigration，或「搬移帳號」：舊裝置
顯示轉移 QR 碼，新裝置接手帳號）。

**原因。** 轉移語意會改變哪一台是主要裝置，可能讓使用者現有的主要裝置被降級或
登出。這是刻意的政策決定，不是技術限制。

## 1a.「主要裝置」提示本身就是轉移（2026-09-22 驗證）

憑證驗證之後，LINE Android 26.14.0 的新裝置登入會跳出「要使用這個裝置做為主要
裝置嗎？」對話框：

- **主要裝置**：「這會開始帳號轉移流程。你將在其他所有裝置上登出 LINE。」這就是
  轉移語意，等同 EasyMigration。永遠不可選。
- **次要裝置**：「你將保持主要裝置的登入狀態…」這是唯一允許的路。

**結論。** 「mint 一個主要 token 又不影響現有裝置的手機 OTP 登入」在設計上就不
可能。PAIS `migratePrimaryUsingPhoneWithTokenV3` 同樣是「migrate」語意。`/PBK4`
全量歷史備份權限也綁在主要裝置上，所以自動化永遠拿不到。個人帳號的備份因此是
滾動的近期歷史視窗，不是完整封存。

## 2. 其他紅線

- **不寫入未經批准的對象。** 個人帳號的傳送只發往使用者明確批准的收件人。OA bot
  的寫入測試只發往指定的測試 OA 帳號。
- **不偽造硬體 attestation。** 永不偽造 FCM push token，也不偽造 Strongbox 與裝置
  完整性 attestation。
- **憑證不進 repo。** session、token 與密碼只放在 `~/.local/state/` 底下與環境
  變數裡。
- **遇到風控錯誤碼就退。** 遇到 `ABUSE_BLOCK`、`BANNED`、`EXCESSIVE_ACCESS` 或
  `NOT_AUTHORIZED_DEVICE` 時，立即停止相關操作，並回報使用者。

## 3. 本地訊息庫的版式

daemon 的訊息庫 `~/.local/state/enil/messages/<你的 mid>/<聊天室 mid>.jsonl` 與 CLI
備份的 `archiveLine` 紀錄使用同一種行版式。[SAFETY.zh-TW.md](../SAFETY.zh-TW.md)
說明訊息庫存了什麼、誰讀得到、怎麼刪除。訊息庫有變動時，要讓那一頁保持正確。

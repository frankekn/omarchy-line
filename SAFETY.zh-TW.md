# SAFETY — 本專案永不實作的操作

[English](SAFETY.md)

任何在本 repo 上工作的 agent、session 或腳本，永久禁止下列行為：

## 1. EasyMigration／帳號轉移 —— 絕對禁止

LINE 的帳號轉移流程（EasyMigration／「搬移帳號」，舊裝置顯示轉移 QR、
新裝置接手帳號）**永不研究、實作或呼叫**。

**原因**：轉移語意會改變主要裝置狀態，可能讓使用者現有的主要裝置
被降級或登出。這是刻意的政策決定，不是技術限制。

## 1a.「主要裝置」提示**本身就是**轉移 —— 2026-09-22 驗證

憑證驗證之後，LINE 的新裝置登入（Android 26.14.0）會跳出
「要使用這個裝置做為主要裝置嗎？」對話框：

- **主要裝置**：「這會開始帳號轉移流程。你將在其他所有裝置上登出
  LINE。」← 這*就是*轉移語意（等同 EasyMigration）。永遠不可選。
- **次要裝置**：「你將保持主要裝置的登入狀態…」← 唯一允許的路。

**結論**：「mint 一個主要 token 又不影響現有裝置的手機 OTP 登入」
*在結構上不可能*。PAIS `migratePrimaryUsingPhoneWithTokenV3` 同樣是
「migrate」語意。`/PBK4` 全量歷史備份權限也綁在主要裝置上，自動化
永遠拿不到；個人帳號備份因此是滾動的近期歷史視窗，不是完整封存。

## 2. 其他紅線

- **不寫入未經批准的對象**：個人帳號的傳送只發往使用者明確批准的
  收件人；OA bot 的寫入測試只發往指定的測試 OA 帳號。
- **不偽造硬體 attestation**：FCM push token 與 Strongbox／裝置完整性
  attestation 永不偽造。
- **憑證不進 repo**：session、token、密碼只放在 `~/.local/state/`
  與環境變數。
- **風控錯誤碼要退**：遇到 ABUSE_BLOCK／BANNED／EXCESSIVE_ACCESS／
  NOT_AUTHORIZED_DEVICE，立即停止相關操作並回報使用者。

## 3. 本地訊息持久化 —— 落在磁碟上的東西

daemon 會把看過的訊息留一份本地永久副本，讓重開聊天室或預覽媒體
不必為使用者已收到的資料再問一次 LINE：

- **位置**：`~/.local/state/enil/messages/<你的 mid>/<聊天室 mid>.jsonl`
  —— 一間聊天室一個 append-only JSONL，按帳號 mid 命名空間。與 CLI
  備份的 `archiveLine` 紀錄同版式。
- **內容**：原始線上訊息（文字、metadata、媒體參照），加上收回墓碑
  與表情覆層。`storage.json`、媒體檔與大頭貼本來就放在同一目錄下。
- **靜態加密**：letter-sealed（E2EE）聊天室存的是*密文*——原始線上
  形式，LINE 伺服器看到的也是它。LINE 不 letter-seal 的聊天室存明文，
  與 `state.json` 快照、`media/` 縮圖在這顆磁碟上留的是同一批資料。
- **存取**：全部在 `~/.local/state/enil`（`0700`）底下——其他本機帳號
  無法穿越。不共享、不同步、不上傳。
- **刪除**：`rm -rf ~/.local/state/enil/messages` 丟掉全部快取訊息；
  daemon 只是退回向 LINE 抓並重新快取。已有的移除 state 目錄的解除
  安裝流程會一併移除它。

這是刻意的取捨：plugin 以「在同一顆已存有可取訊息的 session key 的
磁碟上保留訊息內容」為代價，換取桌面客戶端的行為（歷史撐過重啟、
媒體 metadata 在本地）。

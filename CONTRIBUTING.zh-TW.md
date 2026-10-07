# 參與貢獻

[English](CONTRIBUTING.md)

歡迎回報 bug、送修正或新功能。這一頁列出 pull request 要遵守的規則。怎麼準備
checkout、用 stub 跑面板、在實機上測試，請看 [docs/development.zh-TW.md](docs/development.zh-TW.md)。

## 安全規則

這些規則適用於本專案的每一個改動、每一個測試和每一個腳本。違反其中任何一條的 pull
request 都不會被合併。

- **永遠不用帳號轉移。** daemon 一律以次要裝置登入。不要研究、實作或呼叫 LINE 的
  帳號轉移流程，LINE 問要不要設成主要裝置時也不要選。轉移可能讓使用者的手機被登出。
- **只傳給帳號擁有者選定的對象。** 透過真實帳號傳送的自動化測試，只能傳給那個帳號的
  擁有者為測試挑選的對象。
- **永遠不偽造裝置身分。** 不要偽造裝置身分、推播註冊或完整性驗證訊號。
- **LINE 說停就停。** LINE 回報帳號或裝置受到限制時，停下那個操作並告訴使用者。永遠
  不要想辦法繞過限制再試。
- **憑證不進 repo。** session、token 和密碼只放在 `~/.local/state/` 底下和環境變數裡。
- **讓 SAFETY.md 保持正確。** [SAFETY.zh-TW.md](SAFETY.zh-TW.md) 說明程式碼怎麼處理
  帳號和磁碟上的資料。改動讓它不再正確時，要在同一個 commit 裡更新它。

## 在本機跑檢查

開 pull request 之前，在 repo 根目錄跑下面這些：

```bash
(cd daemon && deno task check && deno task no-any && deno task lint && deno task fmt && deno task test)
node tests/qml/run.js
tests/qml/keytest/run.sh
python3 daemon/stub_test.py
```

每一個指令都必須以 0 結束。沒裝 `qmltestrunner` 時，`tests/qml/keytest/run.sh` 會
跳過。有 Omarchy 的話，再跑一次 `omarchy plugin validate .`。

## Commit 訊息

使用 [Conventional Commits](https://www.conventionalcommits.org/)：`fix:`、`feat:`、
`perf:`、`docs:`、`test:`、`ci:`、`chore:`，有幫助的話加上 scope，例如 `fix(daemon):`
或 `fix(panel):`。commit 訊息用英文，主旨用祈使語氣，說清楚使用者會看到什麼改變。

## Pull request

- 一個 pull request 只做一件事。
- CI 會在 GitHub 提供的 runner 上，對每一個 pull request 跑上面的檢查（`omarchy
  plugin validate` 除外），從 fork 來的 pull request 也一樣。CI 不用任何 secret。
- 英文和繁體中文文件一起更新。每一個 `.md` 檔都有對應的 `.zh-TW.md`。
- 改到 UI 的話，附一張對著 stub 拍的截圖。

## 不要貼個人資料

issue、pull request、log 和截圖都是公開的。絕對不要附上 `storage.json`、mid、訊息
文字、顯示名稱、大頭貼、QR 碼或 PIN 碼。要遮蔽哪些東西，請看
[SECURITY.zh-TW.md](SECURITY.zh-TW.md#送出任何東西之前先遮蔽)。安全問題請照
SECURITY.zh-TW.md 的方式私下回報，不要開 issue。

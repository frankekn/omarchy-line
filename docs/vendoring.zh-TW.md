# 內附的 linejs fork

[English](vendoring.md)

daemon 透過 [Evex Developers](https://github.com/evex-dev) 的
[linejs](https://github.com/evex-dev/linejs) 跟 LINE 溝通。它不 import 已發布的
`jsr:@evex/linejs` 套件，而是 import `daemon/vendor/linejs` 這個 git submodule。
這個 submodule 追蹤公開 fork [frankekn/linejs](https://github.com/frankekn/linejs)
的 `omarchy-vendor` 分支。daemon 需要的修正在協定層，daemon 本身繞不過去，所以這些
修正放在 fork 裡。

linejs 採用 MIT 授權。內附的副本保留它的授權檔
[`daemon/vendor/linejs/LICENSE`](../daemon/vendor/linejs/LICENSE)。

## 釘住的 commit

submodule 釘在 `omarchy-vendor` 上的 `4d6aa18`。這個 commit 比上游 `802f4c7`
「fix: E2EE key registration and client message handling (#226)」多兩個 commit，
`802f4c7` 就是 `omarchy-vendor` 的起點。

- 第一個 commit 是對 `packages/linejs` 與 `packages/types` 的 omarchy 修補。
- 第二個 commit `4d6aa18` 把 fork 根目錄的 `README.md` 從 symlink 改成真正的檔案，
  讓 `omarchy plugin validate` 能通過。這個檢查工具不接受外掛資料夾裡有任何 symlink。

## fork 改了什麼

- **型別。** `@evex/loose-types` 的 `LooseType` 只留在 Thrift 讀寫程式碼、
  `base/push/connManager.ts` 和 `types/thrift.ts`，其他地方都換成具體型別。型別
  套件以 `@frankekn/linejs-types` 發布。
- **請求。** 請求的預設值跟著 LINE 目前的服務端點。呼叫端的 `AbortSignal` 會一路
  傳到加密請求，所以請求逾時對加密呼叫也有效。以前在休眠時斷掉的 keep-alive 連線
  可能永遠卡住。
- **E2EE。** 群組訊息會用它的 `groupKeyId` 指定的那一代共用金鑰解密，金鑰也按代
  快取。以前群組金鑰輪替之後，比較舊的訊息全部解不開。
- **媒體。** OBS 下載收到非 2xx 的回應時會丟出 `ObsError`，不會拖到後面才以
  「HMAC verification failed」失敗。`uploadMediaByE2EE` 接受 `durationMs`，所以
  E2EE 影片在對方那邊不會顯示 0:00。它也接受額外的 `contentMetadata`，但呼叫端不能
  覆寫 `DURATION`、`DOWNLOAD_URL` 或 `PREVIEW_URL`。媒體下載接受 `AbortSignal`。
- **推播與輪詢。** push 連線失敗或 listen 迴圈失敗會回報給呼叫端，不會變成讓 process
  掛掉的 unhandled rejection。
- **其他。** 新增 Album（`moa`）服務、調整通話功能、一個有連線逾時的 Node fetch
  （`base/core/node_fetch.ts`），以及新的測試。workspace 只保留 `packages/linejs`
  與 `packages/types`。

## 回饋給上游的修正

其中幾項修正以 pull request 的形式從這個 fork 的分支送回 `evex-dev/linejs`，上游
已經合併：

- [#231](https://github.com/evex-dev/linejs/pull/231)：讓 abort signal 穿過加密
  傳輸層。
- [#232](https://github.com/evex-dev/linejs/pull/232)：回報 push 連線失敗，不再讓它
  變成沒人處理的錯誤。
- [#233](https://github.com/evex-dev/linejs/pull/233)：抓取訊息加密時用的那一把群組
  共用金鑰。
- [#234](https://github.com/evex-dev/linejs/pull/234)：把非 2xx 的下載回應變成
  `ObsError`。
- [#239](https://github.com/evex-dev/linejs/pull/239)：讓 listen 迴圈持續運作，並
  為表情回應送出真正的 `reqSeq`。
- [#240](https://github.com/evex-dev/linejs/pull/240)：在 E2EE 上傳時帶上影片長度。

`802f4c7` 之後上游又往前走了。等上游包含 daemon 需要的所有東西，計畫是拿掉
submodule，把 `daemon/deno.json` 的 import map 改回 `jsr:@evex/linejs`。

## 跑 fork 的測試

fork 的測試在 fork 裡面跑：在它的根目錄執行 `deno test -A`。這會在 fork 裡產生
`node_modules/` 和 `deno.lock`。跑 `omarchy plugin validate` 之前要把這兩個刪掉，
因為檢查工具不接受 `node_modules/` 裡的 symlink。本專案的 `deno task test` 排除
`vendor/`，只跑自己的測試。

## 修改 linejs

在 `omarchy-vendor` 上改，再到本專案移動釘住的 commit：

```bash
git submodule sync -- daemon/vendor/linejs
git submodule update --init daemon/vendor/linejs
cd daemon/vendor/linejs
git switch omarchy-vendor             # 追蹤 origin/omarchy-vendor
git pull --ff-only
# 修改，然後在 omarchy-vendor 上 commit
deno test -A
rm -rf node_modules deno.lock
git push origin omarchy-vendor
cd ../../..
git add daemon/vendor/linejs          # 移動釘住的 commit
(cd daemon && deno task check && deno task test)
git commit -m "chore(daemon): bump vendored linejs"
```

少了 `git add daemon/vendor/linejs` 和最後的 `git commit`，本專案釘住的還是舊的
commit。

## 合併上游的改動

把上游合併進 `omarchy-vendor`，不要 rebase：

```bash
cd daemon/vendor/linejs
git remote add upstream https://github.com/evex-dev/linejs.git   # 只需一次
git fetch upstream
git switch omarchy-vendor
git merge upstream/main
deno test -A
rm -rf node_modules deno.lock
git push origin omarchy-vendor
cd ../../..
git add daemon/vendor/linejs
(cd daemon && deno task check && deno task test)
git commit -m "chore(daemon): merge upstream linejs"
```

不要 rebase 或 force-push `omarchy-vendor`。本專案過去的每一個 commit 都釘著那個分支
上的某個 commit。分支被改寫之後，那些 commit 不再屬於任何分支，舊 checkout 執行
`git submodule update` 時可能抓不到。

`.gitmodules` 有寫分支名稱，所以 `git submodule update --remote daemon/vendor/linejs`
會把 submodule 移到 `origin/omarchy-vendor` 的最新 commit。這樣移動的 pin 也要照上面
的方式測試並 commit。

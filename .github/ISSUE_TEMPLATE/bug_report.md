---
name: Bug report
about: Something in the panel or the daemon does not work
labels: bug
---

<!--
Do not paste personal data. Remove every mid (u/c/r followed by 32 hex
characters), name, message text, token, QR code, and PIN code. Never attach
storage.json or screenshots of real chats. Report security problems privately:
see SECURITY.md.

請勿貼上個人資料。請拿掉所有 mid、名稱、訊息文字、token、QR 碼與 PIN 碼。不要附上
storage.json 或真實聊天的截圖。安全問題請照 SECURITY.zh-TW.md 私下回報。
-->

## What happened

## What you expected

## Steps to reproduce

1.
2.
3.

## Versions

- Omarchy version (`omarchy version`):
- Plugin commit (`git -C ~/.config/omarchy/plugins/io.github.frankekn.line rev-parse --short HEAD`):
- Panel placement (Below the bar, Center of screen, or App window):

## Daemon log

Output of `journalctl --user -u enil -n 100 --no-pager`, with every mid, name,
and message text removed:

```text

```

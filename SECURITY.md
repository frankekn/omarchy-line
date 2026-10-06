# Security policy

[繁體中文](SECURITY.zh-TW.md)

## Supported versions

Only the latest commit on `main` gets security fixes. Before you report a
problem, check that it still happens on the latest `main`.

## Report a vulnerability privately

Do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting instead:

1. Open the repository page, <https://github.com/frankekn/omarchy-line>.
2. Click **Security**.
3. Click **Report a vulnerability**.
4. Describe the problem, the commit you tested, and the steps that show it.

Only the repository's maintainers can see the report.

## What counts as a security problem

- A leak of the LINE session: the login token, the refresh token, or the
  E2EE keys in `storage.json`, through a log line, a file, the socket, or the
  panel.
- Local file permissions that let another user on the machine read the state
  directory, `storage.json`, the message history, or the socket. The expected
  modes are in [SAFETY.md](SAFETY.md#what-lands-on-disk).
- Any path that sends your data somewhere other than LINE's servers, or that
  sends a message, a reaction, or a read receipt without your action.
- A way for a received message, a FLEX card, or a file to make the daemon or
  the panel run code, write a file you did not ask for, or reach a private
  network address.
- A CI workflow under `.github/workflows/` that exposes a repository secret
  or runs untrusted code with access to one.

Account restrictions that LINE applies to unofficial clients are a known
risk, not a vulnerability. The [Disclaimer](README.md#disclaimer) covers them.

## Redact before you send anything

A report, an issue, or a log excerpt must never contain these items. This
applies to private reports too.

- Any part of `storage.json`. Treat the whole file as your LINE password.
- mids. A mid is a LINE user, group, or room id: `u`, `c`, or `r` followed by
  32 hexadecimal characters. Replace each one with a placeholder such as
  `u<redacted-1>`.
- Message text, display names, and files from your chats.
- Lines from `journalctl --user -u enil`, `state.json`, `events.json`, or the
  `messages/` files, unless you have removed every mid, name, token, and
  message text from them first. The daemon replaces mids with `<mid>` in its
  error lines, but check every line yourself before you paste it.
- QR codes and PIN codes from a login.

If a report needs real data to reproduce, say so in the report. The
maintainer will ask for what is needed.

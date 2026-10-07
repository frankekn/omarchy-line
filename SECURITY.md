# Security policy

[繁體中文](SECURITY.zh-TW.md)

omarchy-line is an unofficial LINE panel for Omarchy. A local daemon holds a
LINE session and the messages it has seen, so a bug here can expose a
person's account and chats.

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

Only the maintainer and people they add to the advisory can see the report.

This is a volunteer project, so responses are best effort. If a report gets
no reply within 30 days, you may disclose it publicly.

## Safe harbor

Test only against your own installation and your own LINE account. If you do
that in good faith and report what you find here, the maintainer will not
take action against you. This project cannot authorize testing against
LINE's servers or against anyone else's account. LINE's terms and the law
still apply to that.

## What counts as a security problem

- A leak of the LINE session: the login token, the refresh token, or the
  E2EE keys in `storage.json`, through a log line, a file, the socket, or the
  panel.
- Local file permissions that let another user on the computer read the
  state directory, `storage.json`, the message history, or the socket. The
  expected modes are in [SAFETY.md](SAFETY.md#what-is-stored-on-disk).
- Any path that sends your data somewhere other than LINE's servers, or that
  sends a message, a reaction, or a read receipt without your action.
- A way for a received message, a FLEX card, or a file to make the daemon or
  the panel run code, write a file you did not ask for, or reach a private
  network address.
- A CI workflow under `.github/workflows/` that exposes a repository secret
  or runs untrusted code with access to one.
- A problem in the vendored linejs at the commit this repository pins. Report
  a problem in upstream linejs to
  [evex-dev/linejs](https://github.com/evex-dev/linejs) instead.

## Out of scope

- Behavior that [SAFETY.md](SAFETY.md) already documents. For example, a FLEX
  image host sees your IP address, installing fetches linejs from GitHub, and
  the daemon's first start downloads its dependencies from JSR and npm.
- Attacks that need root, or code that already runs as your user. Such code
  can read your files anyway.
- Account restrictions that LINE applies to unofficial clients. They are a
  known risk, and the [Disclaimer](README.md#disclaimer) covers them.

## Redact before you send anything

A report, an issue, or a log excerpt must never contain these items. This
applies to private reports too.

- Any part of `storage.json`. Treat the whole file as your LINE password.
- mids. A mid is a LINE user, group, or room id: `u`, `c`, or `r` followed by
  32 hexadecimal characters. Replace each one with a placeholder such as
  `u<redacted-1>`.
- Message text, display names, profile pictures, and files from your chats.
- Lines from `journalctl --user -u enil`, `state.json`, `events.json`, or the
  `messages/` files, unless you have removed every mid, name, token, and
  message text from them first. Most daemon error lines replace mids with
  `<mid>`, but not all of them do. Check every line yourself before you paste
  it.
- Screenshots that show chats, names, or profile pictures.
- QR codes and PIN codes from a login.

If a report needs real data to reproduce, say so in the report. The
maintainer will ask for what is needed.

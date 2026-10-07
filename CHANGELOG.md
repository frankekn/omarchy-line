# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers continue from the original omarchy-line plugin by Unayung
Chen, so this project starts at 2.x.

## [2.16.0] - Unreleased

### Added

- `daemon/install.sh` installs or refreshes the daemon in one command. It
  syncs and updates the linejs submodule, checks for Deno 2, copies the
  systemd user unit only when it changed, and enables and restarts
  `enil.service`. It never touches the state directory. Running it again is
  safe.
- When LINE refuses the account with `ABUSE_BLOCK`, `BANNED`, or
  `EXCESSIVE_ACCESS`, the daemon stops all automatic LINE traffic and keeps
  the session. The panel shows `LINE restricted this account (<code>);
  connection paused — tap to retry`. Tapping that line or logging in resumes
  traffic. `MAINTENANCE_ERROR` keeps retrying, and per-request errors such as
  `NOT_AVAILABLE_USER` do not stop the daemon.
  `state.json`'s `link` gains `reason` and `code` for this state.
- `demo-en` and `demo-zh` fixtures for the stub daemon, and
  `tools/demo-screenshots.sh`, which captures the README screenshots from
  them.
- A `markRead` socket command that sends only the read receipt, without
  fetching a history page.
- A disclaimer, [SAFETY.md](SAFETY.md), [SECURITY.md](SECURITY.md),
  [CONTRIBUTING.md](CONTRIBUTING.md), issue templates, and a pull request
  template. The README now covers install and use, and the internal material
  moved to [docs/](docs/).

### Changed

- Read receipts go to LINE only for the chat you are viewing. In the
  `Center of screen` and `App window` placements, the chat that stays in the
  right pane after you press Esc no longer gets marked read. Clicking into
  its reply box counts as viewing it again and marks the waiting messages
  read.
- The display controls next to the search box (placement, `A−` `A+`, and
  scroll speed) move below the search box when the chat list is narrow, and
  wrap onto a second line instead of clipping.
- Deno runs the daemon with the explicit permission list in
  `daemon/enil-flags.sh` instead of `-A`, for both `deno run` and the
  compiled binary. Writes are limited to the state directory, and
  subprocesses to six named programs.
- `enil-run.sh` looks for `deno` on `PATH`, then at `~/.deno/bin/deno`. It
  prints the fix and exits with code 78 when the linejs submodule is missing
  or out of date, and exits with code 127 when it finds no `deno`.
- The systemd unit restarts the daemon after any exit (`Restart=always`), and
  the panel starts the daemon again when it finds it stopped or hung.
- Reading an open chat costs one request instead of two full chat-list
  refreshes. The panel sends a read receipt only when the chat has unread
  messages.
- The daemon skips the `state.json` write when a full refresh changed
  nothing, and settles one row after a read instead of refreshing the whole
  list.
- The panel does no idle work while it is closed.
- The daemon stops asking again for thumbnails that LINE answered with 404.
- CI runs on GitHub-hosted `ubuntu-24.04` runners for pushes to `main` and
  for every pull request, including pull requests from forks, with no
  secrets. It runs the QML key tests, a shell syntax check of `enil-run.sh`,
  and a `manifest.json` check, in addition to the daemon and panel tests.

### Fixed

- A second daemon on the same state directory refuses to start instead of
  sharing the session.
- The session store, avatars, the event ring, `state.json`, and preference
  files are written atomically and completely, and the session store stays
  private.
- The daemon caps the length of a socket request line, and `sendFile`
  refuses anything that is not a regular file.
- Chat ids can no longer escape the message store's directory.
- The daemon times out a push to a panel that stopped reading, and shutdown
  works when the socket is already gone.
- The panel starts a new daemon boot from event `seq` 0.
- Recovering after a reconnect no longer marks the right pane's chat read.
- Chats you open are marked read during recovery.
- The app window remembers its size only while it floats.
- The self-reply and picture labels are translated, and `textScale` is
  clamped to its range.
- The panel cancels stale file-size checks and keeps the read policy during
  recovery.
- The panel queues `shell.json` writes and encodes `file://` URLs.
- Opening a chat swaps the list once and does not request a stray older
  page.
- Thumbnail paths stay out of the message model.
- The stub daemon exits on `SIGTERM` without waiting.

## Earlier versions

Releases 2.13.0 through 2.15.0 are tagged in git. See the
[tags](https://github.com/frankekn/omarchy-line/tags) and the commit history
for what changed before 2.16.0.

[2.16.0]: https://github.com/frankekn/omarchy-line/compare/v2.15.0...HEAD

# Development

[繁體中文](development.zh-TW.md)

This page is for people who change the code. Read
[architecture.md](architecture.md) for how the two halves fit together and
[protocol.md](protocol.md) for the contract between them.
[CONTRIBUTING.md](../CONTRIBUTING.md) has the rules for pull requests.

## Set up a checkout

```bash
git clone https://github.com/frankekn/omarchy-line.git
cd omarchy-line
git submodule sync -- daemon/vendor/linejs
git submodule update --init
```

The daemon needs [Deno](https://deno.com) 2. The panel tests need Node.js.
The key tests need `qmltestrunner` from `qt6-declarative` and skip when it is
missing.

## Run the checks

Run these from the repository root before you open a pull request. Each one
must exit 0.

```bash
(cd daemon && deno task check && deno task no-any && deno task lint && deno task fmt && deno task test)
node tests/qml/run.js
tests/qml/keytest/run.sh
python3 daemon/stub_test.py
omarchy plugin validate .
qmllint -I /usr/share/omarchy/shell Panel.qml LinePanel.qml LineWindow.qml
```

- `deno task check` type-checks the daemon. `deno task no-any` and
  `deno task lint` refuse `any`. `deno task fmt` checks formatting.
  `deno task test` runs the daemon tests. It imports `panelserver.ts` for
  socket dispatch. Pure functions that still live inside daemon code are
  sliced out between `// enil:*` markers and tested on their own.
- `node tests/qml/run.js` slices function bodies out of `Panel.qml` and runs
  them. It needs no daemon, socket, or state directory.
- `tests/qml/keytest/run.sh` runs the list view's key paths under an
  offscreen `qmltestrunner`.
- `python3 daemon/stub_test.py` checks the stub against the protocol. It runs
  inside its own temporary `XDG_STATE_HOME`.
- `omarchy plugin validate .` and `qmllint` need the local Omarchy shell.

None of these proves the screen looks right. After a change, check it on
real hardware:

```bash
omarchy restart shell                 # after QML changes
systemctl --user restart enil         # after daemon changes
```

`omarchy plugin validate` refuses any symlink inside the plugin folder. Two
choices keep it passing with the submodule in place. `daemon/deno.json` sets
`nodeModulesDir` to `"none"`, so no `daemon/node_modules/` symlinks appear.
The fork's root `README.md` is a real file, not a symlink. Keep both in mind
before you change either.

## Run the panel against the stub

Anything that writes this contract's files and serves this socket can drive
the plugin. It doesn't have to be this daemon. `daemon/stub.py` is exactly
that, a fake daemon in pure stdlib feeding fake data to the panel, so UI work
needs no real LINE session.

```bash
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py              # logged in
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py --logged-out # logged out, QR flow testable
XDG_STATE_HOME=/tmp/enil-stub daemon/stub.py --fixture busy
```

Four `--fixture`s: `default` (one each of `u`/`c`/`r` chats; messages cover
plain text, multiline, failed E2EE, image, video, file, sticker, FLEX, system
events, your own sends, unsent and expired), `empty` (an empty list), `busy`
(200 chats, for list scrolling and search), and `notify` (same as `default`
but opens with one `wanted` already set, so you can see the notification-click flow at
once). `history` pages by `before`, `markRead` (the flag and the command) clears unread, `send` echoes a
message back (`mentions` validated like the daemon then re-attached),
`sendFile` answers `r…` with the same refusal as the daemon, `download` does
the same for unsent/expired. `members` returns a fake list for groups and the
same refusal for 1:1 and rooms. `default` includes a message with @All and
@someone, preceded by an emoji so the offsets really exercise UTF-16 units.

The two-phase clipboard commands are in too: the stub has no clipboard, so
`probeClipboardImage` always returns a `stage` for a drawn fake PNG, which
`sendClipboardImage` then sends (IMAGE, thumbnail via `preview`). Adding
`empty: true` to the probe (something the real daemon **doesn't** have)
returns "剪貼簿裡沒有圖片". Otherwise the panel's "nothing to paste" path is
only reachable by emptying a real clipboard. `sendFile`'s `contentType` is
judged by extension like the daemon (IMAGE/VIDEO/FILE), videos carry no
`mediaPath`, and the three oversized refusals match word for word. The stub is the only
place you can see that message without preparing a real 1 GB file (tests use
sparse files).

`reply`/`react`/`unsend` are in too and write `events` like the real thing:
`send` and `reply` append a `message` event (the real daemon gets LINE's echo
of your own send), then a `read` event two seconds later with `readBy`
attached. Without this "fake peer" the panel's read receipts have nothing to
test against. `react` swaps the whole `reactions` list (not a delta), and
`unsend` only accepts messages `ME` sent. The fixture already includes
messages with `replyTo` (one only carrying `id`, unquotable), `reactions` and
`readBy`.

Stickers too: `stickers` returns two fake packs (one static, one animated,
`url`s on the real CDN paths), `sendSticker`'s two refusals match the daemon
verbatim, and a send produces a `contentType: "STICKER"` message event with a
`stickerUrl`.

`image` is in, necessarily: the panel only reads local files, so without it
the sticker grid, picker, FLEX previews and lightbox are all broken images
under the stub. The stub has no network so images are drawn, one file per
URL (sha256-named, same `media/public-images/` location as the daemon, no
extension), the same path every ask, with the `#` tail dropped like the
daemon. Non-`https://`, credentialed, or unparseable URLs get the daemon's
verbatim `圖片下載失敗`.

Avatars too: some chats and senders carry `avatarPath`/`fromAvatar` (drawn
fake images under `media/avatars/`), some deliberately don't. A row without
an avatar must still render.

`hide`/`unhide` are in (login-blind like the daemon), stamping `hidden: true`
at state-write time: without it the right-click menu, search-finds-it-back
and hidden-doesn't-count-unread paths can't run without a LINE session. The
stub keeps it in memory (dropped with the temp state dir) and never writes
`hidden.json`.

The stub has one command the real daemon lacks, `poke`.
`{"cmd":"poke","chat":"<mid>"}` writes a `state.wanted`, equivalent to "the
user clicked that chat's notification". The real daemon reaches the same
point via `notify-send`'s action, which needs a notification server, a
notification, and a person to click it, none of which development can drive.

`python3 daemon/stub_test.py` pins these shapes against [protocol.md](protocol.md)
(pure stdlib, runs inside its own temp `XDG_STATE_HOME`).

**Never point the stub at the real state dir.** It will overwrite
`state.json`.

## Take screenshots

Take screenshots for the docs against the stub, never against a real
account. Real screenshots show names, avatars, and messages of people who did
not agree to be published. Start the stub with a fixture, point the shell at
the same `XDG_STATE_HOME`, and save the images under `docs/images/`.

## CI

CI runs the same checks on GitHub-hosted runners for pushes to `main` and for
pull requests, including pull requests from forks.
<!-- verify after merge: CI on GitHub-hosted runners, fork PRs included -->

## Tuning variables

The daemon reads these environment variables. To set one for the systemd
unit, run `systemctl --user edit enil` and add an `Environment=` line. An
invalid number is ignored with an `[env] <name> ignored` journal line.

| Variable | Default | Effect |
|---|---|---|
| `ENIL_REQUEST_TIMEOUT_MS` | `30000` | Time to wait for a LINE response's headers. Uploads use 180 seconds. |
| `ENIL_PUSH_STALE_MS` | `180000` | How long the push connection may stay silent before the watchdog rebuilds it. |
| `ENIL_CHAT_LIMIT` | `500` | How many chats one chat-list request asks for. |
| `ENIL_INCREMENTAL` | on | Set to `0` to make every refresh a full chat-list fetch. |

`ENIL_DEVICE` overrides the device type the daemon registers as. The default
is `ANDROIDSECONDARY`. It is a development knob and is not supported: other
device types change what LINE allows, and some lose features such as contact
name lookup.

## Build a binary

A compiled daemon is optional:

```bash
cd daemon
deno task build    # writes ./enil and ./enil.rev
```

`enil-run.sh` uses `./enil` only when `enil.rev` matches the checkout's
`HEAD` and `daemon.ts` is not newer than the binary. Otherwise it runs
`daemon.ts` with Deno, so an update never leaves a stale binary running.

## Benchmarks

```bash
cd daemon
deno task bench:startup
deno task bench:thrift
```

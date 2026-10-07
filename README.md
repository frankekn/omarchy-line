# omarchy-line: an unofficial LINE panel for Omarchy

[![ci](https://github.com/frankekn/omarchy-line/actions/workflows/ci.yml/badge.svg)](https://github.com/frankekn/omarchy-line/actions/workflows/ci.yml)

[繁體中文](README.zh-TW.md)

Your unread LINE count in the Omarchy bar. Click it to search chats, read
messages, reply, and send files without leaving the desktop.

Built on [linejs](https://github.com/evex-dev/linejs) by
[Evex Developers](https://github.com/evex-dev).

| ![The panel in English: chat list and an open conversation](docs/images/panel-en.png) | ![The panel in Traditional Chinese](docs/images/panel-zh.png) |
| :-: | :-: |
| English | 繁體中文 |

![The bar icon with an unread count](docs/images/bar-badge.png)

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by LY
Corporation or LINE Corporation. "LINE" is a trademark of LY Corporation.
This project uses the name only to say which service the plugin works with.

- **Unofficial client, at your own risk.** LINE offers no API for personal
  accounts. The daemon logs in through `linejs`, an unofficial client for
  LINE's private protocol. Using an unofficial client may violate LINE's
  terms of use, and LINE can restrict or ban the account. The software comes
  with no warranty (see [LICENSE](LICENSE)).
- **It takes a device slot.** You log in by scanning a QR code with your
  phone. The daemon registers as a secondary device, so it shows up in your
  phone's list of logged-in devices. It never uses the account-transfer flow,
  so your phone stays the main device.
- **It keeps your session and your messages on disk.** Everything lives in
  `~/.local/state/enil/` (or `$XDG_STATE_HOME/enil/`), mode `0700`.
  `storage.json` (mode `0600`) holds the login token and the E2EE keys.
  `messages/` keeps every message the daemon has seen, and `media/` keeps
  downloaded files and thumbnails. The plugin does not encrypt these files.
- **You can remove what it stores on this machine.** Log out in the panel to
  end the session and delete the login token. To remove everything else too,
  follow [Uninstall](#uninstall).
- **You are responsible for how you use it.** Follow LINE's terms of use.
  The messages stored on your disk include other people's messages, so keep
  them as private as the people who sent them would expect.

[SAFETY.md](SAFETY.md) lists every file, what the code does not do, and the
network requests it makes.

## Features

- The unread count on the bar icon. The icon shows `!` while you are logged
  out.
- A chat list with unread chats first. Type to search chat names and message
  previews.
- Conversations with images, stickers, video thumbnails, FLEX cards, quote
  replies, reactions, and read state on your own messages. Messages in chats
  with Letter Sealing are decrypted.
- Reply with text, `@` mentions in groups, stickers, files, images, videos,
  and images pasted from the clipboard. Unsend your own messages.
- Desktop notifications while the panel is closed. Clicking one opens the
  panel in that chat.
- Hide chats on this computer only.
- Three placements: below the bar, in the center of the screen, or as a
  normal app window.
- When the chat list is narrow, the display controls next to the search box
  move below it and wrap onto a second line instead of being cut off.
- A Traditional Chinese or English interface.
- History stays on disk, so chats open without waiting for LINE after a
  restart.

[docs/usage.md](docs/usage.md) covers the keyboard, settings, and sending
files.

## Requirements

- [Omarchy](https://omarchy.org) with shell plugins (the `omarchy plugin`
  command).
- [Deno](https://deno.com) 2: `sudo pacman -S deno`.
- Your phone with LINE, to scan the login QR code.

Optional packages turn on more features. Without one, only that feature is
missing:

| Package | What it enables |
|---|---|
| `zenity` | The `📎` file picker. `/file <path>` works without it. |
| `ffmpegthumbnailer` or `ffmpeg` | A preview image on videos you send. |
| `wl-clipboard` | Copying message text (`wl-copy`) and sending images from the clipboard (`wl-paste`). |
| `libnotify` | Desktop notifications (`notify-send`). |
| `dbus` | `dbus-monitor` lets the daemon reconnect 3 seconds after the laptop wakes. Without it, the daemon notices a dead connection within about 3 minutes. |

## Install

1. Add the plugin:

   ```bash
   omarchy plugin add https://github.com/frankekn/omarchy-line.git --enable
   ```

2. Install the daemon:

   ```bash
   ~/.config/omarchy/plugins/io.github.frankekn.line/daemon/install.sh
   ```

`install.sh` does these steps. Each step checks the current state before it
changes anything, so you can run it again at any time:

- It runs `git submodule sync` and `git submodule update --init` to put the
  linejs submodule at the commit this checkout pins. `omarchy plugin add`
  does a plain `git clone`, which skips submodules.
- It looks for Deno on `PATH`, then at `~/.deno/bin/deno`. It stops with an
  error if it finds no Deno or finds a version older than 2.
- It copies `daemon/enil.service` to `~/.config/systemd/user/` and runs
  `systemctl --user daemon-reload`, but only when the installed unit differs.
- It enables `enil.service` and restarts it.

`install.sh` never touches the state directory `~/.local/state/enil/`. The
unit always runs the plugin in `~/.config/omarchy/plugins/io.github.frankekn.line`.
If you run `install.sh` from a different checkout, it prints a note, and the
service still runs the installed plugin, not that checkout.

To install the daemon without the script, run the same steps by hand:

```bash
cd ~/.config/omarchy/plugins/io.github.frankekn.line
git submodule sync --recursive
git submodule update --init --recursive
mkdir -p ~/.config/systemd/user
cp daemon/enil.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now enil
```

To read the daemon's log:

```bash
journalctl --user -u enil -f
```

## Log in

1. Have your phone in hand. The login QR code expires.
2. Click the LINE icon in the bar, then click **Log in to LINE**.
3. On your phone, open LINE, tap **Add friend**, then **QR code**, and scan
   the code in the panel.
4. The panel shows a PIN. Enter it on your phone.

When login works, the `!` on the bar icon goes away. If the QR code expires,
click **Try again**.

To log out, click **Log out** in the panel's toolbar.

## Update

```bash
omarchy plugin update io.github.frankekn.line
~/.config/omarchy/plugins/io.github.frankekn.line/daemon/install.sh
omarchy restart shell
```

`omarchy plugin update` updates only the main repository. `install.sh`
updates the linejs submodule and restarts the daemon, so the panel and the
daemon stay on the same version.

## Uninstall

1. Log out in the panel. This ends the session on LINE's side.
2. Stop the daemon and remove the plugin and its data:

   ```bash
   systemctl --user disable --now enil
   rm -f ~/.config/systemd/user/enil.service
   systemctl --user daemon-reload
   rm -rf ~/.local/state/enil
   omarchy plugin remove io.github.frankekn.line
   ```

3. In LINE on your phone, open the list of logged-in devices and remove this
   device if it is still there.

`~/.local/state/enil` holds your session, keys, message history, and media.
Deleting it removes them from this computer.

## FAQ

**Can LINE ban my account for this?** It can. LINE does not offer this kind
of access, and it decides what it allows. The daemon logs in as a secondary
device, and it sends no message, reaction, or read receipt unless you act in
the panel. If LINE answers with `ABUSE_BLOCK`, `BANNED`, or
`EXCESSIVE_ACCESS`, the daemon ends its push loop and makes no LINE request on
its own. The panel shows `LINE restricted this account (<code>); connection
paused — tap to retry`. Nothing retries until you tap that line, which runs a
manual sync, or log in again. A message you send yourself still goes to LINE,
and the panel shows LINE's error if LINE refuses it.
[docs/architecture.md](docs/architecture.md#when-line-restricts-the-account)
explains what stops and what stays.

**The daemon does not start. What do I check?** Run
`journalctl --user -u enil -n 20`. If the log says `daemon/vendor/linejs is
missing or out of date`, the linejs submodule does not match the plugin. Run
`install.sh` again, or the two `git submodule` commands that the log prints.
If the log says `deno not found`, install Deno 2 with `sudo pacman -S deno`.
`systemctl --user status enil` shows exit code 78 for the first case and 127
for the second. systemd tries again every 5 seconds, so the daemon starts by
itself once you fix the cause.

**Does it log out my phone?** No. The daemon logs in as a secondary device by
QR code. It never uses account transfer, which is the flow that moves the
main device.

**Can I use it on several computers?** Log in on each computer with its own
QR scan. Each one appears as its own device. Do not copy the state directory
from one computer to another: LINE changes the refresh token on every login,
so only one daemon can use a session.

**Does it work with Letter Sealing (end-to-end encryption)?** Yes. The daemon
holds this device's Letter Sealing keys and decrypts messages in chats that
use it. When you send, linejs encrypts the message if the other side
requires it. Videos in those chats show as an attachment without a
thumbnail, because the thumbnail is encrypted too.

**Where is my data?** In `~/.local/state/enil/`. [SAFETY.md](SAFETY.md)
lists every file and what it holds.

**Why not a Matrix bridge?** A [LINE bridge for Matrix](https://matrix.org/ecosystem/bridges/line/)
needs a Matrix homeserver and a Matrix client, and your messages pass
through the bridge. omarchy-line is a single daemon on your computer with a
panel in the Omarchy bar. If you already use Matrix, a bridge puts LINE next
to your other chats.

## Alternatives

- LINE's official desktop app for Windows and macOS.
- LINE's official [Chrome extension](https://chromewebstore.google.com/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc).
- A [Matrix bridge](https://matrix.org/ecosystem/bridges/line/).

## Why the daemon is called enil

`enil` is "LINE" spelled backwards.

## Documentation

- [docs/usage.md](docs/usage.md): keyboard, settings, files, and
  notifications.
- [docs/architecture.md](docs/architecture.md): how the panel and the daemon
  work together.
- [docs/protocol.md](docs/protocol.md): the state files and socket commands.
- [docs/vendoring.md](docs/vendoring.md): the vendored linejs fork.
- [docs/development.md](docs/development.md): checks, the stub daemon, and
  CI.
- [CONTRIBUTING.md](CONTRIBUTING.md): rules for pull requests.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

## Security and safety

- [SAFETY.md](SAFETY.md) says what the plugin does with your account and the
  data on your disk.
- [SECURITY.md](SECURITY.md) says how to report a vulnerability privately.

## Acknowledgements

- [linejs](https://github.com/evex-dev/linejs) by
  [Evex Developers](https://github.com/evex-dev), maintained mainly by
  [EdamAme-x](https://github.com/EdamAme-x), with
  [many contributors](https://github.com/evex-dev/linejs/graphs/contributors).
  omarchy-line could not talk to LINE without it. The vendored copy keeps its
  MIT license at
  [`daemon/vendor/linejs/LICENSE`](daemon/vendor/linejs/LICENSE). Several
  fixes from this project went back upstream, such as
  [#239](https://github.com/evex-dev/linejs/pull/239) and
  [#240](https://github.com/evex-dev/linejs/pull/240).
  [docs/vendoring.md](docs/vendoring.md#fixes-contributed-upstream) lists
  them all.
- [Unayung Chen](https://github.com/Unayung) wrote the original omarchy-line
  plugin. This project started as a fork of it, and its version numbers
  continue from that project's 2.x line.
- [Omarchy](https://omarchy.org) and its shell plugin system.
- [Quickshell](https://quickshell.org), which the Omarchy shell and this
  panel run on.

## License

[MIT](LICENSE).

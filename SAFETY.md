# Safety: your account and your data

[繁體中文](SAFETY.zh-TW.md)

This page lists what omarchy-line does with your LINE account and with the
data it keeps on your computer. For the risk of using an unofficial client at
all, read the [Disclaimer](README.md#disclaimer) first. To report a security
problem, follow [SECURITY.md](SECURITY.md).

## What the current code does not do

These statements describe the code on `main` today. A change that breaks one
of them must update this page in the same commit.

- **It does not transfer your account.** The daemon logs in by QR code as a
  secondary device. It never starts LINE's account-transfer flow, because
  that flow can log your phone out. Your phone stays the main device.
- **It does not send on its own.** A message, a file, a sticker, a reaction,
  or an unsend reaches LINE only when you do it in the panel. Read receipts go
  to LINE only for the chat you are viewing in the panel. In the
  `Center of screen` and `App window` placements, a chat stays in the right
  pane after you press Esc to go back to the list, but it gets no read
  receipts until you view it again. Clicking into its reply box counts as viewing it, and sends one read
  receipt for the messages that arrived in the meantime.
- **It does not retry around a restriction.** When LINE answers any request
  with `ABUSE_BLOCK`, `BANNED`, or `EXCESSIVE_ACCESS`, the daemon makes no
  LINE request on its own until you act. It ends the push loop instead of
  only ignoring its events. The panel shows `LINE restricted this account
  (<code>); connection paused — tap to retry`. Automatic traffic starts again
  only when you tap that line, which runs a manual sync, or log in. A message
  you send yourself still goes to LINE, and the panel shows LINE's error if
  LINE refuses it. Other errors, such as `MAINTENANCE_ERROR`, do
  not stop the daemon. [When LINE restricts the
  account](docs/architecture.md#when-line-restricts-the-account) has the
  details.
- **It does not send your data to any server except LINE's.** The daemon uses
  your login token only with LINE's servers, and sends your messages and
  files only to LINE. On your own computer, desktop notifications pass the
  chat name, the sender, and a message preview to your notification daemon,
  which may keep them in its history.
- **It does not put credentials in the repository.** The session token and
  keys live only in `~/.local/state/enil/storage.json`.

## What the daemon is allowed to do

Deno runs the daemon with a fixed permission list from
`daemon/enil-flags.sh`, and refuses anything outside it. The same list
applies to `deno run` and to a compiled binary.

| Permission | Allowed | Why |
|---|---|---|
| Network | Any host | FLEX messages and link previews name images on any HTTPS host, so the set of hosts is not known in advance. |
| Read files | Any path | You can send any file you pick, and the thumbnailer reads it where it is. |
| Write files | Only the state directory | Everything the daemon writes, temporary files included, lives in `~/.local/state/enil/`. |
| Run programs | `dbus-monitor`, `wl-paste`, `ffmpegthumbnailer`, `ffmpeg`, `omarchy-shell`, and `notify-send` | Wake detection, clipboard images, video thumbnails, and notifications. |
| Environment variables | `HOME`, `XDG_STATE_HOME`, the `ENIL_*` variables, `Q_DEBUG`, and `NODE_DEBUG` | The daemon's settings, plus two names that dependencies read at startup. |
| System information | None | |

## Network requests that carry none of your data

- Stickers, profile pictures, and media come from LINE's hosts or from
  addresses that LINE gives the daemon.
- A FLEX message can name images on any public HTTPS host, and the daemon
  downloads them so the panel can show them. That host sees your IP address
  and roughly when the image was fetched. The request is a plain `GET` with
  no cookies and no LINE token. The daemon refuses `http:` addresses and
  hosts that resolve to private addresses.
- `daemon/install.sh` downloads the linejs fork from GitHub as a git
  submodule.
- The first time the daemon starts from source, Deno downloads the JSR and
  npm dependencies that `daemon/deno.json` names, at the versions that
  `daemon/deno.lock` pins, into its cache (`~/.cache/deno` by default).
  `install.sh` starts the daemon, so this happens at the end of the install.
  Later starts use the cache. After a plugin update, Deno downloads only the
  versions that the cache does not have yet. `deno task build` downloads them
  at build time, and the compiled `enil` binary includes them, so the binary
  downloads nothing when it starts.

## What is stored on disk

Everything lives in `~/.local/state/enil/` (or `$XDG_STATE_HOME/enil/`). The
daemon creates this directory with mode `0700`. Each time it starts, it sets
the directory back to `0700` and `storage.json` back to `0600`. These modes
keep other users on the computer out. They do not protect the files from
programs that run as you.

| Path | What it holds |
|---|---|
| `storage.json` | Your login token, refresh token, E2EE keys, and login certificate. **This file is your LINE account.** |
| `storage.json.corrupt-<time>` | A session file the daemon could not read and moved aside. It may still hold your keys. |
| `messages/<your-mid>/<chat-mid>.jsonl` | Every message the daemon has seen, one file per chat. It is never cleaned up automatically. |
| `media/` | Decrypted originals of files and images you opened, thumbnails, and `clipboard-*` images waiting to be sent. |
| `media/avatars/` | Profile pictures. |
| `media/public-images/` | Stickers and FLEX images. |
| `state.json` | The chat list and the last message preview of each chat. |
| `events.json` | The newest 200 live events, including full recent messages. |
| `panel-drafts.json` | Text you typed but did not send. |
| `panel-stickers.json` | Your recently used stickers. |
| `avatars.json` | Which profile picture versions are already downloaded. |
| `hidden.json` | The chats you hid. |
| `sock` | The socket the panel talks to. |
| `lock` | An empty file that stops a second daemon from starting. |
| `qr-<time>.png` | The login QR code. The last one stays after you log in. |

How messages are stored:

- Messages that arrive while the daemon is running, including messages from
  chats with Letter Sealing (end-to-end encryption) on, are stored
  decrypted.
- Older messages that the daemon fetches when you scroll back are stored as
  LINE sent them. For a chat with Letter Sealing, that is ciphertext, but the
  keys that decrypt it are in `storage.json` in the same directory.
- When someone unsends a message, the daemon marks it as unsent. The original
  content stays on disk.

The daemon deletes files in `media/` and `media/public-images/` that are
older than 14 days, or the oldest ones when the folder grows past 500 MB.
`media/avatars/` has no age limit and a 20 MB cap. The daemon deletes a
`clipboard-*` image after the send, whether the send succeeds or fails.

The plugin does not encrypt any of these files. Anyone who can read this
directory as you can read your messages. Exclude it from backups and from
file sync.

The local history is a deliberate trade. The panel behaves like a desktop
client: history survives restarts, and media does not ask LINE again. In
exchange, message content sits on the same disk that already holds the
session keys able to fetch it.

## Remove your data

- **Log out** in the panel to end the session. The daemon asks LINE to end
  the session and deletes the login token fields (`.auth`, `refreshToken`,
  and `expire`) from `storage.json`. It keeps the E2EE keys, the login
  certificate, the message history, and the media on disk.
- **To remove everything**, log out, then follow
  [Uninstall](README.md#uninstall). It stops the daemon and deletes the state
  directory. Then remove this device from the list of logged-in devices in
  LINE on your phone.
- **To drop only the message history**, stop the daemon first. The daemon
  keeps recent chats in memory and may write them back.

  ```bash
  systemctl --user stop enil
  rm -rf ~/.local/state/enil/messages
  systemctl --user start enil
  ```

  The daemon fetches history from LINE again and starts a new local copy.

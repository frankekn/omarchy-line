# Safety: your account and your data

[繁體中文](SAFETY.zh-TW.md)

This page lists what the plugin does with your LINE account and with the data
it keeps on your machine. For the risk of using an unofficial client at all,
read the [Disclaimer](README.md#disclaimer) first. To report a security
problem, follow [SECURITY.md](SECURITY.md).

Contributors and maintainers also follow the red lines in
[docs/MAINTAINERS-SAFETY.md](docs/MAINTAINERS-SAFETY.md).

## What the plugin never does

- **It never transfers your account.** The daemon logs in by QR code as a
  secondary device. It never starts LINE's account-transfer flow
  (EasyMigration, "Carry over", or the "Use this as your main device?"
  choice), because that flow can log your phone out. Your phone stays the
  main device.
- **It never sends on its own.** A message, a file, a sticker, a reaction, or
  an unsend reaches LINE only when you do it in the panel. Read receipts go
  to LINE for the chat you open in the panel.
- **It never sends your data anywhere except LINE.** The daemon uses your
  login token only with LINE's servers, and sends your messages and files
  only to LINE. Nothing is shared, synced, or uploaded to any other place.
- **It never puts your credentials in the repository.** The session token
  and keys live only in `~/.local/state/enil/storage.json`.

The daemon makes some other network requests that carry none of your data:

- Stickers, profile pictures, and media come from LINE's hosts or from
  addresses that LINE gives the daemon.
- A FLEX message can name images on any public HTTPS host, and the daemon
  downloads them so the panel can show them. That host sees your IP address.
  The request is a plain `GET` with no cookies and no LINE token. The daemon
  refuses `http:` addresses and hosts that resolve to private addresses.
- The first run of `deno run` downloads the daemon's dependencies from JSR
  and npm. `git submodule update` downloads the linejs fork from GitHub.

## What lands on disk

Everything lives in `~/.local/state/enil/` (or `$XDG_STATE_HOME/enil/`). The
daemon creates this directory with mode `0700` and sets it back to `0700` and
`storage.json` back to `0600` each time it starts. No other user on the
machine, except root, can open anything inside it.

- `storage.json` holds your login token and your E2EE keys. **This file is
  your LINE account. Never back it up or copy it anywhere.**
- `messages/<your-mid>/<chat-mid>.jsonl` keeps every message the daemon has
  seen, one file per chat, until you delete it. Each line is the message as
  LINE sent it, plus unsend and reaction records.
- `state.json` and `events.json` hold the chat list, message previews, and
  recent messages in readable form.
- `media/` holds downloaded images, video thumbnails, profile pictures,
  stickers, and FLEX images.
- `panel-drafts.json` holds the text you typed but did not send.

The plugin does not encrypt these files. Letter-sealed (E2EE) chats are
stored as the ciphertext LINE sent, but the keys that decrypt them are in
`storage.json` in the same directory. Chats that LINE does not letter-seal
are stored as readable text. Anyone who can read this directory as you can
read your messages.

The local history is a deliberate trade. The panel behaves like a desktop
client: history survives restarts, and media previews do not ask LINE again.
In exchange, message content sits on the same disk that already holds the
session keys able to fetch it.

## Remove your data

- **Log out** in the panel to end the session. The daemon asks LINE to end
  the session and deletes the login token from `storage.json`. It keeps the
  E2EE keys, the message history, and the media cache on disk.
- To remove everything, log out, stop the daemon, and delete the state
  directory. The [Uninstall](README.md#uninstall) section has the commands.
  Then open the list of logged-in devices on your phone and remove this
  device if it is still there.
- To drop only the message history, run
  `rm -rf ~/.local/state/enil/messages`. The daemon fetches history from LINE
  again and starts a new local copy.

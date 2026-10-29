# Web page

[繁體中文](web.zh-TW.md)

The daemon can also serve LINE as a web page. One machine runs the daemon and
holds the LINE session, and any browser on your tailnet uses it. The browsers
share the daemon's one LINE login, so they add no devices to your LINE
account.

![The web page with a group chat open](images/web-en.png)

The page is off by default. It starts when `ENIL_WEB_ADDR` is set.

| Variable | Effect |
|---|---|
| `ENIL_WEB_ADDR` | `host:port` to listen on. Use the machine's Tailscale IP, for example `100.64.0.1:3440`. Do not use `0.0.0.0`: the address is the only network boundary. |
| `ENIL_WEB_KEY` | The sign-in key: 16 or more of `A-Z a-z 0-9 - . _ ~`. Without it, each start makes a new key. |

At start the daemon logs `[web] sign in: http://<addr>/?key=<key>`. Open that
link once in each browser, or open the address and type the key. The browser
then keeps a cookie for 400 days. Change the key to sign out every browser.

If the address does not exist yet (Tailscale is still starting), the daemon
tries again every 10 seconds. LINE keeps working in the meantime.

## What the page can and cannot do

The page sends the same commands as the panel, over a WebSocket that the
daemon connects to its own socket. These are different from the panel:

- Files are uploaded from the browser, then sent. Uploads are kept under
  `media/web-uploads/` until LINE has the file, and at most one day.
- The clipboard commands are refused. They read the daemon machine's
  clipboard, not the browser's. Paste an image into the page instead.
- The page can read only the media cache and the login QR. It cannot read
  `storage.json` or any other file.
- Only images and MP4 open in the browser. Every other file downloads.

## Run it on a Mac

Only one machine may hold the LINE session. Stop the daemon on the other
machine first (`systemctl --user disable --now enil`), and never run both.

1. Install Deno and FFmpeg: `brew install deno ffmpeg`.
2. Clone this repository with `--recurse-submodules`.
3. Copy `daemon/enil.plist` to
   `~/Library/LaunchAgents/io.github.frankekn.enil.plist` and replace
   `@CHECKOUT@`, `@HOME@`, `@TAILSCALE_IP@` and `@WEB_KEY@`.
4. `mkdir -p ~/Library/Logs/enil`, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.frankekn.enil.plist`.
5. Open `http://<tailscale-ip>:3440/?key=<key>` and log in to LINE with the QR.

On macOS the daemon has no desktop notifications and no suspend hook. The
watchdog still rebuilds a stale push connection.

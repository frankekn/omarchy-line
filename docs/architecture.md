# Architecture

[繁體中文](architecture.zh-TW.md)

omarchy-line has two halves that run as separate processes. This page
explains how they divide the work and how they recover from sleep and
network loss. The exact file formats and socket commands are in
[protocol.md](protocol.md).

## Two halves

- **The plugin** is a QML bar widget for the Omarchy shell: `Panel.qml`,
  `LinePanel.qml`, `LineWindow.qml`, `DraftWriter.qml`, `manifest.json`, and
  the `.pragma library` files `EventLog.js`, `PanelKit.js`, `DraftStore.js`,
  and `Strings.js`. It never talks to LINE. It reads local JSON files and
  talks to one local unix socket. `EventLog.js` merges events and messages,
  `PanelKit.js` holds pure UI helpers, `DraftStore.js` keeps drafts, and
  `Strings.js` holds the UI text in both languages. `Panel.qml` holds the
  state machine, the socket and `FileView` wiring, and the view.
- **The daemon**, `enil`, is the half that logs in to LINE. It is a Deno
  program: `daemon/daemon.ts` is the entry point and `daemon/modules/` holds
  the rest. LINE's refresh token rotates on every login, so only one process
  may hold the session at a time. The daemon takes an `flock` on
  `~/.local/state/enil/lock` at startup, and a second daemon on the same state
  directory exits instead of sharing the session.

The name `enil` is "LINE" spelled backwards.

The daemon talks to LINE through [linejs](https://github.com/evex-dev/linejs),
vendored as a git submodule. [vendoring.md](vendoring.md) explains the fork.

## How the halves talk

The daemon writes three things into `~/.local/state/enil/` (or
`$XDG_STATE_HOME/enil/`), and the panel reads them:

- `state.json` holds the login state, the chat list, and unread counts. The
  daemon rewrites it in full and updates its `updatedAt` heartbeat every 30
  seconds.
- `events.json` is a ring of the newest 200 live events: new messages, reads,
  reactions, unsends, and edits.
- `sock` is a unix socket. The panel sends one JSON request per line and gets
  one JSON reply per line. While the panel is connected, the daemon also
  pushes each new event over the socket, so new messages appear within a
  second. `events.json` is the catch-up path after the socket drops.

When `state.json`'s `updatedAt` has not moved for 3 minutes, the panel shows
`DAEMON OFFLINE`.

## Keeping the daemon running

The systemd user unit `daemon/enil.service` uses `Restart=always`, so any exit
brings the daemon back after 5 seconds. Only `systemctl --user stop enil`
keeps it down. The panel covers that case and a hung daemon: when the daemon
looks dead, the panel runs `systemctl --user restart enil` itself, at most
once every 45 seconds. A manual **start daemon** button in the panel does the
same with a 3-second guard.

`daemon/enil-run.sh` is the unit's `ExecStart`. It does these steps in
order:

1. It checks the linejs submodule with `git submodule status`. If the
   submodule was never checked out, or is checked out at a commit other than
   the one this checkout pins, the script prints the two `git submodule`
   commands that fix it and exits with code 78. Outside a git checkout, it
   checks that `daemon/vendor/linejs` has files, and exits with code 78 if it
   is empty.
2. It runs the compiled `enil` binary if `enil.rev` matches the checkout's
   `HEAD` and `daemon.ts` is not newer than the binary.
3. Otherwise it looks for `deno` on `PATH`, then at `~/.deno/bin/deno`. A user
   unit gets systemd's `PATH`, not your login shell's, so the second location
   covers the upstream Deno installer. If it finds neither, it exits with code
   127.
4. It runs `daemon.ts` with `deno run` and the permissions from
   `daemon/enil-flags.sh`.

A failed start does not stop the unit. `Restart=always` starts it again every
5 seconds, so the same message repeats in the journal until you fix the cause.
The checks exist because the alternative is a restart loop on an import error
that names a file inside `vendor/`.

## Deno permissions

`daemon/enil-flags.sh` defines the daemon's Deno permissions in one place.
`enil-run.sh` uses it for `deno run`, and `deno task build` uses it for
`deno compile`, so the source run and the binary cannot drift apart.
`permissions_test.ts` boots `daemon.ts` with exactly this set. Only the
development tasks `deno task test`, `deno task no-any`, and the benchmarks
still use `-A`.

- `--allow-net` has no host list. LINE's hosts would be enough for talk and
  push, but FLEX messages and link previews fetch images from whatever HTTPS
  URL the message carries (`imagecache.ts`). That set is not known in
  advance.
- `--allow-read` has no path list. **Send file** accepts any path you pick in
  the panel, and the thumbnailer reads the file where it is.
- `--allow-write` covers only the state directory: `state.json`, the socket,
  the lock, the session store, decrypted media, and avatars. Every temporary
  file the daemon makes is there too, so there is no `/tmp` entry.
- `--allow-run` names the six programs the daemon starts: `dbus-monitor`
  (sleep and wake, `watchdog.ts`), `wl-paste` (`clipboard.ts`),
  `ffmpegthumbnailer` and `ffmpeg` (`video.ts`), and `omarchy-shell` and
  `notify-send` (`notify.ts`).
- `--allow-env` names the variables that `modules/env.ts` reads: `HOME`,
  `XDG_STATE_HOME`, `ENIL_DEVICE`, `ENIL_INCREMENTAL`, `ENIL_CHAT_LIMIT`,
  `ENIL_PUSH_STALE_MS`, and `ENIL_REQUEST_TIMEOUT_MS`. It also names
  `Q_DEBUG` and `NODE_DEBUG`. Two npm dependencies read them through Node's
  `process.env`, which throws for an unlisted name, and the daemon does not
  boot without `Q_DEBUG`.
- There is no `--allow-sys`. If a dependency ever needs a system API,
  `permissions_test.ts` fails and names it.

`enil-flags.sh` computes the state directory from `XDG_STATE_HOME` the same
way `modules/env.ts` does. A compiled binary keeps the directory of the
environment where `deno task build` ran. If you move `XDG_STATE_HOME` after
the build, the binary cannot write to the new directory, so rebuild it.
`enil-run.sh` falls back to `deno run` only when `enil.rev` is stale, not when
the directory moved.

## When LINE restricts the account

`ABUSE_BLOCK`, `BANNED`, and `EXCESSIVE_ACCESS` mean that LINE refused the
account, not one request. Nothing the daemon retries on its own can change
that answer, and retrying is what turns a rate limit into a ban. When any LINE
call fails with one of these codes, `haltForRestriction` in
`daemon/modules/restriction.ts` stops every automatic path: the poll, the
refresh retry, the watchdog reconnect, the reconnect after wake, and the push
streams. It writes one journal line and publishes the link in `state.json` as
`push: "down"` with `reason: "restricted"` and the code (see
[protocol.md](protocol.md)).

The panel shows the link as its notice line, which you can tap:

- English: `LINE restricted this account (EXCESSIVE_ACCESS); connection paused — tap to retry`
- Traditional Chinese: `LINE 限制了這個帳號（EXCESSIVE_ACCESS），已暫停連線，點此重試`

If a login attempt fails with one of these codes, the login screen shows
`LINE restricted this account — log in later`, and the daemon keeps the
stored credentials and waits.

Only you can lift the halt. Tapping the notice line runs a manual sync, and a
login lifts it too. The daemon keeps the session while it waits: it does not
revoke the token, and the chat list and your drafts stay. Ending the session
would force a new QR scan over what may be a one-hour rate limit.

One idle connection stays open. linejs runs its push loop for as long as the
client holds a token, and the daemon cannot end that loop without clearing the
token. The halt aborts the push streams, so no events reach the daemon, but
the connection and its 30-second pings continue while the halt lasts.

Other codes do not halt the daemon. `MAINTENANCE_ERROR` clears by itself, so
the daemon keeps retrying with its normal backoff. `NOT_AVAILABLE_USER` can
come from the target of one request, such as a send to a deleted account.
`ACCOUNT_NOT_MATCHED` belongs to the login flow. Both fail only the request
that got them.

## Sleep and disconnects

While a laptop sleeps, LINE's push connection half-opens: the kernel still
sees ESTABLISHED, but the daemon stops receiving anything. So the daemon both
listens for logind's `PrepareForSleep` (reconnects 3 s after wake) and checks
once a minute whether the push has been quiet for over three minutes,
rebuilding it on its own and retrying with a backoff that starts at 1 s and caps
at 60 s. A full chat-list refetch also runs every five minutes as a floor.
Errors the push connection throws with nobody listening are journaled as
`[unhandled]`. Anything judged a network problem takes the reconnect path
above and does not restart the daemon. Anything else is journaled the same way
but still lets the daemon exit for systemd to restart. That case is the daemon's
own bug, and running on would only serve stale state.

**The linejs pusher loop dying outright is a different path**: when it cannot
connect it errors both shared streams at once, the `for await` inside
`listen()` ends, and no event arrives again until someone calls `listen()`
once more (upstream v3.4.1 states that is the caller's job). The daemon spots
this on the `log` channel via `LegyPusherError` and decides by `poll.islisten`:
linejs clears it in `finally`, so only the pass where the loop truly ended
reads false. A single message failing to decrypt, or an `InitAndRead` failure
linejs itself sleeps 4 s and retries, reports the identical type while the
loop is alive. Reconnecting then would just fight over `conns[0]`, so those
two are journaled and the connection left alone. A real death zeroes the push
clock and hands back to the same watchdog above (no second backoff): one
failure writes two `LegyPusherError` lines (one from the pusher, one from the
`for await` after the streams errored) that share one backoff gate, so only
one reconnect happens. Before this, the only detector was the three-minute
quiet check.

Every request to LINE also has a header wait cap: 30 s normally, 180 s for the
obs upload host (uploads answer headers only after the whole body is sent).
The cap bounds headers, not bodies, so the push connection and media downloads
with hours-long bodies are never cut. This layer is ours: linejs sets its own
30 s timeout, but the encrypted transport rebuilt the request and dropped that
signal, which meant no timeout at all. After a laptop woke, the keep-alive
connection was long dead while the kernel disagreed, and one chat-list request
sat there for ten minutes blocking every refresh behind it. Now the worst case
is a 30 s failure plus an automatic refetch 15 s later, without waiting for
the five-minute floor poll. Tune with `ENIL_REQUEST_TIMEOUT_MS` (milliseconds).
The timeout itself (`TimeoutError`/`AbortError`) counts as a network problem
and takes the same path as a severed connection: previously it was classified
as an unknown error, where a single timed-out request nobody answered was
enough to kill the daemon for a systemd restart.

Both layers above are automatic but both make you wait: the watchdog checks
once a minute, the floor poll every five. To skip the wait, press the **同步**
button right of the list search box (keyboard `r`, or click the "LINE 連線中斷，
重連中" line under the title). It rebuilds the push connection and refetches
the chat list immediately, re-reading the open conversation too. The button
reads "同步中…" while working, usually settling on "已同步 HH:MM" within
seconds (if a refetch was already in flight it waits out that round and the
button stays on "同步中…" meanwhile). A failure prints its reason
(`同步失敗：連不上 LINE，稍後重試` and friends), never silence. The rebuild
itself takes eight seconds (linejs's own pusher must get its recovery window
first, or both loops fight over one connection) but the sync does not wait for
it. The refetch needs no new connection, so the view comes back first and
the link heals behind it.

Reconnect records live here:

```bash
journalctl --user -u enil | grep '\[push\]'
```

A manual sync appears in the journal as `[sync] requested`.

Push-driven refreshes no longer refetch the whole list either: the push itself
says which chats moved, the daemon debounces them, then issues one
"recent messages" request per affected chat and updates the rows in place,
with no sweep of every box for a few rows. It falls back to the full
`getMessageBoxes` only on login, reconnect, manual sync, a read on another
device, a rename, a burst (more than 8 chats), or a failed incremental round.
The only server-side source of unread counts lives there, and the full pass is
always the corrector. Disable the whole path with `ENIL_INCREMENTAL=0` (on by
default). With it off, every round is the original full refetch.

While push is alive none of this waiting applies: new messages, reads,
reactions and unsends reach the event ring within a second, and with the panel
open the daemon pushes each event over the already-connected socket (see the
push frames in [protocol.md](protocol.md#push-frames)). Not even the file throttle stands in the
way. When the socket drops, the panel still catches up through `events.json`.
Things that happened while disconnected stay on LINE's side and come back via
chat-list and history refetches. `events` only keeps the newest 200 entries,
and a restarted daemon renumbers from scratch (`bootId` changes), so it is the
fast path, not the only path.

## Public images

Stickers, the sticker picker, and FLEX images (including the lightbox) are
downloaded by the daemon into `~/.local/state/enil/media/public-images/`.
QML only ever reads local files, so those image requests never enter the
shell's Qt TLS stack. Downloads of the same URL merge, at most 4 run at once,
and each is capped at 10 MiB with a 20-second timeout. The cache shares the
sweep policy of `media/`. A failed download never falls back to HTTPS from
QML.

The daemon accepts only `https://` image addresses and refuses hosts that
resolve to private addresses. The request carries no cookies and no LINE
token.

## Media pipeline

`history` returns text and media fields first. The rows actually visible ask
the daemon for thumbnails separately. Videos only fetch thumbnails when LINE
offers a real preview URL or the path isn't encrypted chunks. An encrypted
video never degrades into downloading the whole file for one preview and
stays a 📎 attachment row.

**Avatars get their own cache**: `media/avatars/`, filenames are
`sha1(mid + that version's picture token)`. The token is included because a
new photo must mean a new filename, or the old one would sit on screen
forever. Fetches run **at most four at a time** (a cold start needs over a
hundred, and firing them all at the CDN is a fetch storm), and the rest queue.
Failures leave the field absent and never block the chat list or
messages. The avatar lands in `state.json` later. Which CDN host and whether
to append `/preview` are probed once and recorded in `avatars.json`, never
re-probed. This cache **ignores age** (the contact you haven't spoken to in a
month is exactly the one whose face you need) with only a 20 MB cap, sweeping
the oldest when full.

**Clicking an image zooms inside the panel** (lightbox): it opens on the
thumbnail instantly while the original is fetched and swapped in. A failed
original keeps the thumbnail plus a hint line. Wheel zooms 1×–4× around the
cursor, drag pans while zoomed, double-click toggles 1×/2×. ←/→ (or h/l)
walks the same chat's images with a "n / N" title. `o` opens externally, Esc
or a backdrop click closes. FLEX (carousel) images are public CDN URLs.
Clicking enters the lightbox without a `download` first. That path is for
LINE's encrypted media, while public URLs are fetched into cache by `image`.

**Videos and file attachments (the 📎 row) close the panel first, then open
externally**: the panel issues one `download`, the daemon returns the original
path, the panel `close()`s and only then `xdg-open`s. The order cannot flip.
The panel is a fullscreen `WlrLayer.Overlay` and a normal viewer window would
hide underneath, looking like the click did nothing. Files open through
`Quickshell.execDetached` (argv, no shell), so a second file still opens while
the first viewer lives. Switching chats mid-download is fine. The file opens
anyway.

`App window` mode (see [usage.md](usage.md#settings)) does not close: it is a normal window, not an
overlay, so viewers stack on top. Opening videos, files, or the lightbox `o`
there leaves LINE where it was.

Two ways to send files: `/file <path>` in the input, or `📎` for a system file
picker. The picker uses **zenity**, which Omarchy does not preinstall.
Without it `📎` answers "找不到 zenity，請 sudo pacman -S zenity". Installing
makes it work immediately, with no shell restart needed. Picking a file then
cancelling shows no message, by design.

Multi-person rooms (mids starting `r…`) cannot send files. The daemon refuses before
sending, with a message.

**An image goes out as an image, a video as a video**, not everything as an
attachment. The daemon reads magic bytes first, falls back to the extension,
then picks linejs's ObjType: `image`/`gif` is IMAGE, `video` is VIDEO, the
rest `file`. So a `.jpg` that is really an mp4 still goes out as video (LINE
only reads the contentType we send, never the name), `.gif` keeps `gif` (with
`cat=original`, or the receiver gets a frozen frame), and HEIC vs mp4 are both
ISO containers split by the `ftyp` brand. **Audio is always `file`**: a LINE
voice message needs a duration and the daemon has no demuxer. Sending as one
yields a 0:00 waveform.

**Oversized files are refused before being read**: images (incl. gif) **20
MB**, videos and files **1 GB**, refusing with "圖片太大（超過 20 MB）" /
"影片太大（超過 1 GB）" / "檔案太大（超過 1 GB）". The cap is spelled out
because the user picked the file and only they can pick a smaller one. The
caps are ours: LINE refuses only after the whole upload, which on home
upstream means minutes wasted for an error nobody can act on. The image cap
matches the clipboard's because that path is the memory-heaviest (read fully
into memory, encrypt a copy, and linejs uploads the original again as
`__ud-preview` when no thumbnail is given). Video and files upload once, so
the cap sits where LINE itself wouldn't accept. Type detection needs the
header, so the daemon `Deno.stat`s for size, reads only the first 16 bytes
for ObjType, and only reads the whole file after the checks pass.
**Sent videos carry a preview image and a duration.** Without a preview,
linejs uploads the encrypted original again as `__ud-preview`
(`base/obs/mod.ts:389`). That is fine for an image (it is one), but for video the
receiver gets a blank square: the client draws an mp4 as a JPEG. So videos
get two extra steps:

- **Duration** is read straight from the container header: ISO base media's
  `moov/mvhd` (version 0 is 32-bit, version 1 is 64-bit), Matroska's
  `Segment/Info/Duration` (times `TimestampScale`). Only the headers of the
  boxes on the path are read. Phones routinely write `moov` **after** a
  multi-GB `mdat`, so it seeks by declared box size rather than scanning.
  Unreadable (AVI, say) means no duration, and sending is unaffected.
- **Preview** needs `ffmpegthumbnailer` or `ffmpeg` (first found on PATH, in
  that order; Omarchy ships neither): grab the frame at second 1, save as a
  640-wide JPEG. Clips under two seconds grab the middle instead, because seeking
  past the length produces no frame in either tool. **With neither installed
  the send goes out as before, just without a preview**.
  `journalctl --user -u enil | grep 'preview skipped'` says which case it was
  (not installed, run failed, or output wasn't a complete JPEG). The whole
  thumbnail step is capped at 10 s and can never fail the send.

The duration rides in the message's contentMetadata `DURATION` (ms): that
metadata is assembled by `uploadMediaByE2EE` itself, so the fork gained a
`durationMs` parameter (pin `4d6aa18`). The daemon hands a measured duration
down and omits the field otherwise. Over E2EE, obs only sees the encrypted
blob and cannot read a container duration itself (plain `uploadObjTalk` does
it on its own), so the caller has to provide it.

**Clipboard images send directly**: on `probeClipboardImage {chat}` the daemon
runs `wl-paste --list-types` looking for `image/png` / `image/jpeg` /
`image/webp` / `image/gif` (picking the first in that order when several
exist), then `wl-paste --no-newline --type <mime>` to read the bytes.
`--no-newline` is mandatory because wl-paste appends a newline by default, and one
extra byte after a PNG is a corrupt file. Cap **20 MB** (read into memory,
encrypted once, uploaded twice by linejs). On success the snapshot is staged
in `media/` and a restricted `stage` name returned. The panel then sends
`sendClipboardImage {chat, stage, requestId}` and the daemon runs the same
function as `sendFile`, deleting the stage on success or failure. Pasted
screenshots and picked-file images share one type check, naming, and refusal.

Failures all say why, never a bare "send failed": no wl-clipboard →
"找不到 wl-paste，請 sudo pacman -S wl-clipboard"; text in the clipboard →
"剪貼簿裡沒有圖片"; an unsendable format names it ("剪貼簿的圖片格式不支援:
image/tiff"); oversized → "剪貼簿的圖片太大（超過 20 MB）". The daemon is a
systemd user unit. **If it starts before the compositor it has no
`WAYLAND_DISPLAY`**, wl-paste can't reach the display, and the answer is
"連不上 Wayland，請 systemctl --user restart enil", which differs from an empty
clipboard, hence different words. A stuck wl-paste gets 5 s at most, then
"讀不到剪貼簿" with the reason journaled.

**On the panel side this is `Ctrl+V` in the input box.** The clipboard lives
on the daemon's side (`wl-paste` runs there) and the panel cannot read it, so
the key sends a non-message `probeClipboardImage` first. The daemon reads and
pins a staged snapshot in one shot. When the reply happens to be "剪貼簿裡沒有
圖片", the panel knows it's text and lets the input paste normally. Only after
a successful probe does it send `sendClipboardImage` carrying a `requestId`,
so a failed probe or a drop never leaves a token with no history message to
reconcile, and the clipboard can't change between the two phases. So Ctrl+V on
text still pastes text, one socket round-trip slower. Ctrl+V on an image sends
it outright, leaving half-typed input untouched. The banner reads "傳送中…"
during the upload, same as `📎`. No bubble is drawn first. At keypress time
nobody knows whether the clipboard holds an image, and drawing a bubble then
withdrawing it for a text paste would flash one per paste. The real message
arrives back via LINE's push (same path as `📎`). Every other refusal stays
on the banner verbatim and is never downgraded to a text paste. That covers no wl-clipboard,
no Wayland, too big, unsendable format, rooms can't take files. If you switch
chats before the probe answers, the image still goes to the chat captured at
keypress. Text won't paste into the other chat's input, and errors don't jump
over either. If the second-phase request can't be queued on the socket, the
panel sends `discardClipboardImage` to release the stage. **A second press
while waiting does nothing** (holding Ctrl+V auto-repeats and uploads take
seconds): the press is swallowed, like pressing `📎` again while the picker
is open. Sending twice means two identical images, or the same text pasted
twice. The moment the answer lands (sent or refused), Ctrl+V works again.

**Unopenable attachments say why instead of a bare "download failed".**
Unsent messages still arrive from LINE with contentType `FILE`/`IMAGE` but no
content. The daemon marks them `mediaState: "unsent"`, `hasMedia: false`,
rewrites `text` to "已收回訊息" (the list preview too), and clicking answers
"訊息已收回" without touching the network. Chat files expire after **7 days**
(the metadata's `FILE_EXPIRE_TIMESTAMP`, stored in `expiresAt`) as
`mediaState: "expired"`, answering "檔案已過期（LINE 只保留 7 天）", again with no
network. Failures after an actual fetch split in two: the object being gone
(HTTP 404/410, `ObsError`, or the `encrypted data too short` /
`HMAC verification failed` upstream linejs throws earlier in decrypt) answers
"檔案已過期或已被刪除". Everything else is "下載失敗". The panel draws from
the two fields: an unsent message is one grey italic "已收回訊息" line with
sticker/FLEX/thumbnail/📎 all hidden. An expired file's 📎 row appends
"（已過期）". Neither is clickable and lightbox ←/→ skips them.

Every command answered `{ok:false}` also leaves one journal line
`[cmd] <cmd> failed: <class>: <message>` (message truncated to 120 chars, mids
replaced by `<mid>`, request bodies never written).
`journalctl --user -u enil | grep '\[cmd\]'` is the failure log. Refusals
carrying a path **go only to the panel, never the journal**: a missing
`sendFile` shows the panel `找不到檔案: <path>` (the user picked that path)
while the journal only gets "找不到檔案".


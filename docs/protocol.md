# Daemon and panel protocol

[繁體中文](protocol.zh-TW.md)

This page is the reference for the contract between the daemon (`enil`) and
the panel: the files in the state directory, the socket commands, the push
frames, and the message shape. For how the two halves fit together, read
[architecture.md](architecture.md) first.

Any program that writes these files and serves this socket can drive the
panel. [`daemon/stub.py`](development.md#run-the-panel-against-the-stub) is
one such program.

## State directory

Both sides live in `~/.local/state/enil/` (or `$XDG_STATE_HOME/enil`):

| Path | Role |
|---|---|
| `state.json` | login state, chat list, unread counts (atomic write, watched by the plugin's `FileView`) |
| `events.json` | live event ring (atomic write, `FileView`-watched), see below |
| `sock` | unix socket, one JSON request/reply per line; connected panels also receive push frames here |
| `storage.json` | LINE credentials and E2EE keys (`chmod 600`, daemon-only) |
| `lock` | single-instance gate: the running daemon holds an `flock` on it, and a second daemon exits instead of sharing the session (empty, daemon-only) |
| `media/` | downloaded image/video thumbnail cache (swept at 14 days or 500 MB) |
| `media/avatars/` | avatar cache (**age-insensitive**, 20 MB cap, sweeps oldest first) |
| `media/public-images/` | sticker and FLEX image cache (public CDN URLs, same sweep as `media/`) |
| `avatars.json` | which mid's which avatar version was already handled, so a restart doesn't refetch (daemon-only) |
| `hidden.json` | hidden-chat mids, `{"mids":[…]}` (atomic write, daemon-only, cap 1000) |
| `panel-stickers.json` | recent stickers, per account (written by the **plugin**, atomic; the daemon doesn't read it) |
| `qr-<ts>.png` | login QR; a fresh filename each time (QML `Image` won't reload a same-named file) |

`state.json` (rewritten in full every time, no partial updates):

```jsonc
{
  "updatedAt": 1735000000000,          // heartbeat every 30 s; over 180 s is offline
  "bootId": "…",                       // this daemon boot's id, changes on restart
  "me": { "mid": "u…", "displayName": "…" },   // {} while logged out
  "login": {
    "status": "idle",                  // idle|starting|qr|pin|ok|error
    "qrPng": "…/qr-<ts>.png",          // only when status=qr
    "pin": "…",                        // only when status=pin
    "error": "…",                      // only when status=error, human-readable
    "reason": "…",                     // optional, the error's class
    "attempt": "logout",               // optional; logout|resume|manual — which attempt this state belongs to
    "settled": true                     // optional; true once login/logout teardown completed
  },
  "chats": [                           // unread first, then by lastTime
    { "mid": "u…", "name": "…", "unread": 0,
      "lastText": "…", "lastTime": 1735000000000, "lastFrom": "u…",
      "avatarPath": "…/media/avatars/<sha1>.jpg",    // optional, absent means no avatar set
      "hidden": true }                               // optional, only on hidden chats
  ],
  "chatsRevision": 12,                 // bumps only when chats/chatList change; heartbeats don't
  "chatList": { "complete": true, "loaded": 80 }, // optional; false means the server has a next page
  "timings": {                         // optional; rolling daemon latency stats, last 64
    "chats.refresh": { "samples": 18, "lastMs": 241.3,
                       "p50Ms": 205.1, "p95Ms": 390.8, "maxMs": 411.2 },
    "cmd.history": { "samples": 6, "lastMs": 92.4,
                     "p50Ms": 88.0, "p95Ms": 131.7, "maxMs": 131.7 }
  },
  "stateBytes": {                      // optional; rolling state.json write-size stats, last 64
    "samples": 64, "last": 253412,
    "p50": 251190, "p95": 258871, "max": 260112,
    "chats": 80                        // chats count when this file was serialized
  },
  "link": { "push": "up", "since": 1735000000000 },  // optional, push link state
  "refresh": { "at": 1735000000000, "failures": 0,   // optional, chat-list freshness
               "reason": "network" },                //   reason only exists when failures > 0
  "wanted": { "chat": "u…", "at": 1735000000000, "seq": 1 }  // optional, see below
}
```

`login.reason`, `login.attempt`, `login.settled`, `link`, `refresh` and
`wanted` are all optional: older daemons don't write them and the panel must
still render without them (`link.push` is `"up"` or `"down"`; `since` is the
ms timestamp this state began). `login.settled: true` only appears once a
login or logout teardown finished. Transient states mid-startup/resume don't
carry it and consumers must not read them as a settled session.
`login.attempt` is `logout` (teardown after the user pressed logout),
`resume` (boot-time storage resume failed) or `manual` (a QR attempt via
"登入 LINE" failed). Any `settled: true` terminal teardown (logout, any
resume that ran to its end whether the cause is `token_expired` or storage
holding no token at boot, or an established-then-failed manual)
makes the panel drop the previous account's durable drafts. Retryable
transient failures (`network`/unclassified, or a manual that failed before
establishing) keep drafts for the next login to continue.

`refresh` describes **the chat-list path** (talk requests), a different thing
from `link` (the push connection). One can be fine while the other fails, so
it isn't merged into `link`. `at` is the ms timestamp of the last successful
`getMessageBoxes` that wrote `chats`. `failures` counts consecutive failures
since, reset by a success. `reason` exists only when `failures > 0` and shares
`login.reason`'s classes (`network`/`token_expired`/`unknown`). A failure only
lands in the file at the moment the streak begins (same edge-write shape as
`link`). Later counting rides the 30 s heartbeat. At `failures >= 2` the panel
prints "清單可能過期" under the list title line (a single 30 s timeout happens
on phone hotspots and doesn't trip this). The unread badge is unaffected. The
field is absent before login and removed on logout. The stub counts every
write as a success, plus a `fail-refresh` command the real daemon lacks (same
nature as `poke`) that pushes `failures` up so the message is testable without
a real outage.

`chatsRevision` only bumps when `chats` content or list completeness changes.
The 30 s heartbeat never moves it. `chatList.complete === false` means LINE
answered `hasNext`, but the safe pagination semantics of
`minChatId`/`maxChatId` aren't confirmed in this version. The panel clearly
states it only shows and searches the `loaded` chats rather than misreporting
one successful refresh as a complete list.

`timings` is the daemon's in-memory rolling diagnostics, at most the last 64
per entry, all in milliseconds. `chats.refresh` is a full chat-list refresh,
`state.write` a state.json atomic write, `cmd.<name>` the total socket time
for that command from reading its full line, through waiting on prior normal
commands or the shared media queue, to writing the reply. Sampling happens
when a state write actually reaches disk, riding the next write that would
have happened anyway. The panel is never woken for measurement. Stats
restart on daemon restart.

`stateBytes` is the same rolling window measured on **serialized bytes**:
UTF-8 bytes, not milliseconds, so the field names carry no `Ms`. Sampling
fires when a state write reaches disk and the full JSON text exists, once
per write (heartbeats, refreshes and push summaries all go through the same
`writeState`; nothing is serialized extra for measurement). Same beat as
`timings`: a write's own size lands on the next write. Stats restart on
daemon restart, and the whole block is absent right after boot while the
window is empty. `chats` is the chats count **of this very file** when it was
serialized (hidden chats included, since they stay in the file), a different beat
from the rolling stats: read it as "this file's current state". Before any
write-reduction work (field diffs, file splitting), a deployment reads this
block for real numbers.

`timings` and `stateBytes` are **optional fields**: older daemons don't write
them, and the panel's state.json contract has always been "read the keys you
know, ignore the rest", so older panels are unaffected.

The chat row's `hidden` key works the same way: **only hidden chats carry
it**. Unhidden ones omit it entirely (not `false`), and older panels still
render fine. Hidden chats **stay inside `chats`**. The panel needs them for
search, but doesn't draw them normally. The daemon stamps the key at
state-write time from `hidden.json`. The chat-summary cache itself doesn't
carry it, otherwise a stale cached answer would keep hiding state wrong.

## `wanted`: the chat opened from a notification

On a desktop-notification click, the daemon writes one `wanted` entry before
asking the shell to open the panel. Shell IPC only knows open/close/toggle
with no arguments, so "which chat" travels through the `state.json` the panel
already watches.

- `chat` is the chat mid. `at` is the click's ms timestamp.
- `seq` is like the `events` one, **strictly increasing inside one daemon
  process**: the panel remembers the last it handled and only honors newer
  ones. Two clicks on the same chat are two entries (different `seq`), never
  deduplicated. A changed `bootId` means the count restarted.
- Logout removes the whole field: pointing at a chat that can't open would
  just drop the panel on an empty conversation.
- The field never disappears on its own, so "exists?" isn't enough. The
  panel must compare `seq`.

## `events.json`: live events

`events.json` is a ring buffer keeping **only the newest 200 entries**, written
separately from `state.json`. Bursts rewrite this small file instead of
growing or re-reading the big one. The panel remembers the last `seq` it
applied and only consumes newer ones, so one new message never triggers a
full-page history refetch.

```jsonc
{
  "updatedAt": 1735000000000,
  "bootId": "…",                       // same as state.json's, changes on restart
  "events": [                          // ascending seq
    { "seq": 1, "at": 1735000000000, "kind": "message", "chat": "u…",
      "message": { /* same shape as a history entry */ } }
  ]
}
```

- `seq` is strictly increasing **inside one daemon process**, never reused
  and never rewound. A restart renumbers from 1, so a changed `bootId` means
  "a new round" and the panel zeroes its watermark.
- `at` is a ms timestamp. `chat` is the chat mid (every `kind` has it, so the
  panel can pre-filter to the open chat without reading payloads).
- Event writes **coalesce**: at most one per 250 ms (≤ 4/s), so a burst (an
  album, a split long text) doesn't make the panel re-read events.json twenty
  times.
- Logout clears `events` (without resetting `seq`, because a rewinding seq inside
  one `bootId` is the only case the panel can't explain).
- The file is only the slow catch-up path: while a panel holds the socket,
  each event first arrives as a `{"event":…,"boot":…}` push frame (below) and
  the file lands after. What was missed while disconnected is caught up by
  reading the file.

| `kind` | Fields | Fired when |
|---|---|---|
| `message` | `message` (exactly the `history` message shape, decrypted, with mentions/mediaState) | a new message arrives, or one of yours echoes back (LINE pushes your own sends, including from other devices) |
| `read` | `by` (reader's mid), `upTo` (newest message id they read) | the other side read, or you read on another device |
| `reaction` | `messageId`, `reactions` (**the whole new list**, not a delta) | someone adds, swaps or undoes a reaction |
| `unsend` | `messageId` | someone unsends (you or them) |
| `edit` | `message` (the full post-edit message) | a message is edited |
| `history` | `messages` (a revalidated whole page) | the local store answered a stale page first and the reconcile produced a fresh one. One entry is a whole page, so a chat keeps only its newest in the ring; older ones are dropped |

`reaction` carries the whole list rather than a delta because a LINE op only
states one person's new choice at a time. The daemon keeps a per-message
"who picked what" map, seeded from `raw.reactions` at history-load and moved
by each op. A never-loaded message can only start from empty (the next
history load corrects it).

## Socket commands

Socket commands (one JSON line per request, replies
`{ok, data?, error?}`):

| cmd | Args | `data` on success |
|---|---|---|
| `history` | `chat`, `count` (1–200, clamped, non-numbers count as 30), `before?` (message id to page back from), `markRead?` | message array, oldest first |
| `markRead` | `chat`, `upTo` (newest message id read, as a decimal string) | `{ "marked": bool }`. It is `false` when nothing went to LINE: our own read cursor already covers `upTo`, the row already shows 0 unread with nothing uncounted, or LINE refused the check |
| `send` | `chat`, `text`, `mentions?`, `requestId?` | none |
| `reply` | `chat`, `text`, `replyTo` (message id), `mentions?`, `requestId?` | none |
| `react` | `chat`, `messageId`, `type` | none |
| `unsend` | `chat`, `messageId` | none |
| `members` | `chat` | `[{ "mid": "u…", "name": "…" }]`, name-sorted |
| `sendFile` | `chat`, `path`, `requestId?` | none (oversized files and unsupported chats get a written refusal, see [usage.md](usage.md#send-files-and-images)) |
| `probeClipboardImage` | `chat` | `{ "stage": "clipboard-….png" }` (refusal when nothing sendable is on the clipboard) |
| `sendClipboardImage` | `chat`, `stage`, `requestId?` | none |
| `discardClipboardImage` | `stage` | none (releases the stage when the probe succeeded but phase two can't be queued) |
| `download` | `chat`, `messageId` | `{ "path": "…" }` (original file, not a thumbnail) |
| `preview` | `chat`, `messageId` | `{ "path": "…" }` (local thumbnail for on-screen images) |
| `image` | `url` (a public `https://` image) | `{ "path": "…" }` (local cache file) |
| `stickers` | `refresh?` | `{ "packages": [ … ] }`, see below |
| `sendSticker` | `chat`, `packageId`, `stickerId`, `version?`, `requestId?` | none |
| `hide` | `chat` | none (removes the row from the list, recorded in `hidden.json`) |
| `unhide` | `chat` | none |
| `login` | none | none |
| `logout` | none | none |
| `sync` | none | `{ chats, link, at }` |

## Push frames

While a panel holds the socket, the daemon also writes two kinds of **push
frames**. They have no `id`, match no request, and share the same serialized write
channel as replies so a line always arrives whole:

- `{"event": <event>, "boot": "<bootId>"}` is a new event-ring entry
  (`history` events included). The client dedupes by `seq` against its
  watermark. A `boot` different from the known `bootId` means the daemon
  restarted. Zero the watermark and catch up from `events.json`.
- `{"chat": <row>, "chatsRevision": N, "boot": "<bootId>"}` is a single chat
  row whose fields moved (a new-message preview, an unsend, an avatar
  landing) pushed whole. `chatsRevision` is its watermark. A file write
  carrying an older revision is dropped and can never clobber the pushed
  newer value. Whole-list rebuilds (refresh rounds, logout) are not pushed
  and still converge through `state.json`. These frames don't enter the
  event ring and carry no `seq`.

Older clients that don't know push frames just read replies by `id`. Extra
lines are ignored and behavior is unchanged. If a push can't be written or
the peer reads too slowly, the daemon closes that connection. The panel
reconnects and catches up via `events.json` and `state.json`.

While logged out, everything except `login`, `logout`, `hide`, `unhide` and
`discardClipboardImage` answers `{ok:false, error:"尚未登入"}`. An unknown cmd
answers `unknown cmd: <cmd>`. `hide`/`unhide` sit before the login gate: they
only touch our own file and never LINE, so a missing session is no reason to
refuse. Both are **idempotent** (hiding an already-hidden chat still returns
`{ok:true}`, just without a write), and an empty `chat` answers
`{ok:false, error:"沒有指定是哪一間聊天室"}`.

`history` answers text and message fields without waiting for image
downloads. The `preview` request only goes out when a ListView delegate nears
the screen. `image`, `preview` and original `download` share one background
lane of at most four across the daemon, with replies still matched by `id`.
They may come back after interactive commands sent later. State-changing
commands (send, reply, unsend, …) still run in receive order.

The five send commands take an optional non-empty `requestId` string. The
daemon puts it into the LINE message's `contentMetadata` and returns it
verbatim in later history or message events under the same name. The panel
creates one per send. When the socket drops after LINE accepted the message,
the value precisely confirms the outcome, with no guessing by identical text or
time. Other clients may omit it. History messages then carry no such field.

## Drafts and unconfirmed sends

Unsent text, mentions, reply targets and cursor position live in
`$XDG_STATE_HOME/enil/panel-drafts.json`, per account and chat. Every edit
queues an atomic write, and while a write runs only the newest follow-up
snapshot is kept. Switching chats, closing the panel or restarting the shell
all restore. Unconfirmed `requestId`s with their optimistic messages live in
the same file, still displayed and still precisely reconciled after a
disconnect, chat switch or panel restart. A draft's send is dropped only when
its reply succeeds or an identical `requestId` shows up in history/message
events after a disconnect. Failures and unconfirmed sends keep it.
`starting` during a daemon restart and retryable network `error`s don't count
as logout. Only a definite `idle` or a settled non-retryable session error
clears that account's drafts and unconfirmed sends.

## Command details

A reply is **always written whole**: the daemon `writeAll`s to the last byte
rather than one `conn.write`. A unix socket only takes what fits its buffer
(219264 bytes measured), and a `stickers` reply in the hundred-KB range would
truncate silently, leaving the panel waiting for a newline that never comes.
Should a reply itself fail to encode (a BigInt or a cycle snuck in), the
daemon answers `{ok:false, error:"回覆無法編碼"}` and journals
`[cmd] <cmd> reply unserializable: <class>`. The value never reaches the
journal.

`sync` is the manual sync: rebuilds the push connection (without waiting for
it) and refetches the chat list. It always reports the round that
finished **after** this request arrived, waiting out a round already in
flight. `chats` is the fetched chat count, `link` is the push state **at the
moment the sync began** (`"up"`/`"down"`; a rebuild flips it to down at once,
so a value read after the report is always down), `at` is the completion's ms
timestamp. A failed fetch answers `{ok:false, error:"同步失敗：…"}` with a
human-readable reason.

`members` is the group member list for `@`, answerable only for groups
(`c…`) and rooms (`r…`). 1:1 (`u…`) answers
`{ok:false, error:"這不是群組，沒有成員名單"}`. The list excludes yourself.
The daemon caches ten minutes, so re-entering the same chat only fetches
once. Rooms usually can't produce a list. Then the reply is
`{ok:false, error:"多人聊天室（room）拿不到成員名單"}` and the panel shows no
banner, explaining only when the user actually types `@`.

`image` fetches a **public** image into a local file: the daemon caches it in
`media/public-images/` (merging, caps and sweeping as described in [architecture.md](architecture.md#public-images))
and returns `{ "path": "…" }`. The panel only ever reads `file://`. Only
`https://`, no embedded credentials, the response's content type must be
`image/`, and at most five redirects each still `https://`. Any violation or
a failed fetch answers `{ok:false, error:"圖片下載失敗"}`. The panel does
not fall back to fetching HTTPS itself, which is exactly the path this
command exists to avoid.

`send`/`reply` don't pick a cipher. LINE decides. The message goes out plain first, and
linejs itself resends via E2EE when the peer demands it (`mentions` and the
quote ride along). Forcing E2EE instead makes the key exchange answer
`E2EE_RETRY_PLAIN` when the peer has Letter Sealing off, and the message
can't be sent at all.

`reply` is a `send` with a quote: same `mentions` validation, same cipher,
same refusals, one extra `replyTo`. Missing it answers
`{ok:false, error:"沒有指定要回覆哪一則訊息"}`. Unguarded, the message would
still go out as a plain message, silently eating the quote the user picked.

`react`'s `type` is one of LINE's six defaults
`NICE`/`LOVE`/`FUN`/`AMAZING`/`SAD`/`OMG`, plus `UNDO` to take yours back.
Anything else answers `{ok:false, error:"不支援的表情"}`. One person holds one
reaction per message. Resending swaps it instead of stacking.

## Stickers

`stickers` lists the packs **this account owns**, in the order the sticker
shop returns, at most 100:

```jsonc
{ "packages": [
  { "id": "1",                      // pack id (decimal)
    "name": "饅頭人&詹姆士",
    "version": 3,                   // STKVER; 0 when the shop omits it
    "stickers": [
      { "id": "4",
        "url": "https://stickershop.line-scdn.net/stickershop/v1/sticker/4/android/sticker.png",
        "animated": false }
    ] }
] }
```

The daemon caches an hour. `{"cmd":"stickers","refresh":true}` refetches
(only one round runs at a time, so two open panels don't double the requests).
The list comes from the sticker shop's `getOwnedProductSummaries`, but **that
API doesn't return sticker ids**, so each pack's stickers come from the
public `productInfo.meta` (no login needed). A pack whose fetch fails gets an
**empty `stickers` array**. The account does own it. It just couldn't be
read this time, and dropping it from the list would be harder to explain.
`animated` is a **whole-pack** property, not per-sticker: LINE's JSON has no
per-sticker flag and received stickers only carry `STKOPT`. The `url` shares
the CDN path used by received stickers, so one drawing routine serves both.
Logout clears the cache, because a new account means a new set of packs.

Shop trouble splits into two sentences: the request itself failing
(unreachable, a Thrift exception) is
`{ok:false, error:"貼圖清單讀不到：<原因>"}`. The reply **not being a list at
all** (a should-be-list field isn't an array, or a pack is neither object nor
array) is `{ok:false, error:"貼圖清單格式不對"}`, and `sendSticker` uses the
same pair. Two sentences because "can't read" sends people to check their
Wi-Fi while the packets actually came back fine. **A missing field isn't an
error**: Thrift omits empty fields entirely, so an account owning no packs
and the page after a full one both come back as objects without that field.
That is an empty page, not a broken shop. Both used to count as an empty list: the
menu opened blank, got cached an hour, and nobody said a word.

`sendSticker` sends one sticker. `packageId`/`stickerId` are decimal ids.
`version` is optional (defaults to that pack's `version` from the list).
Misshapen ids answer `{ok:false, error:"貼圖編號不對"}`. A pack not in your
list answers `{ok:false, error:"這個貼圖包不在你的貼圖清單裡"}`. LINE takes
any metadata at face value, and without the check the receiver gets an empty
bubble that can't render, unsendably. Whether the sticker is actually **in**
that pack goes **unchecked**: packs with empty `stickers` can't be checked
anyway, and refusing would bill the user for the daemon's failed read.
Stickers **skip E2EE** (their content is metadata, and metadata is never
encrypted). After sending, LINE echoes it back like a `send` and the panel
gets a `message` event. An animated pack (`animated`) sends one extra
`STKOPT: "A"`, static packs omit the field. linejs's `getStickerURL()` only
returns `sticker_animation.png` when it sees the value, and without it even
your own echo is the frozen frame. The panel swaps back to the static URL
when drawing: Qt only renders an APNG's first frame, which still costs
hundreds of KB.

`unsend` only takes back **your own** messages. Other people's answer
`{ok:false, error:"只能收回自己傳的訊息"}`. The sender check runs off the
daemon's own cursor table, with no LINE round trip for a refusal. A message not
in cache answers "訊息不在快取裡". After a successful unsend LINE pushes
`DESTROY_MESSAGE` back and the panel gets an `unsend` event. The daemon
doesn't fake one.

`send`'s `mentions` is optional, `[{ start, end, mid }]` or
`[{ start, end, all: true }]`:

- **`start`/`end` are UTF-16 code-unit offsets into `text`, half-open
  `[start, end)`.** A CJK char counts 1, an astral emoji (surrogate pair)
  counts 2. These are the units JavaScript's `String` `length` and `substring` use.
  Both sides are JS, so nobody converts. These are LINE's own units: linejs
  `parseInt`s `MENTIONEES`'s `S`/`E` and hands them to
  `String.prototype.substring`.
- `mid` is `u` + 32 lowercase hex chars. `all: true` is @All, no mid.
- The daemon validates: non-integer, out of `text`'s range, inverted, a
  misshapen mid, or overlapping a previous span gets **that entry dropped**.
  The rest still send. A broken mention only costs its own marker, not the
  whole message.
- The daemon assembles it into LINE's `contentMetadata.MENTION`. That
  metadata is **not encrypted** (E2EE only covers the body), so the offsets
  describe the string the receiver sees after decryption.

## Message shape

Messages returned by `history` (absent fields are omitted, never `null`):

| Field | Type | Present when |
|---|---|---|
| `id` | string | always |
| `chat` | string | always, the request's `chat` |
| `from` | string | always, sender mid (empty when the source omits it) |
| `fromName` | string | always, falls back to mid when unresolvable |
| `text` | string | always; undecryptable E2EE is "" |
| `time` | number | always, ms |
| `contentType` | string | always; `NONE`/`IMAGE`/`VIDEO`/`STICKER`/`FLEX`… |
| `decryptFailed` | boolean | always; `true` when E2EE couldn't be decrypted |
| `hasMedia` | boolean | always; unsent messages are always `false` |
| `unsent` | boolean | always; `true` on messages the other side unsent, `text` is "已收回訊息" |
| `mediaState` | string | always; `ok`/`unsent`/`expired`, saying why an attachment won't open |
| `expiresAt` | number | a `FILE` whose metadata has `FILE_EXPIRE_TIMESTAMP`; ms |
| `previewable` | boolean | the attachment can be thumbnailed cheaply; currently `IMAGE` and `VIDEO` with a separate thumbnail. Thumbnails don't ride history: the panel sends `preview` for previewable rows to get a local path |
| `altText` | string | `FLEX` and the layout parsed |
| `flexImages` | string[] | same, absolute `https://` images only |
| `stickerUrl` | string | `STICKER` and metadata has `STKID` |
| `fileName` | string | metadata has `FILE_NAME` |
| `fileSize` | number | metadata has `FILE_SIZE` |
| `mentions` | object[] | message metadata has `MENTION`; `{ start, end, name, mid? , all? }`, same offset units, `all`'s `name` is "全部" |
| `replyTo` | object | this message is a reply (`messageRelationType` is `REPLY`); `{ id, fromName?, text? }` |
| `reactions` | object[] | the message has reactions; `[{ type, count, mine }]` in LINE's enum order |
| `readBy` | object | **own messages only**; `{ count, all }` |
| `fromAvatar` | string | the sender has an avatar already cached; local file path |
| `requestId` | string | the send carried a non-empty `requestId` and LINE kept the metadata |

`replyTo`'s `fromName`/`text` is **best effort**: LINE doesn't send the quoted
message along, and fetching per message means a round trip per bubble, so the
daemon only looks inside the messages it rendered this session (last 500,
`text` truncated at 200 chars). An unresolved one carries only `id` and the
panel must still render (one "回覆訊息" line is enough).

`reactions`' `mine` is "did I pick this one". One person counts once per
message, so `count` sums to how many reacted.

`readBy`'s `count` is "people other than me who read up to this message" and
`all` is "everyone the daemon knows about has read it". In 1:1 that's the
other person having read (drawn "已讀"), in a group not-yet-everyone (drawn
"已讀 N"). The denominator is members with a range in `getMessageReadRange`
(minus self). When nothing is known **the whole field is absent**, not
`count: 0`. "Unknown" must never draw as "nobody read". Fetched once on
opening a chat, then kept by `read` events.


# Using the panel

[繁體中文](usage.zh-TW.md)

This page covers day-to-day use: the keyboard, sending files, notifications,
hidden chats, and the settings. Install and login are in the
[README](../README.md).

## Open a chat and mark it read

Click the bar icon to open the panel. The chat list shows
unread chats first. Type to search chat names and message previews.

The daemon sends read receipts only for the chat you are viewing. In the
two-pane layouts, the chat in the right pane counts as viewed only while you
look at it. Focusing the reply box also counts as viewing the chat.
<!-- verify after merge: read receipts only for the chat being viewed; two-pane fix; composer focus counts as viewing -->

Scrolling to the top loads older messages. An **Unread** divider marks the
first unread message when you open a chat.

## Notifications

Only sent while the panel is **closed** (an open panel already shows the
message). One notification per chat per two seconds (albums and split long
texts arrive in bursts), and your own sends never notify.

What a notification looks like:

- **Title** is the chat (the person in 1:1); **body** is "who: what they said"
  in groups, the content itself in 1:1. Non-text renders as `[圖片]`/`[貼圖]`/
  `[影片]`/`[語音]`/`[檔案]`.
- **Icon** is the chat's avatar. If it isn't cached yet the notification goes
  out after at most three seconds anyway. Better iconless than late.
- **Clicking opens the panel and jumps into that chat.** Mechanism:
  `notify-send --action=default=開啟`. Omarchy's notification plugin invokes
  the libnotify action literally named `default` on click
  (`shell/plugins/notifications/Service.qml:376`), and falls back to focusing
  the sender's window class, but this panel is a layer surface with no window
  to focus. On click the daemon writes a `state.wanted` entry (see
  [protocol.md](protocol.md#wanted-the-chat-opened-from-a-notification)) and runs `omarchy-shell io.github.frankekn.line open`.
- libnotify actions only work while the notifying process lives, so
  `notify-send` stays resident (`--action` already implies `--wait`) until the
  notification is dismissed. After ten silent minutes it reaps itself, so an
  ignored notification never leaves an immortal process.

With no `notify-send`, the first attempt writes
`[notify] notify-send not found; notifications disabled` to the journal once
and never repeats. Everything else is unaffected (`libnotify` package,
preinstalled on Omarchy). Notification **content never enters the journal**.

## Keyboard

```
List      type to search   ↑↓ select   Enter to open
          Esc clears search; with the box empty, Esc leaves the input,
          another Esc closes the panel
          after leaving the input: L highlights "Log out", Enter/Space confirms
          after leaving the input: r syncs now (same as the Sync button)
Chat      input focused:   Enter sends   Shift+Enter newline   /file <path>
          Ctrl+V sends a clipboard image, pastes text otherwise
          Esc peels one layer at a time: sticker menu, then @ menu, then the
          quote bar (draft stays), then leaves the input
          after leaving the input: / back to list search, or Esc to the list;
          r still syncs
@ menu    opens on @ in a group, keeps typing to filter (display-name match,
          case-insensitive)
          ↑↓ pick   Enter or Tab inserts   Esc dismisses (typed text stays)
Stickers  😊 toggles (again closes)   click one to send
          Esc or click outside closes
          wheel scrolls the tab strip sideways (‹ › appear when clipped)
          ⟳ refetches the sticker list
          after leaving the input: ←→ (or h/l) switch packs, ↑↓ still scroll
          messages; with the input focused ←→ moves the cursor
Message   hold left button and drag to select   Ctrl+C copies selection
          Ctrl+Shift+C copies the whole message
          Esc returns focus to the reply box (selection clears)
Lightbox  ←→ (or h/l) previous/next   wheel zooms   drag pans   double-click 1×/2×
          o opens externally (the panel closes; not in `App window` mode)
          Esc or click the backdrop to close
```

With the mouse, drag on a message to select. Links open in the default browser
(`xdg-open`). Right-click opens the menu (six reactions on the top row, then
copy message / copy link / open link / reply / unsend. The link items only
appear over a real link, reply only when one is actually pointed at, unsend
only on your own messages). Messages without a text bubble (images, stickers,
attachments) get the same menu. Reaction chips under a message add on click
and undo your own. The quote line above a reply jumps to the original.
Clicking empty space clears the selection and returns focus to the input, so
you can keep typing right after selecting. Opening a link or a file follows
one rule: the two overlay placements ("below the bar" and "center") close the
panel first (otherwise the browser hides underneath). `App window` mode does
not. Only `http://` and `https://` open. Anything else is refused with
"Can't open this link".

Copying goes through **wl-copy** (the `wl-clipboard` package): content travels
over stdin, never on a command line. It isn't in `omarchy`'s dependency list,
but omarchy's own clipboard plugin and network panel use it, so any normal
setup has it. If it is missing, copy answers
"Copy failed: wl-copy not found". Run `sudo pacman -S wl-clipboard` and it works
immediately.

With the sticker menu open, Esc only closes the menu. The chat does not fall
back to the list. The menu is the topmost layer (except the lightbox). Switching
chats, leaving the conversation, or logging out also closes it: picking half
way and switching chats would send the next sticker to the wrong room.

With the lightbox open, Esc only closes the lightbox. The chat does not fall
back either, and focus returns to wherever it was (the reply box in a chat, the
search box in the list). While it is open only `o` does anything. Not even
`r` goes through, so close it first to sync.

`/`, `L` and `r` only work when the input box isn't focused (after Esc).
Otherwise they're just characters. `r` needs no arm-and-confirm like `L`:
syncing can't break anything, an extra press is just an extra round.


## Send files and images

- Press `📎` to pick a file, or type `/file <path>` in the reply box. The
  picker needs `zenity`. Without it, `📎` tells you to install it.
- Press `Ctrl+V` in the reply box to send an image from the clipboard. This
  needs `wl-clipboard`. If the clipboard holds text, `Ctrl+V` pastes the text
  as usual.
- Images (GIF included) up to 20 MB, and videos and other files up to 1 GB.
  The panel refuses a bigger file before it uploads anything.
- An image goes out as an image and a video as a video. Audio goes out as a
  file.
- A sent video gets a preview image only when `ffmpegthumbnailer` or `ffmpeg`
  is installed. Without either, the video still sends, with no preview.
- Multi-person rooms (chat ids that start with `r`) cannot receive files.
- LINE keeps chat files for 7 days. An expired file shows "(expired)" and
  does not open. An unsent message shows as "Message unsent".

Videos and files open in an external program. In the two overlay placements
the panel closes first, so the viewer is not hidden behind it.
[architecture.md](architecture.md#media-pipeline) describes how sending and
downloading work.

## Hide a chat

Right-click a chat in the list and choose **Hide chat**. The chat leaves the
list, does not notify, and does not count toward the bar badge, even when new
messages arrive. To find it again, type in the search box. It appears at the
end of the results with a "Hidden" tag, and the same menu offers **Unhide**.

Hiding is a preference on this computer only. LINE has no field for it, so
your phone does not hide the chat. The daemon records hidden chats in
`~/.local/state/enil/hidden.json`. Hiding is not "leave chat": you stay in
the group on every device.

## Settings

Panel language (`language`) is `System`, `繁體中文` or `English`. `System`
follows your OS locale. zh* gets 繁體中文 and everything else gets English,
so an English system still gets 繁體中文 by picking it explicitly:

```bash
omarchy bar set io.github.frankekn.line language "繁體中文"
```

Daemon-reported errors and message placeholders follow the same setting at
display time. The wire protocol stays unchanged.

`A−` `A+` next to the search box adjust text scale directly (80–160, steps of
10). Written back to shell.json, so it survives reboots.

Or by command:

```bash
omarchy bar set io.github.frankekn.line textScale 130
```

`Scroll 1×` on the same row is wheel speed (`scrollSpeed`, %); click steps
through (0.5× → 0.75× → 1× → 1.5× → 2× → 3× → 0.5×). Chat list, conversation,
and sticker menu all change together. `1×` is default (a notch ≈ 60px, close
to the old fixed step):

```bash
omarchy bar set io.github.frankekn.line scrollSpeed 150
```

Any number in 50–300 is accepted, not just the six steps. The button shows
your factor and clicking jumps to the next step above it. Qt's `Flickable`
has no "pixels per wheel notch" setting (the step is hardcoded), so the panel
measures wheel distance itself: a normal mouse notch is 60px (scaled to the
theme's spacing) × factor, a touchpad reports its real delta × factor (so
speeding up doesn't turn a touchpad into one-screen-per-swipe). The
horizontally scrolling strips in the sticker menu (tab strip, recents) share
the same logic with their own step (≈ two tabs, or one sticker). Dragging,
touch, the scrollbar and the `j`/`k` keys are unchanged.

Next over, `Read 60` is how many messages to ask the daemon at once
(`historyPage`). Click steps (30 → 60 → 100 → 150 → 30). **The first page
when opening a chat and every older page above use this number:**

```bash
omarchy bar set io.github.frankekn.line historyPage 100
```

Any number in 20–200 is accepted, steps or not (same rule as scroll speed:
the button looks for "the next step above current", so hand-editing 37 still
works). The 200 cap is recognized by the daemon too. A `count` arriving over
the socket is clamped to 1–200 there as well, and a non-number counts as
unset (default 30).

Bigger costs a slower first load per chat in exchange for fewer round trips
when reading back. Default is 60: at 30, a page barely covers one screen, so
nearly every scroll-up hits the network.

Older pages don't wait for the very top: **the next page is requested one
screen before the top**, so by the time you reach it the page is usually
already attached. One request in flight at a time, and once the oldest
message is reached it stops asking (an empty page from the daemon means "no
older"). Reopening the chat or pressing sync restarts the count.

Panel position (`placement`) has three modes. The button right of the search
box shows **the current one**. Click cycles (below bar → center → window →
below bar), written back to shell.json:

| Value | Layout | Best for |
|---|---|---|
| `Below the bar` (default) | hangs under the bar icon, single column, list and conversation swap | a glance at unread |
| `Center of screen` | centered, list left + conversation right at once (like the TUI) | replying to a few messages |
| `App window` | a regular Hyprland window, two columns | running it as a chat app |

```bash
omarchy bar set io.github.frankekn.line placement "App window"
```

The first two are `WlrLayer.Overlay`: always on top of every window and
outside Hyprland's window rules. `App window` is a real toplevel: tiles or
floats per your rules, alt-tabs, moves to other workspaces, and external
viewers stack normally when opening images/videos (no panel close needed).
Its window class is `org.quickshell`, title `LINE` (omarchy's dev gallery
shares the class). To float it:

```bash
# ~/.config/hypr/windows.conf (or wherever your windowrules live)
windowrule = float, class:^(org\.quickshell)$, title:^(LINE)$
windowrule = size 1040 720, class:^(org\.quickshell)$, title:^(LINE)$
```

The window remembers its size (written back to `windowWidth`/`windowHeight`
0.8 s after you stop resizing a floating window; a tiled window's size is the
layout's, so retiles are not recorded) and reopens the same. Or set it
directly:

```bash
omarchy bar set io.github.frankekn.line windowWidth 1280
omarchy bar set io.github.frankekn.line windowHeight 860
```

All three modes share identical keyboard handling (Esc peels back to close,
`/`, `L`, `r`, the lightbox). The only difference is Tab ("switch to the
neighboring bar panel"), which does nothing in `App window` mode because the
window isn't a bar panel.


## Known limits

- Unofficial client, with account risk (see the [Disclaimer](../README.md#disclaimer))
- Panel UI is Traditional Chinese or English, and message content is untranslated
- Multi-person rooms (`r…` mids) can't take files. linejs's
  `uploadMediaByE2EE` only accepts `u`/`c`
- E2EE videos show 📎 rather than a thumbnail: the thumbnail is encrypted
  too, and getting one means downloading the whole video
- Sent videos need `ffmpegthumbnailer` or `ffmpeg` for a preview. With
  neither, they send without one (see [Send files and images](#send-files-and-images)). A decoder is
  deliberately not a hard dependency
- Sent videos carry no resolution (`WIDTH`/`HEIGHT`): knowing it takes
  decoding a frame, and the thumbnail step is allowed to be absent
- AVI has no readable duration: `RIFF` doesn't fix a duration's position in
  the header, and LINE won't compute it either


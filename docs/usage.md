# Using the panel

[繁體中文](usage.zh-TW.md)

This page covers day-to-day use: the keyboard, sending files, notifications,
hidden chats, and the settings. Install and login are in the
[README](../README.md).

## Open a chat and mark it read

Click the bar icon to open the panel. The chat list shows
unread chats first. Type to search chat names and message previews.

The daemon sends read receipts only for the chat you are viewing. The
`Center of screen` and `App window` placements show the list and the chat
side by side. When you press Esc to go back to the list, the chat stays in
the right pane, but new messages in it are not marked read. To view the chat
again, click its row in the list or click into its reply box. Clicking the
reply box sends one read receipt for the messages that arrived in the
meantime.

Scrolling to the top loads older messages. An **Unread** divider marks the
first unread message when you open a chat.

## Notifications

The daemon sends a desktop notification only while the panel is closed. An
open panel already shows the message. Your own messages and hidden chats never
notify. A chat gets at most one notification every two seconds, because an
album or a long text split into parts arrives as a burst of messages.

A notification has these parts:

- The title is the chat name. In a one-to-one chat, it is the other person's
  name.
- In a group, the body is the sender's name and the message, as
  `name: message`. In a one-to-one chat, the body is the message only.
- The icon is the chat's profile picture. If the daemon has not downloaded
  the picture yet, it waits up to three seconds and then sends the
  notification without an icon.

The daemon writes notification text in Traditional Chinese, whatever the panel
language is. A message without text shows as `[貼圖]` (sticker), `[圖片]`
(image), `[影片]` (video), `[語音]` (voice message), or `[檔案]` (file). Any
other message without text, such as a message that could not be decrypted,
shows as `[新訊息]` (new message).

Click a notification to open the panel at that chat. The daemon passes
`--action=default=開啟` to `notify-send`. Omarchy's notification service runs
the action named `default` when you click a notification. Without that
action, it tries to focus a window of the sending app, and the panel has no
window to focus. When you click, the daemon writes the chat to `wanted` in
`state.json` (see
[protocol.md](protocol.md#wanted-the-chat-opened-from-a-notification)) and
runs `omarchy-shell io.github.frankekn.line open`.

A notification action works only while the `notify-send` process that sent it
is running. So each `notify-send` process stays until you dismiss its
notification, or for at most ten minutes. After ten minutes the daemon ends
the process, and clicking that notification does nothing.

`notify-send` comes from the `libnotify` package, which Omarchy installs. If
it is missing, the daemon writes
`[notify] notify-send not found; notifications disabled` to the journal once
and sends no more notifications. Everything else keeps working. The daemon
never writes notification content to the journal.

## Keyboard

Some keys work only after you leave the text box. To leave it, press Esc.
Inside the text box, `/`, `L`, and `r` are ordinary characters.

In the chat list:

| Key | Action |
|---|---|
| Type | Search chat names, senders, and message previews. |
| ↑ ↓ | Select a chat. |
| Enter | Open the selected chat. |
| Esc | Clear the search. With an empty search, leave the text box. Press Esc again to close the panel. |
| `L` | Outside the text box: select **Log out**. Press Enter or Space to log out. |
| `r` | Outside the text box: sync now, the same as **Sync**. |

In a chat, with the reply box focused:

| Key | Action |
|---|---|
| Enter | Send the message. |
| Shift+Enter | Start a new line. |
| `/file <path>` | Send a file. |
| Ctrl+V | Send the clipboard image. If the clipboard holds text, paste the text. |
| Esc | Close one layer at a time: the sticker menu, then the @ menu, then the reply quote (the draft stays), then leave the reply box. |

In a chat, outside the reply box:

| Key | Action |
|---|---|
| `/` | Go back to the list and focus the search box. |
| Esc | Go back to the list. |
| `r` | Sync now. |
| ↑ ↓, `j` `k` | Scroll the messages. |

The @ menu opens when you type `@` in a group. Keep typing to filter the
members by display name. The filter ignores case. Press ↑ or ↓ to pick a
member, and press Enter or Tab to insert the name. Esc closes the menu and
keeps what you typed.

The sticker menu opens and closes with the 😊 button. Click a sticker to send
it. Esc or a click outside the menu closes it. The mouse wheel scrolls the
row of sticker packs sideways, and ‹ › buttons appear when the row does not
fit. The ⟳ button downloads the sticker list again. Outside the reply box,
← → (or `h` `l`) switch packs, and ↑ ↓ still scroll the messages. In the reply
box, ← → move the cursor.

While the sticker menu is open, Esc closes only the menu. The chat stays
open. Switching chats, leaving the chat, or logging out also closes the menu,
so a sticker you pick cannot go to a different chat than the one you opened
the menu in.

To copy text, drag across a message with the left mouse button and press
Ctrl+C. Ctrl+Shift+C copies the whole message. Esc clears the selection and
returns focus to the reply box.

In the image viewer:

| Key or action | Result |
|---|---|
| ← → (or `h` `l`) | Show the previous or next image. |
| Mouse wheel | Zoom. |
| Drag | Pan. |
| Double-click | Switch between 1× and 2×. |
| `o` | Open the image in an external program. In the two overlay placements, the panel closes first. |
| Esc, or a click on the backdrop | Close the viewer. |

While the image viewer is open, only `o` and the keys above work. Even `r`
does nothing, so close the viewer before you sync. Closing the viewer
returns focus to where it was: the reply box in a chat, or the search box in
the list.

`r` syncs at once, without the confirm step that `L` has. A sync cannot lose
anything. An extra press costs one extra refresh.

## Use the mouse

- Click a link to open it in your default browser with `xdg-open`. Only
  `http://` and `https://` links open. Other links show
  `Can't open this link`.
- Right-click a message to open its menu. The top row has six reactions.
  Below it are **Copy message**, **Copy link**, **Open link**, **Reply**,
  and **Unsend**. **Copy link** and **Open link** appear only when you
  right-click a link. **Reply** appears only when the panel can identify the
  message, and **Unsend** only on your own messages. Images, stickers, and
  files have the same menu.
- Click a reaction under a message to add the same reaction. Click your own
  reaction to remove it.
- Click the quote above a reply to jump to the original message.
- Click empty space to clear the selection and return focus to the reply
  box.

In the `Below the bar` and `Center of screen` placements, the panel closes
before it opens a link or a file, so the browser or viewer is not hidden
under the panel. In the `App window` placement, the panel stays open.

Copying uses `wl-copy` from the `wl-clipboard` package. The text goes to
`wl-copy` on standard input, never on a command line. Omarchy does not list
`wl-clipboard` as a dependency, but its clipboard plugin and network panel
use it, so most systems have it. If it is missing, copying shows
`Copy failed: wl-copy not found`. Install it with
`sudo pacman -S wl-clipboard`, and copying works at once.

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

The panel saves each setting in Omarchy's `shell.json`, so settings survive a
restart. You can change a setting with the buttons next to the search box or
with `omarchy bar set`.

### Language

`language` is `System`, `繁體中文`, or `English`. `System` follows your
system locale. A locale that starts with `zh` gets Traditional Chinese, and
any other locale gets English. To use Traditional Chinese on an English
system, set it explicitly:

```bash
omarchy bar set io.github.frankekn.line language "繁體中文"
```

The setting also translates error messages and message placeholders from the
daemon when the panel shows them. The daemon itself always sends them in
Traditional Chinese. Notifications come from the daemon, so they stay in
Traditional Chinese (see [Notifications](#notifications)).

### Text size

The `A−` and `A+` buttons change `textScale` by 10, from 80 to 160 percent.
The default is 100.

```bash
omarchy bar set io.github.frankekn.line textScale 130
```

### Scroll speed

The `Scroll 1×` button shows the mouse wheel speed (`scrollSpeed`, in
percent). Each click moves to the next step: 0.5×, 0.75×, 1×, 1.5×, 2×, 3×,
and back to 0.5×. The speed applies to the chat list, the messages, and the
sticker menu. The default is 1×, about 60 pixels for one notch of a normal
mouse wheel.

```bash
omarchy bar set io.github.frankekn.line scrollSpeed 150
```

You can set any value from 50 to 300, not only the steps. The button then
shows your value, and the next click moves to the next step above it.

Qt's `Flickable` has no setting for the distance of one wheel notch, so the
panel measures the wheel itself. One notch of a normal mouse moves 60 pixels,
scaled to the theme's spacing, times the speed. A touchpad moves the distance
it reports, times the speed, so a fast setting does not turn one swipe into a
full screen. The sideways rows in the sticker menu (the pack row and the
recent stickers) use the same speed with their own step of about two packs or
one sticker. Dragging, touch, the scroll bar, and the `j` and `k` keys do not
change with this setting.

### Messages per page

The `Read 60` button shows how many messages the panel asks the daemon for at
a time (`historyPage`). The first page of a chat and every older page use
this number. Each click moves to the next step: 30, 60, 100, 150, and back to
30. The default is 60.

```bash
omarchy bar set io.github.frankekn.line historyPage 100
```

You can set any value from 20 to 200. The button finds the next step above
your value, so a hand-set 37 moves to 60. The daemon also accepts at most 200.
It limits a `count` from the socket to 1 through 200, and it uses 30 when
`count` is not a number.

A bigger page loads the first page of a chat more slowly, but it needs fewer
requests when you scroll back. At 30, one page barely fills the screen, so
almost every scroll up waits for the network. That is why the default is 60.

The panel asks for the next older page when you are one screen away from the
top, so the page is usually there before you reach the top. The panel sends
one request at a time. When the daemon returns an empty page, the panel has
the oldest message and stops asking. Opening the chat again or a sync starts
over.

### Panel position

`placement` has three values. The button to the right of the search box shows
the current one, and each click moves to the next. The table shows the
setting value and the button label in the English panel.

| Setting value | Button label | Layout | Use it for |
|---|---|---|---|
| `Below the bar` (default) | Below the bar | Opens under the bar icon in one column. The list and the chat replace each other. | A quick look at unread messages. |
| `Center of screen` | Centered | Opens in the middle of the screen with the list on the left and the chat on the right. | Answering a few messages. |
| `App window` | Window | A normal Hyprland window with two columns. | Keeping LINE open as a chat app. |

```bash
omarchy bar set io.github.frankekn.line placement "App window"
```

`Below the bar` and `Center of screen` are `WlrLayer.Overlay` layers. They
stay above every window, and Hyprland's window rules do not apply to them.
`App window` is a normal window. It tiles or floats according to your rules,
appears in Alt+Tab, and moves to other workspaces. An external image or video
viewer opens above it, so the panel does not need to close first. Its window
class is `org.quickshell`, and its title is `LINE`. Omarchy's own developer
gallery uses the same class, so match the title too. To make it float:

```bash
# ~/.config/hypr/windows.conf (or wherever your windowrules live)
windowrule = float, class:^(org\.quickshell)$, title:^(LINE)$
windowrule = size 1040 720, class:^(org\.quickshell)$, title:^(LINE)$
```

The window remembers its size. When you stop resizing a floating window, the
panel waits 0.8 seconds and saves the size to `windowWidth` and
`windowHeight`. A tiled window gets its size from the layout, so the panel
does not save it. You can also set the size directly:

```bash
omarchy bar set io.github.frankekn.line windowWidth 1280
omarchy bar set io.github.frankekn.line windowHeight 860
```

The keys work the same in all three placements, with one exception. Tab
switches to the next bar panel, so it does nothing in `App window`, which is
not a bar panel.

## Known limits

- This is an unofficial client, and using it puts your account at risk. See
  the [Disclaimer](../README.md#disclaimer).
- The panel is in Traditional Chinese or English. Message content is not
  translated.
- Multi-person rooms (chat ids that start with `r`) cannot receive files.
  linejs' `uploadMediaByE2EE` accepts only `u` and `c` chats.
- An E2EE video shows 📎 instead of a preview. Its preview image is encrypted
  too, and getting it means downloading the whole video.
- A sent video gets a preview only when `ffmpegthumbnailer` or `ffmpeg` is
  installed (see [Send files and images](#send-files-and-images)). The panel
  does not require a video decoder.
- A sent video carries no resolution (`WIDTH` and `HEIGHT`). Finding the
  resolution means decoding a frame, and the preview step may be missing.
- An AVI file has no duration. The `RIFF` format does not put the duration at
  a fixed place in the header, and LINE does not compute it.

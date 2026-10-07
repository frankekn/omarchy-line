#!/usr/bin/env python3
"""Stub daemon for the omarchy-line bar plugin.

Speaks the two interfaces the plugin actually depends on, with no LINE
involved and no third-party packages:

  ~/.local/state/enil/state.json  atomic writes, refreshed on a heartbeat
  ~/.local/state/enil/sock        line-delimited JSON request/response

The shapes mirror daemon/daemon.ts (PluginChat, PluginMessage, handle()) and
the README 契約 section; daemon/stub_test.py pins them. Everything it serves
is fabricated, and deliberately obviously so: this exists so the panel can be
driven and looked at without a real LINE session.
"""

import hashlib
import json
import os
import re
import shutil
import signal
import socketserver
import struct
import sys
import threading
import time
import urllib.parse
import uuid
import zlib

STATE_DIR = os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "enil"
)
STATE_PATH = os.path.join(STATE_DIR, "state.json")
SOCK_PATH = os.path.join(STATE_DIR, "sock")
MEDIA_DIR = os.path.join(STATE_DIR, "media")
AVATAR_DIR = os.path.join(MEDIA_DIR, "avatars")
# daemon.ts IMAGE_DIR: the public-image cache the `image` command answers from.
IMAGE_DIR = os.path.join(MEDIA_DIR, "public-images")

ME = "ustub-me-0000"
HEARTBEAT = 30.0          # panel calls the daemon offline after 180s
LOGIN_QR_SECONDS = 6.0    # stub login: qr -> pin -> ok
LOGIN_PIN_SECONDS = 4.0
# The daemon's event ring: last 200, seq strictly increasing per process.
EVENTS_MAX = 200
# The daemon uses a uuid; all the panel does with it is notice that it changed.
BOOT_ID = "stub-%d" % int(time.time() * 1000)
# There is nobody on the other end to read anything, so the stub plays the part
# a couple of seconds after a send -- 已讀 cannot be developed against a field
# that never arrives.
READ_DELAY_SECONDS = 2.0
CLIPBOARD_STAGE_TTL_SECONDS = 10 * 60

# MessageReactionType minus ALL and UNDO, in the enum's order, which is the
# order summariseReactions() emits rows in.
REACTION_TYPES = ("NICE", "LOVE", "FUN", "AMAZING", "SAD", "OMG")
# What `react` accepts, exactly as the daemon's REACTION_PICKABLE.
REACTION_PICKABLE = ("UNDO",) + REACTION_TYPES

# The daemon builds these from the sticker shop CDN; any absolute https URL
# exercises the same Image path in the panel.
STICKER_CDN = "https://stickershop.line-scdn.net/stickershop/v1"
STICKER_URL = "%s/sticker/52002734/android/sticker.png" % STICKER_CDN
# daemon.ts isStickerId: package and sticker ids are decimal counters, and
# both end up in a URL and in contentMetadata.
STICKER_ID = re.compile(r"^[1-9][0-9]{0,19}$")


def sticker_url(sticker_id, animated):
    """daemon.ts stickerImageUrl: the animated variant is a different file."""
    return "%s/sticker/%s/android/%s" % (
        STICKER_CDN, sticker_id,
        "sticker_animation.png" if animated else "sticker.png")


def _arm_clipboard_expiry_locked(timer_factory=threading.Timer, now=time.time):
    """Arm the sole worker for the earliest outstanding stage."""
    global clipboard_expiry_deadline, clipboard_expiry_timer
    global clipboard_expiry_generation
    if not clipboard_stage_timers:
        if clipboard_expiry_timer:
            clipboard_expiry_timer.cancel()
            clipboard_expiry_timer = None
            clipboard_expiry_deadline = None
            clipboard_expiry_generation += 1
        return None
    deadline = min(record["deadline"]
                   for record in clipboard_stage_timers.values())
    if (clipboard_expiry_timer is not None
            and clipboard_expiry_deadline is not None
            and clipboard_expiry_deadline <= deadline):
        return clipboard_expiry_timer
    if clipboard_expiry_timer:
        clipboard_expiry_timer.cancel()
    clipboard_expiry_timer = None
    clipboard_expiry_deadline = None
    clipboard_expiry_generation += 1
    generation = clipboard_expiry_generation

    def cleanup():
        global clipboard_expiry_deadline, clipboard_expiry_timer
        paths = []
        with lock:
            if generation != clipboard_expiry_generation:
                return
            clipboard_expiry_timer = None
            clipboard_expiry_deadline = None
            current = max(now(), deadline)
            for stage, record in list(clipboard_stage_timers.items()):
                if record["deadline"] <= current:
                    paths.append(record["path"])
                    clipboard_stage_timers.pop(stage, None)
                    clipboard_stage_bindings.pop(stage, None)
            try:
                _arm_clipboard_expiry_locked(timer_factory, now)
            except Exception:
                # With no worker available, retire every remaining lease now.
                # This is safer than leaving untracked files indefinitely and
                # still guarantees the due files below are removed.
                paths.extend(record["path"]
                             for record in clipboard_stage_timers.values())
                clipboard_stage_timers.clear()
                clipboard_stage_bindings.clear()
        for expired_path in paths:
            try:
                os.remove(expired_path)
            except FileNotFoundError:
                pass

    timer = timer_factory(max(0, deadline - now()), cleanup)
    timer.daemon = True
    clipboard_expiry_timer = timer
    clipboard_expiry_deadline = deadline
    try:
        timer.start()
    except BaseException:
        clipboard_expiry_timer = None
        clipboard_expiry_deadline = None
        clipboard_expiry_generation += 1
        raise
    return timer


def expire_clipboard_stage(path, delay=CLIPBOARD_STAGE_TTL_SECONDS,
                           timer_factory=threading.Timer, now=time.time):
    """Register a lease on the one shared clipboard-expiry worker."""
    stage = os.path.basename(path)
    with lock:
        clipboard_stage_timers[stage] = {
            "path": path, "deadline": now() + delay}
        try:
            return _arm_clipboard_expiry_locked(timer_factory, now)
        except BaseException:
            clipboard_stage_timers.pop(stage, None)
            clipboard_stage_bindings.pop(stage, None)
            if clipboard_stage_timers and clipboard_expiry_timer is None:
                try:
                    _arm_clipboard_expiry_locked()
                except BaseException:
                    pass
            try:
                os.remove(path)
            except OSError:
                pass
            raise


def cancel_clipboard_stage_expiry(stage):
    """Remove a lease and re-arm the shared worker for what remains."""
    with lock:
        if clipboard_stage_timers.pop(stage, None) is not None:
            _arm_clipboard_expiry_locked()


def clipboard_stage_expired(path, now=time.time):
    """Treat a missing or over-age stage as unavailable to a sender."""
    try:
        return now() - os.path.getmtime(path) >= CLIPBOARD_STAGE_TTL_SECONDS
    except FileNotFoundError:
        return True


def recover_clipboard_stages(directory=MEDIA_DIR, now=time.time,
                             timer_factory=threading.Timer):
    """Remove stages whose in-process expiry timers were lost on restart."""
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return
    for name in names:
        if re.fullmatch(r"clipboard-[0-9a-f-]+\.png\.tmp", name):
            try:
                os.remove(os.path.join(directory, name))
            except FileNotFoundError:
                pass
            continue
        if not re.fullmatch(r"clipboard-[0-9a-f-]+\.png", name):
            continue
        path = os.path.join(directory, name)
        try:
            age = max(0, now() - os.path.getmtime(path))
        except FileNotFoundError:
            continue
        if age >= CLIPBOARD_STAGE_TTL_SECONDS:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
        else:
            expire_clipboard_stage(
                path, max(0, CLIPBOARD_STAGE_TTL_SECONDS - age), timer_factory)


def retire_clipboard_stages(directory=MEDIA_DIR):
    """Invalidate every stage from the session that is ending."""
    global clipboard_expiry_deadline, clipboard_expiry_timer
    global clipboard_expiry_generation
    with lock:
        stages = set(clipboard_stage_bindings) | set(clipboard_stage_timers)
        timer = clipboard_expiry_timer
        clipboard_expiry_timer = None
        clipboard_expiry_deadline = None
        clipboard_expiry_generation += 1
        clipboard_stage_bindings.clear()
        clipboard_stage_timers.clear()
    if timer:
        timer.cancel()
    for stage in stages:
        try:
            os.remove(os.path.join(directory, stage))
        except FileNotFoundError:
            pass


def stub_package(pkg_id, name, version, ids, animated):
    return {
        "id": pkg_id, "name": name, "version": version,
        "stickers": [{"id": i, "url": sticker_url(i, animated),
                      "animated": animated} for i in ids],
    }


# Two packages, because one hides everything the picker has to switch between:
# a still package and an animated one resolve to different files under the
# same ids, and the panel has to draw both.
STICKER_PACKAGES = [
    stub_package("1", "STUB 饅頭人&詹姆士", 3, ["4", "13", "401"], False),
    stub_package("11537", "STUB 動起來的貼圖", 7, ["52002734", "52002735"], True),
]
# collectFlexImages() in daemon.ts keeps only absolute https urls, so a
# file:// path here would be a shape the real daemon can never produce.
FLEX_IMAGE_URL = "https://placehold.co/240x160/png"

# Which fabricated mids have a profile picture. Deliberately not all of them:
# a chat or a sender with no avatar is a case the panel has to draw too, and a
# fixture where everybody has one hides it.
AVATAR_SEEDS = {
    ME: 2,
    "cstub-family": 3,
    "cstub-work": 5,
    "ustub-alice": 7,
    "ustub-mom": 11,
    "ustub-bot": 13,
}

# mid -> a ready-made picture, filled by the demo fixtures.
AVATAR_FILES = {}

lock = threading.RLock()
state = {}
messages = {}             # chat mid -> [message, ...]
preview_sources = {}      # message id -> lazy IMAGE/VIDEO thumbnail
download_sources = {}     # message id -> original IMAGE payload
members = {}              # chat mid -> [{mid, name}, ...], sorted by name
reactors = {}             # message id -> {reactor mid: reaction type}
# Chat mids the user has taken off the list. The daemon keeps this in
# hidden.json; the stub is thrown away with its state dir, so a set is the
# whole of it. It outlives a logout for the same reason the daemon's file
# does: it is a preference about a chat, not part of a session.
hidden = set()
login_timer = None
event_seq = 0
wanted_seq = 0
session_generation = 1
clipboard_stage_bindings = {}
clipboard_stage_timers = {}
clipboard_expiry_timer = None
clipboard_expiry_deadline = None
clipboard_expiry_generation = 0

# daemon.ts's MENTION_MID: a LINE user mid is u + 32 lowercase hex. The stub
# validates what the panel sends exactly as the daemon does, so a panel that
# builds a bad mention fails here too rather than only against real LINE.
MENTION_MID = re.compile(r"^u[0-9a-f]{32}$")
MENTION_ALL_NAME = "全部"


def member_mid(name):
    """A real-shaped mid for a fabricated member, so MENTION_MID accepts it."""
    return "u" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:32]


def utf16_len(s):
    """Mention offsets are UTF-16 code units (README 契約); Python counts code
    points. The two differ only above the BMP -- an emoji -- which is exactly
    what a fixture must not get wrong."""
    return len(s.encode("utf-16-le")) // 2


def normalize_mentions(raw, text):
    """daemon.ts's normalizeMentions: sorted, non-overlapping, in range."""
    limit = utf16_len(text)
    found = []
    for e in raw if isinstance(raw, list) else []:
        if not isinstance(e, dict):
            continue
        start, end = e.get("start"), e.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            continue
        if isinstance(start, bool) or isinstance(end, bool):
            continue
        if start < 0 or end <= start or end > limit:
            continue
        if e.get("all") is True:
            found.append({"start": start, "end": end, "all": True})
            continue
        mid = e.get("mid") or ""
        if MENTION_MID.match(mid):
            found.append({"start": start, "end": end, "mid": mid})
    found.sort(key=lambda m: m["start"])
    kept = []
    for m in found:
        if kept and m["start"] < kept[-1]["end"]:
            continue
        kept.append(m)
    return kept


# --------------------------------------------------------------- PNG output
# Minimal greyscale PNG writer. Avoids a Pillow/qrcode dependency for what is
# only ever placeholder art.

def write_png(path, rows):
    h = len(rows)
    w = len(rows[0])
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(png)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def write_qr_png(path, seed_value):
    """A QR-shaped placeholder: real finder patterns, deterministic noise."""
    n, scale, quiet = 25, 8, 3
    mod = [[1] * n for _ in range(n)]
    rnd = seed_value
    for y in range(n):
        for x in range(n):
            rnd = (rnd * 1103515245 + 12345) & 0x7FFFFFFF
            mod[y][x] = (rnd >> 16) & 1
    for oy, ox in ((0, 0), (0, n - 7), (n - 7, 0)):
        for y in range(7):
            for x in range(7):
                edge = y in (0, 6) or x in (0, 6)
                core = 2 <= y <= 4 and 2 <= x <= 4
                mod[oy + y][ox + x] = 0 if (edge or core) else 1
        for y in range(-1, 8):
            for x in range(-1, 8):
                if 0 <= oy + y < n and 0 <= ox + x < n and not (0 <= y < 7 and 0 <= x < 7):
                    mod[oy + y][ox + x] = 1

    side = (n + quiet * 2) * scale
    rows = [[255] * side for _ in range(side)]
    for y in range(n):
        for x in range(n):
            v = 255 if mod[y][x] else 0
            for dy in range(scale):
                for dx in range(scale):
                    rows[(y + quiet) * scale + dy][(x + quiet) * scale + dx] = v
    write_png(path, rows)


def write_thumb_png(path, seed_value, w=240, h=160):
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            row.append((x * 3 + y * 5 + seed_value * 40) % 256)
        rows.append(row)
    write_png(path, rows)


def write_avatar_png(path, seed_value, size=96):
    """A disc on white: an avatar has to be recognisable as one at 32px, and a
    corner-to-corner gradient is not."""
    r = size / 2.0
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            d = ((x - r + 0.5) ** 2 + (y - r + 0.5) ** 2) ** 0.5
            row.append(255 if d > r - 2 else (seed_value * 29 + int(d) * 3) % 190)
        rows.append(row)
    write_png(path, rows)


def stub_avatar(mid):
    """The daemon's `avatarPath`/`fromAvatar` for a mid, or None.

    Written on demand rather than up front so the busy fixture does not pay
    for 200 pictures nobody looks at.
    """
    if mid in AVATAR_FILES:
        return AVATAR_FILES[mid]
    seed_value = AVATAR_SEEDS.get(mid)
    if seed_value is None:
        return None
    path = os.path.join(AVATAR_DIR, "stub-%s.png" % mid)
    if not os.path.exists(path):
        write_avatar_png(path, seed_value)
    return path


# ------------------------------------------------------------- state on disk

# Armed by `fail-refresh`, consumed by the next write_state(): how many failed
# getMessageBoxes rounds the next state write should pretend happened.
refresh_failing = 0


def write_state():
    """Atomic, because the plugin watches this file with FileView."""
    global refresh_failing
    with lock:
        state["updatedAt"] = int(time.time() * 1000)
        # Stamped here, like the daemon's hiddenStamped(): `hidden` is a
        # preference the chat rows are rebuilt underneath (logout empties the
        # list), and only the hidden rows carry the key at all.
        for c in state.get("chats", []):
            if c["mid"] in hidden:
                c["hidden"] = True
            else:
                c.pop("hidden", None)
        # The daemon's refresh health (README 契約). The stub has no network
        # to fail, so an ordinary write stands for a getMessageBoxes round
        # that just succeeded: fresh `at`, zero streak. `fail-refresh` arms
        # refresh_failing instead, and this one write spends it -- `at` sits
        # still through the pretend outage (it is "the last time the list was
        # really fresh"), and the write after that is the recovery. Absent
        # while logged out, like the daemon before login/after logout (the
        # lock is an RLock, so reading the status here re-enters it).
        if not logged_in():
            state.pop("refresh", None)
        elif refresh_failing:
            prev = state.get("refresh") or {}
            state["refresh"] = {
                "at": int(prev.get("at") or 0),
                "failures": int(prev.get("failures") or 0) + refresh_failing,
                "reason": "network",
            }
            refresh_failing = 0
        else:
            state["refresh"] = {"at": state["updatedAt"], "failures": 0}
        blob = json.dumps(state, ensure_ascii=False, indent=2)
        # The write stays under the lock with the snapshot that produced it.
        # os.replace() alone only makes one writer atomic: every caller here
        # shares the one `.tmp` name, and the stub has several threads that
        # write -- a handler per connection plus the login timer -- so two of
        # them outside the lock would interleave their bytes in that file, and
        # whichever replace() landed second would decide the state, which is
        # not the one that ran last.
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(blob)
        os.replace(tmp, STATE_PATH)


# ------------------------------------------------------------- notifications

def set_wanted(mid):
    """state.wanted: what the daemon writes when a notification is clicked.

    The real one gets here from notify-send's `default` action; the stub has
    no notification server, so `poke` is the way in -- see handle().
    """
    global wanted_seq
    with lock:
        wanted_seq += 1
        state["wanted"] = {"chat": mid, "at": int(time.time() * 1000),
                           "seq": wanted_seq}
        return dict(state["wanted"])


# ---------------------------------------------------------------- events

def push_event(kind, chat, **payload):
    """One entry of the `events` ring, numbered like the daemon's pushEvent."""
    global event_seq
    with lock:
        event_seq += 1
        ev = {"seq": event_seq, "at": int(time.time() * 1000),
              "kind": kind, "chat": chat}
        ev.update(payload)
        events = state.setdefault("events", [])
        events.append(ev)
        # Slicing in place, so the list the state dict holds stays the same one.
        del events[:-EVENTS_MAX]
    return ev


def find_message(message_id):
    """(chat mid, message) for an id, or (None, None)."""
    with lock:
        for mid, msgs in messages.items():
            for m in msgs:
                if m["id"] == message_id:
                    return mid, m
    return None, None


def summarise_reactions(by_user):
    """One row per type, in the enum's order -- the bar must not reshuffle."""
    rows = []
    for t in REACTION_TYPES:
        who = [mid for mid, chosen in by_user.items() if chosen == t]
        if who:
            rows.append({"type": t, "count": len(who), "mine": ME in who})
    return rows


def apply_reaction(message_id, who, rtype):
    """Moves one person's choice and rewrites the message's bar. -> rows."""
    with lock:
        by_user = reactors.setdefault(message_id, {})
        # UNDO is a removal, never a row; the daemon's applyReaction agrees.
        if not rtype or rtype in ("UNDO", "ALL"):
            by_user.pop(who, None)
        else:
            by_user[who] = rtype
        rows = summarise_reactions(by_user)
        _, m = find_message(message_id)
        if m is not None:
            if rows:
                m["reactions"] = rows
            else:
                m.pop("reactions", None)
    return rows


def seed_reactions():
    """Fills `reactors` from whatever the fixture put on its messages."""
    with lock:
        reactors.clear()
        for msgs in messages.values():
            for m in msgs:
                rows = m.get("reactions")
                if not rows:
                    continue
                by_user = {}
                for i, row in enumerate(rows):
                    # A fixture states the counts; the mids behind them only
                    # have to be distinct, and one of them is us when mine.
                    for n in range(row["count"]):
                        by_user["ustub-reactor-%d-%d" % (i, n)] = row["type"]
                    if row.get("mine"):
                        by_user.pop("ustub-reactor-%d-0" % i, None)
                        by_user[ME] = row["type"]
                reactors[m["id"]] = by_user


def mark_read_by_peer(chat_mid, message_id, reader):
    """The 已讀 a real peer would send back: readBy on the message + an event."""
    with lock:
        _, m = find_message(message_id)
        # Only our own messages carry readBy -- LINE reports who read what we
        # sent, not what we read of theirs.
        if m is None or m["from"] != ME:
            return
        # A 1:1 has the one peer; a group counts up to its member list, so the
        # panel gets 已讀 N on the way to 已讀.
        others = len(members.get(chat_mid) or []) or 1
        count = min((m.get("readBy") or {}).get("count", 0) + 1, others)
        m["readBy"] = {"count": count, "all": count >= others}
    push_event("read", chat_mid, by=reader, upTo=message_id)
    write_state()


def arm_read_receipt(chat_mid, message_id):
    """Plays the peer reading what we just sent, a couple of seconds later."""
    peer = (members.get(chat_mid) or [{}])[0].get("mid") or "ustub-reader"
    t = threading.Timer(READ_DELAY_SECONDS,
                        mark_read_by_peer, (chat_mid, message_id, peer))
    t.daemon = True
    t.start()
    return t


def refresh_chat_summary(mid):
    msgs = messages.get(mid, [])
    for c in state["chats"]:
        if c["mid"] == mid:
            before = (c.get("lastText"), c.get("lastTime"), c.get("lastFrom"))
            if msgs:
                last = msgs[-1]
                c["lastText"] = preview_text(last)
                c["lastTime"] = last["time"]
                # Rendered verbatim as a label (Panel.qml:706), never compared
                # against myMid -- so this is a display name, not a mid.
                c["lastFrom"] = last["fromName"]
            after = (c.get("lastText"), c.get("lastTime"), c.get("lastFrom"))
            if after != before:
                state["chatsRevision"] = int(state.get("chatsRevision") or 0) + 1
            return


PREVIEW_LABEL = {
    "STICKER": "[貼圖]",
    "CHATEVENT": "[系統事件]",
    "POSTNOTIFICATION": "[貼文通知]",
    "IMAGE": "[圖片]",
    "VIDEO": "[影片]",
    "AUDIO": "[語音]",
}
SYSTEM_EVENT_TYPES = ("CHATEVENT", "POSTNOTIFICATION")
# The daemon's mediastate block, as far as the stub can go without LINE.
UNSENT_TEXT = "已收回訊息"
UNSENT_ERROR = "訊息已收回"
EXPIRED_ERROR = "檔案已過期（LINE 只保留 7 天）"
# imagecache.ts loses every reason behind one string; the panel prints it.
IMAGE_ERROR = "圖片下載失敗"


def preview_text(m):
    """Mirrors previewText() in daemon.ts (the enil:preview block).

    The chat-list line is written by the daemon, not by Panel.qml's bodyText(),
    so it is previewText this has to track -- the earlier version copied
    bodyText and served "[FILE]" / "[IMAGE]" / "[CHATEVENT]" where the daemon
    serves the file name and the Chinese labels.
    """
    ct = m.get("contentType") or ""
    # First, like previewText: a recall leaves the contentType and the file
    # name behind, so every branch below would advertise what is gone. The
    # daemon reads contentMetadata for this; the stub has the derived field.
    if m.get("unsent"):
        return UNSENT_TEXT
    # The daemon reaches "[E2EE 解密失敗]" via the decrypt failure path around
    # its previewText call, not inside it; the stub has no decrypt step to fail.
    if m.get("decryptFailed"):
        return "[E2EE 解密失敗]"
    text = m.get("text") or ""
    # System events take the label first: LINE often sets text to the event
    # name itself, and printing that leaks the English code into the list.
    if ct in SYSTEM_EVENT_TYPES and (not text or text.upper() == ct):
        return PREVIEW_LABEL[ct]
    if text:
        return text
    if ct == "FILE":
        return m.get("fileName") or "[檔案]"
    # Only FLEX/RICH fall back to LINE's own plain-text alternative; a VIDEO
    # with an altText still previews as "[影片]".
    if ct in ("FLEX", "RICH") and m.get("altText"):
        return m["altText"]
    return PREVIEW_LABEL.get(ct) or "[%s]" % (ct or "非文字")


def msg(mid, i, frm, name, text, ago_min, **extra):
    """The mandatory half of PluginMessage; `extra` adds the optional fields."""
    m = {
        "id": "%s-m%d" % (mid, i),
        "chat": mid,
        "from": frm,
        "fromName": name,
        "text": text,
        "time": int((time.time() - ago_min * 60) * 1000),
        "contentType": "NONE",
        "decryptFailed": False,
        "hasMedia": False,
        "unsent": False,
        "mediaState": "ok",
    }
    avatar = stub_avatar(frm)
    if avatar:
        m["fromAvatar"] = avatar
    m.update(extra)
    return m


def stub_members(names):
    """The `members` reply for one group: sorted by name, like the daemon's."""
    return sorted(({"mid": member_mid(n), "name": n} for n in names),
                  key=lambda m: m["name"])


# ------------------------------------------------------------------ fixtures

FIXTURES = ("default", "empty", "busy", "notify", "demo-en", "demo-zh")


def fixture_default():
    """One chat per mid prefix, and every optional field at least once."""
    img1 = os.path.join(MEDIA_DIR, "stub-shot1.png")
    img2 = os.path.join(MEDIA_DIR, "stub-shot2.png")
    img3 = os.path.join(MEDIA_DIR, "stub-shot3.png")
    img4 = os.path.join(MEDIA_DIR, "stub-shot4.png")
    write_thumb_png(img1, 1)
    write_thumb_png(img2, 4)
    write_thumb_png(img3, 7)
    write_thumb_png(img4, 10)

    chats = [
        ("cstub-family", "STUB 家庭群組", 3),
        ("cstub-work", "STUB 工作 / Deploy", 1),
        ("ustub-alice", "STUB Alice", 0),
        ("rstub-lunch", "STUB 午餐揪團（room）", 2),
        ("ustub-notes", "STUB Keep memo", 0),
    ]

    messages["cstub-family"] = [
        msg("cstub-family", 1, "ustub-mom", "STUB 媽", "晚上回來吃飯嗎？", 240),
        # Three people in this group, two of them have read it: 已讀 2, not 已讀.
        msg("cstub-family", 2, ME, "我", "會，大概七點\n先不用等我", 235,
            reactions=[{"type": "NICE", "count": 2, "mine": False},
                       {"type": "LOVE", "count": 1, "mine": True}],
            readBy={"count": 2, "all": False}),
        msg("cstub-family", 3, "ustub-mom", "STUB 媽", "", 200,
            contentType="IMAGE", hasMedia=True),
        msg("cstub-family", 4, "ustub-sis", "STUB 妹", "CHATEVENT", 120,
            contentType="CHATEVENT"),
        msg("cstub-family", 5, "ustub-mom", "STUB 媽", "記得帶傘", 12),
        # LINE keeps chat files for 7 days; past that the object is gone and
        # only the metadata is left, so the panel has to say so rather than
        # offer a download. hasMedia stays True -- there was a file.
        msg("cstub-family", 6, "ustub-sis", "STUB 妹", "", 10,
            contentType="FILE", hasMedia=True, mediaState="expired",
            fileName="stub-過期的行程表.pdf", fileSize=182400,
            expiresAt=int((time.time() - 86400) * 1000)),
        # A recall keeps contentType FILE but drops the bytes, so the daemon
        # ships it with hasMedia False and LINE's own wording in text.
        msg("cstub-family", 7, "ustub-mom", "STUB 媽", UNSENT_TEXT, 8,
            contentType="FILE", unsent=True, mediaState="unsent",
            fileName="stub-recalled.txt"),
    ]
    preview_sources["cstub-family-m3"] = img1
    download_sources["cstub-family-m3"] = img4
    # The picker's source. Names are the display names the daemon resolves;
    # the mids are shaped the way MENTION_MID demands so the round trip the
    # panel drives (pick -> send -> render) is the real one.
    members["cstub-family"] = stub_members(["STUB 媽", "STUB 妹", "STUB 爸"])
    members["cstub-work"] = stub_members(["STUB CI", "STUB Dana", "STUB Eve"])
    # rstub-lunch deliberately has none: the daemon cannot get a member list
    # out of a room, and the panel has to survive that refusal.

    # One incoming message with both kinds of mention, and an emoji in front of
    # them so the offsets are only right if they are counted in UTF-16 code
    # units. Built rather than written out: hand-counted offsets in a fixture
    # are how a wrong unit gets pinned as correct.
    mom = next(m for m in members["cstub-family"] if m["name"] == "STUB 媽")
    parts = ["🎉 ", "@All", " 明天聚餐，", "@" + mom["name"], " 訂位好了嗎"]
    at_all = utf16_len(parts[0])
    at_mom = utf16_len("".join(parts[:3]))
    # Not appended: the recalled message has to stay the newest one in this
    # chat, because that is what pins the chat-list preview.
    messages["cstub-family"].insert(
        4,
        msg("cstub-family", 8, "ustub-sis", "STUB 妹", "".join(parts), 60,
            mentions=[
                {"start": at_all, "end": at_all + utf16_len(parts[1]),
                 "all": True, "name": MENTION_ALL_NAME},
                {"start": at_mom, "end": at_mom + utf16_len(parts[3]),
                 "mid": mom["mid"], "name": mom["name"]},
            ]))

    messages["cstub-work"] = [
        msg("cstub-work", 1, "ustub-bot", "STUB CI", "", 90, contentType="FLEX",
            altText="STUB deploy #4821 succeeded",
            flexImages=[FLEX_IMAGE_URL, FLEX_IMAGE_URL + "?2"]),
        msg("cstub-work", 2, ME, "我", "看到了，謝謝", 88,
            replyTo={"id": "cstub-work-m1", "fromName": "STUB CI",
                     "text": "STUB deploy #4821 succeeded"}),
        msg("cstub-work", 3, "ustub-bot", "STUB CI", "", 60, contentType="FILE",
            hasMedia=True, fileName="stub-build-log.txt", fileSize=48210),
        # E2EE video: the daemon deliberately ships no mediaPath, so the panel
        # falls back to the 📎 line -- that path needs a fixture too.
        msg("cstub-work", 4, "ustub-bot", "STUB CI", "", 40, contentType="VIDEO",
            hasMedia=True, altText="STUB screen recording"),
        # A non-E2EE video carries a cheap standalone thumbnail. This drives
        # lazy preview without making preview fetch the whole recording.
        msg("cstub-work", 6, "ustub-bot", "STUB CI", "", 30,
            contentType="VIDEO", hasMedia=True, previewable=True,
            altText="STUB public recording"),
        msg("cstub-work", 5, "ustub-bot", "STUB CI", "POSTNOTIFICATION", 20,
            contentType="POSTNOTIFICATION"),
    ]
    preview_sources["cstub-work-m6"] = img3
    messages["ustub-alice"] = [
        msg("ustub-alice", 1, "ustub-alice", "STUB Alice", "明天的會議改十點", 600),
        # 1:1, and the peer has read it: all True is what draws a plain 已讀.
        msg("ustub-alice", 2, ME, "我", "收到", 598,
            replyTo={"id": "ustub-alice-m1", "fromName": "STUB Alice",
                     "text": "明天的會議改十點"},
            readBy={"count": 1, "all": True}),
        msg("ustub-alice", 3, "ustub-alice", "STUB Alice", "", 500,
            decryptFailed=True),
        msg("ustub-alice", 4, "ustub-alice", "STUB Alice", "", 480,
            contentType="STICKER", stickerUrl=STICKER_URL),
    ]
    messages["rstub-lunch"] = [
        msg("rstub-lunch", 1, "ustub-bob", "STUB Bob", "今天吃什麼\n有人要開團嗎", 1500),
        msg("rstub-lunch", 2, "ustub-carol", "STUB Carol", "", 1490,
            contentType="IMAGE", hasMedia=True,
            # A reply pointing at a message the daemon never rendered: id only,
            # which the panel has to draw without a quoted line.
            replyTo={"id": "rstub-lunch-m0"},
            reactions=[{"type": "OMG", "count": 1, "mine": True}]),
    ]
    preview_sources["rstub-lunch-m2"] = img2
    download_sources["rstub-lunch-m2"] = img4
    messages["ustub-notes"] = [
        msg("ustub-notes", 1, ME, "我", "記得續約網域", 4000),
    ]
    return chats


def fixture_empty():
    """No chats at all: the panel's empty list, search-with-no-hits path."""
    return []


def fixture_notify():
    """default's chats, plus a hand-off already armed.

    The panel has to open on `state.wanted`'s chat the moment it starts, and
    waiting for a real notification to be clicked is not something a UI change
    can be driven against.
    """
    return fixture_default()


def fixture_busy():
    """200 chats, enough to see the list scroll and the search filter work."""
    chats = []
    for i in range(200):
        mid = "cstub-busy-%03d" % i
        chats.append((mid, "STUB 壓力測試 %03d" % i, i % 5))
        messages[mid] = [
            msg(mid, 1, "ustub-peer-%03d" % i, "STUB Peer %03d" % i,
                "第 %d 個聊天室的第一則" % i, 600 + i),
            msg(mid, 2, ME, "我", "第 %d 個聊天室的回覆" % i, 300 + i),
        ]
    return chats


# ------------------------------------------------------------- demo fixtures
# The README screenshots. Everything above is test data and says so ("STUB"
# everywhere); these two read as a real account instead, one per UI language,
# and are built by one function from two tables so neither locale can drop a
# feature the other shows. The pictures are generated by tools/demo_assets.py
# into DEMO_ASSETS, from the people listed here.

DEMO_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           os.pardir, "docs", "images", "demo")
DEMO_LOCALES = ("en", "zh")
# Avatar colours are assigned in this order, so a key keeps its colour in both
# locales and neighbouring rows in the list never share one.
DEMO_AVATAR_KEYS = (
    "me", "family", "dinner", "work", "emma", "mei", "notes",
    "mom", "dad", "nina", "priya", "marcus", "sofia", "bot", "daniel",
)
# key -> (display name, avatar initials)
DEMO_PEOPLE = {
    "en": {
        "me": ("Jordan Lee", "JL"),
        "family": ("Lee Family", "LF"),
        "dinner": ("Friday Dinner Crew", "FD"),
        "work": ("Platform Team", "PT"),
        "emma": ("Emma Wilson", "EW"),
        "mei": ("Mei Tanaka", "MT"),
        "notes": ("My Notes", "N"),
        "mom": ("Mom", "M"),
        "dad": ("Dad", "D"),
        "nina": ("Nina Lee", "NL"),
        "priya": ("Priya Nair", "PN"),
        "marcus": ("Marcus Johnson", "MJ"),
        "sofia": ("Sofia Ramos", "SR"),
        "bot": ("Release Bot", "RB"),
        "daniel": ("Daniel Okafor", "DO"),
    },
    "zh": {
        "me": ("林宥辰", "辰"),
        "family": ("林家", "林"),
        "dinner": ("週五聚餐", "聚"),
        "work": ("後端開發組", "後"),
        "emma": ("許雅雯", "雯"),
        "mei": ("吳佳穎", "穎"),
        "notes": ("我的筆記", "筆"),
        "mom": ("媽媽", "媽"),
        "dad": ("爸爸", "爸"),
        "nina": ("林宥恩", "恩"),
        "priya": ("陳怡君", "怡"),
        "marcus": ("王柏翰", "柏"),
        "sofia": ("張雅婷", "婷"),
        "bot": ("部署機器人", "部"),
        "daniel": ("黃志明", "明"),
    },
}
DEMO_TEXT = {
    "en": {
        "trip_zip": "kyoto-trip-photos.zip",
        "mom_dinner": "Are you coming home for dinner on Sunday?",
        "me_dinner": "Yes! I'll be there around 6\nShould I bring anything?",
        "nina_at": ["🎉 ", "@All", " Grandma turns 80 on Sunday! ", "@Dad",
                    " did you pick up the cake?"],
        "mom_rain": "Rain all weekend, don't forget an umbrella ☔",
        "priya_ask": "Dinner on Friday? There's a new Thai place by the station",
        "priya_view": "And the rooftop has this view",
        "marcus_in": "I'm in. 7:30 works for me",
        "me_count": "Count me in! Should we book for five?",
        "sofia_booked": "Booked a table for five at 7:30 🙌",
        "mei_merge": "Cache fix is merged, CI should pick it up",
        "bot_deploy": "✅ Deploy #4821 to production succeeded",
        "me_latency": "Nice, p95 latency is back under 120 ms 🎉",
        "loadtest": "load-test-results.csv",
        "daniel_at": ["@Jordan Lee", " can you look at the numbers before standup?"],
        "mei_beta": "Rolling it out to the beta channel this afternoon 🚀",
        "emma_coast": "Made it to the coast! The view is unreal",
        "me_wow": "Wow, that's beautiful 😍 Enjoy the trip!",
        "emma_coffee": "Back on Monday. Coffee next week?",
        "mei_thanks": "Thanks for covering my on-call shift 🙏",
        "me_np": "Anytime! It was a quiet night",
        "note_passport": "Renew passport before March",
        "lease": "apartment-lease-2026.pdf",
    },
    "zh": {
        "trip_zip": "京都旅遊照片.zip",
        "mom_dinner": "禮拜天要回來吃飯嗎？",
        "me_dinner": "會啊！大概六點到\n要帶什麼回去嗎？",
        "nina_at": ["🎉 ", "@All", " 禮拜天阿嬤八十大壽！", "@爸爸",
                    " 蛋糕拿了沒？"],
        "mom_rain": "週末都會下雨，出門記得帶傘 ☔",
        "priya_ask": "禮拜五要不要吃飯？車站旁邊新開一間泰式",
        "priya_view": "頂樓看出去是這樣",
        "marcus_in": "+1，七點半可以",
        "me_count": "算我一個！要訂五個人嗎？",
        "sofia_booked": "訂好了，禮拜五七點半五位 🙌",
        "mei_merge": "快取的修正合進去了，CI 應該會自己跑",
        "bot_deploy": "✅ 正式環境部署 #4821 成功",
        "me_latency": "讚，p95 延遲回到 120 ms 以下了 🎉",
        "loadtest": "壓測結果.csv",
        "daniel_at": ["@林宥辰", " 站會前可以幫我看一下數字嗎？"],
        "mei_beta": "下午先推到 beta 頻道 🚀",
        "emma_coast": "到花蓮了！這景色也太美",
        "me_wow": "哇也太漂亮 😍 玩得開心！",
        "emma_coffee": "禮拜一回台北，下週約咖啡？",
        "mei_thanks": "謝啦，幫我代值班 🙏",
        "me_np": "小事啦，昨晚很平靜",
        "note_passport": "三月前要換護照",
        "lease": "租約-2026.pdf",
    },
}
# Remote pictures go through `image`, keyed by url; seed() pre-fills the cache
# so these answer with the demo art instead of a drawn placeholder.
DEMO_FLEX_URLS = ("https://example.com/demo/deploy-status.png",
                  "https://example.com/demo/deploy-latency.png")
DEMO_STICKER_URL = sticker_url("90000001", False)
DEMO_REMOTE = {
    DEMO_FLEX_URLS[0]: "flex-status.png",
    DEMO_FLEX_URLS[1]: "flex-latency.png",
    DEMO_STICKER_URL: "sticker.png",
}


def demo_asset(name):
    path = os.path.join(DEMO_ASSETS, name)
    if not os.path.exists(path):
        sys.exit("stub.py: %s is missing -- run tools/demo_assets.py" % path)
    return path


def demo_copy(name, dest):
    """A private copy: `preview` with invalidate redraws its file in place."""
    shutil.copyfile(demo_asset(name), dest)
    return dest


def demo_photo(message_id, name):
    """An IMAGE message's thumbnail and original, each its own file."""
    preview_sources[message_id] = demo_copy(
        name, os.path.join(MEDIA_DIR, "demo-preview-%s" % name))
    download_sources[message_id] = demo_copy(
        name, os.path.join(MEDIA_DIR, "demo-original-%s" % name))


def fixture_demo(locale):
    """Six chats that read like a real account, covering what the panel
    draws: unread badges, mentions, reactions, 已讀 N, a quote reply, a
    sticker, a FLEX card, a photo, a file, an unsent message, an expired file.
    """
    people = DEMO_PEOPLE[locale]
    t = DEMO_TEXT[locale]
    name = {k: v[0] for k, v in people.items()}
    mid = {k: "u" + hashlib.sha256(("demo-" + k).encode()).hexdigest()[:32]
           for k in people}
    mid.update(me=ME, family="cdemo-family", dinner="cdemo-dinner",
               work="cdemo-work", notes="udemo-notes")
    for key in people:
        AVATAR_FILES[mid[key]] = demo_asset("avatar-%s-%s.png" % (locale, key))
    family, dinner, work = mid["family"], mid["dinner"], mid["work"]
    emma, mei, notes = mid["emma"], mid["mei"], mid["notes"]

    def by(chat, i, key, text, ago, **extra):
        who = "我" if key == "me" else name[key]
        return msg(chat, i, mid[key], who, text, ago, **extra)

    def mentioned(parts, targets):
        """`mentions` for text built from parts; targets[i] names parts[i]."""
        found, at = [], 0
        for part, target in zip(parts, targets):
            if target == "all":
                found.append({"start": at, "end": at + utf16_len(part),
                              "all": True, "name": MENTION_ALL_NAME})
            elif target:
                found.append({"start": at, "end": at + utf16_len(part),
                              "mid": member_mid(name[target]),
                              "name": name[target]})
            at += utf16_len(part)
        return {"text": "".join(parts), "mentions": found}

    def group(keys):
        return stub_members([name[k] for k in keys])

    week = 8 * 24 * 60
    members[family] = group(["mom", "dad", "nina", "me"])
    members[dinner] = group(["priya", "marcus", "sofia", "me"])
    members[work] = group(["mei", "daniel", "bot", "me"])

    nina = mentioned(t["nina_at"], [None, "all", None, "dad", None])
    messages[family] = [
        # Past LINE's seven days, so the file is gone and the date divider
        # above "Today" shows up.
        by(family, 1, "nina", "", week, contentType="FILE", hasMedia=True,
           mediaState="expired", fileName=t["trip_zip"], fileSize=84_213_000,
           expiresAt=int((time.time() - 86400) * 1000)),
        by(family, 2, "mom", t["mom_dinner"], 300),
        by(family, 3, "me", t["me_dinner"], 296,
           reactions=[{"type": "LOVE", "count": 2, "mine": False}],
           readBy={"count": 2, "all": False}),
        by(family, 4, "dad", "", 180, contentType="IMAGE", hasMedia=True,
           reactions=[{"type": "LOVE", "count": 1, "mine": False},
                      {"type": "FUN", "count": 1, "mine": True}]),
        by(family, 5, "nina", nina["text"], 62, mentions=nina["mentions"]),
        by(family, 6, "mom", UNSENT_TEXT, 9, contentType="NONE", unsent=True,
           mediaState="unsent"),
        by(family, 7, "mom", t["mom_rain"], 6),
    ]
    demo_photo("%s-m4" % family, "photo-dinner.jpg")

    messages[dinner] = [
        by(dinner, 1, "priya", t["priya_ask"], 210),
        by(dinner, 2, "priya", t["priya_view"], 209),
        by(dinner, 3, "priya", "", 209, contentType="IMAGE", hasMedia=True),
        by(dinner, 4, "marcus", t["marcus_in"], 150,
           reactions=[{"type": "NICE", "count": 2, "mine": False}]),
        by(dinner, 5, "marcus", "", 149, contentType="STICKER",
           stickerUrl=DEMO_STICKER_URL),
        by(dinner, 6, "me", t["me_count"], 141,
           replyTo={"id": "%s-m1" % dinner, "fromName": name["priya"],
                    "text": t["priya_ask"]},
           readBy={"count": 3, "all": True}),
        by(dinner, 7, "sofia", t["sofia_booked"], 31),
    ]
    demo_photo("%s-m3" % dinner, "photo-skyline.jpg")

    daniel = mentioned(t["daniel_at"], ["me", None])
    messages[work] = [
        by(work, 1, "mei", t["mei_merge"], 95),
        by(work, 2, "bot", "", 72, contentType="FLEX",
           altText=t["bot_deploy"], flexImages=list(DEMO_FLEX_URLS)),
        by(work, 3, "me", t["me_latency"], 70,
           replyTo={"id": "%s-m2" % work, "fromName": name["bot"],
                    "text": t["bot_deploy"]},
           reactions=[{"type": "NICE", "count": 2, "mine": False},
                      {"type": "AMAZING", "count": 1, "mine": False}],
           readBy={"count": 2, "all": False}),
        by(work, 4, "daniel", "", 41, contentType="FILE", hasMedia=True,
           fileName=t["loadtest"], fileSize=48_210),
        by(work, 5, "daniel", daniel["text"], 40, mentions=daniel["mentions"]),
        by(work, 6, "mei", t["mei_beta"], 12),
    ]

    messages[emma] = [
        by(emma, 1, "emma", t["emma_coast"], 1500),
        by(emma, 2, "emma", "", 1499, contentType="IMAGE", hasMedia=True),
        by(emma, 3, "me", t["me_wow"], 1440, readBy={"count": 1, "all": True}),
        by(emma, 4, "emma", t["emma_coffee"], 25),
    ]
    demo_photo("%s-m2" % emma, "photo-coast.jpg")

    messages[mei] = [
        by(mei, 1, "mei", t["mei_thanks"], 2900),
        by(mei, 2, "me", t["me_np"], 2880, readBy={"count": 1, "all": True}),
    ]
    messages[notes] = [
        by(notes, 1, "me", t["note_passport"], 4400),
        by(notes, 2, "me", "", 4390, contentType="FILE", hasMedia=True,
           fileName=t["lease"], fileSize=1_284_000),
    ]

    os.makedirs(IMAGE_DIR, exist_ok=True)
    for url, asset in DEMO_REMOTE.items():
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()
        demo_copy(asset, os.path.join(IMAGE_DIR, key))

    # Newest first, like the daemon's list.
    return [
        (family, name["family"], 3),
        (work, name["work"], 2),
        (emma, name["emma"], 1),
        (dinner, name["dinner"], 2),
        (mei, name["mei"], 0),
        (notes, name["notes"], 0),
    ]


def seed(fixture, logged_out):
    global session_generation
    os.makedirs(AVATAR_DIR, exist_ok=True)          # and MEDIA_DIR with it
    state.clear()
    messages.clear()
    preview_sources.clear()
    download_sources.clear()
    members.clear()
    reactors.clear()
    AVATAR_FILES.clear()
    retire_clipboard_stages()
    session_generation = 1
    my_name = (DEMO_PEOPLE[fixture[len("demo-"):]]["me"][0]
               if fixture.startswith("demo-") else "STUB User")
    state.update({
        "updatedAt": int(time.time() * 1000),
        "bootId": BOOT_ID,
        # The daemon only learns who it is from a live session, so a
        # logged-out start has me == {} -- the panel must survive that.
        "me": {} if logged_out else {"mid": ME, "displayName": my_name},
        "login": {"status": "idle", "settled": True}
        if logged_out else {"status": "ok"},
        "chats": [],
        "chatsRevision": 1,
        "chatList": {"complete": True, "loaded": 0},
        # Always present, even empty: the panel reads state.events on every
        # change and must never have to guard the field itself.
        "events": [],
    })
    chats = {
        "default": fixture_default,
        "empty": fixture_empty,
        "busy": fixture_busy,
        "notify": fixture_notify,
        "demo-en": lambda: fixture_demo("en"),
        "demo-zh": lambda: fixture_demo("zh"),
    }[fixture]()
    for mid, name, unread in chats:
        row = {
            "mid": mid, "name": name, "unread": unread,
            "lastText": "", "lastTime": 0, "lastFrom": "",
        }
        avatar = stub_avatar(mid)
        if avatar:
            row["avatarPath"] = avatar
        state["chats"].append(row)
        refresh_chat_summary(mid)
    state["chatList"]["loaded"] = len(state["chats"])
    seed_reactions()
    if fixture == "notify" and state["chats"]:
        set_wanted(state["chats"][0]["mid"])
    write_state()


# ------------------------------------------------------------- login theatre

def set_login(status, **extra):
    with lock:
        info = {"status": status}
        info.update(extra)
        state["login"] = info
    write_state()


def start_login():
    """idle -> qr -> pin -> ok, on a timer, the way the real flow reads."""
    global login_timer
    # A fresh filename each time: the plugin has no way to force a reload of its
    # own. Assigning qrImage.source = "" does nothing while the panel is closed
    # and that Image does not exist yet, and it destroys the binding as well, so
    # a changed path is the only thing that brings a new QR onto the screen.
    # Milliseconds, the clock the daemon names its own `qr-${Date.now()}.png`
    # from. handle() refuses a login under a live QR, so two of these are a
    # whole qr -> pin -> ok cycle apart -- but that cycle is two constants at
    # the top of this file, and a name that is only distinct for as long as
    # they stay slow is a trap for whoever shortens them. One read for both
    # the name and the seed, so they cannot straddle a tick.
    ts = int(time.time() * 1000)
    qr = os.path.join(STATE_DIR, "qr-%d.png" % ts)
    write_qr_png(qr, ts & 0xFFFF)
    for old in os.listdir(STATE_DIR):
        if old.startswith("qr-") and os.path.join(STATE_DIR, old) != qr:
            try:
                os.remove(os.path.join(STATE_DIR, old))
            except OSError:
                pass
    set_login("qr", qrPng=qr)

    def to_pin():
        global login_timer
        set_login("pin", pin="8134")
        login_timer = threading.Timer(LOGIN_PIN_SECONDS, to_ok)
        login_timer.daemon = True
        login_timer.start()

    def to_ok():
        global session_generation
        with lock:
            session_generation += 1
        set_login("ok")

    if login_timer:
        login_timer.cancel()
    login_timer = threading.Timer(LOGIN_QR_SECONDS, to_pin)
    login_timer.daemon = True
    login_timer.start()


def logged_in():
    with lock:
        return state["login"].get("status") == "ok"


# ---------------------------------------------------------------- socket API

# The extensions the daemon's mediaKindOf() maps to something other than a
# file, as the contentType the panel gets for each. The daemon decides from the
# magic bytes first and only falls back to the name; the stub does not carry a
# second copy of that signature table -- the fixtures are named for what they
# are, and two tables are two things to keep in step.
KIND_BY_EXT = {
    ".png": "IMAGE", ".jpg": "IMAGE", ".jpeg": "IMAGE", ".webp": "IMAGE",
    ".heic": "IMAGE", ".heif": "IMAGE", ".avif": "IMAGE", ".gif": "IMAGE",
    ".mp4": "VIDEO", ".m4v": "VIDEO", ".mov": "VIDEO", ".webm": "VIDEO",
    ".mkv": "VIDEO", ".avi": "VIDEO",
}


def media_kind_of(path):
    """`contentType` for a file the panel just sent, the daemon's way.

    A .gif goes up as linejs's "gif" ObjType, but that is still contentType 1
    -- IMAGE -- on the way back, so there is no third answer here.
    """
    return KIND_BY_EXT.get(os.path.splitext(path)[1].lower(), "FILE")


# daemon.ts SEND_MAX_BYTES, keyed by the contentType above rather than by
# linejs's ObjType: an IMAGE is read whole, encrypted into a second copy and
# then uploaded twice, so it stops where the clipboard does; the other two are
# the one-copy path.
SEND_MAX_BYTES = {
    "IMAGE": 20 * 1024 * 1024,
    "VIDEO": 1024 * 1024 * 1024,
    "FILE": 1024 * 1024 * 1024,
}


def size_error(kind, size):
    """The daemon's refusal for a file too big to upload, or None.

    The panel prints it raw, so the wording has to match daemon.ts down to the
    unit -- the limit is named because the user picked the file and is the only
    one who can pick a smaller one. The stub is where that path is reachable
    without a 21 MB screenshot and a real LINE session.
    """
    cap = SEND_MAX_BYTES[kind]
    if size <= cap:
        return None
    noun = {"IMAGE": "圖片", "VIDEO": "影片"}.get(kind, "檔案")
    gb = 1024 * 1024 * 1024
    unit = ("%d GB" % round(cap / gb)) if cap >= gb else (
        "%d MB" % round(cap / (1024 * 1024)))
    return {"ok": False, "error": "%s太大（超過 %s）" % (noun, unit)}


def file_target_error(mid):
    """The daemon's refusal for a chat it cannot upload to, or None.

    uploadMediaByE2EE only accepts u/c mids; the daemon rejects the rest up
    front with these exact strings, and the panel shows them raw. Shared by
    `sendFile` and `sendClipboardImage` here for the same reason it is one
    function in the daemon: the two must refuse identically.
    """
    if mid[:1] in ("u", "c"):
        return None
    return {
        "ok": False,
        "error": "多人聊天室（room）暫不支援傳檔案"
        if mid.startswith("r") else "不支援的聊天室",
    }


# daemon.ts HISTORY_COUNT / HISTORY_COUNT_MAX. The stub used to do
# `int(req.get("count") or 30)`, which had two answers the daemon never gives:
# a non-numeric count raised ValueError (the connection died mid-request
# instead of answering), and a negative one was a slice from the wrong end, so
# `count: -5` handed back the newest messages while claiming to page back.
HISTORY_COUNT = 30
HISTORY_COUNT_MAX = 200


def history_count(value):
    """The daemon's clamp, so the panel meets one rule, not two.

    A choice is a number, or a string that parses as one; anything else --
    None, a blank string, a list, a dict -- means the caller did not choose,
    so the default stands. Out of range is a choice we cannot honour, so it
    is clamped. `bool` is refused by hand because it is an `int` subclass
    here, so `float(True)` is 1.0 and a `count: true` would have asked for
    one message; JSON `true` is not a number and the daemon does not read it
    as one either.
    Rounded half-up rather than with `round()`, whose banker's rounding would
    put 60.5 at 60 while the daemon's Math.round puts it at 61. `int()`
    truncates towards zero instead of flooring, which differs from Math.round
    below zero -- and every such value is clamped to 1 before anyone sees it.
    """
    if isinstance(value, bool):
        return HISTORY_COUNT
    try:
        n = float(value)
    except (TypeError, ValueError):
        return HISTORY_COUNT
    # NaN fails every comparison, so it would clamp to 1 rather than answering
    # "not a number"; infinity would clamp to the maximum for the same reason.
    if n != n or n in (float("inf"), float("-inf")):
        return HISTORY_COUNT
    return max(1, min(HISTORY_COUNT_MAX, int(n + 0.5)))


def handle(req):
    global session_generation
    cmd = req.get("cmd")
    if cmd == "login":
        with lock:
            # Same gate as the daemon: startLogin() claims it in its first
            # statement, so a login arriving while a QR or PIN is still on
            # screen is turned away rather than starting the flow over. The
            # stub used to start it over, and the login button sits under the
            # QR, so the panel could reach it -- that minted a second QR right
            # behind the first, and an Image whose source string did not
            # change does not reload, so the old picture stayed up with
            # nothing to show for it. All three answers come off one read
            # under one lock: each connection is served on its own thread, so
            # a status read outside it can go stale between the look and the
            # claim -- the timer reaching "ok" in that gap would get a live
            # session overwritten with "starting" and a second QR flow.
            status = state["login"].get("status")
            if status == "ok":
                return {"ok": True}
            if status in ("starting", "qr", "pin"):
                return {"ok": False, "error": "登入中，請稍候"}
            # Written out, not just held in memory, because the panel decides
            # from the watched state.json: canLogin is (idle|error), so a gate
            # that never reaches the file leaves the login button live for the
            # whole of start_login() and reads 尚未登入 where the daemon reads
            # 啟動中. setLogin("starting") is the daemon's first move too.
            # `lock` is an RLock, so this re-enters it and the claim reaches
            # memory and the file without another thread seeing one without
            # the other.
            was = state["login"]
            try:
                set_login("starting")
            except Exception:
                # set_login() changes the status before it writes the file, so
                # a write that fails in there still leaves the claim standing,
                # and outside the try below there is nothing to take it back.
                # Put the whole previous value back rather than a bare "idle":
                # the file was never rewritten, so it still holds this, extra
                # fields and all.
                state["login"] = was
                raise
        try:
            start_login()
        except Exception:
            # A gate nobody releases would refuse every later login for the
            # life of the process. Released under the lock, the way it was
            # claimed, so the reset and its write reach the next caller as one
            # step rather than as an idle it can claim halfway through.
            with lock:
                set_login("idle")
            raise
        return {"ok": True}

    if cmd == "logout":
        with lock:
            # One lock over the look and everything that follows from it. The
            # daemon gets this ordering for free: it handles one command at a
            # time, and startLogin() claims its gate before the login command
            # answers, so a logout is always either wholly before that claim
            # or wholly after it. Here a connection gets a thread, so reading
            # the status and then letting go left a gap for a login to claim
            # "starting" in -- this branch would clear that claim and report
            # success while start_login() carried on and published a QR for a
            # session the user had just logged out of.
            status = state["login"].get("status")
            # Same refusal as the daemon: a QR/PIN login in flight cannot be
            # cancelled, and dropping to idle under it invites a second login.
            if status in ("starting", "qr", "pin"):
                return {"ok": False, "error": "登入中，請稍候"}
            # logout() in daemon.ts drops me and chats together before it
            # sets idle; leaving me behind would let the panel keep matching
            # "我" against an account it is no longer signed in to.
            state["me"] = {}
            state["chats"] = []
            state["chatsRevision"] = int(state.get("chatsRevision") or 0) + 1
            state.pop("chatList", None)
            state["events"] = []
            # Same as the daemon: a hand-off pointing at a chat nobody can
            # open any more would send the panel to an empty conversation.
            state.pop("wanted", None)
            messages.clear()
            members.clear()
            reactors.clear()
            session_generation += 1
            retire_clipboard_stages()
            set_login("idle", settled=True)
        return {"ok": True}

    # Before the gate, exactly like the daemon: hiding is a preference of ours
    # and never reaches LINE, so no session is needed for it. Idempotent both
    # ways, and an empty mid is refused rather than hidden -- a row keyed on
    # "" could never be unhidden from the list it is not in.
    if cmd in ("hide", "unhide"):
        # `String(req.chat ?? "")` in daemon.ts, spelled out: this one mid is
        # kept in a set and compared against the rows' string mids, so a
        # number arriving as `chat` has to become a string here. Left raw it
        # would go into `hidden` as a key no row can ever equal -- {"ok":true}
        # for a chat that never hides.
        mid = req.get("chat")
        mid = "" if mid is None else str(mid)
        if not mid:
            return {"ok": False, "error": "沒有指定是哪一間聊天室"}
        with lock:
            was = mid in hidden
            if cmd == "hide":
                hidden.add(mid)
            else:
                hidden.discard(mid)
            moved = was != (mid in hidden)
            if moved:
                state["chatsRevision"] = int(state.get("chatsRevision") or 0) + 1
        if moved:
            write_state()
        return {"ok": True}

    if cmd == "discardClipboardImage":
        stage = req.get("stage")
        if isinstance(stage, str) and re.fullmatch(
                r"clipboard-[0-9a-f-]+\.png", stage):
            with lock:
                clipboard_stage_bindings.pop(stage, None)
            cancel_clipboard_stage_expiry(stage)
            try:
                os.remove(os.path.join(MEDIA_DIR, stage))
            except FileNotFoundError:
                pass
        return {"ok": True}

    # The daemon gates everything else on having a client.
    if not logged_in():
        return {"ok": False, "error": "尚未登入"}

    if cmd == "sync":
        # The daemon also rebuilds the push link here, which the stub has none
        # of; what the panel needs from this reply is the shape and a count it
        # can print, so answer with a link that is always healthy.
        with lock:
            n = len(state["chats"])
        return {"ok": True, "data": {
            "chats": n, "link": "up", "at": int(time.time() * 1000)}}

    if cmd == "history":
        mid = req.get("chat")
        with lock:
            if mid not in messages:
                return {"ok": False, "error": "沒有這個聊天室的游標"}
            msgs = list(messages[mid])
            before = req.get("before")
            if before:
                idx = next((i for i, m in enumerate(msgs) if m["id"] == before), 0)
                msgs = msgs[:idx]            # empty once the top is reached
            count = history_count(req.get("count"))
            msgs = msgs[-count:]
            if req.get("markRead"):
                for c in state["chats"]:
                    if c["mid"] == mid:
                        if c.get("unread", 0) != 0:
                            c["unread"] = 0
                            state["chatsRevision"] = int(
                                state.get("chatsRevision") or 0) + 1
        if req.get("markRead"):
            write_state()
        return {"ok": True, "data": msgs}

    if cmd == "markRead":
        # The daemon's lightweight check: no page, just the read. Same
        # refusals and the same "nothing to do" answer for a row that is
        # already at 0 -- the stub has no LINE cursor, so `unread` is its
        # whole notion of read. One deliberate difference: the daemon wants
        # `upTo` to be a decimal string, because real message ids are, but
        # the fixtures' ids are "<chat>-m<n>", so here any non-empty string
        # (never a number) is a message id.
        mid = req.get("chat")
        up_to = req.get("upTo")
        if not isinstance(mid, str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{1,128}", mid):
            return {"ok": False, "error": "不支援的聊天室"}
        if not isinstance(up_to, str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{1,128}", up_to):
            return {"ok": False, "error": "訊息 id 不對"}
        marked = False
        with lock:
            for c in state["chats"]:
                if c["mid"] == mid and c.get("unread", 0) != 0:
                    c["unread"] = 0
                    state["chatsRevision"] = int(
                        state.get("chatsRevision") or 0) + 1
                    marked = True
        if marked:
            write_state()
        return {"ok": True, "data": {"marked": marked}}

    if cmd == "members":
        mid = req.get("chat") or ""
        # Same three answers as the daemon: a 1:1 box has no member list, a
        # room cannot produce one, and anything else is a group.
        if not mid or mid.startswith("u"):
            return {"ok": False, "error": "這不是群組，沒有成員名單"}
        rows = members.get(mid)
        if not rows:
            return {"ok": False, "error": "多人聊天室（room）拿不到成員名單"
                    if mid.startswith("r") else "這個聊天室沒有成員名單"}
        return {"ok": True, "data": rows}

    # One branch, like the daemon's: a reply is a send that quotes something.
    if cmd in ("send", "reply"):
        mid, text = req.get("chat"), req.get("text") or ""
        reply_to = req.get("replyTo") or "" if cmd == "reply" else ""
        if cmd == "reply" and not reply_to:
            return {"ok": False, "error": "沒有指定要回覆哪一則訊息"}
        # Invalid mentions are dropped, never refused: the daemon does the
        # same, because a mention the panel got wrong must not cost the user
        # the message.
        picked = normalize_mentions(req.get("mentions"), text)
        by_mid = {m["mid"]: m["name"] for m in members.get(mid, [])}
        for m in picked:
            m["name"] = MENTION_ALL_NAME if m.get("all") else by_mid.get(
                m.get("mid"), m.get("mid"))
        extra = {"mentions": picked} if picked else {}
        if isinstance(req.get("requestId"), str) and req["requestId"]:
            extra["requestId"] = req["requestId"]
        if reply_to:
            # The daemon fills fromName/text from what it has rendered before
            # and ships the id alone when it has not; the stub has every
            # message, so the miss only happens on an id it never made.
            _, target = find_message(reply_to)
            extra["replyTo"] = {"id": reply_to} if target is None else {
                "id": reply_to, "fromName": target["fromName"],
                "text": target["text"][:200]}
        with lock:
            if mid not in messages:
                return {"ok": False, "error": "沒有這個聊天室: %s" % mid}
            n = len(messages[mid]) + 1
            sent = msg(mid, n, ME, "我", text, 0, **extra)
            messages[mid].append(sent)
            refresh_chat_summary(mid)
        # LINE echoes our own send back down the push stream, so the panel gets
        # it as an event rather than by re-reading history; the stub does too.
        push_event("message", mid, message=sent)
        write_state()
        arm_read_receipt(mid, sent["id"])
        return {"ok": True}

    if cmd == "stickers":
        # The daemon caches for an hour and refetches on `refresh`; the stub
        # has nothing to fetch, so both answers are the same list. It still
        # has to accept the flag -- the panel sends it.
        return {"ok": True, "data": {"packages": STICKER_PACKAGES}}

    if cmd == "sendSticker":
        mid = req.get("chat") or ""
        package_id = str(req.get("packageId") or "")
        sticker_id = str(req.get("stickerId") or "")
        # The daemon's two refusals, word for word: a malformed id would reach
        # LINE verbatim, and a package nobody owns arrives as an empty bubble.
        if not (STICKER_ID.match(package_id) and STICKER_ID.match(sticker_id)):
            return {"ok": False, "error": "貼圖編號不對"}
        pkg = next((p for p in STICKER_PACKAGES if p["id"] == package_id), None)
        if pkg is None:
            return {"ok": False, "error": "這個貼圖包不在你的貼圖清單裡"}
        # Not which sticker inside it -- the daemon does not check that either,
        # because a package whose list could not be read has none to check.
        # Which file the url points at is the package's answer, not that one
        # sticker's: parseProductInfo() reads a single hasAnimation for the
        # whole package, so a still image inside an animated package is a shape
        # the real daemon can never hand back.
        animated = any(t["animated"] for t in pkg["stickers"])
        with lock:
            if mid not in messages:
                return {"ok": False, "error": "沒有這個聊天室: %s" % mid}
            n = len(messages[mid]) + 1
            sent = msg(mid, n, ME, "我", "", 0, contentType="STICKER",
                       stickerUrl=sticker_url(sticker_id, animated),
                       **({"requestId": req["requestId"]}
                          if isinstance(req.get("requestId"), str)
                          and req["requestId"] else {}))
            messages[mid].append(sent)
            refresh_chat_summary(mid)
        # Same as send: LINE pushes our own sticker back down the stream, so
        # the panel gets it as an event rather than by re-reading history.
        push_event("message", mid, message=sent)
        write_state()
        arm_read_receipt(mid, sent["id"])
        return {"ok": True}

    if cmd == "react":
        mid = req.get("chat") or ""
        message_id = req.get("messageId") or ""
        rtype = str(req.get("type") or "").upper()
        if rtype not in REACTION_PICKABLE:
            return {"ok": False, "error": "不支援的表情"}
        chat_of, target = find_message(message_id)
        if target is None:
            return {"ok": False, "error": "訊息不在快取裡"}
        rows = apply_reaction(message_id, ME, rtype)
        push_event("reaction", chat_of or mid, messageId=message_id,
                   reactions=rows)
        write_state()
        return {"ok": True}

    if cmd == "unsend":
        message_id = req.get("messageId") or ""
        chat_of, target = find_message(message_id)
        if target is None:
            return {"ok": False, "error": "訊息不在快取裡"}
        # The daemon reads the sender off its cursor and refuses without
        # asking LINE; the stub has the message itself.
        if target["from"] != ME:
            return {"ok": False, "error": "只能收回自己傳的訊息"}
        with lock:
            # What a recall leaves behind: the contentType and the file name,
            # but no content, no reactions and nothing to quote.
            target.update({"text": UNSENT_TEXT, "unsent": True,
                           "mediaState": "unsent", "hasMedia": False})
            for gone in ("reactions", "mediaPath", "stickerUrl", "flexImages",
                         "readBy"):
                target.pop(gone, None)
            reactors.pop(message_id, None)
            refresh_chat_summary(chat_of)
        push_event("unsend", chat_of, messageId=message_id)
        write_state()
        return {"ok": True}

    if cmd == "sendFile":
        mid, path = req.get("chat") or "", req.get("path") or ""
        refused = file_target_error(mid)
        if refused:
            return refused
        if not os.path.exists(path):
            return {"ok": False, "error": "找不到檔案: %s" % path}
        kind = media_kind_of(path)
        # From the size alone, which is where the daemon checks it too: there
        # the point is that a 3 GB recording never reaches memory at all.
        too_big = size_error(kind, os.path.getsize(path))
        if too_big:
            return too_big
        with lock:
            if mid not in messages:
                return {"ok": False, "error": "沒有這個聊天室: %s" % mid}
            n = len(messages[mid]) + 1
            extra = {
                "contentType": kind,
                "hasMedia": True,
                "fileName": os.path.basename(path),
                "fileSize": os.path.getsize(path),
            }
            if isinstance(req.get("requestId"), str) and req["requestId"]:
                extra["requestId"] = req["requestId"]
            # Only an IMAGE gets a thumbnail: the daemon leaves an E2EE VIDEO
            # with the 📎 fallback, because its "preview" is the whole file.
            if kind == "IMAGE":
                extra["previewSource"] = path
            sent = msg(mid, n, ME, "我", "", 0, **extra)
            preview_source = sent.pop("previewSource", None)
            if preview_source:
                preview_path = os.path.join(
                    MEDIA_DIR, "preview-%s.png" % hashlib.sha1(
                        sent["id"].encode()).hexdigest())
                shutil.copyfile(preview_source, preview_path)
                preview_sources[sent["id"]] = preview_path
                download_sources[sent["id"]] = preview_source
            messages[mid].append(sent)
            refresh_chat_summary(mid)
        push_event("message", mid, message=sent)
        write_state()
        arm_read_receipt(mid, sent["id"])
        return {"ok": True}

    if cmd == "probeClipboardImage":
        mid = req.get("chat") or ""
        refused = file_target_error(mid)
        if refused:
            return refused
        # Stub-only lever, like `poke`: there is no clipboard here, so the one
        # refusal the panel cannot otherwise be shown has to be askable for.
        if req.get("empty"):
            return {"ok": False, "error": "剪貼簿裡沒有圖片"}
        with lock:
            if state["login"].get("status") != "ok":
                return {"ok": False, "error": "尚未登入"}
            accepted_generation = session_generation
        stage = "clipboard-%s.png" % uuid.uuid4()
        path = os.path.join(MEDIA_DIR, stage)
        write_thumb_png(path, 7, w=320, h=200)
        with lock:
            if (state["login"].get("status") != "ok"
                    or session_generation != accepted_generation):
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
                return {"ok": False, "error": "尚未登入"}
            clipboard_stage_bindings[stage] = {
                "generation": accepted_generation, "chat": mid,
                "claimed": False}
            # Keep validation, publication, and lease registration in one
            # critical section so logout cannot retire the binding between
            # those last two steps.
            expire_clipboard_stage(path)
        return {"ok": True, "data": {"stage": stage}}

    if cmd == "sendClipboardImage":
        stage = req.get("stage")
        mid = req.get("chat") or ""
        staged = stage is not None and stage != ""
        if stage is None or stage == "":
            # Compatibility with the original one-command socket contract.
            # New panels probe first so a failed read is never ambiguous.
            refused = file_target_error(mid)
            if refused:
                return refused
            if req.get("empty"):
                return {"ok": False, "error": "剪貼簿裡沒有圖片"}
            stage = "clipboard-%s.png" % uuid.uuid4()
            write_thumb_png(os.path.join(MEDIA_DIR, stage), 7, w=320, h=200)
        elif not isinstance(stage, str) or not re.fullmatch(
                r"clipboard-[0-9a-f-]+\.png", stage):
            return {"ok": False, "error": "剪貼簿暫存已失效"}
        path = os.path.join(MEDIA_DIR, stage)
        if clipboard_stage_expired(path):
            if staged:
                with lock:
                    clipboard_stage_bindings.pop(stage, None)
                cancel_clipboard_stage_expiry(stage)
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            return {"ok": False, "error": "剪貼簿暫存已失效"}
        preview_path = os.path.join(
            MEDIA_DIR, "preview-%s.png" % uuid.uuid4())
        if staged:
            lease_removed = False
            with lock:
                binding = clipboard_stage_bindings.get(stage)
                if (not binding or binding.get("claimed")
                        or binding.get("generation") != session_generation):
                    return {"ok": False, "error": "剪貼簿暫存已失效"}
                if binding.get("chat") != mid:
                    clipboard_stage_bindings.pop(stage, None)
                    lease_removed = clipboard_stage_timers.pop(stage, None) is not None
                    claim_status = "mismatch"
                else:
                    binding["claimed"] = True
                    try:
                        # Hold the lease lock through rename: expiry cannot
                        # remove the pathname between the binding claim and
                        # the filesystem claim.
                        os.replace(path, preview_path)
                    except FileNotFoundError:
                        clipboard_stage_bindings.pop(stage, None)
                        lease_removed = clipboard_stage_timers.pop(stage, None) is not None
                        claim_status = "missing"
                    except BaseException:
                        binding["claimed"] = False
                        raise
                    else:
                        lease_removed = clipboard_stage_timers.pop(stage, None) is not None
                        claim_status = "claimed"
                if lease_removed:
                    _arm_clipboard_expiry_locked()
            if claim_status == "mismatch":
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
                return {"ok": False, "error": "剪貼簿暫存已失效"}
            if claim_status == "missing":
                return {"ok": False, "error": "剪貼簿暫存已失效"}
        else:
            try:
                os.replace(path, preview_path)
            except FileNotFoundError:
                return {"ok": False, "error": "剪貼簿暫存已失效"}
            except BaseException:
                try:
                    os.remove(path)
                except OSError:
                    pass
                raise
        download_path = os.path.join(
            MEDIA_DIR, "original-%s.png" % uuid.uuid4())
        keep_preview = False
        try:
            shutil.copyfile(preview_path, download_path)
            refused = file_target_error(mid)
            if refused:
                return refused
            with lock:
                if mid not in messages:
                    return {"ok": False, "error": "沒有這個聊天室: %s" % mid}
                n = len(messages[mid]) + 1
                # The stage is one-shot like production. Keep a distinct
                # cached preview because history still needs a drawable file.
                sent = msg(mid, n, ME, "我", "", 0, contentType="IMAGE",
                           hasMedia=True,
                           fileName=stage, fileSize=os.path.getsize(preview_path),
                           **({"requestId": req["requestId"]}
                              if isinstance(req.get("requestId"), str)
                              and req["requestId"] else {}))
                preview_sources[sent["id"]] = preview_path
                download_sources[sent["id"]] = download_path
                messages[mid].append(sent)
                refresh_chat_summary(mid)
                keep_preview = True
            push_event("message", mid, message=sent)
            write_state()
            arm_read_receipt(mid, sent["id"])
            return {"ok": True}
        finally:
            if staged:
                with lock:
                    clipboard_stage_bindings.pop(stage, None)
            if not keep_preview:
                for pending_path in (preview_path, download_path):
                    try:
                        os.remove(pending_path)
                    except FileNotFoundError:
                        pass


    if cmd == "preview":
        wanted_chat = req.get("chat")
        wanted = req.get("messageId")
        with lock:
            found = next(((chat, m) for chat, rows in messages.items()
                          for m in rows if m["id"] == wanted), None)
            if not found:
                return {"ok": False, "error": "訊息不在快取裡"}
            owner_chat, m = found
            if owner_chat != wanted_chat:
                return {"ok": False, "error": "訊息不在這個聊天室"}
            if m:
                if m.get("mediaState") in ("unsent", "expired"):
                    return {"ok": False, "error": "縮圖不可用"}
                if m.get("contentType") not in ("IMAGE", "VIDEO"):
                    return {"ok": False, "error": "這則訊息沒有縮圖"}
                if (m.get("contentType") == "VIDEO"
                        and m.get("previewable") is not True):
                    return {"ok": False, "error": "縮圖不可用"}
                path = preview_sources.get(m["id"])
                if path:
                    if req.get("invalidate"):
                        write_thumb_png(path, int(time.time_ns()), w=240, h=160)
                    return {"ok": True, "data": {"path": path}}
                return {"ok": False, "error": "縮圖下載失敗"}

    if cmd == "download":
        # The daemon passes `chat` straight through as messageBoxId; when the
        # panel omits it LINE answers ILLEGAL_ARGUMENT "Invalid messageBoxId".
        # The stub has to fail the same way or a panel bug looks fine here.
        wanted_chat = req.get("chat")
        wanted = req.get("messageId")
        with lock:
            found = next(((chat, m) for chat, rows in messages.items()
                          for m in rows if m["id"] == wanted), None)
            if not found:
                return {"ok": False, "error": "訊息不在快取裡"}
            owner_chat, m = found
            if owner_chat != wanted_chat:
                return {"ok": False, "error": "訊息不在這個聊天室"}
            # The daemon refuses these two from what it already knows, before
            # it asks LINE for anything; the panel must see the same strings.
            if m.get("mediaState") == "unsent":
                return {"ok": False, "error": UNSENT_ERROR}
            if m.get("mediaState") == "expired":
                return {"ok": False, "error": EXPIRED_ERROR}
            # VIDEO mediaPath is its thumbnail, never the recording. Every
            # image fixture has an immutable original separate from preview.
            p = download_sources.get(m["id"])
            if not p:
                p = os.path.join(
                    MEDIA_DIR, m.get("fileName") or ("%s.bin" % wanted))
                if not os.path.exists(p):
                    with open(p, "w", encoding="utf-8") as f:
                        f.write("stub payload for %s\n" % wanted)
            return {"ok": True, "data": {"path": p}}

    if cmd == "image":
        # No network here, so the picture is drawn rather than fetched: what
        # the panel wants from this command is a local file to hang a file://
        # on, and the same one every time, or a sticker grid re-requests the
        # whole page on every scroll. Without it every sticker cell, the
        # picker, a FLEX preview and the lightbox are broken images, which is
        # the one thing the stub exists to prevent.
        raw = str(req.get("url") or "")
        # The fragment never reaches a server, so two urls that differ only
        # there are one picture -- imagecache.ts drops it before it keys on
        # anything, and the file has to collapse the same way.
        raw = raw.split("#", 1)[0]
        try:
            parts = urllib.parse.urlsplit(raw)
            public = (parts.scheme == "https" and bool(parts.hostname)
                      and not parts.username and not parts.password)
        except ValueError:              # urlsplit refuses some netlocs outright
            public = False
        # Everything imagecache.ts refuses -- a url it cannot parse, a scheme
        # that is not https, credentials in the url, a body that is not an
        # image -- reaches the panel as this one string.
        if not public:
            return {"ok": False, "error": IMAGE_ERROR}
        # Keyed like imagecache.ts: sha256 of the url, no extension (Qt reads
        # the format out of the header), so one url is one file for as long as
        # the cache lives.
        key = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        path = os.path.join(IMAGE_DIR, key)
        if req.get("invalidate") is True or not os.path.exists(path):
            # Made here rather than in seed(), because the sweep the README
            # documents can take the directory away under a running stub.
            os.makedirs(IMAGE_DIR, exist_ok=True)
            # A sticker page asks for forty of these at once and two threads
            # that both miss aim at one path; a half-written PNG left there is
            # one the panel can never repair, because its single retry asks
            # for the same url and gets the same path back. So draw beside it
            # and rename over, the way imagecache.ts does.
            part = "%s.%d.part" % (path, threading.get_ident())
            try:
                # The seed is the url: two pictures that come out identical
                # read as a panel bug, and one that changes across restarts
                # hides a caching bug.
                write_thumb_png(part, int(key[:2], 16), w=240, h=240)
                os.replace(part, path)
            except OSError:
                # A full disk is the only way here, and it must not leave a
                # half-drawn `.part` behind for the sweep to count.
                if os.path.exists(part):
                    os.remove(part)
                return {"ok": False, "error": IMAGE_ERROR}
        return {"ok": True, "data": {"path": path}}

    if cmd == "poke":
        # Stub only. The real daemon has no such command: it writes
        # `state.wanted` from a notify-send action, which needs a notification
        # server, a toast and somebody to click it. This is the same write,
        # reachable from a test.
        mid = req.get("chat") or ""
        with lock:
            known = any(c["mid"] == mid for c in state["chats"])
        if not known:
            return {"ok": False, "error": "沒有這個聊天室: %s" % mid}
        armed = set_wanted(mid)
        write_state()
        return {"ok": True, "data": armed}

    if cmd == "fail-refresh":
        # Stub only, like `poke`. The real daemon moves state.refresh when a
        # getMessageBoxes round actually fails, which would take a dead
        # network here; this is the same write, reachable from a test -- and
        # from anyone who wants the panel's 清單可能過期 line without
        # pulling a cable. Each call is one more failed round (the panel
        # speaks up at two), and the next ordinary write is the recovery --
        # see the stamp in write_state(), which is where the arm is spent.
        global refresh_failing
        with lock:
            refresh_failing += 1
            write_state()  # RLock: the arm and the write cannot interleave
            armed = dict(state["refresh"])
        return {"ok": True, "data": armed}

    return {"ok": False, "error": "unknown cmd: %s" % cmd}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        for raw in self.rfile:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                continue
            try:
                res = handle(req)
            except Exception as e:                      # never drop the client
                res = {"ok": False, "error": "stub error: %s" % e}
            res["id"] = req.get("id")
            self.wfile.write((json.dumps(res, ensure_ascii=False) + "\n").encode())
            self.wfile.flush()


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def parse_args(argv):
    fixture = "default"
    if "--fixture" in argv:
        i = argv.index("--fixture")
        if i + 1 >= len(argv) or argv[i + 1] not in FIXTURES:
            sys.exit("usage: stub.py [--logged-out] [--real] [--fixture %s]"
                     % "|".join(FIXTURES))
        fixture = argv[i + 1]
    return fixture, "--logged-out" in argv, "--real" in argv


def main():
    fixture, logged_out, real = parse_args(sys.argv[1:])
    if not real and "XDG_STATE_HOME" not in os.environ:
        sys.exit(
            "stub.py: refusing to take over the live state dir %s — set "
            "XDG_STATE_HOME to an isolated dir, or pass --real to serve the "
            "real panel deliberately" % STATE_DIR)
    # SIGTERM needs the socket file gone and nothing else: exit through
    # os._exit so the finally below never gets to wait on serve_forever
    # (its shutdown() has to catch the poll loop, which can outlast a
    # test harness's patience on a loaded machine).
    def _die(*_):
        if os.path.exists(SOCK_PATH):
            os.remove(SOCK_PATH)
        os._exit(0)

    signal.signal(signal.SIGTERM, _die)
    os.makedirs(STATE_DIR, exist_ok=True)
    seed(fixture, logged_out)
    recover_clipboard_stages()

    if os.path.exists(SOCK_PATH):
        os.remove(SOCK_PATH)
    server = Server(SOCK_PATH, Handler)
    # Start the serve thread (and, through it, every handler thread) with
    # SIGTERM blocked: a signal the kernel hands to a non-main thread only
    # flags CPython, and _die then waits out the main loop's HEARTBEAT sleep.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    threading.Thread(target=server.serve_forever, daemon=True).start()
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
    print("enil-stub[%s]: %s + %s" % (fixture, STATE_PATH, SOCK_PATH), flush=True)

    try:
        while True:
            time.sleep(HEARTBEAT)
            write_state()                                # keeps the panel "online"
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        if os.path.exists(SOCK_PATH):
            os.remove(SOCK_PATH)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Pins daemon/stub.py to the contract documented in README 契約.

Runs the stub in a throwaway XDG_STATE_HOME -- never the real ~/.local/state
-- and drives it over its own socket, the way the plugin does. Standard
library only, and it must stay well under 10 seconds.
"""

import ast
import json
import os
import re
import runpy
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
STUB = os.path.join(HERE, "stub.py")


def read_text(path):
    """Source read off disk, not out of `git show`: an uncommitted regression
    has to fail the suite rather than slip through because it is unstaged."""
    with open(path, encoding="utf-8") as f:
        return f.read()

# README: state.json top level, and the chat rows inside it.
STATE_KEYS = {"updatedAt", "bootId", "me", "login", "chats", "chatsRevision", "events"}
# `wanted` only exists once a notification has been clicked (or `poke` has
# faked one), so it is not part of the shape a fresh state.json has.
STATE_OPTIONAL = {
    "link": dict, "wanted": dict, "refresh": dict, "chatList": dict,
    "timings": dict,
}
CHAT_TYPES = {
    "mid": str, "name": str, "unread": int,
    "lastText": str, "lastTime": int, "lastFrom": str,
}
# Absent, never empty, when the contact has no picture. `hidden` is absent
# unless it is true -- an older panel build must not have to know the key.
CHAT_OPTIONAL = {"avatarPath": str, "hidden": bool}
# PluginMessage in daemon.ts: the always-present half, then the optional half.
MSG_REQUIRED = {
    "id": str, "chat": str, "from": str, "fromName": str, "text": str,
    "time": int, "contentType": str, "decryptFailed": bool, "hasMedia": bool,
    "unsent": bool, "mediaState": str,
}
MSG_OPTIONAL = {
    "mediaPath": str, "altText": str, "flexImages": list,
    "stickerUrl": str, "fileName": str, "fileSize": int, "expiresAt": int,
    "mentions": list, "replyTo": dict, "reactions": list, "readBy": dict,
    "fromAvatar": str, "requestId": str, "previewable": bool,
}
# README 契約: one row of `stickers`, and one sticker inside it.
PACKAGE_TYPES = {"id": str, "name": str, "version": int, "stickers": list}
STICKER_TYPES = {"id": str, "url": str, "animated": bool}
# README 契約: the click hand-off the panel opens a conversation from.
WANTED_TYPES = {"chat": str, "at": int, "seq": int}
# README 契約: the chat list's freshness. `reason` only exists while failing.
REFRESH_TYPES = {"at": int, "failures": int}
MEDIA_STATES = ("ok", "unsent", "expired")
EVENT_KINDS = ("message", "read", "reaction", "unsend")
# stub.py's REACTION_PICKABLE; the daemon builds the same list off LINE's enum.
REACTIONS = ("UNDO", "NICE", "LOVE", "FUN", "AMAZING", "SAD", "OMG")
# Any absolute https url exercises the same path; nothing is fetched.
STUB_IMAGE_URL = "https://placehold.co/240x160/png"


class Stub:
    """The stub as a subprocess plus one socket connection to it."""

    def __init__(self, *args):
        self.dir = tempfile.mkdtemp(prefix="enil-stub-test-")
        env = dict(os.environ, XDG_STATE_HOME=self.dir)
        self.state_dir = os.path.join(self.dir, "enil")
        self.proc = subprocess.Popen(
            [sys.executable, STUB, *args], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        sock_path = os.path.join(self.state_dir, "sock")
        # The stub prints its paths once both files exist; a bounded poll is
        # simpler than reading that line and still fails fast.
        for _ in range(200):
            if os.path.exists(sock_path):
                break
            time.sleep(0.02)
        else:
            raise AssertionError("stub never created %s" % sock_path)
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(sock_path)
        self.rf = self.sock.makefile("rwb")
        self.n = 0

    def call(self, **req):
        self.n += 1
        req.setdefault("id", self.n)
        self.rf.write((json.dumps(req) + "\n").encode())
        self.rf.flush()
        line = self.rf.readline()
        assert line, "stub closed the connection"
        return json.loads(line.decode())

    def state(self):
        with open(os.path.join(self.state_dir, "state.json"), encoding="utf-8") as f:
            return json.load(f)

    def close(self):
        try:
            self.rf.close()
            self.sock.close()
        finally:
            self.proc.terminate()
            # 15, not 5: termination goes through the stub's cleanup on a
            # loaded CI runner, and a too-tight bound turns that into a flake.
            self.proc.wait(timeout=15)
            self.proc.stdout.close()
            shutil.rmtree(self.dir, ignore_errors=True)


def is_int(v):
    # JSON has one number type; bool is an int in Python and must not pass.
    return isinstance(v, int) and not isinstance(v, bool)


class ContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = Stub("--fixture", "default")

    @classmethod
    def tearDownClass(cls):
        cls.s.close()

    def all_messages(self):
        out = []
        for c in self.s.state()["chats"]:
            res = self.s.call(cmd="history", chat=c["mid"], count=100)
            self.assertTrue(res["ok"], res)
            out.extend(res["data"])
        return out

    def test_a_message_request_tokens_round_trip(self):
        mid = "ustub-notes"
        first = self.s.call(cmd="history", chat=mid, count=100)["data"][0]["id"]
        package = self.s.call(cmd="stickers")["data"]["packages"][0]
        sticker = package["stickers"][0]
        cases = [
            {"cmd": "send", "chat": mid, "text": "token send"},
            {"cmd": "reply", "chat": mid, "text": "token reply", "replyTo": first},
            {"cmd": "sendSticker", "chat": mid, "packageId": package["id"],
             "stickerId": sticker["id"]},
            {"cmd": "sendFile", "chat": mid, "path": STUB},
            {"cmd": "sendClipboardImage", "chat": mid,
             "stage": self.s.call(cmd="probeClipboardImage", chat=mid)["data"]["stage"]},
        ]
        for index, req in enumerate(cases):
            token = "stub-request-%d" % index
            res = self.s.call(requestId=token, **req)
            self.assertTrue(res["ok"], res)
            last = self.s.call(cmd="history", chat=mid, count=200)["data"][-1]
            self.assertEqual(token, last.get("requestId"), req["cmd"])

    def test_state_shape(self):
        st = self.s.state()
        self.assertLessEqual(STATE_KEYS, set(st))
        self.assertLessEqual(set(st) - STATE_KEYS, set(STATE_OPTIONAL))
        self.assertTrue(is_int(st["updatedAt"]))
        self.assertTrue(is_int(st["chatsRevision"]))
        self.assertEqual({"complete": True, "loaded": len(st["chats"])}, st["chatList"])
        # README documents me as {} when logged out, so when it is populated
        # it has to be populated properly: both keys, both strings.
        self.assertEqual({"mid", "displayName"}, set(st["me"]))
        self.assertIsInstance(st["me"]["mid"], str)
        self.assertIsInstance(st["me"]["displayName"], str)
        self.assertTrue(st["me"]["mid"])
        self.assertTrue(st["me"]["displayName"])
        self.assertEqual("ok", st["login"]["status"])
        self.assertTrue(st["chats"])
        for c in st["chats"]:
            self.assertLessEqual(set(CHAT_TYPES), set(c), c["mid"])
            self.assertLessEqual(set(c) - set(CHAT_TYPES), set(CHAT_OPTIONAL),
                                 "%s has an undocumented field" % c["mid"])
            for k, t in list(CHAT_TYPES.items()) + list(CHAT_OPTIONAL.items()):
                if k not in c:
                    continue
                self.assertTrue(is_int(c[k]) if t is int else isinstance(c[k], t),
                                "chat %s field %s" % (c["mid"], k))

    def test_fixture_covers_every_mid_prefix(self):
        prefixes = {c["mid"][:1] for c in self.s.state()["chats"]}
        self.assertLessEqual({"u", "c", "r"}, prefixes)

    def test_message_field_types(self):
        seen = set()
        for m in self.all_messages():
            for k, t in MSG_REQUIRED.items():
                self.assertIn(k, m, m["id"])
                ok = is_int(m[k]) if t is int else isinstance(m[k], t)
                self.assertTrue(ok, "%s.%s is %r" % (m["id"], k, type(m[k])))
            for k in set(m) - set(MSG_REQUIRED):
                self.assertIn(k, MSG_OPTIONAL, "%s has undocumented %s" % (m["id"], k))
                t = MSG_OPTIONAL[k]
                ok = is_int(m[k]) if t is int else isinstance(m[k], t)
                self.assertTrue(ok, "%s.%s is %r" % (m["id"], k, type(m[k])))
                seen.add(k)
            if "flexImages" in m:
                for u in m["flexImages"]:
                    self.assertIsInstance(u, str)
                    self.assertTrue(u.startswith("https://"), u)
        # Every optional field has to appear somewhere, or the panel branch
        # that reads it is untested.
        # mediaPath is a valid patched-message field, but history deliberately
        # omits it so the stub exercises the same lazy preview request as the
        # real daemon.
        self.assertEqual(set(MSG_OPTIONAL) - {"mediaPath"}, seen)

    def test_fixture_covers_every_render_branch(self):
        msgs = self.all_messages()
        types = {m["contentType"] for m in msgs}
        self.assertLessEqual(
            {"NONE", "IMAGE", "VIDEO", "FILE", "STICKER", "FLEX",
             "CHATEVENT", "POSTNOTIFICATION"}, types)
        self.assertTrue(any(m["decryptFailed"] for m in msgs))
        self.assertTrue(any("\n" in m["text"] for m in msgs))
        self.assertTrue(any(m["from"] == self.s.state()["me"]["mid"] for m in msgs))
        # A VIDEO with no mediaPath is the 📎 fallback the daemon ships for
        # E2EE video; losing it would leave that branch unexercised.
        self.assertTrue(any(m["contentType"] == "VIDEO" and "mediaPath" not in m
                            for m in msgs))
        self.assertTrue(any(m["contentType"] == "VIDEO" and m.get("previewable") is True
                            and "mediaPath" not in m for m in msgs))
        self.assertTrue(any(m["contentType"] == "IMAGE" and "mediaPath" not in m
                            for m in msgs))
        for m in msgs:
            if m.get("mediaPath"):
                self.assertTrue(os.path.exists(m["mediaPath"]), m["id"])

    def test_history_pages_with_before(self):
        mid = "cstub-family"
        page = self.s.call(cmd="history", chat=mid, count=2)["data"]
        self.assertEqual(2, len(page))
        older = self.s.call(cmd="history", chat=mid, count=2, before=page[0]["id"])
        self.assertTrue(older["ok"])
        self.assertTrue(older["data"])
        self.assertLess(older["data"][-1]["time"], page[0]["time"])
        # Walking back to the top yields an empty page, not an error: that is
        # what tells the panel to stop asking for more.
        cursor, pages = older["data"][0]["id"], 0
        while pages < 10:
            page = self.s.call(cmd="history", chat=mid, count=2, before=cursor)
            self.assertTrue(page["ok"], page)
            if not page["data"]:
                break
            cursor = page["data"][0]["id"]
            pages += 1
        else:
            self.fail("history never ran out of pages")

    def test_history_count_is_clamped_like_the_daemon(self):
        # The panel lets the reader pick the page size now, so `count` is a
        # number from shell.json rather than a literal in one function. The
        # two answers the old `int(req.get("count") or 30)` gave that the
        # daemon never gave: a non-numeric count killed the connection with a
        # ValueError, and a negative one sliced from the wrong end -- so
        # `count: -5` paged *forward* while claiming to page back.
        mid = "cstub-family"
        whole = self.s.call(cmd="history", chat=mid, count=1000)["data"]
        self.assertTrue(whole)
        # Out of range is still a choice, so it is clamped, not defaulted.
        self.assertEqual(1, len(self.s.call(cmd="history", chat=mid, count=0)["data"]))
        self.assertEqual(1, len(self.s.call(cmd="history", chat=mid, count=-5)["data"]))
        self.assertEqual(
            len(whole),
            len(self.s.call(cmd="history", chat=mid, count=100000)["data"]),
            "a huge count is capped, and the cap is above this fixture")
        # A count is a whole number of messages; 2.6 is 3, not a crash.
        self.assertEqual(3, len(self.s.call(cmd="history", chat=mid, count=2.6)["data"]))
        # Not a number at all means the caller did not choose: the default of
        # 30 is above this fixture, so it is the whole conversation. The rows
        # after "abc" are the ones the daemon used to disagree about, because
        # `Number("")`, `Number([])` and `Number(false)` are 0 rather than NaN
        # and `Number([60])` is 60 -- a blank count asked LINE for a single
        # message there while asking for everything here. Same rule now: a
        # number, or a string that parses as one, and nothing else. Every row
        # also has to come back at all: the old parse raised inside handle(),
        # which killed the connection instead of answering.
        for bad in ("abc", "", " ", "\n", [], [60], True, False, None, {}):
            self.assertEqual(
                len(whole),
                len(self.s.call(cmd="history", chat=mid, count=bad)["data"]),
                bad)

    def test_history_bounds_match_the_daemon_and_the_panel(self):
        stub = read_text(STUB)
        daemon = read_text(os.path.join(HERE, "modules", "socket.ts"))
        panel = read_text(os.path.join(HERE, os.pardir, "PanelKit.js"))
        for name in ("HISTORY_COUNT", "HISTORY_COUNT_MAX"):
            self.assertEqual(
                re.search(r"^%s = (\d+)$" % name, stub, re.M).group(1),
                re.search(r"^const %s = (\d+);$" % name, daemon, re.M).group(1),
                name)
        # The panel clamps to the same ceiling, or its button would offer a
        # page size one of the two daemons quietly refuses to fetch.
        self.assertEqual(
            re.search(r"^HISTORY_COUNT_MAX = (\d+)$", stub, re.M).group(1),
            re.search(r"return Math\.max\(20, Math\.min\((\d+), n\)\)",
                      panel).group(1))

    def test_the_state_file_write_stays_inside_the_lock(self):
        """os.replace() alone is atomic for one writer, not for these."""
        # Every write_state() shares the one `.tmp` name, and the stub has
        # more than one thread writing: a handler per connection, plus the
        # login timer. Outside the lock they interleave their bytes in that
        # file and the later replace() need not be the later snapshot. This
        # is not worth driving from outside -- eight threads hammering `hide`
        # only lost bytes in three runs out of eight, so a behavioural test
        # would pass while broken more often than it caught it. The invariant
        # is structural, so it is pinned structurally, like the bounds above.
        tree = ast.parse(read_text(STUB))
        fn = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.FunctionDef)
                  and n.name == "write_state")
        blocks = [n for n in fn.body if isinstance(n, ast.With)]
        self.assertEqual(1, len(blocks), "write_state holds one outer block")
        self.assertEqual("lock", blocks[0].items[0].context_expr.id,
                         "and that block is the state lock")
        under_lock = {getattr(n, "lineno", None)
                      for n in ast.walk(blocks[0])}
        # Every step that touches the shared `.tmp`, not just the rename:
        # open() and write() are what interleave on that one inode, so a
        # refactor that left only os.replace() behind under the lock would
        # bring the corruption back with this test still green.
        touches = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and (
            (isinstance(n.func, ast.Name) and n.func.id == "open")
            or (isinstance(n.func, ast.Attribute)
                and n.func.attr in ("write", "replace")))]
        self.assertEqual(3, len(touches),
                         "write_state opens, writes and replaces")
        for call in touches:
            self.assertIn(call.lineno, under_lock,
                          "the file write belongs to the snapshot's lock")

    def test_the_logout_branch_decides_and_writes_under_one_lock(self):
        """The daemon gets this from handling one command at a time."""
        # A logout that reads "idle", loses the lock to a login claiming
        # "starting", and then clears that claim answers {ok:true} and ends
        # at "qr" -- which is exactly what a logout that simply ran first
        # answers and ends at. The replies cannot tell the two apart, so
        # there is nothing here for a behavioural test to assert on. What
        # separates them is that the look and the reset share one lock, so
        # that is what is pinned, like write_state() above.
        tree = ast.parse(read_text(STUB))
        fn = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.FunctionDef)
                  and n.name == "handle")
        branch = next(
            n for n in ast.walk(fn)
            if isinstance(n, ast.If) and isinstance(n.test, ast.Compare)
            and getattr(n.test.comparators[0], "value", None) == "logout")
        blocks = [n for n in branch.body if isinstance(n, ast.With)]
        self.assertEqual(1, len(blocks), "logout holds one outer block")
        self.assertEqual("lock", blocks[0].items[0].context_expr.id,
                         "and that block is the state lock")
        under_lock = {getattr(n, "lineno", None)
                      for n in ast.walk(blocks[0])}
        # Every mention of `state`, not just the reset: the race being
        # pinned is the status READ drifting back outside the lock, and a
        # check that only followed set_login() stayed green through exactly
        # that, which is how this test was first written.
        touches = [n for n in ast.walk(branch)
                   if isinstance(n, ast.Name) and n.id == "state"]
        self.assertTrue(touches, "logout still reads and clears state")
        for node in touches:
            self.assertIn(node.lineno, under_lock,
                          "the read shares the lock with the reset")
        resets = [n for n in ast.walk(branch) if isinstance(n, ast.Call)
                  and isinstance(n.func, ast.Name)
                  and n.func.id == "set_login"]
        self.assertTrue(resets, "logout still resets the login status")
        for call in resets:
            self.assertIn(call.lineno, under_lock,
                          "and so does the reset")

    def test_mark_read_zeroes_unread(self):
        mid = "cstub-family"
        revision = self.s.state()["chatsRevision"]
        self.assertGreater(
            [c for c in self.s.state()["chats"] if c["mid"] == mid][0]["unread"], 0)
        self.s.call(cmd="history", chat=mid, count=5, markRead=True)
        self.assertEqual(
            0, [c for c in self.s.state()["chats"] if c["mid"] == mid][0]["unread"])
        self.assertEqual(revision + 1, self.s.state()["chatsRevision"])
        self.s.call(cmd="history", chat=mid, count=5, markRead=True)
        self.assertEqual(revision + 1, self.s.state()["chatsRevision"])

    def test_send_appends_and_updates_summary(self):
        mid = "ustub-notes"
        before = len(self.s.call(cmd="history", chat=mid, count=100)["data"])
        self.assertEqual({"ok": True, "id": self.s.n + 1},
                         self.s.call(cmd="send", chat=mid, text="STUB echo"))
        after = self.s.call(cmd="history", chat=mid, count=100)["data"]
        self.assertEqual(before + 1, len(after))
        self.assertEqual("STUB echo", after[-1]["text"])
        chat = [c for c in self.s.state()["chats"] if c["mid"] == mid][0]
        self.assertEqual("STUB echo", chat["lastText"])
        self.assertEqual("我", chat["lastFrom"])
        self.assertEqual(after[-1]["time"], chat["lastTime"])

    def test_members_answers_groups_and_refuses_the_rest(self):
        res = self.s.call(cmd="members", chat="cstub-family")
        self.assertTrue(res["ok"], res)
        rows = res["data"]
        self.assertGreater(len(rows), 1)
        for r in rows:
            self.assertEqual({"mid", "name"}, set(r))
            self.assertIsInstance(r["mid"], str)
            self.assertIsInstance(r["name"], str)
            # The panel puts this mid straight into a mention it sends back.
            self.assertRegex(r["mid"], r"^u[0-9a-f]{32}$")
        self.assertEqual([r["name"] for r in rows],
                         sorted(r["name"] for r in rows), "sorted by name")
        # 1:1 and room: the daemon's two refusals, word for word.
        self.assertEqual({"ok": False, "error": "這不是群組，沒有成員名單",
                          "id": self.s.n + 1},
                         self.s.call(cmd="members", chat="ustub-alice"))
        self.assertEqual("多人聊天室（room）拿不到成員名單",
                         self.s.call(cmd="members", chat="rstub-lunch")["error"])

    def test_incoming_mentions_are_utf16_offsets_into_the_text(self):
        msgs = self.s.call(cmd="history", chat="cstub-family", count=100)["data"]
        with_mentions = [m for m in msgs if m.get("mentions")]
        self.assertEqual(1, len(with_mentions), "one mention fixture")
        m = with_mentions[0]
        # Slice the way the panel does: in UTF-16 code units, which is why the
        # fixture carries an emoji ahead of the first mention.
        units = m["text"].encode("utf-16-le")
        self.assertGreater(len(units) // 2, len(m["text"]), "emoji in the text")

        def cut(a, b):
            return units[a * 2:b * 2].decode("utf-16-le")

        kinds = set()
        last_end = 0
        for e in m["mentions"]:
            self.assertLessEqual(last_end, e["start"], "sorted, non-overlapping")
            last_end = e["end"]
            self.assertTrue(cut(e["start"], e["end"]).startswith("@"),
                            cut(e["start"], e["end"]))
            self.assertIsInstance(e["name"], str)
            if e.get("all"):
                kinds.add("all")
                self.assertEqual("全部", e["name"])
                self.assertEqual("@All", cut(e["start"], e["end"]))
            else:
                kinds.add("mid")
                self.assertRegex(e["mid"], r"^u[0-9a-f]{32}$")
                self.assertEqual("@" + e["name"], cut(e["start"], e["end"]))
        self.assertEqual({"all", "mid"}, kinds, "both kinds in the fixture")

    def test_send_keeps_valid_mentions_and_drops_the_rest(self):
        mid = "cstub-family"
        who = self.s.call(cmd="members", chat=mid)["data"][0]
        text = "@%s @All 收到" % who["name"]
        end = 1 + len(who["name"])
        res = self.s.call(cmd="send", chat=mid, text=text, mentions=[
            {"start": 0, "end": end, "mid": who["mid"]},
            {"start": end + 1, "end": end + 5, "all": True},
            {"start": 0, "end": 999, "mid": who["mid"]},        # out of range
            {"start": 2, "end": 4, "mid": "not-a-mid"},         # bad mid
        ])
        self.assertTrue(res["ok"], res)
        last = self.s.call(cmd="history", chat=mid, count=100)["data"][-1]
        self.assertEqual(
            [{"start": 0, "end": end, "mid": who["mid"], "name": who["name"]},
             {"start": end + 1, "end": end + 5, "all": True, "name": "全部"}],
            last["mentions"])
        # A message with nothing valid to mention carries no field at all.
        self.s.call(cmd="send", chat=mid, text="沒有 mention",
                    mentions=[{"start": 0, "end": 2, "mid": "nope"}])
        self.assertNotIn(
            "mentions",
            self.s.call(cmd="history", chat=mid, count=100)["data"][-1])

    def test_send_file_rejects_room_mid_like_the_daemon(self):
        res = self.s.call(cmd="sendFile", chat="rstub-lunch", path=STUB)
        self.assertFalse(res["ok"])
        self.assertEqual("多人聊天室（room）暫不支援傳檔案", res["error"])

    def test_preview_labels_match_the_daemon(self):
        # previewText() in daemon.ts, not bodyText() in Panel.qml: the chat
        # list line is the daemon's to write.
        by_mid = {c["mid"]: c for c in self.s.state()["chats"]}
        self.assertEqual("[貼文通知]", by_mid["cstub-work"]["lastText"])
        self.assertEqual("[貼圖]", by_mid["ustub-alice"]["lastText"])
        self.assertEqual("[圖片]", by_mid["rstub-lunch"]["lastText"])
        for c in by_mid.values():
            self.assertNotRegex(c["lastText"], r"^\[[A-Z]+\]$")

    def test_send_file_accepts_u_mid(self):
        res = self.s.call(cmd="sendFile", chat="ustub-notes", path=STUB)
        self.assertTrue(res["ok"], res)
        last = self.s.call(cmd="history", chat="ustub-notes", count=100)["data"][-1]
        self.assertEqual("FILE", last["contentType"])
        self.assertEqual("stub.py", last["fileName"])
        self.assertTrue(is_int(last["fileSize"]))
        # A FILE previews as its name, and only falls back to "[檔案]".
        chat = [c for c in self.s.state()["chats"] if c["mid"] == "ustub-notes"][0]
        self.assertEqual(last["fileName"], chat["lastText"])

    def test_send_file_types_a_video_as_a_video(self):
        # The daemon picks linejs's ObjType from the bytes and the name; sent
        # as a file, an mp4 arrives as an attachment LINE will not play.
        path = os.path.join(self.s.dir, "clip.mp4")
        with open(path, "wb") as f:
            f.write(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 16)
        res = self.s.call(cmd="sendFile", chat="ustub-notes", path=path)
        self.assertTrue(res["ok"], res)
        last = self.s.call(cmd="history", chat="ustub-notes", count=100)["data"][-1]
        self.assertEqual("VIDEO", last["contentType"])
        # No thumbnail: an E2EE video has no usable preview, so the panel keeps
        # the 📎 row rather than an Image that never loads.
        self.assertNotIn("mediaPath", last)

    def test_image_preview_invalidation_never_rewrites_the_source(self):
        path = os.path.join(self.s.dir, "source.png")
        original = b"\x89PNG\r\n\x1a\noriginal-image-bytes"
        with open(path, "wb") as f:
            f.write(original)
        res = self.s.call(cmd="sendFile", chat="ustub-notes", path=path)
        self.assertTrue(res["ok"], res)
        last = self.s.call(cmd="history", chat="ustub-notes", count=100)["data"][-1]
        preview = self.s.call(cmd="preview", chat="ustub-notes",
                              messageId=last["id"], invalidate=True)
        self.assertTrue(preview["ok"], preview)
        self.assertNotEqual(path, preview["data"]["path"])
        with open(path, "rb") as f:
            self.assertEqual(original, f.read())
        download = self.s.call(cmd="download", chat="ustub-notes",
                               messageId=last["id"])
        self.assertTrue(download["ok"], download)
        with open(download["data"]["path"], "rb") as f:
            self.assertEqual(original, f.read())

    def test_fixture_preview_invalidation_never_changes_an_original(self):
        for chat, message_id in (("cstub-family", "cstub-family-m3"),
                                 ("rstub-lunch", "rstub-lunch-m2")):
            download = self.s.call(cmd="download", chat=chat,
                                   messageId=message_id)
            self.assertTrue(download["ok"], download)
            with open(download["data"]["path"], "rb") as f:
                original = f.read()
            preview = self.s.call(cmd="preview", chat=chat,
                                  messageId=message_id, invalidate=True)
            self.assertTrue(preview["ok"], preview)
            again = self.s.call(cmd="download", chat=chat,
                                messageId=message_id)
            with open(again["data"]["path"], "rb") as f:
                self.assertEqual(original, f.read())
            self.assertNotEqual(download["data"]["path"],
                                preview["data"]["path"])

    def sparse(self, name, size):
        """A file of `size` bytes that costs nothing to create.

        The cap is checked from the size alone, on both sides, so a hole is as
        good as a gigabyte of zeros -- and a test that actually wrote one would
        not stay under the ten seconds this suite is allowed.
        """
        path = os.path.join(self.s.dir, name)
        with open(path, "wb") as f:
            f.truncate(size)
        return path

    def test_send_file_refuses_an_oversized_upload(self):
        # LINE only refuses one after the whole body has gone up, and the
        # daemon buffers the file to get there; the limit is named because the
        # user picked the file and is the only one who can pick a smaller one.
        before = len(self.s.call(cmd="history", chat="ustub-notes",
                                 count=200)["data"])
        cases = [
            ("huge.png", 20 * 1024 * 1024 + 1, "圖片太大（超過 20 MB）"),
            ("huge.mp4", 1024 * 1024 * 1024 + 1, "影片太大（超過 1 GB）"),
            ("huge.bin", 1024 * 1024 * 1024 + 1, "檔案太大（超過 1 GB）"),
        ]
        for name, size, want in cases:
            res = self.s.call(cmd="sendFile", chat="ustub-notes",
                              path=self.sparse(name, size))
            self.assertFalse(res["ok"], name)
            self.assertEqual(want, res["error"])
        # A refusal is not a send: the bubble must not appear either.
        after = self.s.call(cmd="history", chat="ustub-notes", count=200)
        self.assertEqual(before, len(after["data"]))

    def test_send_file_accepts_a_file_exactly_at_the_cap(self):
        # The cap is inclusive on both sides: an off-by-one here is a refusal
        # nobody can explain from the sentence they are shown.
        path = self.sparse("edge.png", 20 * 1024 * 1024)
        res = self.s.call(cmd="sendFile", chat="ustub-notes", path=path)
        self.assertTrue(res["ok"], res)
        last = self.s.call(cmd="history", chat="ustub-notes",
                           count=100)["data"][-1]
        self.assertEqual("edge.png", last["fileName"])
        self.assertEqual(20 * 1024 * 1024, last["fileSize"])

    def test_send_clipboard_image_sends_a_picture(self):
        probe = self.s.call(cmd="probeClipboardImage", chat="ustub-notes")
        self.assertTrue(probe["ok"], probe)
        stage = probe["data"]["stage"]
        res = self.s.call(cmd="sendClipboardImage", chat="ustub-notes",
                          stage=stage)
        self.assertTrue(res["ok"], res)
        replay = self.s.call(cmd="sendClipboardImage", chat="ustub-notes",
                             stage=stage)
        self.assertFalse(replay["ok"], replay)
        self.assertEqual("剪貼簿暫存已失效", replay["error"])
        last = self.s.call(cmd="history", chat="ustub-notes", count=100)["data"][-1]
        self.assertEqual("IMAGE", last["contentType"])
        self.assertTrue(last["hasMedia"])
        self.assertNotIn("mediaPath", last)
        preview = self.s.call(cmd="preview", chat="ustub-notes",
                              messageId=last["id"])
        self.assertTrue(preview["ok"], preview)
        self.assertTrue(os.path.exists(preview["data"]["path"]), preview)
        self.assertTrue(is_int(last["fileSize"]))
        chat = [c for c in self.s.state()["chats"] if c["mid"] == "ustub-notes"][0]
        self.assertEqual("[圖片]", chat["lastText"])

    def test_clipboard_stage_is_bound_to_its_original_chat(self):
        probe = self.s.call(cmd="probeClipboardImage", chat="ustub-notes")
        stage = probe["data"]["stage"]
        refused = self.s.call(cmd="sendClipboardImage", chat="ustub-alice",
                              stage=stage)
        self.assertFalse(refused["ok"])
        self.assertEqual("剪貼簿暫存已失效", refused["error"])
        replay = self.s.call(cmd="sendClipboardImage", chat="ustub-notes",
                             stage=stage)
        self.assertFalse(replay["ok"])
        self.assertEqual("剪貼簿暫存已失效", replay["error"])

    def test_logout_retires_clipboard_stages(self):
        scope = runpy.run_path(STUB, run_name="stub_retire_stage_test")
        retire = scope["retire_clipboard_stages"]
        globals_ = retire.__globals__
        with tempfile.TemporaryDirectory() as directory:
            stage = "clipboard-%s.png" % uuid.uuid4()
            path = os.path.join(directory, stage)
            with open(path, "wb") as f:
                f.write(b"stage")
            globals_["clipboard_stage_bindings"] = {
                stage: {"generation": 1, "chat": "ustub-notes",
                        "claimed": False}}
            retire(directory)
            self.assertFalse(os.path.exists(path))
            self.assertEqual({}, globals_["clipboard_stage_bindings"])

    def test_clipboard_probe_cannot_cross_a_session_change(self):
        for replacement in (False, True):
            with self.subTest(replacement=replacement):
                scope = runpy.run_path(
                    STUB, run_name="stub_probe_session_race_%s" % replacement)
                handle = scope["handle"]
                globals_ = handle.__globals__
                entered = threading.Event()
                resume = threading.Event()
                result = []
                with tempfile.TemporaryDirectory() as directory:
                    globals_["MEDIA_DIR"] = directory
                    globals_["write_state"] = lambda: None
                    globals_["state"] = {
                        "login": {"status": "ok"}, "me": {}, "chats": [],
                        "chatsRevision": 0, "events": []}
                    globals_["messages"] = {"ustub-notes": []}
                    real_write = globals_["write_thumb_png"]

                    def paused_write(path, seed, w=64, h=64):
                        real_write(path, seed, w=w, h=h)
                        entered.set()
                        self.assertTrue(resume.wait(timeout=5))

                    globals_["write_thumb_png"] = paused_write
                    worker = threading.Thread(target=lambda: result.append(handle({
                        "cmd": "probeClipboardImage", "chat": "ustub-notes"})))
                    worker.start()
                    self.assertTrue(entered.wait(timeout=5))
                    self.assertTrue(handle({"cmd": "logout"})["ok"])
                    if replacement:
                        with globals_["lock"]:
                            globals_["session_generation"] += 1
                            globals_["state"]["login"] = {"status": "ok"}
                    resume.set()
                    worker.join(timeout=5)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(
                        [{"ok": False, "error": "尚未登入"}], result)
                    self.assertEqual([], os.listdir(directory))
                    self.assertEqual({}, globals_["clipboard_stage_bindings"])
                    self.assertEqual({}, globals_["clipboard_stage_timers"])

    def test_legacy_clipboard_command_still_sends_without_a_stage(self):
        res = self.s.call(cmd="sendClipboardImage", chat="ustub-notes")
        self.assertTrue(res["ok"], res)
        last = self.s.call(cmd="history", chat="ustub-notes", count=100)["data"][-1]
        self.assertEqual("IMAGE", last["contentType"])
        self.assertNotIn("mediaPath", last)
        preview = self.s.call(cmd="preview", chat="ustub-notes",
                              messageId=last["id"])
        self.assertTrue(preview["ok"], preview)
        self.assertTrue(os.path.exists(preview["data"]["path"]), preview)

    def test_empty_stage_uses_the_legacy_clipboard_contract(self):
        res = self.s.call(cmd="sendClipboardImage", chat="ustub-notes", stage="")
        self.assertTrue(res["ok"], res)
        last = self.s.call(cmd="history", chat="ustub-notes", count=100)["data"][-1]
        self.assertEqual("IMAGE", last["contentType"])

    def test_concurrent_clipboard_sends_consume_the_stage_once(self):
        probe = self.s.call(cmd="probeClipboardImage", chat="ustub-notes")
        stage = probe["data"]["stage"]
        count = 12
        ready = threading.Barrier(count)
        out = [None] * count
        path = os.path.join(self.s.state_dir, "sock")

        def send(i):
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(path)
            rf = sock.makefile("rwb")
            try:
                ready.wait(timeout=10)
                req = {"id": i + 1, "cmd": "sendClipboardImage",
                       "chat": "ustub-notes", "stage": stage}
                rf.write((json.dumps(req) + "\n").encode())
                rf.flush()
                out[i] = json.loads(rf.readline().decode())
            finally:
                rf.close()
                sock.close()

        threads = [threading.Thread(target=send, args=(i,))
                   for i in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
        self.assertEqual(1, sum(result.get("ok") is True for result in out))
        refusals = [result.get("error") for result in out
                    if result.get("ok") is False]
        self.assertEqual(["剪貼簿暫存已失效"] * (count - 1), refusals)
    def test_clipboard_preview_invalidation_preserves_the_download(self):
        res = self.s.call(cmd="sendClipboardImage", chat="ustub-notes")
        self.assertTrue(res["ok"], res)
        last = self.s.call(cmd="history", chat="ustub-notes", count=100)["data"][-1]
        download = self.s.call(cmd="download", chat="ustub-notes",
                               messageId=last["id"])
        self.assertTrue(download["ok"], download)
        with open(download["data"]["path"], "rb") as f:
            original = f.read()
        preview = self.s.call(cmd="preview", chat="ustub-notes",
                              messageId=last["id"], invalidate=True)
        self.assertTrue(preview["ok"], preview)
        self.assertNotEqual(download["data"]["path"], preview["data"]["path"])
        with open(download["data"]["path"], "rb") as f:
            self.assertEqual(original, f.read())

    def test_failed_clipboard_copy_removes_claimed_and_partial_files(self):
        scope = runpy.run_path(STUB, run_name="stub_copy_failure_test")
        handle = scope["handle"]
        globals_ = handle.__globals__
        with tempfile.TemporaryDirectory() as directory:
            globals_["MEDIA_DIR"] = directory
            globals_["messages"] = {"ustub-notes": []}
            globals_["state"] = {"login": {"status": "ok"}}
            stage = "clipboard-%s.png" % uuid.uuid4()
            globals_["clipboard_stage_bindings"] = {
                stage: {"generation": globals_["session_generation"],
                        "chat": "ustub-notes", "claimed": False}}
            with open(os.path.join(directory, stage), "wb") as f:
                f.write(b"preview")
            original_copy = shutil.copyfile

            def fail_after_partial(source, destination):
                with open(destination, "wb") as f:
                    f.write(b"partial")
                raise OSError("disk full")

            try:
                globals_["shutil"].copyfile = fail_after_partial
                with self.assertRaisesRegex(OSError, "disk full"):
                    handle({"cmd": "sendClipboardImage", "chat": "ustub-notes",
                            "stage": stage})
            finally:
                globals_["shutil"].copyfile = original_copy
            self.assertEqual([], os.listdir(directory))


    def test_send_clipboard_image_rejects_room_mid_like_the_daemon(self):
        res = self.s.call(cmd="probeClipboardImage", chat="rstub-lunch")
        self.assertFalse(res["ok"])
        self.assertEqual("多人聊天室（room）暫不支援傳檔案", res["error"])

        probe = self.s.call(cmd="probeClipboardImage", chat="ustub-notes")
        stage = probe["data"]["stage"]
        refused = self.s.call(cmd="sendClipboardImage", chat="rstub-lunch",
                              stage=stage)
        self.assertFalse(refused["ok"])
        self.assertEqual("剪貼簿暫存已失效", refused["error"])
        consumed = self.s.call(cmd="sendClipboardImage", chat="ustub-notes",
                               stage=stage)
        self.assertEqual("剪貼簿暫存已失效", consumed["error"])

    def test_send_clipboard_image_can_be_asked_for_an_empty_clipboard(self):
        # Stub-only flag: without it the panel's "nothing to paste" path can
        # only be reached by clearing a real clipboard.
        res = self.s.call(cmd="probeClipboardImage", chat="ustub-notes", empty=True)
        self.assertFalse(res["ok"])
        self.assertEqual("剪貼簿裡沒有圖片", res["error"])

    def test_stale_clipboard_stage_can_be_discarded(self):
        probe = self.s.call(cmd="probeClipboardImage", chat="ustub-notes")
        stage = probe["data"]["stage"]
        path = os.path.join(self.s.state_dir, "media", stage)
        self.assertTrue(os.path.exists(path), path)
        self.assertTrue(self.s.call(cmd="discardClipboardImage", stage=stage)["ok"])
        self.assertFalse(os.path.exists(path), path)
        # Cleanup is deliberately idempotent: a retry after a lost reply is
        # still success and cannot target anything outside a known stage.
        self.assertTrue(self.s.call(cmd="discardClipboardImage", stage=stage)["ok"])

    def test_completed_clipboard_stages_release_expiry_workers(self):
        stub = Stub("--fixture", "default")
        try:
            tasks = "/proc/%d/task" % stub.proc.pid
            baseline = len(os.listdir(tasks))
            for _ in range(20):
                stage = stub.call(
                    cmd="probeClipboardImage", chat="ustub-notes")["data"]["stage"]
                self.assertTrue(stub.call(
                    cmd="discardClipboardImage", stage=stage)["ok"])
            stage = stub.call(
                cmd="probeClipboardImage", chat="ustub-notes")["data"]["stage"]
            self.assertTrue(stub.call(
                cmd="sendClipboardImage", chat="ustub-notes", stage=stage)["ok"])
            stub.call(cmd="probeClipboardImage", chat="ustub-notes")
            self.assertTrue(stub.call(cmd="logout")["ok"])
            deadline = time.time() + 1
            while time.time() < deadline and len(os.listdir(tasks)) > baseline + 2:
                time.sleep(0.01)
            self.assertLessEqual(len(os.listdir(tasks)), baseline + 2)
        finally:
            stub.close()

    def test_abandoned_clipboard_probes_share_one_expiry_worker(self):
        stub = Stub("--fixture", "default")
        try:
            tasks = "/proc/%d/task" % stub.proc.pid
            baseline = len(os.listdir(tasks))
            for _ in range(40):
                self.assertTrue(stub.call(
                    cmd="probeClipboardImage", chat="ustub-notes")["ok"])
            deadline = time.time() + 1
            while time.time() < deadline and len(os.listdir(tasks)) > baseline + 2:
                time.sleep(0.01)
            self.assertLessEqual(len(os.listdir(tasks)), baseline + 2)
            self.assertTrue(stub.call(cmd="logout")["ok"])
        finally:
            stub.close()

    def test_abandoned_clipboard_stage_has_a_bounded_lease(self):
        scope = runpy.run_path(STUB, run_name="stub_expiry_test")
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "clipboard-abandoned.png")
            with open(path, "wb") as f:
                f.write(b"stage")
            scheduled = {}

            class FakeTimer:
                daemon = False

                def __init__(self, delay, cleanup):
                    scheduled["delay"] = delay
                    scheduled["cleanup"] = cleanup

                def start(self):
                    scheduled["started"] = True

            timer = scope["expire_clipboard_stage"](
                path, timer_factory=FakeTimer)
            self.assertAlmostEqual(10 * 60, scheduled["delay"], delta=0.1)
            self.assertTrue(scheduled["started"])
            self.assertTrue(timer.daemon)
            scheduled["cleanup"]()
            self.assertFalse(os.path.exists(path))
            scheduled["cleanup"]()

    def test_failed_expiry_worker_registration_removes_the_stage(self):
        scope = runpy.run_path(STUB, run_name="stub_expiry_start_failure_test")
        globals_ = scope["expire_clipboard_stage"].__globals__
        with tempfile.TemporaryDirectory() as directory:
            stage = "clipboard-registration-failure.png"
            path = os.path.join(directory, stage)
            with open(path, "wb") as f:
                f.write(b"stage")
            globals_["clipboard_stage_bindings"][stage] = {
                "generation": globals_["session_generation"],
                "chat": "ustub-notes", "claimed": False}

            class FailingTimer:
                daemon = False

                def __init__(self, _delay, _cleanup):
                    pass

                def start(self):
                    raise RuntimeError("cannot start expiry worker")

            with self.assertRaisesRegex(RuntimeError, "cannot start"):
                scope["expire_clipboard_stage"](
                    path, timer_factory=FailingTimer)
            self.assertFalse(os.path.exists(path))
            self.assertNotIn(stage, globals_["clipboard_stage_bindings"])
            self.assertNotIn(stage, globals_["clipboard_stage_timers"])
            self.assertIsNone(globals_["clipboard_expiry_timer"])

    def test_failed_expiry_worker_rollover_retires_every_stage(self):
        scope = runpy.run_path(STUB, run_name="stub_expiry_rollover_failure_test")
        globals_ = scope["expire_clipboard_stage"].__globals__
        clock = [100.0]
        timers = []
        starts = [0]

        class FailingSecondTimer:
            daemon = False

            def __init__(self, delay, cleanup):
                self.delay = delay
                self.cleanup = cleanup
                timers.append(self)

            def start(self):
                starts[0] += 1
                if starts[0] == 2:
                    raise RuntimeError("cannot roll expiry worker")

            def cancel(self):
                pass

        with tempfile.TemporaryDirectory() as directory:
            stages = ["clipboard-first.png", "clipboard-second.png"]
            paths = [os.path.join(directory, stage) for stage in stages]
            for path in paths:
                with open(path, "wb") as f:
                    f.write(b"stage")
            for stage in stages:
                globals_["clipboard_stage_bindings"][stage] = {
                    "generation": globals_["session_generation"],
                    "chat": "ustub-notes", "claimed": False}
            scope["expire_clipboard_stage"](
                paths[0], delay=10, timer_factory=FailingSecondTimer,
                now=lambda: clock[0])
            scope["expire_clipboard_stage"](
                paths[1], delay=20, timer_factory=FailingSecondTimer,
                now=lambda: clock[0])
            self.assertEqual(1, starts[0])
            clock[0] = 110.0
            timers[0].cleanup()
            self.assertEqual(2, starts[0])
            self.assertEqual([], os.listdir(directory))
            self.assertEqual({}, globals_["clipboard_stage_bindings"])
            self.assertEqual({}, globals_["clipboard_stage_timers"])
            self.assertIsNone(globals_["clipboard_expiry_timer"])

    def test_restart_and_consume_reject_expired_clipboard_stages(self):
        scope = runpy.run_path(STUB, run_name="stub_restart_expiry_test")
        handle = scope["handle"]
        globals_ = handle.__globals__
        with tempfile.TemporaryDirectory() as directory:
            globals_["MEDIA_DIR"] = directory
            globals_["messages"] = {"ustub-notes": []}
            globals_["state"] = {"login": {"status": "ok"}}
            now = time.time()

            recovered = "clipboard-%s.png" % uuid.uuid4()
            recovered_path = os.path.join(directory, recovered)
            with open(recovered_path, "wb") as f:
                f.write(b"expired")
            os.utime(recovered_path, (now - 601, now - 601))
            scope["recover_clipboard_stages"](directory, now=lambda: now)
            self.assertFalse(os.path.exists(recovered_path))

            fresh = "clipboard-%s.png" % uuid.uuid4()
            fresh_path = os.path.join(directory, fresh)
            with open(fresh_path, "wb") as f:
                f.write(b"fresh")
            os.utime(fresh_path, (now - 125, now - 125))
            scheduled = {}

            class FakeTimer:
                daemon = False

                def __init__(self, delay, cleanup):
                    scheduled["delay"] = delay
                    scheduled["cleanup"] = cleanup

                def start(self):
                    scheduled["started"] = True

            scope["recover_clipboard_stages"](
                directory, now=lambda: now, timer_factory=FakeTimer)
            self.assertAlmostEqual(475, scheduled["delay"], delta=0.1)
            self.assertTrue(scheduled["started"])
            scheduled["cleanup"]()
            self.assertFalse(os.path.exists(fresh_path))

            consumed = "clipboard-%s.png" % uuid.uuid4()
            consumed_path = os.path.join(directory, consumed)
            with open(consumed_path, "wb") as f:
                f.write(b"expired")
            os.utime(consumed_path, (now - 601, now - 601))
            globals_["clipboard_stage_bindings"] = {
                consumed: {"generation": globals_["session_generation"],
                           "chat": "ustub-notes", "claimed": False}}
            refused = handle({"cmd": "sendClipboardImage",
                              "chat": "ustub-notes", "stage": consumed})
            self.assertEqual({"ok": False, "error": "剪貼簿暫存已失效"}, refused)
            self.assertFalse(os.path.exists(consumed_path))

    def test_failed_clipboard_stage_creation_removes_partial_files(self):
        scope = runpy.run_path(STUB, run_name="stub_stage_write_failure_test")
        handle = scope["handle"]
        globals_ = handle.__globals__
        real_os = globals_["os"]

        class FailingReplaceOS:
            path = real_os.path

            def __getattr__(self, name):
                return getattr(real_os, name)

            @staticmethod
            def replace(_source, _target):
                raise OSError("rename failed")

        with tempfile.TemporaryDirectory() as directory:
            globals_["MEDIA_DIR"] = directory
            globals_["state"] = {"login": {"status": "ok"}}
            globals_["messages"] = {"ustub-notes": []}
            globals_["os"] = FailingReplaceOS()
            try:
                for request in (
                        {"cmd": "probeClipboardImage", "chat": "ustub-notes"},
                        {"cmd": "sendClipboardImage", "chat": "ustub-notes"}):
                    with self.assertRaisesRegex(OSError, "rename failed"):
                        handle(request)
                    self.assertEqual([], os.listdir(directory))
            finally:
                globals_["os"] = real_os

            abandoned = "clipboard-%s.png.tmp" % uuid.uuid4()
            with open(os.path.join(directory, abandoned), "wb") as f:
                f.write(b"partial")
            scope["recover_clipboard_stages"](directory)
            self.assertEqual([], os.listdir(directory))

    def test_failed_clipboard_claim_keeps_its_expiry_lease(self):
        scope = runpy.run_path(STUB, run_name="stub_stage_claim_failure_test")
        handle = scope["handle"]
        globals_ = handle.__globals__
        real_os = globals_["os"]
        with tempfile.TemporaryDirectory() as directory:
            globals_["MEDIA_DIR"] = directory
            globals_["state"] = {"login": {"status": "ok"}}
            globals_["messages"] = {"ustub-notes": []}
            probe = handle({"cmd": "probeClipboardImage", "chat": "ustub-notes"})
            stage = probe["data"]["stage"]
            path = os.path.join(directory, stage)

            class FailClaimOnceOS:
                path = real_os.path
                failed = False

                def __getattr__(self, name):
                    return getattr(real_os, name)

                def replace(self, source, target):
                    if source == path and not self.failed:
                        self.failed = True
                        raise PermissionError("claim denied")
                    return real_os.replace(source, target)

            globals_["os"] = FailClaimOnceOS()
            try:
                with self.assertRaisesRegex(PermissionError, "claim denied"):
                    handle({"cmd": "sendClipboardImage", "chat": "ustub-notes",
                            "stage": stage})
            finally:
                globals_["os"] = real_os
            self.assertFalse(globals_["clipboard_stage_bindings"][stage]["claimed"])
            self.assertIn(stage, globals_["clipboard_stage_timers"])
            self.assertTrue(os.path.exists(path))
            self.assertTrue(handle({"cmd": "discardClipboardImage", "stage": stage})["ok"])
            self.assertNotIn(stage, globals_["clipboard_stage_timers"])
            self.assertFalse(os.path.exists(path))

    def test_failed_legacy_clipboard_claim_removes_its_unleased_stage(self):
        scope = runpy.run_path(STUB, run_name="stub_legacy_claim_failure_test")
        handle = scope["handle"]
        globals_ = handle.__globals__
        real_os = globals_["os"]
        with tempfile.TemporaryDirectory() as directory:
            globals_["MEDIA_DIR"] = directory
            globals_["state"] = {"login": {"status": "ok"}}
            globals_["messages"] = {"ustub-notes": []}

            class FailSecondReplaceOS:
                path = real_os.path
                replacements = 0

                def __getattr__(self, name):
                    return getattr(real_os, name)

                def replace(self, source, target):
                    self.replacements += 1
                    if self.replacements == 2:
                        raise PermissionError("legacy claim denied")
                    return real_os.replace(source, target)

            globals_["os"] = FailSecondReplaceOS()
            try:
                with self.assertRaisesRegex(PermissionError, "legacy claim denied"):
                    handle({"cmd": "sendClipboardImage", "chat": "ustub-notes"})
            finally:
                globals_["os"] = real_os
            self.assertEqual([], os.listdir(directory))

    def images_dir(self):
        return os.path.join(self.s.state_dir, "media", "public-images")

    def assert_is_a_picture(self, path):
        self.assertTrue(os.path.exists(path), path)
        # Under media/public-images, like the daemon's IMAGE_DIR: that is the
        # directory the README's sweep policy names.
        self.assertEqual(self.images_dir(), os.path.dirname(path))
        with open(path, "rb") as f:
            self.assertEqual(b"\x89PNG\r\n\x1a\n", f.read(8), path)

    def test_image_answers_a_public_url_with_one_file_per_url(self):
        first = self.s.call(cmd="image", url=STUB_IMAGE_URL)
        self.assertTrue(first["ok"], first)
        self.assertEqual({"path"}, set(first["data"]))
        self.assert_is_a_picture(first["data"]["path"])
        # Asked twice is one file: the panel keeps the path and only asks
        # again after a sweep, and a second answer somewhere else would leave
        # a sticker grid rewriting itself.
        again = self.s.call(cmd="image", url=STUB_IMAGE_URL)
        self.assertEqual(first["data"]["path"], again["data"]["path"])
        # A fragment never reaches a server, so imagecache.ts drops it before
        # it keys on anything and the two collapse onto one file.
        fragment = self.s.call(cmd="image", url=STUB_IMAGE_URL + "#2")
        self.assertEqual(first["data"]["path"], fragment["data"]["path"])
        other = self.s.call(cmd="image", url=STUB_IMAGE_URL + "?2")
        self.assertTrue(other["ok"], other)
        self.assertNotEqual(first["data"]["path"], other["data"]["path"])
        self.assert_is_a_picture(other["data"]["path"])

    def test_image_invalidation_replaces_corrupt_cached_bytes(self):
        first = self.s.call(cmd="image", url=STUB_IMAGE_URL)
        self.assertTrue(first["ok"], first)
        path = first["data"]["path"]
        with open(path, "wb") as f:
            f.write(b"corrupt")
        refreshed = self.s.call(
            cmd="image", url=STUB_IMAGE_URL, invalidate=True)
        self.assertTrue(refreshed["ok"], refreshed)
        self.assertEqual(path, refreshed["data"]["path"])
        self.assert_is_a_picture(path)

    def test_image_refuses_everything_that_is_not_a_public_https_url(self):
        # imagecache.ts loses every reason behind one string, and the panel
        # prints it: http, a scheme with no host, credentials in the url and a
        # url nobody can parse all come back the same way.
        for url in ("http://placehold.co/240x160/png", "file:///etc/hostname",
                    "https://user:pw@placehold.co/240x160/png", "https://",
                    "https://[::1/x", "", "not a url"):
            res = self.s.call(cmd="image", url=url)
            self.assertEqual(False, res["ok"], url)
            self.assertEqual("圖片下載失敗", res["error"], url)
            self.assertNotIn("data", res)

    def test_image_serves_every_picture_the_fixture_puts_on_screen(self):
        # The whole point of the command in the stub: without it the sticker
        # grid, the picker, a FLEX preview and the lightbox are broken images
        # in the workflow the README documents for a machine with no session.
        urls = [st["url"]
                for pkg in self.s.call(cmd="stickers")["data"]["packages"]
                for st in pkg["stickers"]]
        for m in self.all_messages():
            urls.extend(m.get("flexImages", []))
            if m.get("stickerUrl"):
                urls.append(m["stickerUrl"])
        self.assertTrue(urls)
        for url in urls:
            res = self.s.call(cmd="image", url=url)
            self.assertTrue(res["ok"], url)
            self.assert_is_a_picture(res["data"]["path"])

    def test_media_state_is_one_of_three_and_agrees_with_unsent(self):
        for m in self.all_messages():
            self.assertIn(m["mediaState"], MEDIA_STATES, m["id"])
            self.assertEqual(m["unsent"], m["mediaState"] == "unsent", m["id"])
            # The daemon derives "expired" from expiresAt, so the stub must
            # not hand the panel one without the other.
            if m["mediaState"] == "expired":
                self.assertLess(m["expiresAt"], int(time.time() * 1000), m["id"])

    def test_fixture_has_a_recalled_and_an_expired_message(self):
        msgs = self.all_messages()
        unsent = [m for m in msgs if m["mediaState"] == "unsent"]
        expired = [m for m in msgs if m["mediaState"] == "expired"]
        self.assertTrue(unsent, "no recalled message in the fixture")
        self.assertTrue(expired, "no expired file in the fixture")
        for m in unsent:
            # The daemon drops hasMedia on a recall: the bytes are gone, and
            # the panel must not offer a download that cannot work.
            self.assertFalse(m["hasMedia"], m["id"])
            self.assertFalse(m["decryptFailed"], m["id"])
            self.assertEqual("已收回訊息", m["text"], m["id"])
        for m in expired:
            # An expired file still was a file; only the object is gone.
            self.assertTrue(m["hasMedia"], m["id"])
            self.assertFalse(m["unsent"], m["id"])

    def test_recalled_message_previews_as_the_marker(self):
        # The chat list line, not the bubble: previewText checks the recall
        # before the file name it left behind.
        chat = [c for c in self.s.state()["chats"] if c["mid"] == "cstub-family"][0]
        self.assertEqual("已收回訊息", chat["lastText"])

    def test_download_refuses_a_recall_and_an_expired_file(self):
        by_state = {}
        for m in self.all_messages():
            by_state.setdefault(m["mediaState"], m)
        for state, error in (("unsent", "訊息已收回"),
                             ("expired", "檔案已過期（LINE 只保留 7 天）")):
            m = by_state[state]
            res = self.s.call(cmd="download", chat=m["chat"], messageId=m["id"])
            self.assertFalse(res["ok"], res)
            self.assertEqual(error, res["error"])
            self.assertNotIn("data", res)

    def test_download_returns_a_path(self):
        img = next(m for m in self.all_messages() if m["contentType"] == "IMAGE")
        res = self.s.call(cmd="download", chat=img["chat"], messageId=img["id"])
        self.assertTrue(res["ok"], res)
        self.assertEqual({"path"}, set(res["data"]))
        self.assertTrue(os.path.exists(res["data"]["path"]))

    def test_preview_returns_the_visible_image_path(self):
        img = next(m for m in self.all_messages()
                   if m["contentType"] == "IMAGE")
        self.assertNotIn("mediaPath", img)
        res = self.s.call(cmd="preview", chat=img["chat"], messageId=img["id"])
        self.assertTrue(res["ok"], res)
        self.assertTrue(os.path.exists(res["data"]["path"]), res)
        vid = next(m for m in self.all_messages() if m["contentType"] == "VIDEO")
        res = self.s.call(cmd="download", chat=vid["chat"], messageId=vid["id"])
        self.assertTrue(res["ok"], res)
        self.assertTrue(os.path.exists(res["data"]["path"]))
        previewed = next(m for m in self.all_messages()
                         if m["contentType"] == "VIDEO"
                         and m.get("previewable") is True)
        preview = self.s.call(cmd="preview", chat=previewed["chat"],
                              messageId=previewed["id"])
        self.assertTrue(preview["ok"], preview)
        self.assertTrue(os.path.exists(preview["data"]["path"]))
        res = self.s.call(cmd="download", chat=previewed["chat"],
                          messageId=previewed["id"])
        self.assertTrue(res["ok"], res)
        self.assertNotEqual(preview["data"]["path"], res["data"]["path"])

        unavailable = next(m for m in self.all_messages()
                           if m["contentType"] == "VIDEO"
                           and m.get("previewable") is not True)
        refused = self.s.call(cmd="preview", chat=unavailable["chat"],
                              messageId=unavailable["id"])
        self.assertFalse(refused["ok"], refused)
        self.assertEqual("縮圖不可用", refused["error"])

    def test_preview_refuses_recalled_and_expired_media_before_cache_use(self):
        by_state = {}
        for m in self.all_messages():
            by_state.setdefault(m["mediaState"], m)
        for state in ("unsent", "expired"):
            m = by_state[state]
            res = self.s.call(cmd="preview", chat=m["chat"], messageId=m["id"])
            self.assertFalse(res["ok"], res)
            self.assertEqual("縮圖不可用", res["error"])

    def test_preview_invalidate_replaces_a_corrupt_cached_file(self):
        img = next(m for m in self.all_messages()
                   if m["contentType"] == "IMAGE")
        first = self.s.call(cmd="preview", chat=img["chat"], messageId=img["id"])
        self.assertTrue(first["ok"], first)
        path = first["data"]["path"]
        with open(path, "wb") as f:
            f.write(b"broken")
        res = self.s.call(cmd="preview", chat=img["chat"],
                          messageId=img["id"], invalidate=True)
        self.assertTrue(res["ok"], res)
        self.assertEqual(path, res["data"]["path"])
        with open(path, "rb") as f:
            self.assertEqual(b"\x89PNG\r\n\x1a\n", f.read(8))

    def test_download_without_a_chat_fails_like_line_does(self):
        # Production resolves the cached message first, then rejects the
        # mismatched chat before making a LINE request.
        img = next(m for m in self.all_messages() if m["contentType"] == "IMAGE")
        for req in (dict(cmd="download", messageId=img["id"]),
                    dict(cmd="download", chat="", messageId=img["id"])):
            res = self.s.call(**req)
            self.assertEqual(False, res["ok"], req)
            self.assertEqual("訊息不在這個聊天室", res["error"])
            self.assertNotIn("data", res)

    def test_download_is_scoped_to_the_requested_chat(self):
        img = next(m for m in self.all_messages() if m["contentType"] == "IMAGE")
        other = next(c["mid"] for c in self.s.state()["chats"]
                     if c["mid"] != img["chat"])
        res = self.s.call(cmd="download", chat=other, messageId=img["id"])
        self.assertFalse(res["ok"], res)
        self.assertEqual("訊息不在這個聊天室", res["error"])

    def test_preview_and_download_validate_message_before_chat(self):
        img = next(m for m in self.all_messages() if m["contentType"] == "IMAGE")
        other = next(c["mid"] for c in self.s.state()["chats"]
                     if c["mid"] != img["chat"])
        for cmd in ("preview", "download"):
            missing = self.s.call(cmd=cmd, chat="nope", messageId="missing")
            self.assertEqual("訊息不在快取裡", missing["error"])
            wrong = self.s.call(cmd=cmd, chat=other, messageId=img["id"])
            self.assertEqual("訊息不在這個聊天室", wrong["error"])

    def test_errors_are_ok_false_with_a_string(self):
        for req in (dict(cmd="wat"), dict(cmd="history", chat="nope"),
                    dict(cmd="download", chat="x", messageId="nope")):
            res = self.s.call(**req)
            self.assertEqual(False, res["ok"], req)
            self.assertIsInstance(res["error"], str)
            self.assertNotIn("data", res)

    def test_sync_answers_the_chat_count_and_the_link(self):
        before = int(time.time() * 1000)
        res = self.s.call(cmd="sync")
        self.assertTrue(res["ok"], res)
        data = res["data"]
        self.assertEqual(len(self.s.state()["chats"]), data["chats"])
        self.assertTrue(is_int(data["chats"]))
        self.assertEqual("up", data["link"])
        self.assertTrue(is_int(data["at"]))
        # The panel prints this as 已同步 HH:MM, so it has to be a real clock.
        self.assertGreaterEqual(data["at"], before)
        self.assertLessEqual(data["at"], int(time.time() * 1000))
        self.assertEqual({"chats", "link", "at"}, set(data))

    def test_reply_echoes_request_id(self):
        self.assertEqual(4242, self.s.call(cmd="wat", id=4242)["id"])


class FixtureTest(unittest.TestCase):
    def test_empty_fixture_serves_an_empty_list(self):
        s = Stub("--fixture", "empty")
        try:
            self.assertEqual([], s.state()["chats"])
            # `refresh` is stamped on every logged-in write (U73); the other
            # optional keys still only appear once something arms them.
            self.assertEqual(STATE_KEYS | {"refresh", "chatList"}, set(s.state()))
        finally:
            s.close()

    def test_sync_counts_the_chats_that_are_actually_there(self):
        # Pins the count to the list rather than to a constant: an empty
        # account has to answer 0, not the default fixture's number.
        s = Stub("--fixture", "empty")
        try:
            self.assertEqual(0, s.call(cmd="sync")["data"]["chats"])
        finally:
            s.close()

    def test_busy_fixture_has_200_chats_with_history(self):
        s = Stub("--fixture", "busy")
        try:
            chats = s.state()["chats"]
            self.assertEqual(200, len(chats))
            self.assertTrue(s.call(cmd="history", chat=chats[-1]["mid"])["data"])
        finally:
            s.close()

    def test_logged_out_refuses_commands_but_allows_login(self):
        s = Stub("--logged-out")
        try:
            self.assertEqual("idle", s.state()["login"]["status"])
            # The daemon has no identity before a session exists.
            self.assertEqual({}, s.state()["me"])
            res = s.call(cmd="history", chat="cstub-family")
            self.assertEqual({"ok": False, "error": "尚未登入", "id": res["id"]}, res)
            # syncNow() in daemon.ts refuses with the very same string; the
            # panel shows it raw, so a divergence here would be visible.
            res = s.call(cmd="sync")
            self.assertEqual({"ok": False, "error": "尚未登入", "id": res["id"]}, res)
            self.assertTrue(s.call(cmd="login")["ok"])
            self.assertEqual("qr", s.state()["login"]["status"])
            self.assertTrue(os.path.exists(s.state()["login"]["qrPng"]))
            # Logging out mid-QR is the one refusal the daemon makes here.
            self.assertFalse(s.call(cmd="logout")["ok"])
        finally:
            s.close()

    def test_a_second_login_under_the_qr_is_refused(self):
        s = Stub("--logged-out")
        try:
            self.assertTrue(s.call(cmd="login")["ok"])
            first = s.state()["login"]["qrPng"]
            # The daemon answers a login that arrives under a live QR with
            # this refusal instead of starting the flow over. The stub said
            # {ok:true} and restarted it, which minted a second QR file right
            # behind the first one.
            res = s.call(cmd="login")
            self.assertEqual(
                {"ok": False, "error": "登入中，請稍候", "id": res["id"]}, res)
            # And the QR the panel is already showing is left alone.
            self.assertEqual("qr", s.state()["login"]["status"])
            self.assertEqual(first, s.state()["login"]["qrPng"])
            self.assertTrue(os.path.exists(first))
        finally:
            s.close()

    def test_the_in_flight_login_status_reaches_state_json(self):
        s = Stub("--logged-out")
        try:
            seen, stop = [], threading.Event()

            def watch():
                while not stop.is_set():
                    try:
                        st = s.state()["login"]["status"]
                    except (OSError, ValueError, KeyError):
                        continue
                    if not seen or seen[-1] != st:
                        seen.append(st)

            w = threading.Thread(target=watch, daemon=True)
            w.start()
            try:
                self.assertTrue(s.call(cmd="login")["ok"])
            finally:
                stop.set()
                w.join(timeout=5)
            # The panel takes canLogin from this file, not from the stub's
            # memory, so the gate has to be in the file while the QR is being
            # drawn. Claimed in memory only, the file steps idle -> qr and the
            # login button stays live for the whole of start_login(), reading
            # 尚未登入 where the daemon reads 啟動中.
            self.assertIn("starting", seen)
            self.assertEqual("qr", s.state()["login"]["status"])
        finally:
            s.close()

    def test_a_claim_that_cannot_be_written_is_not_left_standing(self):
        s = Stub("--logged-out")
        try:
            # set_login() changes the status before it writes the file, so a
            # write that fails in there still leaves the claim standing in
            # memory -- and the claim is above the try that covers
            # start_login(), so nothing was taking it back. A gate nobody
            # releases refuses every later login for the life of the process.
            # A directory where the temp file goes is the failure: write_state
            # cannot open it. The other writer is the heartbeat, and its first
            # tick is 30s after startup, so this window is not racing it.
            blocked = os.path.join(s.state_dir, "state.json.tmp")
            os.mkdir(blocked)
            res = s.call(cmd="login")
            self.assertFalse(res["ok"])
            self.assertIn("stub error", res["error"])
            os.rmdir(blocked)
            # The refusal this must NOT be is 登入中，請稍候.
            self.assertTrue(s.call(cmd="login")["ok"])
            self.assertEqual("qr", s.state()["login"]["status"])
        finally:
            s.close()

    def test_only_one_of_many_simultaneous_logins_starts_the_flow(self):
        s = Stub("--logged-out")
        try:
            # What the sequential test above cannot reach: its second login
            # arrives once the first has already got to "qr", so it never
            # sees the "starting" window -- the ~10ms while the winner is
            # still drawing the PNG and no QR exists yet. Eight clients let
            # go at once put seven of them inside it, which is what pins
            # "starting" into the refusal set: take it out and this fails
            # every run, while the sequential test never notices.
            #
            # It does not pin the claim being atomic, and should not be read
            # as doing so. Splitting the read from the assignment leaves a
            # window of a couple of microseconds and CPython only switches
            # threads every 5ms, so a check-then-set gate passes this test
            # every time -- measured against one, not assumed. What holds
            # that is the single lock block in handle(), and the comment
            # there says why it has to stay one block.
            n, out = 8, [None] * 8
            ready = threading.Barrier(n)
            path = os.path.join(s.state_dir, "sock")

            def go(i):
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.connect(path)
                rf = sock.makefile("rwb")
                try:
                    ready.wait(timeout=10)
                    rf.write(b'{"cmd":"login","id":1}\n')
                    rf.flush()
                    out[i] = json.loads(rf.readline().decode())
                finally:
                    rf.close()
                    sock.close()

            threads = [threading.Thread(target=go, args=(i,))
                       for i in range(n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=15)
            started = {"ok": True, "id": 1}
            refused = {"ok": False, "error": "登入中，請稍候", "id": 1}
            self.assertEqual(1, out.count(started))
            self.assertEqual([refused] * (n - 1),
                             [r for r in out if r != started])
            self.assertEqual("qr", s.state()["login"]["status"])
        finally:
            s.close()

    def test_logout_clears_me_and_the_chat_list(self):
        s = Stub("--fixture", "default")
        try:
            self.assertTrue(s.state()["me"])
            self.assertTrue(s.call(cmd="logout")["ok"])
            self.assertEqual("idle", s.state()["login"]["status"])
            self.assertEqual([], s.state()["chats"])
            # logout() in daemon.ts clears me and chats together.
            self.assertEqual({}, s.state()["me"])
            self.assertEqual(STATE_KEYS, set(s.state()))
        finally:
            s.close()


class HiddenTest(unittest.TestCase):
    """`hide` / `unhide`: the chat rows the user has taken off the list.

    A preference this machine keeps -- LINE has no attribute for it -- so the
    stub answers it with no session at all, exactly like the daemon.
    """

    def setUp(self):
        self.s = Stub("--fixture", "default")
        self.addCleanup(self.s.close)

    def rows(self):
        return {c["mid"]: c for c in self.s.state()["chats"]}

    def test_only_the_hidden_row_carries_the_flag(self):
        before = self.rows()
        self.assertNotIn("hidden", before["cstub-family"])
        res = self.s.call(cmd="hide", chat="cstub-family")
        self.assertEqual({"ok": True, "id": res["id"]}, res)
        after = self.rows()
        self.assertIs(True, after["cstub-family"]["hidden"])
        # The chat stays in the list: the panel needs it there to find it
        # again when the search box has something in it.
        self.assertEqual(set(before), set(after))
        for mid, c in after.items():
            if mid != "cstub-family":
                self.assertNotIn("hidden", c, mid)

    def test_unhide_takes_the_key_away_rather_than_setting_it_false(self):
        self.s.call(cmd="hide", chat="cstub-family")
        res = self.s.call(cmd="unhide", chat="cstub-family")
        self.assertTrue(res["ok"], res)
        self.assertNotIn("hidden", self.rows()["cstub-family"])

    def test_repeating_either_one_changes_nothing(self):
        for _ in range(2):
            self.assertTrue(self.s.call(cmd="hide", chat="ustub-alice")["ok"])
        self.assertIs(True, self.rows()["ustub-alice"]["hidden"])
        for _ in range(2):
            self.assertTrue(self.s.call(cmd="unhide", chat="ustub-alice")["ok"])
        self.assertNotIn("hidden", self.rows()["ustub-alice"])
        # Unhiding one that was never hidden is a no-op, not an error: the
        # panel offers whichever of the two the row is not already in, and a
        # stale state.json would otherwise turn one click into a red banner.
        self.assertTrue(self.s.call(cmd="unhide", chat="rstub-lunch")["ok"])

    def test_an_empty_mid_is_refused_with_the_daemon_s_words(self):
        for cmd in ("hide", "unhide"):
            for req in ({}, {"chat": ""}):
                res = self.s.call(cmd=cmd, **req)
                self.assertEqual(
                    {"ok": False, "error": "沒有指定是哪一間聊天室",
                     "id": res["id"]}, res)

    def test_a_mid_that_is_not_a_string_is_read_the_daemon_s_way(self):
        # daemon.ts reads it as String(req.chat ?? ""): only null (or nothing
        # at all) means "not given" -- every other value is a mid, spelled out
        # as a string. The stub kept it raw, so a number went into `hidden` as
        # a key none of the rows' string mids can ever equal, and 0 came back
        # refused where the daemon accepts "0".
        for cmd in ("hide", "unhide"):
            for chat in (123, 0):
                self.assertTrue(self.s.call(cmd=cmd, chat=chat)["ok"], (cmd, chat))
        res = self.s.call(cmd="hide", chat=None)
        self.assertEqual(
            {"ok": False, "error": "沒有指定是哪一間聊天室", "id": res["id"]}, res)

    def test_a_message_never_un_hides_a_chat(self):
        self.s.call(cmd="hide", chat="cstub-family")
        # `send` is the one way a fixture chat gets a new last message, and
        # Frank's ruling is that even one the user just sent leaves the row
        # hidden: it comes back by hand or not at all.
        self.assertTrue(
            self.s.call(cmd="send", chat="cstub-family", text="嗨")["ok"])
        self.assertIs(True, self.rows()["cstub-family"]["hidden"])

    def test_hiding_works_with_no_session(self):
        s = Stub("--logged-out")
        try:
            # Before the 尚未登入 gate in both daemons: it writes a file of
            # ours and never reaches LINE, so a session that is still coming
            # up is no reason to refuse it.
            self.assertTrue(s.call(cmd="hide", chat="cstub-family")["ok"])
            self.assertTrue(s.call(cmd="unhide", chat="cstub-family")["ok"])
        finally:
            s.close()


class AvatarTest(unittest.TestCase):
    """avatarPath / fromAvatar: the picture fields the panel draws rows from."""

    @classmethod
    def setUpClass(cls):
        cls.s = Stub("--fixture", "default")

    @classmethod
    def tearDownClass(cls):
        cls.s.close()

    def avatars_dir(self):
        return os.path.join(self.s.state_dir, "media", "avatars")

    def assert_is_a_picture(self, path):
        self.assertTrue(os.path.exists(path), path)
        # Under media/avatars, like the daemon's: the sweep that caps pictures
        # at 20 MB is the one that looks at exactly this directory.
        self.assertEqual(self.avatars_dir(), os.path.dirname(path))
        with open(path, "rb") as f:
            self.assertEqual(b"\x89PNG\r\n\x1a\n", f.read(8), path)

    def test_a_chat_picture_is_a_file_and_missing_ones_are_absent(self):
        chats = self.s.state()["chats"]
        withpic = [c for c in chats if "avatarPath" in c]
        self.assertTrue(withpic)
        for c in withpic:
            self.assert_is_a_picture(c["avatarPath"])
        # The fallback the panel has to draw as well: absent, not "".
        self.assertTrue([c for c in chats if "avatarPath" not in c])

    def test_a_message_carries_the_sender_picture(self):
        seen_with = seen_without = False
        for c in self.s.state()["chats"]:
            res = self.s.call(cmd="history", chat=c["mid"], count=100)
            self.assertTrue(res["ok"], res)
            for m in res["data"]:
                if "fromAvatar" in m:
                    self.assert_is_a_picture(m["fromAvatar"])
                    seen_with = True
                else:
                    seen_without = True
        self.assertTrue(seen_with)
        self.assertTrue(seen_without)

    def test_a_1_to_1_chat_and_its_sender_share_one_picture(self):
        # A 1:1 box is keyed by the peer's mid, so the row's picture and the
        # bubble's are the same person -- and the same file, or the panel is
        # holding two decodes of one image.
        chat = next(c for c in self.s.state()["chats"]
                    if c["mid"] == "ustub-alice")
        res = self.s.call(cmd="history", chat="ustub-alice", count=100)
        theirs = [m for m in res["data"] if m["from"] == "ustub-alice"]
        self.assertTrue(theirs)
        for m in theirs:
            self.assertEqual(chat["avatarPath"], m["fromAvatar"], m["id"])


class WantedTest(unittest.TestCase):
    """state.wanted: the hand-off a clicked notification leaves behind."""

    def test_poke_arms_a_hand_off_and_never_repeats_a_seq(self):
        s = Stub("--fixture", "default")
        try:
            self.assertNotIn("wanted", s.state())
            res = s.call(cmd="poke", chat="cstub-work")
            self.assertTrue(res["ok"], res)
            armed = s.state()["wanted"]
            self.assertEqual(armed, res["data"])
            self.assertEqual(set(WANTED_TYPES), set(armed))
            for k, t in WANTED_TYPES.items():
                self.assertTrue(is_int(armed[k]) if t is int
                                else isinstance(armed[k], t), k)
            self.assertEqual("cstub-work", armed["chat"])
            self.assertEqual(1, armed["seq"])
            # Clicking the same chat again is a new hand-off: the panel tells
            # them apart by seq, so a repeat would be ignored as already done.
            self.assertTrue(s.call(cmd="poke", chat="cstub-work")["ok"])
            self.assertEqual(2, s.state()["wanted"]["seq"])
            self.assertTrue(s.call(cmd="poke", chat="ustub-alice")["ok"])
            self.assertEqual(
                {"chat": "ustub-alice", "seq": 3},
                {k: s.state()["wanted"][k] for k in ("chat", "seq")})
        finally:
            s.close()

    def test_poke_refuses_a_chat_that_is_not_there(self):
        s = Stub("--fixture", "default")
        try:
            res = s.call(cmd="poke", chat="cstub-nope")
            self.assertFalse(res["ok"], res)
            self.assertIn("沒有這個聊天室", res["error"])
            self.assertNotIn("wanted", s.state())
        finally:
            s.close()

    def test_the_notify_fixture_starts_with_one_armed(self):
        s = Stub("--fixture", "notify")
        try:
            armed = s.state()["wanted"]
            self.assertEqual(set(WANTED_TYPES), set(armed))
            mids = [c["mid"] for c in s.state()["chats"]]
            self.assertIn(armed["chat"], mids)
            # A hand-off is only worth honouring if the conversation behind it
            # can actually be opened.
            self.assertTrue(s.call(cmd="history", chat=armed["chat"],
                                   count=10)["ok"])
        finally:
            s.close()

    def test_logging_out_drops_the_hand_off(self):
        s = Stub("--fixture", "notify")
        try:
            self.assertIn("wanted", s.state())
            self.assertTrue(s.call(cmd="logout")["ok"])
            self.assertNotIn("wanted", s.state())
        finally:
            s.close()


class RefreshHealthTest(unittest.TestCase):
    """state.refresh: the chat list's freshness stamp (README 契約)."""

    def test_a_logged_in_state_carries_a_fresh_stamp(self):
        s = Stub("--fixture", "default")
        try:
            r = s.state()["refresh"]
            # Success shape exactly: no `reason` key to explain away.
            self.assertEqual(set(REFRESH_TYPES), set(r))
            self.assertTrue(is_int(r["at"]) and r["at"] > 0)
            self.assertEqual(0, r["failures"])
        finally:
            s.close()

    def test_fail_refresh_counts_up_and_keeps_the_last_success_time(self):
        s = Stub("--fixture", "default")
        try:
            at = s.state()["refresh"]["at"]
            res = s.call(cmd="fail-refresh")
            self.assertTrue(res["ok"], res)
            r = s.state()["refresh"]
            self.assertEqual({"at": at, "failures": 1, "reason": "network"}, r)
            self.assertEqual(res["data"], r)
            # The panel speaks up at two consecutive failures, so the demo
            # path is two calls -- and `at` must sit still through the streak:
            # it is "the last time the list was really fresh".
            self.assertTrue(s.call(cmd="fail-refresh")["ok"])
            r = s.state()["refresh"]
            self.assertEqual(2, r["failures"])
            self.assertEqual(at, r["at"])
            # The pretend outage must not read as a dead daemon.
            self.assertTrue(is_int(s.state()["updatedAt"]))
        finally:
            s.close()

    def test_the_next_successful_write_clears_the_streak(self):
        s = Stub("--fixture", "default")
        try:
            self.assertTrue(s.call(cmd="fail-refresh")["ok"])
            self.assertTrue(s.call(cmd="fail-refresh")["ok"])
            # Any ordinary command that writes state stands for a round that
            # succeeded; poke is the cheapest one that always writes.
            self.assertTrue(s.call(cmd="poke", chat="cstub-work")["ok"])
            r = s.state()["refresh"]
            self.assertEqual(0, r["failures"])
            self.assertNotIn("reason", r)
            self.assertTrue(r["at"] > 0)
        finally:
            s.close()

    def test_logged_out_has_no_refresh_and_refuses_the_lever(self):
        s = Stub("--logged-out")
        try:
            self.assertNotIn("refresh", s.state())
            # Behind the same gate as the rest: no session, no refresh rounds.
            res = s.call(cmd="fail-refresh")
            self.assertFalse(res["ok"], res)
            self.assertEqual("尚未登入", res["error"])
        finally:
            s.close()

    def test_logout_takes_the_field_away(self):
        s = Stub("--fixture", "default")
        try:
            self.assertIn("refresh", s.state())
            self.assertTrue(s.call(cmd="logout")["ok"])
            self.assertNotIn("refresh", s.state())
        finally:
            s.close()


def load_stub_module():
    """Import stub.py so preview_text() can be called directly.

    XDG_STATE_HOME is forced to a throwaway dir first: importing must never
    let the module resolve its paths to the live ~/.local/state/enil.
    """
    import importlib.util
    os.environ["XDG_STATE_HOME"] = tempfile.mkdtemp(prefix="enil-stub-import-")
    # Otherwise the import drops a daemon/__pycache__ into the work tree.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("enil_stub", STUB)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class EventTest(unittest.TestCase):
    """The events ring and the three commands that feed it.

    A fresh stub per test: unsend and react change the fixture for good, and a
    test that only passes when it runs before another one is not a test.
    """

    def setUp(self):
        self.s = Stub("--fixture", "default")

    def tearDown(self):
        self.s.close()

    def events(self):
        return self.s.state()["events"]

    def message(self, chat, index=-1):
        res = self.s.call(cmd="history", chat=chat, count=100)
        self.assertTrue(res["ok"], res)
        return res["data"][index]

    def test_events_start_empty_and_are_numbered_from_one(self):
        self.assertEqual([], self.events())
        self.assertTrue(self.s.state()["bootId"])
        self.assertIsInstance(self.s.state()["bootId"], str)
        self.assertTrue(self.s.call(cmd="send", chat="ustub-notes", text="a")["ok"])
        self.assertTrue(self.s.call(cmd="send", chat="ustub-notes", text="b")["ok"])
        evs = self.events()
        self.assertEqual([1, 2], [e["seq"] for e in evs])
        for e in evs:
            self.assertEqual(EVENT_KINDS[0], e["kind"])
            self.assertEqual("ustub-notes", e["chat"])
            self.assertTrue(is_int(e["at"]))
            # The payload is what history would have returned, whole.
            for k in MSG_REQUIRED:
                self.assertIn(k, e["message"], k)

    def test_reply_quotes_its_target_and_lands_as_an_event(self):
        target = self.message("ustub-alice", 0)
        res = self.s.call(cmd="reply", chat="ustub-alice", text="好",
                          replyTo=target["id"])
        self.assertTrue(res["ok"], res)
        sent = self.message("ustub-alice")
        self.assertEqual(target["id"], sent["replyTo"]["id"])
        self.assertEqual(target["fromName"], sent["replyTo"]["fromName"])
        self.assertEqual(target["text"], sent["replyTo"]["text"])
        self.assertEqual(sent, self.events()[-1]["message"])

    def test_reply_without_a_target_is_refused(self):
        # It would otherwise send as a plain message and silently lose the
        # quote the user picked -- the daemon refuses for the same reason.
        res = self.s.call(cmd="reply", chat="ustub-alice", text="好")
        self.assertFalse(res["ok"])
        self.assertEqual("沒有指定要回覆哪一則訊息", res["error"])
        self.assertEqual([], self.events())

    def test_reply_to_an_unknown_id_keeps_the_id_alone(self):
        res = self.s.call(cmd="reply", chat="ustub-alice", text="好",
                          replyTo="ustub-alice-m999")
        self.assertTrue(res["ok"], res)
        self.assertEqual({"id": "ustub-alice-m999"},
                         self.message("ustub-alice")["replyTo"])

    def test_react_builds_a_bar_and_undo_takes_it_away(self):
        target = self.message("ustub-notes", 0)
        self.assertNotIn("reactions", target)
        self.assertTrue(self.s.call(cmd="react", chat="ustub-notes",
                                    messageId=target["id"], type="LOVE")["ok"])
        rows = [{"type": "LOVE", "count": 1, "mine": True}]
        self.assertEqual(rows, self.message("ustub-notes", 0)["reactions"])
        ev = self.events()[-1]
        self.assertEqual("reaction", ev["kind"])
        self.assertEqual(target["id"], ev["messageId"])
        # The event carries the whole new bar, not the one person's delta.
        self.assertEqual(rows, ev["reactions"])
        self.assertTrue(self.s.call(cmd="react", chat="ustub-notes",
                                    messageId=target["id"], type="UNDO")["ok"])
        self.assertNotIn("reactions", self.message("ustub-notes", 0))
        self.assertEqual([], self.events()[-1]["reactions"])

    def test_react_replaces_rather_than_stacks(self):
        target = self.message("ustub-notes", 0)
        for t in ("NICE", "OMG"):
            self.assertTrue(self.s.call(cmd="react", chat="ustub-notes",
                                        messageId=target["id"], type=t)["ok"])
        # One person holds one reaction; the first must not be left behind.
        self.assertEqual([{"type": "OMG", "count": 1, "mine": True}],
                         self.message("ustub-notes", 0)["reactions"])

    def test_react_refuses_what_line_has_no_enum_for(self):
        target = self.message("ustub-notes", 0)
        for bad in ("THUMBSUP", "ALL", ""):
            res = self.s.call(cmd="react", chat="ustub-notes",
                              messageId=target["id"], type=bad)
            self.assertFalse(res["ok"], bad)
            self.assertEqual("不支援的表情", res["error"])
        res = self.s.call(cmd="react", chat="ustub-notes",
                          messageId="ustub-notes-m999", type="NICE")
        self.assertFalse(res["ok"])
        self.assertEqual("訊息不在快取裡", res["error"])
        self.assertEqual([], self.events())

    def test_unsend_takes_only_our_own(self):
        theirs = self.message("cstub-family", 0)
        res = self.s.call(cmd="unsend", chat="cstub-family",
                          messageId=theirs["id"])
        self.assertFalse(res["ok"])
        self.assertEqual("只能收回自己傳的訊息", res["error"])
        self.assertEqual([], self.events())

    def test_unsend_strips_the_bubble_and_says_so(self):
        mine = self.message("ustub-notes", 0)
        self.assertTrue(self.s.call(cmd="unsend", chat="ustub-notes",
                                    messageId=mine["id"])["ok"])
        gone = self.message("ustub-notes", 0)
        self.assertTrue(gone["unsent"])
        self.assertEqual("unsent", gone["mediaState"])
        self.assertFalse(gone["hasMedia"])
        self.assertEqual("已收回訊息", gone["text"])
        for k in ("reactions", "readBy", "mediaPath"):
            self.assertNotIn(k, gone)
        # The chat-list preview follows the bubble.
        chat = [c for c in self.s.state()["chats"]
                if c["mid"] == "ustub-notes"][0]
        self.assertEqual("已收回訊息", chat["lastText"])
        ev = self.events()[-1]
        self.assertEqual("unsend", ev["kind"])
        self.assertEqual(mine["id"], ev["messageId"])
        self.assertEqual("ustub-notes", ev["chat"])
        # Nothing to download and nothing to quote once it is gone.
        self.assertEqual("訊息已收回",
                         self.s.call(cmd="download", chat="ustub-notes",
                                     messageId=mine["id"])["error"])

    def test_a_read_receipt_follows_a_send(self):
        self.assertTrue(self.s.call(cmd="send", chat="ustub-alice",
                                    text="在嗎")["ok"])
        sent = self.message("ustub-alice")
        self.assertNotIn("readBy", sent)
        # The stub plays the peer a couple of seconds later; the panel has no
        # other way to see 已讀 appear on a message it just sent.
        for _ in range(80):
            read = [e for e in self.events() if e["kind"] == "read"]
            if read:
                break
            time.sleep(0.05)
        else:
            self.fail("no read event within 4s")
        self.assertEqual("ustub-alice", read[-1]["chat"])
        self.assertEqual(sent["id"], read[-1]["upTo"])
        self.assertTrue(read[-1]["by"])
        self.assertEqual({"count": 1, "all": True},
                         self.message("ustub-alice")["readBy"])

    def test_logged_out_refuses_the_other_commands(self):
        s = Stub("--logged-out")
        try:
            for req in ({"cmd": "reply", "chat": "c", "text": "x",
                         "replyTo": "1"},
                        {"cmd": "react", "chat": "c", "messageId": "1",
                         "type": "NICE"},
                        {"cmd": "unsend", "chat": "c", "messageId": "1"},
                        {"cmd": "stickers"},
                        {"cmd": "sendSticker", "chat": "c", "packageId": "1",
                         "stickerId": "4"},
                        {"cmd": "poke", "chat": "c"},
                        {"cmd": "image", "url": STUB_IMAGE_URL}):
                res = s.call(**req)
                self.assertFalse(res["ok"], req)
                self.assertEqual("尚未登入", res["error"])
        finally:
            s.close()


class StickerTest(unittest.TestCase):
    """`stickers` and `sendSticker`, against README 契約 and daemon.ts."""

    CDN = "https://stickershop.line-scdn.net/stickershop/v1/sticker"

    def setUp(self):
        self.s = Stub("--fixture", "default")

    def tearDown(self):
        self.s.close()

    def packages(self, **extra):
        res = self.s.call(cmd="stickers", **extra)
        self.assertTrue(res["ok"], res)
        return res["data"]["packages"]

    def test_the_reply_has_the_shape_the_panel_reads(self):
        pkgs = self.packages()
        self.assertTrue(pkgs)
        for p in pkgs:
            self.assertEqual(PACKAGE_TYPES, {k: type(p[k]) for k in p})
            self.assertTrue(p["stickers"])
            for t in p["stickers"]:
                self.assertEqual(STICKER_TYPES, {k: type(t[k]) for k in t})
                self.assertTrue(t["url"].startswith(self.CDN + "/"))

    def test_refresh_is_accepted_and_answers_the_same_list(self):
        # The daemon refetches here; what the panel needs from the stub is
        # that the flag is not an unknown-argument failure.
        self.assertEqual(self.packages(), self.packages(refresh=True))

    def test_an_animated_package_points_at_the_other_file(self):
        for p in self.packages():
            for t in p["stickers"]:
                tail = "sticker_animation.png" if t["animated"] else "sticker.png"
                self.assertEqual("%s/%s/android/%s" % (self.CDN, t["id"], tail),
                                 t["url"])
        # Both kinds are in the fixture: one of them alone hides the switch.
        flags = {t["animated"] for p in self.packages() for t in p["stickers"]}
        self.assertEqual({True, False}, flags)

    def test_a_sent_sticker_is_a_message_event_with_a_url(self):
        pkg = self.packages()[0]
        tid = pkg["stickers"][0]["id"]
        res = self.s.call(cmd="sendSticker", chat="ustub-notes",
                          packageId=pkg["id"], stickerId=tid)
        self.assertTrue(res["ok"], res)
        ev = self.s.state()["events"][-1]
        self.assertEqual("message", ev["kind"])
        self.assertEqual("ustub-notes", ev["chat"])
        sent = ev["message"]
        self.assertEqual("STICKER", sent["contentType"])
        self.assertEqual("", sent["text"])
        self.assertEqual(pkg["stickers"][0]["url"], sent["stickerUrl"])
        for k in MSG_REQUIRED:
            self.assertIn(k, sent, k)
        # And it is the newest message in that chat, like any other send.
        history = self.s.call(cmd="history", chat="ustub-notes", count=100)
        self.assertEqual(sent, history["data"][-1])
        # The chat list preview is the label, not an empty line.
        row = next(c for c in self.s.state()["chats"]
                   if c["mid"] == "ustub-notes")
        self.assertEqual("[貼圖]", row["lastText"])

    def test_malformed_ids_are_refused_before_anything_is_sent(self):
        before = len(self.s.state()["events"])
        for bad in ({"packageId": "", "stickerId": "4"},
                    {"packageId": "1", "stickerId": "0"},
                    {"packageId": "01", "stickerId": "4"},
                    {"packageId": "1", "stickerId": "1.5"},
                    {"packageId": "abc", "stickerId": "4"}):
            res = self.s.call(cmd="sendSticker", chat="ustub-notes", **bad)
            self.assertFalse(res["ok"], bad)
            self.assertEqual("貼圖編號不對", res["error"])
        self.assertEqual(before, len(self.s.state()["events"]))

    def test_a_package_the_account_does_not_own_is_refused(self):
        res = self.s.call(cmd="sendSticker", chat="ustub-notes",
                          packageId="999999", stickerId="4")
        self.assertFalse(res["ok"])
        self.assertEqual("這個貼圖包不在你的貼圖清單裡", res["error"])

    def test_a_sticker_id_the_package_does_not_list_still_sends(self):
        # The daemon does not check it either: a package whose product JSON
        # could not be read has an empty `stickers`, and refusing every send
        # into it would charge the daemon's failure to the user.
        pkg = self.packages()[0]
        res = self.s.call(cmd="sendSticker", chat="ustub-notes",
                          packageId=pkg["id"], stickerId="88888")
        self.assertTrue(res["ok"], res)

    def test_an_unlisted_id_still_follows_the_package_it_was_sent_from(self):
        # daemon.ts parseProductInfo(): hasAnimation is read once for the whole
        # package, so "animated" is the package's property. An id that is not
        # in the list must not fall back to the still file -- that url is one
        # an animated package can never answer with, and the picker would draw
        # a frozen sticker the real daemon shows moving.
        pkg = next(p for p in self.packages() if p["stickers"][0]["animated"])
        res = self.s.call(cmd="sendSticker", chat="ustub-notes",
                          packageId=pkg["id"], stickerId="88888")
        self.assertTrue(res["ok"], res)
        sent = self.s.state()["events"][-1]["message"]
        self.assertEqual("%s/88888/android/sticker_animation.png" % self.CDN,
                         sent["stickerUrl"])


class PreviewTest(unittest.TestCase):
    """preview_text() against previewText() in daemon.ts, branch by branch."""

    @classmethod
    def setUpClass(cls):
        cls.stub = load_stub_module()

    def preview(self, **m):
        m.setdefault("contentType", "NONE")
        return self.stub.preview_text(m)

    def test_file_prefers_the_name(self):
        self.assertEqual("a.txt", self.preview(contentType="FILE", fileName="a.txt"))
        self.assertEqual("[檔案]", self.preview(contentType="FILE"))

    def test_media_labels(self):
        self.assertEqual("[圖片]", self.preview(contentType="IMAGE"))
        self.assertEqual("[影片]", self.preview(contentType="VIDEO"))
        self.assertEqual("[語音]", self.preview(contentType="AUDIO"))
        self.assertEqual("[貼圖]", self.preview(contentType="STICKER"))
        # altText is a FLEX/RICH fallback only; a VIDEO keeps its label.
        self.assertEqual("[影片]", self.preview(contentType="VIDEO", altText="x"))

    def test_flex_falls_back_to_alt_text(self):
        self.assertEqual("alt", self.preview(contentType="FLEX", altText="alt"))
        self.assertEqual("alt", self.preview(contentType="RICH", altText="alt"))
        self.assertEqual("[FLEX]", self.preview(contentType="FLEX"))

    def test_system_events_prefer_the_label_over_the_event_name(self):
        self.assertEqual("[系統事件]", self.preview(
            contentType="CHATEVENT", text="CHATEVENT"))
        self.assertEqual("[貼文通知]", self.preview(contentType="POSTNOTIFICATION"))
        # Real prose from LINE still wins.
        self.assertEqual("已加入", self.preview(
            contentType="CHATEVENT", text="已加入"))

    def test_unsent_outranks_everything_it_left_behind(self):
        self.assertEqual("已收回訊息", self.preview(
            unsent=True, contentType="FILE", fileName="a.txt"))
        self.assertEqual("已收回訊息", self.preview(
            unsent=True, contentType="NONE", text="原本說的話"))
        # Not recalled: the file name is still the right line to print.
        self.assertEqual("a.txt", self.preview(
            unsent=False, contentType="FILE", fileName="a.txt"))

    def test_unknown_type_and_decrypt_failure(self):
        self.assertEqual("[非文字]", self.preview(contentType=""))
        self.assertEqual("[WHATEVER]", self.preview(contentType="WHATEVER"))
        self.assertEqual("[E2EE 解密失敗]", self.preview(
            contentType="NONE", decryptFailed=True, text="x"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

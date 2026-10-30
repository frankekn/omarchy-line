#!/usr/bin/env python3
"""Exercise the real viewport methods in a rendered, isolated Qt ListView."""
from pathlib import Path
import os
import shutil
import signal
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
RUNNER = shutil.which("qmltestrunner") or next(
    (str(p) for p in [Path("/usr/lib/qt6/bin/qmltestrunner")]
     if p.is_file()), None)


def method(source, name):
    lines = source.splitlines()
    start = next(i for i, line in enumerate(lines)
                 if line.startswith("  function " + name + "("))
    end = next(i for i in range(start + 1, len(lines)) if lines[i] == "  }")
    return "\n".join(lines[start:end + 1])


def fixture():
    source = (REPO / "Panel.qml").read_text()
    start = source.index("          onModelChanged: {", source.index("          id: msgList"))
    end = source.index("          // 點在氣泡", start)
    methods = "\n".join(method(source, name) for name in [
        "setMessages", "clearSwap", "settleMessageViewport", "captureMessageAnchor", "restoreMessageViewport",
        "withDay", "applyEvents", "mergeMessage", "applyEdit", "applyHistory",
        "applyRead", "applyReaction", "applyUnsend", "anchoredContentY",
        "mergeFailedMessages", "preserveAmbiguousBubbles", "pendingBubble", "withFields",
    ])
    # request() 送出時替樂觀泡泡補 requestId 的那一段。
    tag_start = source.index("      if (msgId) {\n        var tagged = []")
    tag_end = source.index("\n    }\n    var p = root.pending", tag_start)
    history_start = source.index("      var historyRows = EventLog.keepPreviewPaths")
    history_end = source.index("      root.reconcileAmbiguous", history_start)
    return (QML.replace("METHODS", methods).replace("HANDLERS", source[start:end])
            .replace("HISTORY_REPLY", source[history_start:history_end])
            .replace("TAG_REQUEST", source[tag_start:tag_end]))


QML = '''import QtQuick
import QtTest
import "EventLog.js" as EventLog
import "PanelKit.js" as PanelKit
import "Style.js" as Style
Item {
  id: root
  width: 600; height: 400
  property var messages: []
  property bool atBottom: true
  property int prependAnchorIndex: -1
  property real keepContentY: -1
  property var messageAnchor: null
  property int messageSwapGeneration: 0
  property var activeChat: ({mid: "C1"})
  property string panelInstanceId: "test"
  property int nextId: 0
  property string myMid: "ME"
  property int readerCount: 2
  property int olderRequests: 0
  property string growingId: ""
  property var failedMessagesByChat: ({})
  property var pending: ({})
  property var ambiguousSendsByChat: ({})
  function reconcileAmbiguous(mid, rows) {}
  function viewingChat() { return true }
  function request(cmd, args) { return true }
  function historyReply(rows) {
    var res = {data: rows}
    var askedFor = "C1"
    HISTORY_REPLY
  }
  function sendText(text) {
    var msgId = root.pendingBubble({n: 121, text: text})
    var requestId = "req-" + msgId
    var requestBubble = null
    TAG_REQUEST
    return msgId
  }
  function nearOlderEdge(y, origin, content, height) {
    return PanelKit.nearOlderEdge(y, origin, content, height)
  }
  function loadOlder() { olderRequests++ }
  function rows(start, end) {
    var out = []
    for (var i = start; i < end; i++)
      out.push({id: "m" + i, n: i, time: 1700000000000 + i * 8640000,
                from: i % 3 === 0 ? "ME" : "THEM"})
    return root.withDay(out)
  }
  METHODS
  ListView {
    id: msgList
    anchors.fill: parent
    spacing: 6
    model: root.messages
    verticalLayoutDirection: ListView.TopToBottom
    cacheBuffer: 1200
    boundsBehavior: Flickable.StopAtBounds
    flickableDirection: Flickable.VerticalFlick
    interactive: contentHeight > height
    section.property: "day"
    section.delegate: Text { required property string section; text: section; height: 25 }
    delegate: Rectangle {
      required property var modelData
      required property int index
      width: msgList.width
      height: 30 + ((Number(modelData.n) % 7 + 7) % 7) * 23
              + (root.growingId === modelData.id ? 180 : 0)
              + (modelData.reactions && modelData.reactions.length > 0 ? 25 : 0)
      Text { text: parent.modelData.id }
    }
    HANDLERS
  }
  TestCase {
    name: "MessageViewport"
    when: windowShown
    function init() {
      root.growingId = ""
      root.failedMessagesByChat = ({})
      root.ambiguousSendsByChat = ({})
      root.pending = ({})
      root.setMessages(root.rows(0, 120), true)
      wait(80)
      root.olderRequests = 0
    }
    function reading() {
      msgList.positionViewAtIndex(55, ListView.Beginning)
      msgList.contentY += 13
      wait(40)
      return root.captureMessageAnchor()
    }
    function stays(anchor) {
      wait(80)
      var after = root.captureMessageAnchor()
      verify(after !== null)
      compare(after.id, anchor.id)
      verify(Math.abs(after.offset - anchor.offset) < 1,
             "viewport offset changed: " + anchor.offset + " -> " + after.offset)
      compare(root.keepContentY, -1)
    }
    function incoming(id) {
      return {chat: "C1", kind: "message",
              message: {id: id, n: 121, time: 1700000000000 + 121 * 8640000, from: "THEM"}}
    }
    function test_incoming_preserves_visible_message() {
      var anchor = reading()
      root.applyEvents([incoming("new")])
      stays(anchor)
      compare(root.olderRequests, 0)
    }
    function test_read_receipt_preserves_visible_message() {
      var anchor = reading()
      root.applyEvents([{chat: "C1", kind: "read", by: "OTHER", upTo: "m119"}])
      stays(anchor)
      compare(root.messages[0].readBy.count, 1)
    }
    function test_other_chat_does_not_move_messages() {
      var anchor = reading()
      var event = incoming("other")
      event.chat = "C2"
      root.applyEvents([event])
      stays(anchor)
    }
    function test_burst_keeps_original_anchor() {
      var anchor = reading()
      root.applyEvents([incoming("new1")])
      root.applyEvents([incoming("new2")])
      root.applyEvents([incoming("new3")])
      stays(anchor)
      compare(root.atBottom, false)
    }
    function test_history_response_respects_reader_scroll() {
      var anchor = reading()
      var changed = root.messages.slice()
      changed[changed.length - 1] = Object.assign({}, changed[changed.length - 1], {text: "updated"})
      root.historyReply(changed)
      stays(anchor)
    }
    function test_history_head_keeps_loaded_older_pages() {
      var anchor = reading()
      root.historyReply(root.rows(60, 121))
      stays(anchor)
      compare(root.messages[0].id, "m0")
      compare(root.messages[root.messages.length - 1].id, "m120")
    }
    function test_history_gap_is_not_merged() {
      root.setMessages(root.rows(0, 60).concat(root.rows(120, 121)), true)
      root.historyReply(root.rows(62, 121))
      compare(root.messages[0].id, "m62")
      compare(root.messages.length, 59)
    }
    function test_answered_send_without_token_leaves_no_ghost() {
      root.sendText("hi")
      root.pending = ({})
      var confirmed = {id: "wire-hi", n: 121, time: 1800000000000, from: "ME", text: "hi"}
      root.historyReply(root.rows(60, 120).concat([confirmed]))
      compare(root.messages.filter(function(m) { return m.pending }).length, 0)
      compare(root.messages[root.messages.length - 1].id, "wire-hi")
      compare(root.messages[0].id, "m0")
    }
    function test_in_flight_send_survives_history_merge() {
      var id = root.sendText("hi")
      root.pending = {r1: {msgId: id}}
      root.historyReply(root.rows(60, 120))
      compare(root.messages.filter(function(m) { return m.pending }).length, 1)
    }
    function test_user_scroll_wins_over_pending_restore() {
      reading()
      root.applyEvents([incoming("new")])
      root.settleMessageViewport()
      msgList.contentY -= 100
      var y = msgList.contentY
      wait(80)
      verify(Math.abs(msgList.contentY - y) < 1,
             "restore moved the reader: " + y + " -> " + msgList.contentY)
      compare(root.keepContentY, -1)
    }
    function test_failed_bubble_reload_is_idempotent() {
      var failed = {id: "failed-local", n: 121, time: 1800000000000,
                    from: "ME", failed: true, text: "完整失敗訊息\\n第二行"}
      root.failedMessagesByChat = {C1: [failed, failed]}
      root.setMessages(root.messages.concat([failed, failed]), true)
      var counts = []
      for (var i = 0; i < 3; i++) {
        root.historyReply(root.rows(60, 121))
        var failures = root.messages.filter(function(m) { return m.id === failed.id })
        counts.push(failures.length)
        compare(failures[0].text, failed.text)
      }
      console.log("FAILED_BUBBLE_COUNTS " + JSON.stringify(counts))
      compare(counts.join(","), "1,1,1")
      wait(80)
      verify(msgList.atYEnd)
    }
    function test_failed_merge_preserves_current_and_confirmed_versions() {
      var saved = {id: "failed-local", time: 2, failed: true, text: "saved"}
      var current = Object.assign({}, saved, {text: "current full text"})
      root.failedMessagesByChat = {C1: [saved, saved]}
      var merged = root.mergeFailedMessages("C1", [current, current])
      compare(merged.length, 1)
      compare(merged[0].text, current.text)
      var confirmed = {id: saved.id, time: 3, from: "ME", text: "confirmed"}
      merged = root.mergeFailedMessages("C1", [current, confirmed])
      compare(merged.length, 1)
      compare(merged[0].text, confirmed.text)
      root.failedMessagesByChat = ({})
      compare(root.mergeFailedMessages("C1", [current, current]).length, 1)
      root.failedMessagesByChat = {C1: [saved]}
      compare(root.mergeFailedMessages("C1", [])[0].text, saved.text)
    }
    function test_real_history_preserves_and_confirms_ambiguous_tokens() {
      var pending = {id: "pending-local", n: 121, time: 1800000000000,
                     from: "ME", pending: true, requestId: "send-token", text: "pending full text"}
      root.ambiguousSendsByChat = {C1: [{requestId: "send-token", bubble: pending}]}
      root.setMessages(root.messages.concat([pending]), true)
      root.historyReply(root.rows(60, 121))
      var waiting = root.messages.filter(function(m) { return m.pending })
      compare(waiting.length, 1)
      compare(waiting[0].requestId, "send-token")
      compare(waiting[0].text, pending.text)
      var confirmed = {id: "wire-send", n: 121, time: 1800000000000,
                       from: "ME", requestId: "send-token", text: pending.text}
      root.historyReply(root.rows(60, 121).concat([confirmed]))
      compare(root.messages.filter(function(m) { return m.pending }).length, 0)
      compare(root.messages.filter(function(m) { return m.requestId === "send-token" }).length, 1)
      root.ambiguousSendsByChat = ({})
      root.historyReply(root.rows(200, 210))
      compare(root.messages[0].id, "m200")
      compare(root.messages[root.messages.length - 1].id, "m209")
    }
    function test_older_page_preserves_visible_message() {
      var anchor = reading()
      root.prependAnchorIndex = 20
      root.setMessages(root.rows(-20, 0).concat(root.messages), false)
      stays(anchor)
      compare(root.prependAnchorIndex, -1)
    }
    function test_bottom_reader_follows_new_message() {
      root.applyEvents([incoming("new")])
      wait(100)
      verify(msgList.atYEnd)
      compare(root.atBottom, true)
      compare(root.olderRequests, 0)
    }
    function test_own_send_follows_to_bottom() {
      root.sendText("hi")
      wait(100)
      verify(msgList.atYEnd)
      compare(root.messages[root.messages.length - 1].text, "hi")
    }
    function test_own_send_while_reading_jumps_to_bottom() {
      reading()
      root.sendText("hi")
      wait(100)
      verify(msgList.atYEnd)
      compare(root.atBottom, true)
    }
    function test_own_send_during_pending_restore_jumps_to_bottom() {
      reading()
      root.applyEvents([incoming("new")])
      root.sendText("hi")
      wait(100)
      verify(msgList.atYEnd)
    }
    // The full lifecycle of a send, the way a messenger sees it: optimistic
    // bubble, the server's echo replacing it, then the peer's activity a few
    // seconds later. 已讀 sits on the time row and never changes a bubble's
    // height; a reaction does add a row, so it stands in for "the newest
    // bubble grew" here.
    function test_send_echo_and_reaction_keep_the_newest_bubble_in_view() {
      root.sendText("hi")
      wait(50)
      var echo = {id: "wire-hi", n: 121, time: 1800000000000, from: "ME",
                  text: "hi", requestId: root.messages[root.messages.length - 1].requestId}
      root.applyEvents([{chat: "C1", kind: "message", message: echo}])
      wait(50)
      verify(msgList.atYEnd, "echo left the bottom")
      compare(root.messages.filter(function(m) { return m.pending }).length, 0)
      root.applyEvents([{chat: "C1", kind: "read", by: "OTHER", upTo: "wire-hi"}])
      root.applyEvents([{chat: "C1", kind: "reaction", messageId: "wire-hi",
                         reactions: [{type: "LOVE", count: 1}]}])
      wait(100)
      compare(root.messages[root.messages.length - 1].readBy.count, 1)
      verify(msgList.atYEnd, "the reaction row pushed the newest bubble below the fold: cy="
             + msgList.contentY + " end=" + (msgList.originY + msgList.contentHeight - msgList.height))
    }
    function test_own_send_tall_bubble_follows_to_bottom() {
      for (var i = 0; i < 5; i++) {
        root.sendText("tall" + i)
        wait(30)
      }
      wait(100)
      verify(msgList.atYEnd)
    }
    function test_identical_model_releases_swap_guard() {
      var anchor = reading()
      root.setMessages(root.messages.slice())
      stays(anchor)
    }
    function test_image_growth_above_reader_preserves_visible_message() {
      var anchor = reading()
      root.growingId = "m54"
      stays(anchor)
    }
    function test_image_growth_at_bottom_keeps_following() {
      root.growingId = "m119"
      wait(100)
      verify(msgList.atYEnd)
    }
    function test_deferred_bottom_follow_respects_reader_scroll() {
      msgList.toBottom()
      msgList.contentY -= 200
      var anchor = root.captureMessageAnchor()
      stays(anchor)
      verify(!msgList.atYEnd)
    }
    function test_switch_chat_while_restore_pending() {
      reading()
      root.applyEvents([incoming("new")])
      root.setMessages(root.rows(200, 260), true)
      wait(100)
      verify(msgList.atYEnd)
      compare(root.keepContentY, -1)
    }
  }
}
'''


@unittest.skipUnless(RUNNER, "qmltestrunner not installed")
class MessageScrollTest(unittest.TestCase):
    def test_viewport_updates(self):
        with tempfile.TemporaryDirectory(prefix="enil-message-scroll-") as tmp:
            root = Path(tmp)
            for name in ["EventLog.js", "PanelKit.js"]:
                shutil.copy2(REPO / name, root / name)
            (root / "Style.js").write_text(".pragma library\nfunction space(v) { return v }\n")
            (root / "tst_scroll.qml").write_text(fixture())
            env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                       XDG_CONFIG_HOME=str(root / "config"), XDG_CACHE_HOME=str(root / "cache"))
            child = subprocess.Popen([RUNNER, "-input", str(root / "tst_scroll.qml")],
                                     env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, start_new_session=True)
            try:
                output, _ = child.communicate(timeout=45)
            finally:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            self.assertEqual(child.returncode, 0, output)
            self.assertNotIn("Binding loop", output)
            print(output, end="")


if __name__ == "__main__":
    unittest.main()

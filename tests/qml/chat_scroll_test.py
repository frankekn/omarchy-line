#!/usr/bin/env python3
"""Real ListView geometry under chat patches; synthetic data, no daemon."""
from pathlib import Path
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
RUNNER = shutil.which("qmltestrunner") or next(
    (str(p) for p in [Path("/usr/lib/qt6/bin/qmltestrunner")]
     if p.is_file()), None)


def method(source, name, indent="  "):
    lines = source.splitlines()
    first = next(i for i, line in enumerate(lines)
                 if line.startswith(indent + "function " + name + "("))
    last = next(i for i in range(first + 1, len(lines))
                if lines[i] == indent + "}")
    return "\n".join(lines[first:last + 1])


@unittest.skipUnless(RUNNER, "qmltestrunner not installed")
class ChatScrollTest(unittest.TestCase):
    def run_case(self, action, *, unread=False, at_top=False):
        source = (REPO / "Panel.qml").read_text()
        methods = "\n".join(method(source, name) for name in
                            ("replaceChatSnapshot", "applyChatPatch", "clampSelection",
                             "moveSelection", "openChat", "backToList", "wheelScroll"))
        for name in ("cancelChatListRestore", "setChatSearch", "mergeFailedMessages",
                     "preserveAmbiguousBubbles", "withDay"):
            methods += "\n" + method(source, name)
        search_start = source.index("          onTextChanged:", source.index("          id: searchField"))
        search_handler = source[search_start:source.index("\n", search_start)]
        list_start = source.index("        id: listFlick")
        list_end = source.index("        delegate:", list_start)
        list_inputs = source[list_start:list_end]
        drag_handler = re.search(r"^        onDraggingChanged:.*$", list_inputs, re.M)
        drag_handler = drag_handler.group(0) if drag_handler else ""
        scrollbar = re.search(r"^        ScrollBar.vertical: ScrollBar \{.*$", list_inputs, re.M)
        scrollbar_handler = scrollbar.group(0) if scrollbar else ""
        if "onPressedChanged" not in scrollbar_handler:
            scrollbar_handler = "ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }"
        scrollbar_handler = scrollbar_handler.replace("ScrollBar {", "ScrollBar { id: chatBar;")
        press_handler = re.search(r"onPressedChanged: (.*) }$", scrollbar_handler)
        press_body = press_handler.group(1) if press_handler else ""
        if press_handler:
            scrollbar_handler = scrollbar_handler[:press_handler.start()] + "}"
        scrollbar_handler = scrollbar_handler[:-1] + '''
          onPressedChanged: {
            if (pressed && root.patchOnBar) {
              root.inputPosition = listFlick.contentY
              root.patchDuringInput()
            }
            PRESS_BODY
          }
        }'''.replace("PRESS_BODY", press_body)
        down_handler = next(line for line in source.splitlines()
                            if line.startswith("          Keys.onDownPressed: root.moveSelection"))
        down_handler = down_handler.replace(": root.", ": { if (root.patchOnDown) root.patchDuringInput(); root.") + " }"
        rows = method((REPO / "PanelKit.js").read_text(), "chatRows", "")
        qml = '''import QtQuick
import QtTest
import QtQuick.Controls
import "PanelKit.js" as PanelKit
import "EventLog.js" as EventLog
import "Style.js" as Style
Item {
  id: root
  width: 300
  height: 300
  property var chatSnapshot: []
  property double chatRevisionSeen: 1
  property string chatBootSeen: "synthetic"
  property var chatListRestore: null
  property int selectedIndex: 0
  property string search: ""
  property real fontScale: 1
  property real scrollSpeed: 1
  property bool patchOnDown: false
  property bool patchOnBar: false
  property real inputPosition: -1
  function patchDuringInput() {
    root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
  }
  property var lightbox: null
  // wheelScroll 只拿它來比對是不是訊息清單；這裡只測聊天清單。
  property Item msgList: null
  function settleMessageViewport() {}
  property bool restoringDraft: false
  property var mentionPicks: []
  property var replyTarget: null
  property string hiddenOnOpen: ""
  property var activeChat: null
  property var historyCache: ({})
  property var messages: []
  property var failedMessagesByChat: ({})
  property var ambiguousSendsByChat: ({})
  property string myMid: "ME"
  property int unreadMarkCount: 0
  property string unreadMarkId: ""
  property bool loading: false
  property bool loadingOlder: false
  property string view: "list"
  property string notice: ""
  property bool twoPane: false
  function setStickerOpen(value) {}
  function chatHidden(mid) { return false }
  function setMessages(rows, follow) { messages = rows }
  function loadHistory(mid) {}
  function loadMembers(mid) {}
  readonly property var listModel: chatRows(chatSnapshot, search, true)
  readonly property int listCount: listModel.length
  onListCountChanged: root.clampSelection()
  property var before: null
  METHODS
  ROWS
  function capture() {
    var index = -1
    for (var y = listFlick.contentY; index < 0 && y < listFlick.contentY + listFlick.height; y++)
      index = listFlick.indexAt(1, y)
    var item = index >= 0 ? listFlick.itemAtIndex(index) : null
    return {
      top: index >= 0 ? root.listModel[index].mid : "",
      offset: item ? item.y - listFlick.contentY : 0,
      selected: root.listModel[root.selectedIndex] ? root.listModel[root.selectedIndex].mid : "",
      contentY: listFlick.contentY
    }
  }
  TextInput {
    id: searchField
    width: 100; height: 20
    SEARCH_HANDLER
    DOWN_HANDLER
    Keys.onUpPressed: root.moveSelection(-1)
  }
  TextInput { id: replyField }
  ListView {
    id: listFlick
    anchors.fill: parent
    spacing: 8
    cacheBuffer: 600
    boundsBehavior: Flickable.StopAtBounds
    DRAG_HANDLER
    SCROLLBAR_HANDLER
    model: root.listModel
    MouseArea {
      y: listFlick.originY
      width: listFlick.width
      height: Math.max(listFlick.height, listFlick.contentHeight)
      acceptedButtons: Qt.NoButton
      onWheel: function(wheel) {
        root.wheelScroll(listFlick, wheel.angleDelta.y, wheel.pixelDelta.y)
      }
    }
    delegate: Rectangle {
      required property var modelData
      width: 300
      height: 44
      Text { text: parent.modelData.mid }
    }
  }
  Component.onCompleted: {
    var rows = []
    for (var i = 0; i < 30; i++)
      rows.push({mid: "C" + i, lastTime: 30 - i, unread: INITIAL_UNREAD})
    root.chatSnapshot = rows
  }
  TestCase {
    name: "ChatViewport"
    when: windowShown
    function test_update() {
      wait(80)
      POSITION
      root.before = root.capture()
      ACTION
      wait(80)
      console.log("RESULT " + JSON.stringify({before: root.before, after: root.capture(),
                                             inputPosition: root.inputPosition,
                                             restoreCleared: root.chatListRestore === null}))
    }
  }
}
'''.replace("METHODS", methods).replace("ROWS", rows).replace("ACTION", action)
        qml = (qml.replace("SEARCH_HANDLER", search_handler)
               .replace("DOWN_HANDLER", down_handler)
               .replace("DRAG_HANDLER", drag_handler)
               .replace("SCROLLBAR_HANDLER", scrollbar_handler))
        qml = qml.replace("INITIAL_UNREAD", "i < 15 ? 1 : 0" if unread else "0")
        qml = qml.replace("POSITION", "listFlick.positionViewAtBeginning(); root.selectedIndex = 0"
                          if at_top else
                          "listFlick.positionViewAtIndex(10, ListView.Beginning); "
                          "listFlick.contentY += 13; root.selectedIndex = 10")
        with tempfile.TemporaryDirectory(prefix="enil-chat-scroll-") as tmp:
            root = Path(tmp)
            path = root / "tst_chat_scroll.qml"
            path.write_text(qml)
            shutil.copy2(REPO / "PanelKit.js", root / "PanelKit.js")
            shutil.copy2(REPO / "EventLog.js", root / "EventLog.js")
            (root / "Style.js").write_text(".pragma library\nfunction space(v) { return v }\n")
            env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                       XDG_CONFIG_HOME=str(root / "config"), XDG_CACHE_HOME=str(root / "cache"))
            child = subprocess.Popen([RUNNER, "-input", str(path)], env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, start_new_session=True)
            try:
                output, _ = child.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                self.fail("qmltestrunner scroll check timed out")
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
        self.assertNotIn("ERROR", output)
        self.assertNotIn("Binding loop", output)
        line = next((line.split("RESULT ", 1)[1] for line in output.splitlines()
                     if "RESULT " in line), None)
        self.assertIsNotNone(line, output)
        result = json.loads(line)
        self.assertTrue(result["restoreCleared"], output)
        return result

    def assert_anchor_preserved(self, result):
        self.assertEqual(result["before"]["top"], "C10")
        self.assertEqual(result["after"]["top"], result["before"]["top"])
        self.assertAlmostEqual(result["after"]["offset"], result["before"]["offset"], delta=1)
        self.assertEqual(result["after"]["selected"], result["before"]["selected"])

    def test_socket_patch_keeps_visible_chat_and_selection(self):
        self.assert_anchor_preserved(self.run_case(
            'root.applyChatPatch({mid:"C29",lastTime:100,unread:1},2,"synthetic")'))

    def test_full_snapshot_keeps_visible_chat_and_selection(self):
        self.assert_anchor_preserved(self.run_case('''
          var next = root.chatSnapshot.slice()
          next.unshift({mid:"NEW",lastTime:100,unread:1})
          root.replaceChatSnapshot(next)
        '''))

    def test_read_clear_keeps_selected_chat_after_reordering(self):
        self.assert_anchor_preserved(self.run_case(
            'root.applyChatPatch({mid:"C10",unread:0},2,"synthetic")', unread=True))

    def test_rapid_patches_share_original_anchor(self):
        self.assert_anchor_preserved(self.run_case('''
          root.applyChatPatch({mid:"C29",lastTime:100,unread:1},2,"synthetic")
          root.applyChatPatch({mid:"C28",lastTime:101,unread:1},3,"synthetic")
          root.replaceChatSnapshot(root.chatSnapshot.slice())
        '''))

    def test_list_at_top_follows_new_chat_but_keeps_selection(self):
        result = self.run_case(
            'root.applyChatPatch({mid:"C29",lastTime:100,unread:1},2,"synthetic")', at_top=True)
        self.assertEqual(result["before"]["top"], "C0")
        self.assertEqual(result["after"]["top"], "C29")
        self.assertEqual(result["after"]["selected"], "C0")

    def test_search_replaces_pending_anchor(self):
        result = self.run_case('''
          root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
          searchField.text = "C1"
        ''')
        self.assertEqual(result["after"]["top"], "C1")
        self.assertEqual(result["after"]["selected"], "C1")

    def test_search_then_same_tick_push_uses_new_query_anchor(self):
        result = self.run_case('''
          root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
          searchField.text = "C1"
          Qt.callLater(function() {
            verify(root.chatListRestore !== null, "old callback cleared new token")
            compare(root.chatListRestore.selectedMid, "C1")
          })
          root.applyChatPatch({mid:"C19",lastTime:101},3,"synthetic")
        ''')
        self.assertEqual(result["after"]["top"], "C19")
        self.assertEqual(result["after"]["selected"], "C1")

    def test_later_push_preserves_anchor_within_new_query(self):
        result = self.run_case('''
          root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
          searchField.text = "C1"
          wait(80)
          listFlick.positionViewAtIndex(3, ListView.Beginning)
          listFlick.contentY += 13
          root.selectedIndex = 3
          root.before = root.capture()
          root.applyChatPatch({mid:"C19",lastTime:101},3,"synthetic")
        ''')
        self.assertEqual(result["after"]["top"], result["before"]["top"])
        self.assertAlmostEqual(result["after"]["offset"], result["before"]["offset"], delta=1)
        self.assertEqual(result["after"]["selected"], result["before"]["selected"])

    def test_keyboard_navigation_wins_over_pending_restore(self):
        result = self.run_case('''
          searchField.forceActiveFocus()
          root.selectedIndex = 0
          root.patchOnDown = true
          keyClick(Qt.Key_Down)
          var chosen = root.listModel[root.selectedIndex].mid
          var navigated = listFlick.contentY
          wait(80)
          compare(root.listModel[root.selectedIndex].mid, chosen)
          compare(listFlick.contentY, navigated)
          var item = listFlick.itemAtIndex(root.selectedIndex)
          verify(item !== null, "keyboard selection must remain instantiated in the viewport")
          verify(item.y >= listFlick.contentY && item.y + item.height <= listFlick.contentY + listFlick.height,
                 "keyboard selection must stay visible after deferred restore")
        ''')
        self.assertEqual(result["after"]["selected"], "C1")

    def test_open_chat_ends_old_list_restore(self):
        result = self.run_case('''
          root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
          root.openChat(root.listModel[0])
          listFlick.positionViewAtBeginning()
        ''')
        self.assertEqual(result["after"]["top"], "C29")

    def test_back_to_list_ends_old_list_restore(self):
        result = self.run_case('''
          root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
          root.backToList()
        ''')
        self.assertEqual(result["after"]["top"], "C29")
        self.assertEqual(result["after"]["selected"], "C29")

    def test_real_wheel_input_ends_pending_restore(self):
        result = self.run_case('''
          root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
          mouseWheel(listFlick, 100, 100, 0, -120)
          var scrolled = listFlick.contentY
          verify(scrolled > 0)
          wait(80)
          compare(listFlick.contentY, scrolled)
        ''')
        self.assertNotEqual(result["after"]["top"], "C10")

    def test_real_scrollbar_press_ends_pending_restore(self):
        result = self.run_case('''
          root.patchOnBar = true
          mousePress(chatBar, chatBar.width / 2, chatBar.height * chatBar.position + 5)
          mouseRelease(chatBar, chatBar.width / 2, chatBar.height * chatBar.position + 5)
        ''')
        self.assertEqual(result["inputPosition"], result["before"]["contentY"])
        self.assertEqual(result["after"]["contentY"], result["inputPosition"])

    def test_real_drag_ends_pending_restore(self):
        self.run_case('''
          mousePress(listFlick,100,250,Qt.LeftButton,Qt.NoModifier,0)
          root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
          mouseMove(listFlick,100,210,0)
          mouseMove(listFlick,100,160,0)
          mouseMove(listFlick,100,100,0)
          mouseMove(listFlick,100,40,0)
          verify(listFlick.dragging)
          root.inputPosition = listFlick.contentY
          wait(80)
          compare(listFlick.contentY,root.inputPosition,
                  "deferred restore must not undo active user drag")
          mouseRelease(listFlick,100,40,Qt.LeftButton,Qt.NoModifier,0)
        ''')

    def test_patch_during_real_drag_does_not_restore_stale_viewport(self):
        self.run_case('''
          mousePress(listFlick,100,250,Qt.LeftButton,Qt.NoModifier,0)
          mouseMove(listFlick,100,210,0)
          mouseMove(listFlick,100,160,0)
          verify(listFlick.dragging)
          root.applyChatPatch({mid:"C29",lastTime:100},2,"synthetic")
          mouseMove(listFlick,100,100,0)
          mouseMove(listFlick,100,40,0)
          verify(listFlick.dragging)
          root.inputPosition = listFlick.contentY
          wait(80)
          compare(listFlick.contentY,root.inputPosition,
                  "patch during drag must not undo later user movement")
          mouseRelease(listFlick,100,40,Qt.LeftButton,Qt.NoModifier,0)
        ''')


if __name__ == "__main__":
    unittest.main()

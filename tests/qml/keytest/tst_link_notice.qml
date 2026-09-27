// U74. The linkNotice line used to bind its own height to its own
// implicitHeight (`height: visible ? implicitHeight : 0`), and QQuickText
// re-runs layout -- recomputing implicitHeight -- the moment a height is
// assigned to it. With anchors.left/right and elide in play, the first time
// the text went from empty to non-empty (a reconnect putting 連線中斷 on
// screen) Qt printed `Binding loop detected for property "height"` -- four
// times in three days of shell journal, at Panel.qml:{2602,2746,2999,3002}
// across versions, always this one Text.
//
// The fix moves height/topMargin onto a wrapping Item (linkNoticeSlot), so
// the Text no longer reads its own implicitHeight from its own height. This
// harness reproduces the shipped shape verbatim and toggles the line the way
// a reconnect does; run.sh greps the runner output for "Binding loop", which
// is the only way to fail on the warning -- qmltestrunner here is QtTest
// without failOnWarning().
//
//   QT_QPA_PLATFORM=offscreen qmltestrunner -input tst_link_notice.qml
import QtQuick 2.15
import QtTest 1.15

Item {
  id: harness
  width: 360; height: 240
  visible: true

  // The panel's rule, reduced: what the line shows is derived from state, and
  // state is replaced wholesale (property var change signals fire on assign,
  // not on in-place mutation -- same as parseState reassigning root.state).
  property var state: ({ link: { push: "up", since: 1 } })

  function linkNoticeText() {
    var l = harness.state && harness.state.link ? harness.state.link : null
    if (!l || String(l.push || "") !== "down") return ""
    return "LINE 連線中斷，重連中，點此立即重連"
  }

  Item {
    id: listHero
    anchors.left: parent.left
    anchors.right: parent.right
    height: 40
  }

  // The shipped shape of Panel.qml's linkNoticeSlot/linkNotice, minus the
  // shell-only bits (Style/Color/fonts): the Item owns topMargin and height,
  // the Text keeps only what draws -- and, load-bearing for the loop, the
  // full-width anchors and elide that make QQuickText re-layout on resize.
  Item {
    id: linkNoticeSlot
    anchors.top: listHero.bottom
    anchors.topMargin: linkNotice.visible ? 6 : 0
    anchors.left: parent.left
    anchors.right: parent.right
    height: linkNotice.visible ? linkNotice.implicitHeight : 0

    Text {
      id: linkNotice
      anchors.left: parent.left
      anchors.right: parent.right
      visible: text !== ""
      text: harness.linkNoticeText()
      elide: Text.ElideRight

      MouseArea {
        id: linkHover
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
      }
    }
  }

  TestCase {
    name: "LinkNoticeBindingLoop"
    when: windowShown

    function setPush(v) {
      // A fresh object, never an in-place edit: the binding on linkNotice.text
      // only re-evaluates when the property assignment signals.
      harness.state = { link: { push: v, since: 1 } }
    }

    function init() {
      setPush("up")
    }

    // The reconnect edge from the journal: empty -> 連線中斷 -> empty. The
    // assertions pin the layout contract; the binding-loop warning itself is
    // caught by run.sh grepping this runner's output.
    function test_a_reconnect_toggles_the_line_without_a_binding_loop() {
      compare(linkNotice.visible, false, "healthy link -> no line")
      compare(linkNoticeSlot.height, 0, "and the slot takes no room")
      compare(linkNoticeSlot.anchors.topMargin, 0, "margin collapses with it")

      setPush("down")
      compare(linkNotice.visible, true, "down -> the line is on screen")
      verify(linkNoticeSlot.height > 0, "the slot grew to fit it")
      compare(linkNoticeSlot.height, linkNotice.implicitHeight,
              "to exactly the text's implicit height")
      compare(linkNoticeSlot.anchors.topMargin, 6, "and the margin is back")

      setPush("up")
      compare(linkNotice.visible, false, "recovered -> gone again")
      compare(linkNoticeSlot.height, 0, "and the room is given back")
    }

    // Twice in a row, because the journal shows repeated reconnects and the
    // loop warning is only printed once per binding by Qt -- a second toggle
    // after a first quiet one is the cheap insurance that the first was not
    // quiet by accident of ordering.
    function test_b_a_second_reconnect_is_just_as_quiet() {
      setPush("down")
      verify(linkNoticeSlot.height > 0)
      setPush("up")
      compare(linkNoticeSlot.height, 0)
    }
  }
}

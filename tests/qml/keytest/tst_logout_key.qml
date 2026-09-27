// U25 follow-up harness. Pattern copied from the verifier's
// verify/U25/keytest/tst_keys.qml — offscreen qmltestrunner, no shell, no
// daemon, no state dir, nothing written into the worktree.
//
// Two environment constraints found the hard way, both silent (exit 1, zero
// output -- the same way qmllint dies with exit 255 and not one line of output
// on a typed `function x(): void` inside a custom IpcHandler):
//   * `import qs.Ui` cannot be loaded outside a Quickshell process, so the
//     dispatcher sits next to this file as PanelKeyCatcher.qml, a verbatim
//     copy of the shipped one rather than an imitation.
//   * `import QtQuick.Controls` also kills the runner, so searchField is
//     stubbed with the plain TextInput that a TextField wraps — enough to
//     reproduce "an editor holds focus and eats character keys".
//
//   QT_QPA_PLATFORM=offscreen qmltestrunner -input tst_logout_key.qml
import QtQuick 2.15
import QtTest 1.15

Item {
  id: harness
  width: 300; height: 200
  visible: true

  property int closeHits: 0
  property int logoutHits: 0
  property bool loggedIn: true
  property string view: "list"

  PanelKeyCatcher {
    id: keyCatcher
    anchors.fill: parent

    onCloseRequested: harness.closeHits++
    // Same shape as the handler under test in Panel.qml.
    onTextKey: function(t) {
      if (t === "L") {
        if (harness.loggedIn && harness.view === "list") logoutLabel.forceActiveFocus()
        return
      }
      if (t !== "/") return
      searchFieldStub.forceActiveFocus()
    }

    // Mimics searchField: the editor that focusTarget parks focus in for the
    // list view, and that therefore competes for every character key.
    TextInput {
      id: searchFieldStub
      width: 100; height: 24
      // Panel.qml:831-839 after follow-up 2: empty box hands focus to
      // keyCatcher instead of closing, so the list view gets the same
      // "Esc leaves the input, Esc again backs out" model as the chat view.
      Keys.onEscapePressed: {
        if (text.length > 0) text = ""
        else keyCatcher.forceActiveFocus()
      }
    }

    // Mimics logoutLabel after this follow-up: no activeFocusOnTab, its own
    // Return / Enter / Space / Escape handlers.
    Text {
      id: logoutLabel
      y: 100
      text: "登出"
      Keys.onReturnPressed: harness.logoutHits++
      Keys.onEnterPressed: harness.logoutHits++
      Keys.onSpacePressed: harness.logoutHits++
      Keys.onEscapePressed: keyCatcher.forceActiveFocus()
    }
  }

  TestCase {
    name: "LogoutKeyPath"
    when: windowShown

    function init() {
      harness.closeHits = 0; harness.logoutHits = 0
      harness.loggedIn = true; harness.view = "list"
      searchFieldStub.text = ""
      keyCatcher.forceActiveFocus()
    }

    function test_a_L_focuses_logout_without_logging_out() {
      compare(keyCatcher.activeFocus, true, "keyCatcher holds focus to begin with")
      keyClick("L")
      compare(logoutLabel.activeFocus, true, "L moved focus onto 登出")
      compare(harness.logoutHits, 0, "the first press must NOT log out")
    }

    function test_b_return_on_the_focused_label_logs_out() {
      keyClick("L")
      keyClick(Qt.Key_Return)
      compare(harness.logoutHits, 1, "Return logs out once the label has focus")
    }

    function test_c_space_on_the_focused_label_logs_out() {
      keyClick("L")
      keyClick(Qt.Key_Space)
      compare(harness.logoutHits, 1, "Space logs out once the label has focus")
    }

    function test_d_escape_hands_focus_back_instead_of_closing_the_panel() {
      keyClick("L")
      compare(logoutLabel.activeFocus, true)
      keyClick(Qt.Key_Escape)
      compare(keyCatcher.activeFocus, true, "Esc gave focus back to keyCatcher")
      compare(harness.closeHits, 0, "Esc did NOT fall through and close the panel")
      compare(harness.logoutHits, 0, "Esc did not log out")
    }

    function test_e_lowercase_l_stays_a_movement_key() {
      keyClick("l")
      compare(logoutLabel.activeFocus, false,
              "lowercase l is consumed as Right by PanelKeyCatcher:65, never reaches onTextKey")
    }

    function test_f_L_is_inert_when_logged_out_or_outside_the_list() {
      harness.loggedIn = false
      keyClick("L")
      compare(logoutLabel.activeFocus, false, "nothing to focus when logged out")
      harness.loggedIn = true; harness.view = "chat"
      keyClick("L")
      compare(logoutLabel.activeFocus, false, "nothing to focus in the chat view")
    }

    // The full sequence the brief asks to be proven, from where the user
    // actually starts in the list view: focus parked in searchField.
    function test_g_full_sequence_from_searchField() {
      searchFieldStub.forceActiveFocus()
      compare(searchFieldStub.activeFocus, true, "searchField holds focus, as focusTarget parks it")
      keyClick(Qt.Key_Escape)
      compare(keyCatcher.activeFocus, true, "Esc on the empty box left the input for keyCatcher")
      compare(harness.closeHits, 0, "that first Esc did NOT close the panel")
      keyClick("L")
      compare(logoutLabel.activeFocus, true, "L now reaches onTextKey and focuses 登出")
      compare(harness.logoutHits, 0, "still no logout on the first press")
      keyClick(Qt.Key_Return)
      compare(harness.logoutHits, 1, "Return logs out")
      keyClick(Qt.Key_Escape)
      compare(keyCatcher.activeFocus, true, "Esc from the label goes back to keyCatcher")
      compare(harness.closeHits, 0, "and still does not close the panel")
    }

    // The hop that follow-up 2 adds, and the second Esc that still closes.
    function test_h_escape_from_the_search_box_leaves_the_input_then_closes() {
      searchFieldStub.forceActiveFocus()
      searchFieldStub.text = "abc"
      keyClick(Qt.Key_Escape)
      compare(searchFieldStub.text, "", "a non-empty box is cleared first")
      compare(searchFieldStub.activeFocus, true, "and keeps focus")
      compare(harness.closeHits, 0, "clearing does not close")

      keyClick(Qt.Key_Escape)
      compare(keyCatcher.activeFocus, true, "empty box -> Esc hands focus to keyCatcher")
      compare(harness.closeHits, 0, "and does not close the panel")

      keyClick(Qt.Key_Escape)
      compare(harness.closeHits, 1, "the next Esc closes via keyCatcher.onCloseRequested")
      console.log("HOP searchField -> Esc -> keyCatcherFocused=" + keyCatcher.activeFocus
                  + ", second Esc closeHits=" + harness.closeHits)
    }

    // Regression for the old behaviour: while the editor still holds focus it
    // swallows L as a character. This is why the hop above had to be added.
    function test_i_editor_still_swallows_L_while_it_holds_focus() {
      searchFieldStub.forceActiveFocus()
      keyClick("L")
      compare(logoutLabel.activeFocus, false, "the editor consumes the character")
      compare(searchFieldStub.text, "L", "it is typed into the search box")
    }

    // j/k and / are reachable from the list view now too, not just L.
    function test_j_other_catcher_keys_reachable_from_the_list_view() {
      searchFieldStub.forceActiveFocus()
      keyClick(Qt.Key_Escape)
      compare(keyCatcher.activeFocus, true)
      keyClick("/")
      compare(searchFieldStub.activeFocus, true, "/ jumps back into the search box")
    }
  }
}

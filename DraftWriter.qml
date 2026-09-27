pragma Singleton

import QtQuick
import Quickshell.Io

// One writer per QML engine. Panel instances can disappear independently,
// but this object outlives them and keeps every atomic rename in revision order.
QtObject {
  id: root

  signal writeFailed(string error)
  signal writeSucceeded(string content)

  property string filePath: ""
  property var queued: []
  property bool saving: false
  property string current: ""
  property string lastError: ""
  property int retryAttempt: 0

  property FileView writer: FileView {
    path: root.filePath
    atomicWrites: true
    blockLoading: true
    printErrors: false
    onSaved: root.finishSave(true)
    onSaveFailed: function(error) {
      // The journal is the surface: a failed draft write never blocks the
      // panel, but it must not be silent either. `current` keeps its payload
      // and the backoff keeps trying until the filesystem recovers.
      console.warn(
        "line",
        "drafts not saved (attempt", root.retryAttempt + 1,
        "| pending:", root.queued.length + ")", error,
      )
      root.lastError = String(error || "draft save failed")
      root.writeFailed(root.lastError)
      root.saving = false
      root.retryAttempt++
      retryTimer.interval = Math.min(4000, 250 * Math.pow(2, root.retryAttempt - 1))
      retryTimer.restart()
    }
  }

  property Timer retryTimer: Timer {
    interval: 250
    repeat: false
    onTriggered: root.pumpSave()
  }

  function save(path, content) {
    if (!root.filePath) root.filePath = String(path)
    if (root.filePath !== String(path)) {
      console.warn("line", "draft path changed", path)
      root.lastError = "draft path changed"
      root.writeFailed(root.lastError)
      return false
    }
    // The current atomic write must finish (or retry) unchanged. Everything
    // behind it is replaceable composer state, so retain only the newest
    // snapshot instead of writing every intermediate keystroke.
    root.queued = [String(content)]
    root.pumpSave()
    return true
  }

  function pumpSave() {
    if (root.saving) return
    if (!root.current && root.queued.length === 0) return
    if (!root.current) {
      var next = root.queued.slice()
      root.current = next.shift()
      root.queued = next
    }
    root.saving = true
    root.writer.setText(root.current)
  }

  function finishSave(succeeded) {
    if (!root.saving) return
    root.saving = false
    if (succeeded) {
      var saved = root.current
      root.current = ""
      root.lastError = ""
      root.retryAttempt = 0
      root.writeSucceeded(saved)
    }
    root.pumpSave()
  }
}

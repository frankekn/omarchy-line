pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

// One recovery owner per QML engine, shared by every bar and panel instance.
// A failed FileView read is not evidence that the daemon needs a restart.
QtObject {
  id: root

  signal finished(bool healthy)

  readonly property string stateDir:
    (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") || "") + "/.local/state") + "/enil"
  readonly property int graceMs: 10000
  property string phase: "idle"
  property double lastRequestMs: 0
  property double requestMs: 0
  property string suspectPid: ""
  property double suspectSinceMs: 0
  property bool acted: false
  property string action: ""
  property string actionReason: ""

  property Loader probeLoader: Loader {
    active: root.phase === "probe"
    sourceComponent: Component {
      Socket {
        path: root.stateDir + "/sock"
        connected: true
        onConnectionStateChanged: {
          if (connected) write('{"id":"enil-health","cmd":"ping"}\n')
        }
        parser: SplitParser {
          splitMarker: "\n"
          onRead: function(line) { root.probeReply(line) }
        }
      }
    }
  }

  property Timer probeDeadline: Timer {
    interval: 2500
    onTriggered: root.probeFinished(false)
  }

  property Timer retryTimer: Timer {
    interval: 1000
    onTriggered: root.beginProbe()
  }

  property Timer processDeadline: Timer {
    interval: 10000
    onTriggered: {
      // Do not interpret a failed or hung systemctl query as an inactive unit.
      if (root.phase === "status") root.statusProcess.signal(9)
      else if (root.phase === "action") root.actionProcess.signal(9)
      root.finish(false)
    }
  }

  property Process statusProcess: Process {
    command: ["systemctl", "--user", "show", "enil.service",
              "--property=ActiveState", "--property=MainPID"]
    stdout: StdioCollector { id: statusOutput; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) { root.statusFinished(exitCode, statusOutput.text) }
  }

  property Process actionProcess: Process {
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (root.phase !== "action") return
      root.processDeadline.stop()
      if (exitCode !== 0) {
        console.warn("line", "daemon recovery failed", root.action, "exit", exitCode)
        root.finish(false)
        return
      }
      root.phase = "wait"
      root.retryTimer.restart()
    }
  }

  function request(force) {
    var now = Date.now()
    if (root.phase !== "idle" || root.statusProcess.running || root.actionProcess.running) return false
    if (now - root.lastRequestMs < (force ? 3000 : 45000)) return false
    root.lastRequestMs = now
    root.requestMs = now
    root.suspectPid = ""
    root.suspectSinceMs = 0
    root.acted = false
    root.beginProbe()
    return true
  }

  function beginProbe() {
    root.phase = "probe"
    root.probeDeadline.restart()
  }

  function probeReply(line) {
    if (root.phase !== "probe") return
    try {
      var reply = JSON.parse(line)
      // A matching refusal also proves the event loop is alive. This keeps
      // recovery safe with an older daemon that does not implement ping yet.
      if (reply && reply.id === "enil-health" && typeof reply.ok === "boolean")
        root.probeFinished(true)
    } catch (e) { /* unsolicited or malformed frames are not a health reply */ }
  }

  function probeFinished(healthy) {
    if (root.phase !== "probe") return
    root.probeDeadline.stop()
    root.phase = "status"
    if (healthy || root.acted) {
      root.finish(healthy)
      return
    }
    root.processDeadline.restart()
    root.statusProcess.running = true
  }

  function statusFinished(exitCode, text) {
    if (root.phase !== "status") return
    root.processDeadline.stop()
    if (exitCode !== 0) {
      console.warn("line", "daemon status query failed", "exit", exitCode)
      root.finish(false)
      return
    }
    var fields = {}
    String(text).split("\n").forEach(function(line) {
      var at = line.indexOf("=")
      if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim()
    })
    var state = fields.ActiveState
    if (state === "inactive" || state === "failed") {
      root.runAction("start", "unit-" + state)
      return
    }
    if (state === "active") {
      var pid = String(fields.MainPID || "")
      if (!/^[1-9][0-9]*$/.test(pid)) { root.finish(false); return }
      var now = Date.now()
      // A new PID is a new startup, not a continuation of the old hang.
      if (root.suspectPid !== pid) {
        root.suspectPid = pid
        root.suspectSinceMs = now
      }
      if (now - root.suspectSinceMs >= root.graceMs) {
        root.runAction("restart", "rpc-unresponsive")
        return
      }
    } else {
      root.suspectPid = ""
      root.suspectSinceMs = 0
      if (["activating", "deactivating", "reloading"].indexOf(state) < 0) {
        root.finish(false)
        return
      }
    }
    // Let systemd finish an in-progress transition; never counter it with a
    // second restart. Bound the check rather than leave recovery busy forever.
    if (Date.now() - root.requestMs > 30000) { root.finish(false); return }
    root.phase = "wait"
    root.retryTimer.restart()
  }

  function runAction(action, reason) {
    if (root.acted) { root.finish(false); return }
    root.acted = true
    root.action = action
    root.actionReason = reason
    root.phase = "action"
    console.log("line", "daemon recovery", action, reason)
    root.actionProcess.command = ["systemctl", "--user", action, "enil.service"]
    root.processDeadline.restart()
    root.actionProcess.running = true
  }

  function finish(healthy) {
    root.probeDeadline.stop()
    root.processDeadline.stop()
    root.retryTimer.stop()
    root.phase = "idle"
    root.finished(healthy)
  }
}

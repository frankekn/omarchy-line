#!/usr/bin/env python3
"""Offscreen Quickshell checks; fake systemctl, sockets and state only."""
from pathlib import Path
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest

REPO = Path(__file__).resolve().parents[2]
QS = shutil.which("quickshell")


class Fixture:
    def __init__(self, root, state):
        self.root = root
        self.state = root / "fixture.json"
        self.state.write_text(json.dumps(state))
        self.actions = root / "actions.jsonl"
        self.actions.touch()
        (root / "bin").mkdir()
        systemctl = root / "bin/systemctl"
        systemctl.write_text('''#!/usr/bin/python3
from pathlib import Path
import json, os, sys, time
root=Path(os.environ["ENIL_TEST_FIXTURE"])
p=root/"fixture.json"
s=json.loads(p.read_text())
a=sys.argv[2]
with (root/"actions.jsonl").open("a") as f:
 f.write(json.dumps({"action":a,"time":time.monotonic()})+"\\n")
if a=="show":
 if s.get("query_error"): sys.exit(1)
 print("ActiveState="+s["unit"])
 print("MainPID="+str(s.get("pid",11)))
elif a in ("start","restart"):
 s.update(unit="active",responsive=True)
 t=p.with_suffix(".tmp");t.write_text(json.dumps(s));t.replace(p)
else: sys.exit(2)
''')
        systemctl.chmod(0o755)
        (root / "runtime").mkdir(mode=0o700)
        (root / "home").mkdir()
        (root / "state/enil").mkdir(parents=True)
        shutil.copy2(REPO / "DaemonSupervisor.qml", root / "DaemonSupervisor.qml")
        (root / "qmldir").write_text("singleton DaemonSupervisor 1.0 DaemonSupervisor.qml\n")
        self.stop = threading.Event()
        self.connections = []
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(root / "state/enil/sock"))
        self.listener.listen()
        self.listener.settimeout(0.1)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except (socket.timeout, OSError):
                continue
            self.connections.append(conn)
            threading.Thread(target=self.answer, args=(conn,), daemon=True).start()

    def answer(self, conn):
        try:
            conn.settimeout(1)
            data = b""
            while b"\n" not in data:
                part = conn.recv(4096)
                if not part:
                    return
                data += part
            request = json.loads(data.split(b"\n")[0])
            assert request == {"id": "enil-health", "cmd": "ping"}
            while not self.stop.wait(0.05):
                state = json.loads(self.state.read_text())
                if state.get("responsive"):
                    # A refusal from a pre-ping daemon is also a valid reply.
                    conn.sendall(json.dumps({"id": request["id"], "ok": False}).encode() + b"\n")
                    return
        except (OSError, ValueError):
            pass
        finally:
            conn.close()

    def close(self):
        self.stop.set()
        self.listener.close()
        for conn in self.connections:
            conn.close()
        self.thread.join(timeout=1)

    def env(self):
        return {
            "PATH": str(self.root / "bin") + ":/usr/bin:/bin",
            "HOME": str(self.root / "home"),
            "XDG_RUNTIME_DIR": str(self.root / "runtime"),
            "XDG_CONFIG_HOME": str(self.root / "home/config"),
            "XDG_CACHE_HOME": str(self.root / "home/cache"),
            "XDG_STATE_HOME": str(self.root / "state"),
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(self.root / "no-bus"),
            "QT_QPA_PLATFORM": "offscreen",
            "ENIL_TEST_FIXTURE": str(self.root),
            "NO_COLOR": "1",
        }

    def run(self, qml, delay_action=None, duration=25):
        path = self.root / "shell.qml"
        path.write_text(qml)
        log_path = self.root / "quickshell.log"
        with log_path.open("w") as log:
            child = subprocess.Popen([QS, "--no-color", "--path", str(path)],
                                     env=self.env(), stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            try:
                if delay_action:
                    delay_action()
                until = time.monotonic() + duration
                while time.monotonic() < until and child.poll() is None:
                    if "RESULT " in log_path.read_text():
                        break
                    time.sleep(0.05)
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
        output = log_path.read_text()
        assert "RESULT " in output, output
        assert "ERROR" not in output and "ReferenceError" not in output, output
        return output, [json.loads(line) for line in self.actions.read_text().splitlines()]


RECOVERY_QML = '''import QtQuick
import Quickshell
ShellRoot {
  QtObject { id: a; function recover() { return DaemonSupervisor.request(false) } }
  QtObject { id: b; function recover() { return DaemonSupervisor.request(false) } }
  Connections {
    target: DaemonSupervisor
    function onFinished(healthy) { console.log("RESULT healthy=" + healthy) }
  }
  Component.onCompleted: Qt.callLater(function() {
    console.log("REQUEST A=" + a.recover())
    console.log("REQUEST B=" + b.recover())
  })
}
'''


@unittest.skipUnless(QS, "quickshell not installed")
class SupervisorTest(unittest.TestCase):
    def recovery(self, state, expected, healthy):
        with tempfile.TemporaryDirectory(prefix="enil-supervisor-") as tmp:
            f = Fixture(Path(tmp), state)
            try:
                output, actions = f.run(RECOVERY_QML)
            finally:
                f.close()
        self.assertIn("REQUEST A=true", output)
        self.assertIn("REQUEST B=false", output)
        self.assertIn("RESULT healthy=" + str(healthy).lower(), output)
        operations = [a for a in actions if a["action"] != "show"]
        self.assertEqual(expected, [a["action"] for a in operations])
        return actions

    def test_healthy_rpc_never_touches_systemd(self):
        self.assertEqual([], self.recovery({"unit": "active", "responsive": True}, [], True))

    def test_two_instances_start_inactive_unit_once(self):
        self.recovery({"unit": "inactive", "responsive": False}, ["start"], True)

    def test_same_unresponsive_pid_gets_full_grace_before_restart(self):
        actions = self.recovery({"unit": "active", "responsive": False}, ["restart"], True)
        self.assertGreaterEqual(actions[-1]["time"] - actions[0]["time"], 10)

    def test_failed_status_query_never_mutates_service(self):
        self.recovery({"unit": "active", "responsive": False, "query_error": True}, [], False)

    def test_short_startup_gap_does_not_restart(self):
        with tempfile.TemporaryDirectory(prefix="enil-supervisor-") as tmp:
            f = Fixture(Path(tmp), {"unit": "active", "responsive": False})
            try:
                def recover():
                    time.sleep(4)
                    f.state.write_text(json.dumps({"unit": "active", "responsive": True}))
                output, actions = f.run(RECOVERY_QML, recover)
            finally:
                f.close()
        self.assertIn("RESULT healthy=true", output)
        self.assertTrue(all(a["action"] == "show" for a in actions))

    def test_late_state_directory_does_not_request_recovery(self):
        panel = (REPO / "Panel.qml").read_text().splitlines()
        def method(name):
            i = next(i for i, line in enumerate(panel) if line.startswith("  function " + name + "("))
            j = next(j for j in range(i + 1, len(panel)) if panel[j] == "  }")
            return "\n".join(panel[i:j+1])
        with tempfile.TemporaryDirectory(prefix="enil-supervisor-") as tmp:
            f = Fixture(Path(tmp), {"unit": "active", "responsive": True})
            state = Path(tmp) / "late/enil/state.json"
            qml = '''import QtQuick
import Quickshell
import Quickshell.Io
ShellRoot {
  id: root
  property var state: null
  property double nowMs: Date.now()
  property bool stateReloadPending: false
  property int kicks: 0
  readonly property bool online: !!state && nowMs - Number(state.updatedAt || 0) < 180000
  function kickDaemon(force) { kicks++ }
  FileView {
    id: stateFile
    path: PATH_VALUE
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: { root.state=JSON.parse(text()); root.finishStateReload() }
    onLoadFailed: { root.state=null; root.finishStateReload() }
  }
  GUARD
  FINISH
  Timer { interval: 1200; running: true; onTriggered: root.guardDaemon() }
  Timer { interval: 1700; running: true; onTriggered: console.log("RESULT online="+root.online+" kicks="+root.kicks) }
}
'''.replace("PATH_VALUE", json.dumps(str(state))).replace("GUARD", method("guardDaemon")).replace("FINISH", method("finishStateReload"))
            try:
                def create_state():
                    time.sleep(0.5)
                    state.parent.mkdir(parents=True)
                    state.write_text(json.dumps({"updatedAt": int(time.time()*1000)}))
                output, actions = f.run(qml, create_state, duration=5)
            finally:
                f.close()
        self.assertIn("RESULT online=true kicks=0", output)
        self.assertEqual([], actions)


if __name__ == "__main__":
    unittest.main()

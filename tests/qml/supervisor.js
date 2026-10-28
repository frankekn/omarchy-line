"use strict";
// Real singleton method bodies, fake clock/I/O. No systemctl, socket or LINE.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../../DaemonSupervisor.qml"), "utf8");

function body(name) {
  const lines = source.split("\n");
  const first = lines.findIndex((line) => line.startsWith("  function " + name + "("));
  assert(first >= 0, name);
  const last = lines.findIndex((line, i) => i > first && line === "  }");
  return lines.slice(first + 1, last).join("\n");
}

function fixture() {
  let now = 1000000;
  const results = [];
  const timer = () => ({ restart() {}, stop() {} });
  const root = {
    phase: "idle", lastRequestMs: 0, requestMs: 0,
    suspectPid: "", suspectSinceMs: 0, graceMs: 10000, acted: false,
    statusProcess: { running: false }, actionProcess: { running: false },
    probeDeadline: timer(), retryTimer: timer(), processDeadline: timer(),
    finished: (healthy) => results.push(healthy),
  };
  const args = {
    request: ["force"], beginProbe: [], probeReply: ["line"],
    probeFinished: ["healthy"], statusFinished: ["exitCode", "text"],
    runAction: ["action", "reason"], finish: ["healthy"],
  };
  for (const [name, names] of Object.entries(args)) {
    const f = new Function("root", "Date", "console", ...names, body(name));
    root[name] = (...values) => f(root, { now: () => now }, { log() {}, warn() {} }, ...values);
  }
  return {
    root, results,
    advance: (ms) => { now += ms; },
    status(state, pid = "11", exitCode = 0) {
      root.statusProcess.running = false;
      root.statusFinished(exitCode, "ActiveState=" + state + "\nMainPID=" + pid + "\n");
    },
    failedProbe() { root.beginProbe(); root.probeFinished(false); },
  };
}

{
  const { root, results } = fixture();
  assert.equal(root.request(false), true);
  assert.equal(root.request(false), false, "a second panel joins the same in-flight check");
  root.probeReply('{"id":"other","ok":true}');
  root.probeReply("bad json");
  assert.equal(root.phase, "probe");
  root.probeReply('{"id":"enil-health","ok":false}');
  assert.deepEqual(results, [true], "even an older daemon's matching refusal proves it is alive");
  assert.equal(root.actionProcess.running, false);
  assert.equal(root.request(true), false, "manual clicks share the cooldown too");
}
for (const state of ["inactive", "failed"]) {
  const f = fixture();
  f.root.request(false);
  f.root.probeFinished(false);
  f.status(state);
  assert.deepEqual(f.root.actionProcess.command, ["systemctl", "--user", "start", "enil.service"]);
  assert.equal(f.root.request(false), false, "an operation in progress cannot be duplicated");
}
{
  const f = fixture();
  f.root.request(false);
  f.root.probeFinished(false);
  f.status("active");
  assert.equal(f.root.phase, "wait");
  f.advance(9999);
  f.failedProbe(); f.status("active");
  assert.equal(f.root.actionProcess.running, false, "short disconnects never restart a live unit");
  f.advance(1);
  f.failedProbe(); f.status("active");
  assert.deepEqual(f.root.actionProcess.command, ["systemctl", "--user", "restart", "enil.service"]);
  assert.equal(f.root.actionReason, "rpc-unresponsive");
}
{
  const f = fixture();
  f.root.request(false); f.root.probeFinished(false); f.status("active", "11");
  f.advance(10000); f.failedProbe(); f.status("active", "12");
  assert.equal(f.root.actionProcess.running, false, "a replacement PID gets a new grace window");
  f.advance(5000); f.failedProbe();
  f.root.probeReply('{"id":"enil-health","ok":true}');
  // failedProbe has moved to status, so a stale reply cannot change that check.
  assert.equal(f.root.phase, "status");
  f.status("active", "12");
  assert.equal(f.root.actionProcess.running, false);
  f.root.beginProbe(); f.root.probeReply('{"id":"enil-health","ok":true}');
  assert.deepEqual(f.results, [true]);
}
for (const [state, pid, code] of [["active", "0", 0], ["unknown", "11", 0], ["inactive", "0", 1]]) {
  const f = fixture();
  f.root.request(false); f.root.probeFinished(false); f.status(state, pid, code);
  assert.equal(f.root.actionProcess.running, false, "unknown status is never permission to mutate the unit");
  assert.deepEqual(f.results, [false]);
}
{
  const f = fixture();
  f.root.request(false); f.root.probeFinished(false); f.status("active", "11");
  f.advance(9000); f.failedProbe(); f.status("activating", "11");
  f.advance(5000); f.failedProbe(); f.status("active", "11");
  assert.equal(f.root.actionProcess.running, false, "a systemd transition resets even an unchanged PID's grace");
  f.advance(31000); f.failedProbe(); f.status("deactivating");
  assert.equal(f.root.actionProcess.running, false);
  assert.deepEqual(f.results, [false], "systemd transitions are not countered by restarts");
}
{
  const f = fixture();
  f.root.request(false); f.root.probeFinished(false); f.status("inactive");
  f.root.actionProcess.running = false;
  f.failedProbe();
  assert.deepEqual(f.results, [false], "one recovery attempt issues at most one service operation");
  assert.equal(f.root.phase, "idle");
}
console.log("PASS shared daemon supervisor: coalescing, RPC, cooldown, status, grace, PID changes and failures");

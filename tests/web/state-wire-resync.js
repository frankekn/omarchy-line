// A missing state patch reconnects without a false offline notice.
import { assert, tapSocket, until } from "./harness.js";

export async function stateWireResync(h) {
  const context = await h.context({ locale: "en-US" });
  await context.addInitScript(() => {
    globalThis.__resyncTrace = {
      connections: [],
      changes: [],
      receivedAt: 0,
      handling: false,
    };
  });
  const source = await Deno.readTextFile(
    new URL("../../daemon/web/public/js/connection.js", import.meta.url),
  );
  const socketLine = "    model.socket = socket;";
  const frameLine = "      const decoded = decodeState(frame);";
  assert.equal(source.split(socketLine).length, 2);
  assert.equal(source.split(frameLine).length, 2);
  const instrumented = source.replace(
    socketLine,
    `    globalThis.__resyncTrace.connections.push({
      at: performance.now(), sameTurn: globalThis.__resyncTrace.handling,
    });\n${socketLine}`,
  ).replace(
    frameLine,
    `      if (frame.testResync) {
        const trace = globalThis.__resyncTrace;
        trace.receivedAt = performance.now();
        trace.handling = true;
        queueMicrotask(() => trace.handling = false);
        const status = document.getElementById("connection");
        const notices = document.getElementById("notices");
        const toast = document.getElementById("toast");
        const capture = () => trace.changes.push({
          connected: status.classList.contains("connected"),
          text: document.getElementById("connection-text").textContent,
          noticesHidden: notices.hidden,
          toastHidden: toast.hidden,
        });
        capture();
        const observer = new MutationObserver(capture);
        for (const element of [status, notices, toast]) {
          observer.observe(element, {
            attributes: true, characterData: true, childList: true, subtree: true,
          });
        }
      }
${frameLine}`,
  );
  await context.route(
    "**/js/connection.js",
    (route) =>
      route.fulfill({ contentType: "text/javascript", body: instrumented }),
  );
  const page = await context.newPage();
  let heldHistory;
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.cmd !== "history" || heldHistory) return true;
      heldHistory = frame;
      return false;
    },
  });
  await h.signIn(page);
  const full = tap.received.find((frame) => frame.web === "state");
  assert.ok(full?.generation);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await until(() => heldHistory, "pending history before resync");
  tap.socket.send(JSON.stringify({
    web: "state-delta",
    generation: full.generation,
    base: full.version + 1,
    version: full.version + 2,
    state: {},
    remove: [],
    put: [],
    testResync: true,
  }));
  await until(
    () => tap.received.filter((frame) => frame.web === "state").length >= 2,
    "fresh snapshot after resync",
    10000,
  );
  await page.locator("#connection.connected").waitFor();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  await page.waitForTimeout(100);
  const trace = await page.evaluate(() => globalThis.__resyncTrace);
  console.log("  resync trace", JSON.stringify(trace));
  assert.equal(trace.connections.length, 2);
  assert.ok(trace.receivedAt > 0);
  assert.equal(trace.connections[1].sameTurn, true);
  assert.ok(trace.changes.length > 0);
  assert.ok(
    trace.changes.every((entry) =>
      entry.connected && entry.text === "Connected" && entry.noticesHidden &&
      entry.toastHidden
    ),
    JSON.stringify(trace.changes),
  );
  h.step("state-resync-immediate-without-offline-ui");
}

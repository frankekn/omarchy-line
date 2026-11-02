// Read-only daemon status in the settings dialog: the rows come from state
// metadata, a field the daemon does not write is not shown, and the block
// stays usable at 320px and 200% text.
import axe from "npm:axe-core@4.10.3";
import { assert, tapSocket, until } from "./harness.js";

async function rows(page) {
  return await page.locator("#daemon-status-list").evaluate((list) => {
    const out = {};
    for (const term of list.querySelectorAll("dt")) {
      out[term.textContent] = term.nextElementSibling?.textContent ?? "";
    }
    return out;
  });
}

export async function daemonStatus(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    // This context bypasses CSP to inject axe; the app's headers are
    // unchanged.
    bypassCSP: true,
  });
  const page = await context.newPage();
  await h.signIn(page);
  await page.locator("#settings-open").click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor();
  const section = dialog.getByRole("region", { name: "Status" });
  await section.waitFor();
  let shown = await rows(page);
  assert.equal(shown["LINE sign-in"], "Signed in (STUB User)");
  assert.equal(shown["Sync failures in a row"], "0");
  assert(shown["Last sync"], "last sync time");
  assert(shown["State updated"], "state time");
  // The stub writes no push link state, so there is no push row.
  assert.equal("Push connection" in shown, false);
  // Read-only: nothing in the block can take focus or act.
  assert.equal(
    await section.locator("button, input, a, [tabindex]").count(),
    0,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  h.step("status-rows-from-state");

  // Two failed refresh rounds: the count shows when the dialog opens again.
  await h.request({ cmd: "fail-refresh" });
  await h.request({ cmd: "fail-refresh" });
  await until(async () => {
    await page.locator("#settings-open").click();
    await dialog.waitFor();
    shown = await rows(page);
    if (shown["Sync failures in a row"]?.startsWith("2")) return true;
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    return false;
  }, "two sync failures");
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate(async () => {
    const scan = await globalThis.axe.run("#settings", {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    return scan.violations.map((rule) => rule.id);
  });
  assert.deepEqual(result, [], "axe on the settings dialog");
  h.step("status-failures-and-axe");
  await context.close();

  // A phone, with a push link up since yesterday: every value stays on one
  // line, and the themes fill an even grid.
  const phone = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phonePage = await phone.newPage();
  const since = Date.now() - 26 * 3600_000;
  await tapSocket(phonePage, {
    server(frame) {
      if (frame.web === "state" && frame.state) {
        frame.state.link = { push: "up", since };
      }
      return true;
    },
  });
  await h.signIn(phonePage);
  await phonePage.locator("#settings-open").tap();
  await phonePage.getByRole("region", { name: "Status" }).waitFor();
  shown = await rows(phonePage);
  assert.match(shown["Push connection"], /^Connected · since \S+/);
  // Today's times are the clock alone.
  assert.match(shown["Last sync"], /^\d{1,2}:\d\d [AP]M$/);
  const lines = await phonePage.locator("#daemon-status-list").evaluate(
    (list) =>
      [...list.querySelectorAll("dd")].map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const tops = new Set(
          [...range.getClientRects()].map((rect) => Math.round(rect.top)),
        );
        return `${node.previousElementSibling.textContent} ${tops.size}`;
      }),
  );
  assert.deepEqual(
    lines,
    Object.keys(shown).map((label) => `${label} 1`),
    "one line per value",
  );
  const cells = await phonePage.locator("#themes label").evaluateAll((
    labels,
  ) =>
    labels.map((node) => {
      const box = node.getBoundingClientRect();
      return [Math.round(box.left), Math.round(box.width)];
    })
  );
  const [system, ...named] = cells;
  const lefts = new Set(named.map(([left]) => left));
  const widths = new Set(named.map(([, width]) => width));
  assert.equal(named.length, 10);
  assert.equal(lefts.size, 2, "two columns");
  assert.equal(widths.size, 1, "equal cells");
  assert.ok(system[1] > [...widths][0] * 2, "Match system spans the row");
  h.step("status-one-line-and-theme-grid-390");
  await phone.close();

  // 320px wide at 200% text: no horizontal scroll in the dialog.
  const narrow = await h.context({
    locale: "zh-TW",
    viewport: { width: 320, height: 640 },
  });
  await narrow.addInitScript(() => {
    if (location.protocol !== "http:") return;
    localStorage["enil.settings"] = JSON.stringify({
      theme: "system",
      textSize: 150,
      sound: false,
    });
  });
  const small = await narrow.newPage();
  await h.signIn(small);
  // The largest app size, then the browser text doubled on top of it.
  await small.evaluate(() => document.documentElement.style.fontSize = "200%");
  await small.locator("#settings-open").click();
  const zh = small.getByRole("dialog", { name: "設定" });
  await zh.waitFor();
  await zh.getByRole("region", { name: "狀態" }).scrollIntoViewIfNeeded();
  const fits = await small.locator("#settings").evaluate((node) =>
    node.scrollWidth <= node.clientWidth
  );
  assert(fits, "status fits 320px at 200%");
  shown = await rows(small);
  assert.equal(shown["LINE 登入"], "已登入 (STUB User)");
  h.step("status-narrow-zh");
  await narrow.close();
}

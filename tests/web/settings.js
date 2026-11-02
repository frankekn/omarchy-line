// Settings dialog: saved theme and text size without a flash, AA contrast in
// every theme, no horizontal scroll at the largest size, the new-message
// sound, and keyboard use.
import axe from "npm:axe-core@4.10.3";
import { assert, tapSocket, until } from "./harness.js";

const THEMES = [
  "system",
  "catppuccin",
  "catppuccin-latte",
  "everforest",
  "flexoki-light",
  "gruvbox",
  "kanagawa",
  "matte-black",
  "nord",
  "rose-pine",
  "tokyo-night",
];

// Count started tones instead of playing them, and record the background of
// the first frame before any page script runs.
function instrument() {
  globalThis.__tones = 0;
  class FakeParam {
    setValueAtTime() {}
    exponentialRampToValueAtTime() {}
  }
  class FakeNode {
    constructor() {
      this.frequency = new FakeParam();
      this.gain = new FakeParam();
    }
    connect(node) {
      return node;
    }
    start() {
      globalThis.__tones++;
    }
    stop() {}
  }
  globalThis.AudioContext = class {
    currentTime = 0;
    destination = {};
    resume() {
      return Promise.resolve();
    }
    createOscillator() {
      return new FakeNode();
    }
    createGain() {
      return new FakeNode();
    }
  };
  requestAnimationFrame(() => {
    globalThis.__firstFrame = {
      theme: document.documentElement.dataset.theme || "",
      size: document.documentElement.dataset.textSize || "",
      background: getComputedStyle(document.body).backgroundColor,
      fontSize: getComputedStyle(document.documentElement).fontSize,
    };
  });
}

export async function settings(h) {
  await keyboardAndSound(h);
  await contrast(h);
  await narrow(h);
}

async function keyboardAndSound(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  let boot = "", account = "";
  const tap = await tapSocket(page, {
    server(frame) {
      if (frame.web === "state" && frame.state) {
        boot = String(frame.state.bootId || boot);
        account = String(frame.state.me?.mid || account);
      }
      return true;
    },
  });
  await h.signIn(page);

  // Keyboard: open, change every setting, close with Escape.
  const opener = page.locator("#settings-open");
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.value),
    "100",
  );
  await page.keyboard.press("ArrowRight");
  await until(
    () =>
      page.evaluate(() => document.documentElement.dataset.textSize === "115"),
    "text size 115",
  );
  // The theme radios start at "system"; arrow keys choose a theme.
  await page.keyboard.press("Tab");
  assert.deepEqual(
    await page.evaluate(() => [
      document.activeElement?.name,
      document.activeElement?.value,
    ]),
    ["theme", "system"],
  );
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "nord",
  );
  // The page creates no <select>: WebKit reports a CSP violation for one.
  assert.equal(await page.locator("select").count(), 0);
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "sound-toggle",
  );
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#sound-toggle").isChecked(), true);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "settings-close",
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "settings-open",
  );
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage["enil.settings"])),
    { theme: "nord", textSize: 115, sound: true },
  );
  h.step("keyboard changes and saves every setting");

  await page.reload({ waitUntil: "load" });
  await page.locator("#connection.connected").waitFor();
  // WebKit can lay out the page and connect before its first rendering
  // update runs the requestAnimationFrame callback that records the frame.
  await until(
    () => page.evaluate(() => globalThis.__firstFrame !== undefined),
    "first frame",
  );
  const first = await page.evaluate(() => globalThis.__firstFrame);
  assert.deepEqual(first, {
    theme: "nord",
    size: "115",
    background: "rgb(34, 39, 48)",
    fontSize: "16.1px",
  });
  assert.equal(
    await page.locator('meta[name="theme-color"]').getAttribute("content"),
    "#2e3440",
  );
  assert.equal(
    await page.locator('meta[name="color-scheme"]').getAttribute("content"),
    "dark",
  );
  h.step("reload paints the saved theme and size in the first frame");

  // Sound: hide one chat, then view another.
  await page.getByRole("button", { name: /STUB Alice/ }).click();
  await page.getByLabel("Chat options", { exact: true }).click();
  await page.locator("#hide-chat").click();
  await page.locator("#hide-chat", { hasText: "Unhide" }).waitFor();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.locator("#active-name", { hasText: "STUB 家庭群組" }).waitFor();
  await until(() => boot && account, "state frame");
  let seq = 1_000_000;
  const inject = (chat, from) => {
    seq++;
    tap.socket.send(JSON.stringify({
      boot,
      event: {
        seq,
        kind: "message",
        chat,
        message: {
          id: String(9_000_000 + seq),
          chat,
          from,
          fromName: "Peer",
          time: Date.now(),
          text: `sound ${seq}`,
          contentType: "NONE",
        },
      },
    }));
  };
  const tones = () => page.evaluate(() => globalThis.__tones);
  const settle = () => page.waitForTimeout(150);
  await page.bringToFront();
  inject("cstub-family", "upeer-sound");
  await settle();
  assert.equal(await tones(), 0, "the chat in view stays quiet");
  inject("cstub-work", "upeer-sound");
  await until(async () => await tones() === 1, "first tone");
  inject("cstub-work", "upeer-sound");
  await settle();
  assert.equal(await tones(), 1, "a second tone within 2 s is dropped");
  inject("rstub-lunch", account);
  await settle();
  assert.equal(await tones(), 1, "own messages stay quiet");
  inject("ustub-alice", "upeer-sound");
  await settle();
  assert.equal(await tones(), 1, "hidden chats stay quiet");
  await page.waitForTimeout(2100);
  inject("cstub-work", "upeer-sound");
  await until(async () => await tones() === 2, "tone after the gap");
  await opener.click();
  await page.locator("#sound-toggle").uncheck();
  await page.keyboard.press("Escape");
  inject("rstub-lunch", "upeer-sound");
  await settle();
  assert.equal(await tones(), 2, "the sound is off");
  h.step("sound plays only for new messages in other visible chats");
  await context.close();
}

async function contrast(h) {
  for (const colorScheme of ["dark", "light"]) {
    const context = await h.context({
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
      colorScheme,
      // This context bypasses CSP to inject axe; the app's headers are
      // unchanged.
      bypassCSP: true,
    });
    const page = await context.newPage();
    await h.signIn(page);
    await page.addScriptTag({ content: axe.source });
    await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
    await page.locator("article.message-row").first().waitFor();
    // The system theme only differs by scheme; named themes need one pass.
    const themes = colorScheme === "dark" ? THEMES : ["system"];
    for (const theme of themes) {
      await page.evaluate((theme) => {
        globalThis.enilSettings.apply({ theme, textSize: 100, sound: false });
      }, theme);
      // Settings, and the quick switcher with its tinted choice.
      for (const open of [null, "#settings-open", "#switcher-open"]) {
        if (open) await page.locator(open).click();
        if (open === "#switcher-open") {
          await page.locator("#switcher-list [aria-selected=true]").waitFor();
          // Typing must reach the filter, however the switcher opened.
          await page.waitForFunction(() =>
            document.activeElement?.id === "switcher-input"
          );
          await page.keyboard.press("ArrowDown");
        }
        const violations = await page.evaluate(async () => {
          const scan = await globalThis.axe.run(document, {
            runOnly: { type: "rule", values: ["color-contrast"] },
          });
          return scan.violations.flatMap((rule) =>
            rule.nodes.map((node) => ({
              target: node.target,
              failure: node.failureSummary,
            }))
          );
        });
        assert.deepEqual(
          violations,
          [],
          `${theme} ${colorScheme} ${open ?? ""}`,
        );
        if (open) {
          await page.keyboard.press("Escape");
          const dialog = open === "#switcher-open" ? "#switcher" : "#settings";
          await page.locator(dialog).waitFor({ state: "hidden" });
        }
      }
      h.step(
        `axe contrast ${theme}${theme === "system" ? ` ${colorScheme}` : ""}`,
      );
    }
    await context.close();
  }
}

async function narrow(h) {
  const context = await h.context({
    locale: "zh-TW",
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    // about:blank denies storage; only the app origin needs the setting.
    if (location.protocol !== "http:") return;
    localStorage["enil.settings"] = JSON.stringify({
      theme: "gruvbox",
      textSize: 150,
      sound: false,
    });
  });
  const page = await context.newPage();
  await h.signIn(page);
  const overflow = () =>
    page.evaluate(() =>
      [
        document.scrollingElement,
        ...document.querySelectorAll(
          ".sidebar, .sidebar-bottom, .chat-header, .composer, .settings",
        ),
      ].flatMap((node) =>
        node && node.getClientRects().length &&
          node.scrollWidth > node.clientWidth + 1
          ? [`${node.className || node.tagName} ${node.scrollWidth}`]
          : []
      )
    );
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).fontSize),
    "21px",
  );
  assert.deepEqual(await overflow(), [], "chat list");
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.locator("article.message-row").first().waitFor();
  assert.deepEqual(await overflow(), [], "chat");
  await page.locator("#back").click();
  await page.locator("#settings-open").click();
  await page.locator("#settings").waitFor();
  assert.deepEqual(await overflow(), [], "settings");
  h.step("150% text at 320 px has no horizontal scroll");
  await context.close();
}

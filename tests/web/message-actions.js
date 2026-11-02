// Copy, save and forward actions, voice playback and location links.
import { assert, CHAT, tapSocket, until } from "./harness.js";

/** A silent mono 8 kHz, 16-bit PCM WAV of `seconds` length. */
function silentWav(seconds) {
  const rate = 8000, samples = rate * seconds, size = 44 + samples * 2;
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, size - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

export async function messageActions(h) {
  const voicePath = `${h.stateDir}/media/test-voice`;
  await Deno.writeFile(voicePath, silentWav(2));
  const text = "Copy and forward me 42";
  await h.request({ id: 1, cmd: "poke", chat: CHAT, text });
  const now = Date.now();
  const extra = [
    {
      id: "voice-known",
      chat: CHAT,
      from: "ustub-mom",
      fromName: "STUB 媽",
      text: "",
      time: now,
      contentType: "AUDIO",
      hasMedia: true,
      unsent: false,
      decryptFailed: false,
      mediaState: "ok",
      audioMs: 3456,
    },
    {
      id: "voice-unknown",
      chat: CHAT,
      from: "ustub-mom",
      fromName: "STUB 媽",
      text: "",
      time: now + 1000,
      contentType: "AUDIO",
      hasMedia: true,
      unsent: false,
      decryptFailed: false,
      mediaState: "ok",
    },
    {
      id: "place-1",
      chat: CHAT,
      from: "ustub-mom",
      fromName: "STUB 媽",
      text: "Taipei 101",
      time: now + 2000,
      contentType: "LOCATION",
      hasMedia: false,
      unsent: false,
      decryptFailed: false,
      mediaState: "ok",
      location: {
        title: "Taipei 101",
        address: "No. 7, Section 5, Xinyi Road",
        latitude: 25.033964,
        longitude: 121.564468,
      },
    },
  ];
  const context = await h.context({ locale: "en-US", acceptDownloads: true });
  const page = await context.newPage();
  const histories = new Set();
  const tap = await tapSocket(page, {
    client(frame, tap) {
      if (frame.cmd === "history" && frame.chat === CHAT && !frame.before) {
        histories.add(frame.id);
      }
      if (frame.cmd === "download" && frame.messageId.startsWith("voice-")) {
        tap.socket.send(JSON.stringify({
          id: frame.id,
          ok: true,
          data: { path: voicePath },
        }));
        return false;
      }
      return true;
    },
    server(frame) {
      if (histories.delete(frame.id) && Array.isArray(frame.data)) {
        frame.data.push(...extra);
      }
      return true;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  const log = page.getByRole("log");
  const textRow = log.locator("article.message-row").filter({ hasText: text });
  await textRow.waitFor();

  // A plain HTTP origin has no navigator.clipboard; copy selects text instead.
  assert.equal(await page.evaluate(() => globalThis.isSecureContext), false);
  assert.equal(await page.evaluate(() => !!navigator.clipboard), false);
  await page.evaluate(() => {
    globalThis.copiedText = [];
    document.addEventListener("copy", (event) => {
      const area = event.target;
      globalThis.copiedText.push(
        area instanceof HTMLTextAreaElement
          ? area.value.slice(area.selectionStart, area.selectionEnd)
          : String(globalThis.getSelection()),
      );
    });
  });
  await textRow.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await page.locator("#toast:not([hidden])").filter({ hasText: "Copied" })
    .waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.copiedText), [text]);
  assert.equal(await page.locator(".copy-buffer").count(), 0);
  h.step("copy-selection-fallback");

  // When the browser refuses that too, the text opens selected in a dialog.
  await page.evaluate(() => {
    document.execCommand = () => false;
  });
  const copyButton = textRow.getByRole("button", { name: "Message actions" });
  await copyButton.click();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  const copyDialog = page.locator("dialog.copy-dialog[open]");
  await copyDialog.waitFor();
  const area = copyDialog.locator("textarea");
  assert.equal(await area.inputValue(), text);
  assert.equal(
    await area.evaluate((node) =>
      document.activeElement === node &&
      node.selectionEnd - node.selectionStart === node.value.length
    ),
    true,
  );
  await page.keyboard.press("Escape");
  await copyDialog.waitFor({ state: "detached" }).catch(() => {});
  await until(
    () => page.locator("dialog.copy-dialog[open]").count().then((n) => !n),
    "copy dialog closed",
  );
  assert.equal(
    await copyButton.evaluate((n) => document.activeElement === n),
    true,
  );
  h.step("copy-manual-dialog");

  // A secure origin uses the asynchronous clipboard API.
  await page.evaluate(() => {
    globalThis.clipboardWrites = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value) {
          globalThis.clipboardWrites.push(value);
          return Promise.resolve();
        },
      },
    });
  });
  await copyButton.click();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await until(
    () => page.evaluate(() => globalThis.clipboardWrites.length === 1),
    "clipboard write",
  );
  assert.deepEqual(await page.evaluate(() => globalThis.clipboardWrites), [
    text,
  ]);
  h.step("copy-clipboard-api");

  // Saving an image asks /api/file for a named attachment.
  const imageRow = log.locator('article[data-message-id="cstub-family-m3"]');
  await imageRow.scrollIntoViewIfNeeded();
  const download = page.waitForEvent("download");
  await imageRow.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  const saved = await download;
  assert.equal(saved.suggestedFilename(), "line-image-cstub-family-m3.png");
  const savedUrl = new URL(saved.url());
  assert.equal(savedUrl.pathname, "/api/file");
  assert.equal(savedUrl.searchParams.get("download"), "1");
  assert.equal(
    savedUrl.searchParams.get("name"),
    "line-image-cstub-family-m3",
  );
  assert.equal(await textRow.locator('[data-action="save"]').count(), 0);
  h.step("save-image-named");

  // Voice: the known length shows at once, the other after its metadata.
  const known = log.locator('article[data-message-id="voice-known"]');
  await known.scrollIntoViewIfNeeded();
  assert.equal(await known.locator(".voice-length").textContent(), "0:03");
  await known.getByRole("button", { name: "Play voice message" }).click();
  const knownAudio = known.locator("audio.voice-player");
  await knownAudio.waitFor();
  assert.equal(await knownAudio.evaluate((node) => node.controls), true);
  assert.match(await knownAudio.getAttribute("src"), /^blob:/);
  assert.equal(await knownAudio.getAttribute("aria-label"), "Voice message");
  await until(
    () => knownAudio.evaluate((node) => node.readyState >= 1),
    "voice metadata",
  );
  assert.equal(await known.locator(".voice-length").textContent(), "0:03");
  const unknown = log.locator('article[data-message-id="voice-unknown"]');
  assert.equal(await unknown.locator(".voice-length").textContent(), "");
  await unknown.getByRole("button", { name: "Play voice message" }).click();
  await until(
    async () => await unknown.locator(".voice-length").textContent() === "0:02",
    "voice length from metadata",
  );
  assert.ok(
    tap.sent.some((m) => m.cmd === "download" && m.messageId === "voice-known"),
  );
  assert.equal(
    await unknown.locator('[data-action="save"]').count(),
    1,
  );
  h.step("voice-playback-length");

  // Location: title, address and an external map link, nothing embedded.
  const place = log.locator('article[data-message-id="place-1"]');
  await place.scrollIntoViewIfNeeded();
  assert.equal(
    await place.locator(".location-title").textContent(),
    "Taipei 101",
  );
  assert.equal(
    await place.locator(".location-address").textContent(),
    "No. 7, Section 5, Xinyi Road",
  );
  assert.equal(await place.locator(".message-text").count(), 0);
  const link = place.getByRole("link", { name: "Open in Maps" });
  assert.equal(
    await link.getAttribute("href"),
    "https://www.google.com/maps?q=25.033964,121.564468",
  );
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await place.locator("img, iframe").count(), 0);
  h.step("location-link");

  // Forward: pick a chat, confirm, and the same text goes out with send.
  const dialogsBefore = h.dialogs.length;
  await textRow.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Forward", exact: true }).click();
  const picker = page.locator("dialog.forward-dialog[open]");
  await picker.waitFor();
  await picker.getByRole("combobox").fill("alice");
  await picker.getByRole("option", { name: "STUB Alice" }).waitFor();
  await page.keyboard.press("Enter");
  await until(
    () =>
      tap.sent.some((m) =>
        m.cmd === "send" && m.chat === "ustub-alice" && m.text === text &&
        typeof m.requestId === "string"
      ),
    "forwarded send",
  );
  assert.equal(h.dialogs.length, dialogsBefore + 1);
  assert.equal(h.dialogs.at(-1).type, "confirm");
  assert.match(h.dialogs.at(-1).message, /STUB Alice/);
  await page.locator("#toast:not([hidden])").filter({
    hasText: "Forwarded to STUB Alice",
  }).waitFor();
  assert.equal(await page.locator("dialog.forward-dialog[open]").count(), 0);
  assert.equal(
    await place.locator('[data-action="forward"]').count(),
    0,
  );
  h.step("forward-text");

  // Menu keyboard semantics, native dismissal and bounds at a narrow edge.
  const more = textRow.getByRole("button", { name: "Message actions" });
  await more.focus();
  await more.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Message actions" });
  assert.equal(await menu.locator(":focus").textContent(), "Reply");
  await page.keyboard.press("End");
  assert.equal(await menu.locator(":focus").textContent(), "Forward");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  assert.equal(await menu.locator(":focus").textContent(), "React");
  await page.keyboard.press("Escape");
  assert.equal(await more.evaluate((n) => document.activeElement === n), true);
  await more.click();
  await page.locator("#messages").dispatchEvent("scroll");
  assert.equal(await menu.isVisible(), true);
  await page.locator("#messages").evaluate((list) => {
    list.scrollTop += list.scrollTop > 20 ? -20 : 20;
  });
  await menu.waitFor({ state: "hidden" });
  assert.equal(await more.evaluate((n) => document.activeElement === n), true);
  await more.click();
  await page.mouse.click(2, 2);
  assert.equal(await menu.isVisible(), false);
  h.step("menu-keyboard-dismiss-scroll");

  await more.click();
  assert.equal(await menu.isVisible(), true);
  await more.click();
  assert.equal(await menu.isVisible(), false);
  const originalReply = textRow.locator('[data-action="reply"]');
  await originalReply.evaluate((button) => button.disabled = true);
  await more.click();
  assert.equal(
    await page.getByRole("menuitem", { name: "Reply", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await menu.locator(":focus").textContent(), "React");
  await menu.locator(":focus").press("Home");
  assert.equal(await menu.locator(":focus").textContent(), "React");
  await page.keyboard.press("Escape");
  await originalReply.evaluate((button) => button.disabled = false);
  h.step("menu-toggle-and-disabled-actions");

  const state = await h.state();
  let injectedSeq = Math.max(0, ...state.events.map((event) => event.seq));
  await page.locator("#messages").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await page.waitForFunction(() => {
    const list = document.getElementById("messages");
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 2;
  });
  const placeMore = place.locator(".message-more");
  await placeMore.click();
  const anchorBefore = await placeMore.boundingBox();
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: {
      seq: ++injectedSeq,
      at: Date.now(),
      kind: "message",
      chat: CHAT,
      message: {
        id: "menu-live",
        chat: CHAT,
        from: "ustub-mom",
        fromName: "STUB 媽",
        time: Date.now() + 10000,
        text: "Arrived while choosing an action",
        contentType: "NONE",
      },
    },
  }));
  await page.locator('[data-message-id="menu-live"]').waitFor({
    state: "attached",
  });
  await page.evaluate(() =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  );
  assert.equal(await menu.isVisible(), true);
  assert.equal(await menu.locator(":focus").textContent(), "Reply");
  const anchorAfter = await placeMore.boundingBox();
  assert.ok(Math.abs(anchorAfter.y - anchorBefore.y) <= 1);
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await page.locator("#reply-target").waitFor();
  assert.match(await page.locator("#reply-label").textContent(), /Taipei 101/);
  await page.locator("#cancel-reply").click();
  const jump = page.getByRole("button", {
    name: "Jump to latest",
    exact: true,
  });
  const atBottom = () =>
    page.waitForFunction(() => {
      const list = document.getElementById("messages");
      return list.scrollHeight - list.scrollTop - list.clientHeight <= 2;
    });
  const arrive = async (id) => {
    tap.socket.send(JSON.stringify({
      boot: state.bootId,
      event: {
        seq: ++injectedSeq,
        at: Date.now(),
        kind: "message",
        chat: CHAT,
        message: {
          id,
          chat: CHAT,
          from: "ustub-mom",
          fromName: "STUB 媽",
          time: Date.now() + 11000 + injectedSeq,
          text: "Another incoming message",
          contentType: "NONE",
        },
      },
    }));
    await page.locator(`[data-message-id="${id}"]`).waitFor({
      state: "attached",
    });
  };
  await atBottom();
  await arrive("menu-after-reply");
  await atBottom();
  for (const dismissal of ["escape", "outside"]) {
    await page.locator(".message-more").last().click();
    await arrive(`menu-paused-${dismissal}`);
    assert.equal(await menu.isVisible(), true);
    const distance = await page.locator("#messages").evaluate((list) =>
      list.scrollHeight - list.scrollTop - list.clientHeight
    );
    assert.ok(distance > 2 && distance < 120, String(distance));
    if (dismissal === "escape") await page.keyboard.press("Escape");
    else await page.mouse.click(2, 2);
    await atBottom();
    await arrive(`menu-live-${dismissal}`);
    await atBottom();
    assert.equal(await jump.isVisible(), false);
  }
  await page.locator(".message-more").last().click();
  await arrive("menu-before-scroll");
  await page.locator("#messages").evaluate((list) => {
    list.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -150, bubbles: true }),
    );
    list.scrollTop -= 150;
    list.dispatchEvent(new Event("scroll"));
  });
  assert.equal(await menu.isVisible(), false);
  const readingTop = await page.locator("#messages").evaluate((list) =>
    list.scrollTop
  );
  await arrive("menu-reading");
  assert.ok(
    Math.abs(
      await page.locator("#messages").evaluate((list) => list.scrollTop) -
        readingTop,
    ) <= 1,
  );
  assert.equal(await jump.isVisible(), true);
  await jump.click();
  await atBottom();
  h.step(
    "menu close resumes live following; explicit scrolling preserves history",
  );

  // At 320 px and 200% text, the trigger has its own gutter.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  for (const row of [textRow, known, place]) {
    await row.scrollIntoViewIfNeeded();
    const fits = await row.evaluate((node) => {
      const list = document.getElementById("messages");
      const bounds = list.getBoundingClientRect();
      return list.scrollWidth <= list.clientWidth &&
        [...node.querySelectorAll("button, a, audio, .message-meta")].every(
          (child) => {
            if (!child.getClientRects().length) return true;
            const rect = child.getBoundingClientRect();
            return rect.left >= bounds.left - 1 &&
              rect.right <= bounds.right + 1;
          },
        );
    });
    assert.equal(fits, true);
    const triggerBounds = await row.locator(".message-more").boundingBox();
    const bubbleBounds = await row.locator(".bubble").boundingBox();
    assert.ok(triggerBounds.width >= 44 && triggerBounds.height >= 44);
    assert.ok(
      triggerBounds.x >= bubbleBounds.x + bubbleBounds.width ||
        triggerBounds.x + triggerBounds.width <= bubbleBounds.x,
    );
  }
  await more.click();
  const menuBounds = await menu.boundingBox();
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 320);
  assert.ok(menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 640);
  assert.equal(await page.locator(".message-menu").count(), 1);
  await page.keyboard.press("Escape");
  h.step("narrow-large-text");

  await more.click();
  const messageId = await textRow.getAttribute("data-message-id");
  tap.socket.send(JSON.stringify({
    boot: state.bootId,
    event: {
      seq: ++injectedSeq,
      at: Date.now(),
      kind: "unsend",
      chat: CHAT,
      messageId,
    },
  }));
  await page.locator(`article[data-message-id="${messageId}"]`)
    .getByText("Message unsent").waitFor();
  assert.equal(await menu.isVisible(), false);
  assert.equal(
    await log.evaluate((node) => document.activeElement === node),
    true,
  );
  h.step("removed-actions-close-menu-and-preserve-focus");

  const flex = {
    id: "flex-private",
    chat: CHAT,
    from: "ustub-mom",
    fromName: "STUB 媽",
    time: Date.now() + 20000,
    contentType: "FLEX",
    text: "",
    altText: "Private FLEX content",
  };
  const deliver = (event) =>
    tap.socket.send(JSON.stringify({
      boot: state.bootId,
      event: { ...event, seq: ++injectedSeq, at: Date.now(), chat: CHAT },
    }));
  deliver({ kind: "message", message: flex });
  const flexRow = page.locator('[data-message-id="flex-private"]');
  await flexRow.locator(".message-text").filter({ hasText: flex.altText })
    .waitFor();
  await flexRow.locator(".message-more").click();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  assert.equal(
    await page.evaluate(() => globalThis.clipboardWrites.at(-1)),
    flex.altText,
  );
  deliver({ kind: "unsend", messageId: flex.id });
  await flexRow.getByText("Message unsent", { exact: true }).waitFor();
  assert.equal((await flexRow.textContent()).includes(flex.altText), false);
  deliver({
    kind: "message",
    message: {
      ...flex,
      id: "flex-unreadable",
      time: flex.time + 1,
      decryptFailed: true,
    },
  });
  const unreadable = page.locator('[data-message-id="flex-unreadable"]');
  await unreadable.getByText("Unable to decrypt this message", { exact: true })
    .waitFor();
  await unreadable.locator(".message-more").click();
  assert.equal(
    await page.getByRole("menuitem", { name: "Copy", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("menuitem", { name: "Forward", exact: true }).count(),
    0,
  );
  await page.keyboard.press("Escape");
  h.step(
    "FLEX copy uses displayed text and unsent or unreadable content stays masked",
  );
}

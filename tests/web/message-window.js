// Exercise trimming, paging and protected interactions in the real page.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function messageWindow(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const appUrl = new URL("../../daemon/web/public/js/app.js", import.meta.url);
  let app = await Deno.readTextFile(appUrl);
  for (
    const [old, replacement] of [
      [
        "  model = createModel();",
        "  model = createModel();\nglobalThis.__windowModel = model;",
      ],
      ["ctx = finish();", "ctx = finish();\nglobalThis.__windowCtx = ctx;"],
    ]
  ) {
    assert.equal(app.split(old).length, 2);
    app = app.replace(old, replacement);
  }
  await context.route(
    "**/js/app.js",
    (route) => route.fulfill({ contentType: "text/javascript", body: app }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const now = Date.now();
  const row = (i) => ({
    id: String(9_000_000 + i),
    chat: CHAT,
    from: "u-window-peer",
    fromName: "Peer",
    time: now + i * 1000,
    text: `Window message ${i}${
      i >= 50 && i % 3 === 0 ? " long".repeat(50) : ""
    }`,
    contentType: "NONE",
  });
  const archive = Array.from({ length: 50 }, (_, i) => row(i));
  const requests = [];
  let shortPage = false, firstPage = true, holdPage = false, heldPage;
  const tap = await tapSocket(page, {
    client(frame, connection) {
      if (frame.cmd === "markRead") {
        connection.socket.send(JSON.stringify({ id: frame.id, ok: true }));
        return false;
      }
      if (frame.cmd !== "history") return true;
      requests.push(frame);
      const end = frame.before
        ? archive.findIndex((message) => message.id === frame.before)
        : archive.length;
      if (end < 0) throw new Error(`Unknown history cursor ${frame.before}`);
      const count = firstPage ? 20 : frame.before && shortPage ? 10 : 50;
      firstPage = false;
      shortPage = false;
      const reply = JSON.stringify({
        id: frame.id,
        ok: true,
        data: archive.slice(Math.max(0, end - count), end),
      });
      if (holdPage) {
        holdPage = false;
        heldPage = () => connection.socket.send(reply);
      } else connection.socket.send(reply);
      return false;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByText("Window message 49", { exact: true }).waitFor();
  await page.waitForFunction(() => !globalThis.__windowModel.loading);
  assert.equal(requests.length, 1);
  assert.equal(
    await page.evaluate(() => globalThis.__windowModel.noOlder),
    false,
  );
  assert.equal(await page.locator(".message-row").count(), 20);
  await page.evaluate(() => {
    globalThis.__windowModel.unreadMarkId = "";
    globalThis.__windowCtx.renderMessages("bottom");
  });
  let seq = await page.evaluate(() => globalThis.__windowModel.seq);
  const boot = await page.evaluate(() => globalThis.__windowModel.boot);
  async function deliver(messages) {
    for (const message of messages) {
      archive.push(message);
      tap.socket.send(JSON.stringify({
        event: { seq: ++seq, kind: "message", chat: CHAT, message },
        boot,
      }));
    }
    await page.waitForFunction(
      (expected) => globalThis.__windowModel.seq >= expected,
      seq,
    );
  }
  async function atBottom() {
    await page.locator("#messages").evaluate((list) => {
      list.scrollTop = list.scrollHeight;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  async function current() {
    return await page.evaluate(() => {
      const model = globalThis.__windowModel;
      const list = document.getElementById("messages");
      return {
        ids: model.messages.filter((message) => !message.pending).map((
          message,
        ) => String(message.id)),
        rows: list.querySelectorAll(".message-row").length,
        bottom: list.scrollHeight - list.clientHeight - list.scrollTop,
        noOlder: model.noOlder,
      };
    });
  }
  async function userPageUp() {
    await page.locator("#messages").evaluate((list) => {
      list.scrollTop = 250;
      list.focus({ preventScroll: true });
    });
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
  }
  async function fixture(options = {}) {
    await page.evaluate(({ now, chat, options, stateDir }) => {
      const model = globalThis.__windowModel, ctx = globalThis.__windowCtx;
      getSelection().removeAllRanges();
      document.activeElement?.blur();
      ctx.writePending(chat, []);
      model.sent.clear();
      model.messages = Array.from({ length: 500 }, (_, i) => ({
        id: String(10_000_000 + i),
        chat,
        from: "u-window-peer",
        fromName: "Peer",
        time: now + i * 1000,
        text: `Fixture ${i}`,
        contentType: "NONE",
        ...(i === (options.imageAt ?? 0) && options.image
          ? {
            text: "",
            contentType: "IMAGE",
            hasMedia: true,
            previewable: true,
            mediaState: "ok",
            mediaPath: `${stateDir}/media/stub-shot1.png`,
          }
          : {}),
        ...(i === 499 && options.quote
          ? { replyTo: { id: "10000000", text: "origin" } }
          : {}),
      }));
      model.unreadMarkId = "";
      model.noOlder = true;
      model.loading = false;
      model.loadingOlder = false;
      ctx.renderMessages("bottom");
    }, { now, chat: CHAT, options, stateDir: h.stateDir });
    await atBottom();
  }
  let nextFixtureId = 10_000_500;
  async function fixtureMessage() {
    const id = nextFixtureId++;
    const message = {
      ...row(id),
      id: String(id),
      time: now + id * 1000,
      text: `Fixture live ${id}`,
    };
    await deliver([message]);
    return message.id;
  }

  shortPage = true;
  await userPageUp();
  await until(() => requests.length === 2, "short older page");
  await page.waitForFunction(() => !globalThis.__windowModel.loadingOlder);
  assert.equal(requests[1].before, row(30).id);
  assert.equal((await current()).ids[0], row(20).id);
  assert.equal((await current()).noOlder, false);
  await userPageUp();
  await until(() => requests.length === 3, "older page after short page");
  await page.waitForFunction(() => !globalThis.__windowModel.loadingOlder);
  assert.equal(requests[2].before, row(20).id);
  assert.equal((await current()).ids[0], row(0).id);
  assert.equal((await current()).noOlder, false);
  await userPageUp();
  await until(() => requests.length === 4, "empty older page");
  await page.waitForFunction(() => !globalThis.__windowModel.loadingOlder);
  assert.equal(requests[3].before, row(0).id);
  assert.equal((await current()).noOlder, true);
  h.step("short initial and older pages remain pageable until an empty page");

  const features = await page.locator("#messages").evaluate((list) => {
    list.style.overflowAnchor = "none";
    return {
      userAgent: navigator.userAgent,
      overflowAnchor: CSS.supports("overflow-anchor", "none"),
      computedAnchor: getComputedStyle(list).overflowAnchor,
      contentVisibility: CSS.supports("content-visibility", "auto"),
    };
  });
  console.log(`  browser features ${JSON.stringify(features)}`);
  if (features.overflowAnchor) assert.equal(features.computedAnchor, "none");
  await atBottom();
  assert.ok((await current()).bottom <= 2);
  if (await page.evaluate(() => typeof globalThis.find === "function")) {
    assert.equal(
      await page.evaluate(() =>
        globalThis.find("Window message 0", false, false, true)
      ),
      true,
    );
    h.step("browser find reaches loaded offscreen messages");
  } else console.log("  browser find API unavailable");
  await page.evaluate(() => getSelection().removeAllRanges());
  await atBottom();
  if (features.contentVisibility) {
    assert.equal(
      await page.locator(".message-row").first().evaluate((node) =>
        getComputedStyle(node).contentVisibility
      ),
      "auto",
    );
    assert.equal(
      await page.locator(".message-row").last().evaluate((node) =>
        getComputedStyle(node).contentVisibility
      ),
      "visible",
    );
  }
  let beforeTrim, maxBottom = 0, maxTailMove = 0;
  for (let i = 50; i < 750; i += 25) {
    if (i === 725) {
      beforeTrim = await page.locator(".message-row").last().evaluate((node) =>
        node.getBoundingClientRect().bottom
      );
      for (let j = 0; j < 25; j++) {
        await deliver([row(i + j)]);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const sample = await page.evaluate(() => {
          const list = document.getElementById("messages");
          const tail = list.querySelector(".message-row:last-child");
          return {
            bottom: list.scrollHeight - list.clientHeight - list.scrollTop,
            tail: tail.getBoundingClientRect().bottom,
          };
        });
        maxBottom = Math.max(maxBottom, Math.abs(sample.bottom));
        maxTailMove = Math.max(maxTailMove, Math.abs(sample.tail - beforeTrim));
      }
    } else await deliver(Array.from({ length: 25 }, (_, j) => row(i + j)));
  }
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  let state = await current();
  assert.equal(state.ids.length, 500);
  assert.equal(state.rows, 500);
  assert.equal(state.ids[0], row(250).id);
  assert.equal(state.noOlder, false);
  assert.ok(state.bottom <= 2, `bottom distance ${state.bottom}`);
  assert.ok(maxBottom <= 2, `frame bottom distance ${maxBottom}`);
  assert.ok(maxTailMove <= 2, `frame tail movement ${maxTailMove}`);
  console.log(
    `  trim frames: 25, max bottom ${maxBottom}px, tail ${maxTailMove}px`,
  );
  const afterTrim = await page.locator(".message-row").last().evaluate((node) =>
    node.getBoundingClientRect().bottom
  );
  assert.ok(
    Math.abs(afterTrim - beforeTrim) <= 2,
    `last row moved ${afterTrim - beforeTrim}px after trim`,
  );
  assert.deepEqual(
    await page.locator(".message-row").evaluateAll((rows) =>
      rows.map((row) => row.dataset.messageId)
    ),
    state.ids,
  );
  h.step("bottom follow caps the history and keeps the viewport at the bottom");

  await page.locator("#messages").evaluate((list) =>
    list.focus({ preventScroll: true })
  );
  await page.keyboard.press("ArrowUp");
  const beforeScroll = await page.locator("#messages").evaluate((list) =>
    list.scrollTop
  );
  const readingAnchor = await page.evaluate(() => {
    const list = document.getElementById("messages");
    const area = list.getBoundingClientRect();
    const node = [...list.querySelectorAll(".message-row")].find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= area.top && rect.bottom <= area.bottom;
    });
    return {
      id: node.dataset.messageId,
      top: node.getBoundingClientRect().top,
    };
  });
  assert.ok((await current()).bottom > 2);
  await deliver([row(750), row(751)]);
  state = await current();
  assert.equal(state.ids.length, 502);
  assert.equal(state.ids[0], row(250).id);
  assert.ok(state.bottom > 2);
  const afterScroll = await page.locator("#messages").evaluate((list) =>
    list.scrollTop
  );
  assert.ok(Math.abs(afterScroll - beforeScroll) <= 2);
  const readingAfter = await page.locator(
    `article[data-message-id="${readingAnchor.id}"]`,
  ).evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(
    Math.abs(readingAfter - readingAnchor.top) <= 2,
    `reading position moved ${readingAfter - readingAnchor.top}px`,
  );
  h.step("reading above the bottom never trims or follows incoming messages");

  const oldRequests = requests.length;
  shortPage = true;
  holdPage = true;
  await userPageUp();
  await until(() => typeof heldPage === "function", "held older page");
  const anchor = await page.evaluate(() => {
    const list = document.getElementById("messages"),
      area = list.getBoundingClientRect();
    const node = [...list.querySelectorAll(".message-row")].find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= area.top && rect.bottom <= area.bottom;
    });
    return {
      id: node.dataset.messageId,
      top: node.getBoundingClientRect().top,
    };
  });
  heldPage();
  heldPage = null;
  await page.waitForFunction(() =>
    !globalThis.__windowModel.loadingOlder &&
    globalThis.__windowModel.messages.some((message) =>
      message.id === "9000240"
    )
  );
  assert.equal(requests.length, oldRequests + 1);
  assert.equal(requests.at(-1).before, row(250).id);
  state = await current();
  assert.equal(state.noOlder, false);
  assert.equal(state.ids[0], row(240).id);
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  const anchorAfter = await page.locator(
    `article[data-message-id="${anchor.id}"]`,
  )
    .evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(
    Math.abs(anchorAfter - anchor.top) <= 2,
    `older-page anchor moved ${anchorAfter - anchor.top}px`,
  );
  await userPageUp();
  await page.waitForFunction(() =>
    !globalThis.__windowModel.loadingOlder &&
    globalThis.__windowModel.messages.some((message) =>
      message.id === "9000190"
    )
  );
  assert.equal(requests.length, oldRequests + 2);
  assert.equal(requests.at(-1).before, row(240).id);
  state = await current();
  assert.deepEqual(
    state.ids,
    Array.from({ length: 562 }, (_, i) => row(190 + i).id),
  );
  assert.deepEqual(
    await page.locator(".message-row").evaluateAll((rows) =>
      rows.map((row) => row.dataset.messageId)
    ),
    state.ids,
  );
  assert.equal(new Set(state.ids).size, state.ids.length);
  h.step("before pages back from the retained head without a gap or duplicate");

  await fixture();
  archive.push(...Array.from({ length: 550 }, (_, i) => ({
    ...row(i),
    id: String(9_999_950 + i),
    time: now + (i - 50) * 1000,
  })));
  await page.evaluate((chat) => {
    const model = globalThis.__windowModel, ctx = globalThis.__windowCtx;
    const pending = {
      id: "pending-unconfirmed",
      chat,
      from: model.account,
      time: 1,
      pending: true,
      status: "uncertain",
      requestId: "unconfirmed",
      text: "pending",
    };
    const sent = {
      ...pending,
      id: "pending-sent",
      status: "sent",
      requestId: "acknowledged",
      text: "sent without echo",
    };
    ctx.writePending(chat, [pending]);
    model.sent.set(sent.requestId, sent);
    model.messages.push(pending, sent);
    ctx.renderMessages("bottom");
  }, CHAT);
  await atBottom();
  await fixtureMessage();
  state = await current();
  assert.equal(state.ids.length, 500);
  assert.equal(state.ids[0], "10000001");
  assert.equal(state.noOlder, false);
  assert.equal(await page.getByText("pending", { exact: true }).count(), 1);
  assert.equal(
    await page.getByText("sent without echo", { exact: true }).count(),
    1,
  );
  const pendingRequests = requests.length;
  await userPageUp();
  await page.waitForFunction(() =>
    !globalThis.__windowModel.loadingOlder &&
    globalThis.__windowModel.messages.some((message) =>
      message.id === "10000000"
    )
  );
  assert.equal(requests.length, pendingRequests + 1);
  assert.equal(requests.at(-1).before, "10000001");
  state = await current();
  assert.deepEqual(
    state.ids,
    Array.from({ length: 550 }, (_, i) => String(9_999_951 + i)),
  );
  assert.equal(new Set(state.ids).size, state.ids.length);
  assert.equal(await page.getByText("pending", { exact: true }).count(), 1);
  assert.equal(
    await page.getByText("sent without echo", { exact: true }).count(),
    1,
  );
  h.step("pending and acknowledged sends survive outside the limit");

  await fixture();
  await page.locator("#messages").evaluate((list) =>
    list.focus({ preventScroll: true })
  );
  await page.keyboard.press("ArrowUp");
  await page.evaluate(() => {
    const grow = document.createElement("div");
    grow.style.height = "180px";
    document.querySelector(".message-row:last-child .bubble").append(grow);
    globalThis.__windowGrow = grow;
  });
  await atBottom();
  assert.ok((await current()).bottom <= 2);
  await page.evaluate(() => globalThis.__windowGrow.style.height = "360px");
  assert.ok((await current()).bottom > 2);
  await fixtureMessage();
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  assert.ok((await current()).bottom <= 2);
  assert.equal((await current()).ids.length, 500);
  h.step("returning to bottom follows later deferred height changes");

  await fixture({ image: true, imageAt: 498 });
  await page.locator('article[data-message-id="10000498"] img.media-image')
    .evaluate((node) => node.decode());
  const selectedTail = await page.evaluate(() => {
    const text = document.querySelector(
      'article[data-message-id="10000499"] .message-text',
    );
    globalThis.__windowImage = document.querySelector(
      'article[data-message-id="10000498"] img.media-image',
    );
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return getSelection().toString();
  });
  assert.ok(selectedTail.includes("Fixture 499"));
  await atBottom();
  await fixtureMessage();
  await fixtureMessage();
  state = await current();
  assert.equal(state.ids[0], "10000001");
  assert.equal(
    await page.evaluate(() => getSelection().toString()),
    selectedTail,
  );
  assert.equal(
    await page.evaluate(() =>
      globalThis.__windowImage.isSameNode(
        document.querySelector(
          'article[data-message-id="10000498"] img.media-image',
        ),
      )
    ),
    true,
  );
  h.step("top trimming keeps selected text and retained image nodes");

  await fixture();
  await page.locator(
    'article[data-message-id="10000000"] .message-actions button',
  ).first()
    .evaluate((node) => node.focus({ preventScroll: true }));
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 501);
  assert.equal(
    await page.locator('article[data-message-id="10000000"]').count(),
    1,
  );
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 502);
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.closest(".message-row")?.dataset.messageId
    ),
    "10000000",
  );
  await page.evaluate(() => document.activeElement.blur());
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 500);
  h.step("focused rows defer trimming until focus moves");

  await fixture();
  const selectedText = await page.evaluate(() => {
    const first = document.querySelector(
      'article[data-message-id="10000000"] .message-text',
    );
    const last = document.querySelector(
      'article[data-message-id="10000001"] .message-text',
    );
    const range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(last.firstChild, last.firstChild.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return getSelection().toString();
  });
  assert.ok(selectedText.includes("Fixture 0"));
  assert.ok(selectedText.includes("Fixture 1"));
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 501);
  assert.equal(
    await page.evaluate(() => getSelection().toString()),
    selectedText,
  );
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 502);
  assert.equal(
    await page.evaluate(() => getSelection().toString()),
    selectedText,
  );
  await page.evaluate(() => getSelection().removeAllRanges());
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 500);
  h.step("a multi-row text selection defers trimming");

  await fixture();
  await page.evaluate(() => {
    globalThis.__windowModel.unreadMarkId = "10000000";
    globalThis.__windowCtx.renderMessages("preserve");
  });
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 501);
  assert.equal(await page.locator(".unread-divider").count(), 1);
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 502);
  await page.evaluate(() => globalThis.__windowModel.unreadMarkId = "");
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 500);
  h.step("the unread divider protects its row until cleared");

  await fixture();
  // A tiny local WebM lets the browser actually play the retained node.
  const videoData = [
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAI5EU2bdLpN",
    "u4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1Os",
    "ggIj7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrX",
    "sYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAn0AAAAAAABZUrmvXrgEA",
    "AAAAAABO14EBc8WIdvbdXrwg/amcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4JCw",
    "gRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVS",
    "RIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WIdvbdXrwg/alnyKBFo4dFTkNPREVSRIeTTGF2YzYz",
    "LjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnXt",
    "54EAo6OBAACAEAIAnQEqEAAQAABHCIWFiIWEiAICAAwNYAD+/6tQgKOVgQH0ALEBAAEQEAAY",
    "ABhYL/QACAAAo5WBA+gAsQEAARAQABgAGFgv9AAIAACjlYEF3ACxAQABEBAAGAAYWC/0AAgA",
    "ABxTu2uRu4+zgQC3iveBAfGCAbHwgQM=",
  ].join("");
  await page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(
      atob(encoded),
      (character) => character.charCodeAt(0),
    );
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.src = url;
    document.querySelector('article[data-message-id="10000000"] .bubble')
      .append(video);
    globalThis.__windowVideo = video;
    globalThis.__windowVideoUrl = url;
    let timer;
    try {
      await Promise.race([
        video.play(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("video play timed out")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }, videoData);
  await atBottom();
  assert.equal(
    await page.evaluate(() => globalThis.__windowVideo.paused),
    false,
  );
  await fixtureMessage();
  assert.equal((await current()).ids.length, 501);
  assert.equal(
    await page.evaluate(() => globalThis.__windowVideo.isConnected),
    true,
  );
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 502);
  await page.evaluate(() => {
    globalThis.__windowVideo.pause();
    URL.revokeObjectURL(globalThis.__windowVideoUrl);
  });
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 500);
  h.step("a playing video keeps its message node connected");

  await fixture({ image: true });
  await page.locator('article[data-message-id="10000000"] img.media-image')
    .evaluate((node) => node.click());
  assert.equal(
    await page.locator("#lightbox").evaluate((node) => node.open),
    true,
  );
  await atBottom();
  assert.ok((await current()).bottom <= 2);
  await fixtureMessage();
  assert.equal((await current()).ids.length, 501);
  assert.equal(
    await page.locator('article[data-message-id="10000000"]').count(),
    1,
  );
  assert.equal(
    await page.locator("#lightbox").evaluate((node) => node.open),
    true,
  );
  await page.locator("#lightbox-close").evaluate((node) => node.click());
  await atBottom();
  await fixtureMessage();
  assert.equal((await current()).ids.length, 500);
  h.step("the current lightbox image is not trimmed");

  await fixture({ quote: true });
  await page.evaluate(() => globalThis.__windowModel.noOlder = false);
  const beforeQuote = requests.length;
  await page.locator('article[data-message-id="10000499"] .quote').click();
  await page.waitForFunction(() =>
    document.getElementById("messages").scrollTop < 150
  );
  await page.waitForTimeout(400);
  assert.equal(requests.length, beforeQuote);
  await page.locator("#messages").evaluate((list) =>
    list.focus({ preventScroll: true })
  );
  await page.keyboard.press("ArrowUp");
  await until(
    () => requests.length > beforeQuote,
    "user paging after quote jump",
  );
  assert.equal(requests[beforeQuote].before, "10000000");
  await page.waitForFunction(() => !globalThis.__windowModel.loadingOlder);
  h.step("quote jumps do not page; a subsequent user scroll still pages");

  await fixture({ quote: true });
  await fixtureMessage();
  assert.equal(
    await page.locator('article[data-message-id="10000000"]').count(),
    0,
  );
  await page.locator('article[data-message-id="10000499"] .quote').evaluate((
    node,
  ) => node.click());
  await page.getByText(/The original isn't in this page/).waitFor();
  h.step("a quote to trimmed history keeps the existing missing-origin notice");

  if (h.browserName === "webkit") {
    // Playwright does not implement wheel input in mobile WebKit. A separate
    // desktop WebKit context exercises actual wheel input at the same width.
    const wheelContext = await h.context({
      locale: "en-US",
      viewport: { width: 390, height: 844 },
    });
    const wheelPage = await wheelContext.newPage();
    const wheelRequests = [];
    await tapSocket(wheelPage, {
      client(frame, connection) {
        if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
        wheelRequests.push(frame);
        connection.socket.send(JSON.stringify({
          id: frame.id,
          ok: true,
          data: frame.before ? archive.slice(20, 30) : archive.slice(30, 50),
        }));
        return false;
      },
    });
    await h.signIn(wheelPage);
    await wheelPage.getByRole("button", { name: /STUB 家庭群組/ }).click();
    await wheelPage.getByText("Window message 49", { exact: true }).waitFor();
    const box = await wheelPage.locator("#messages").boundingBox();
    await wheelPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await wheelPage.mouse.wheel(0, -5000);
    await until(() => wheelRequests.length > 1, "WebKit wheel paging");
    assert.equal(wheelRequests[1].before, row(30).id);
    await wheelPage.getByText("Window message 20", { exact: true }).waitFor();
    h.step("desktop WebKit wheel scroll loads the older page");
  }
}

// Exercise trimming, paging and protected interactions in the real page.
import { assert, CHAT, tapSocket, until } from "./harness.js";

async function exposeFollowContext(context) {
  const appUrl = new URL("../../daemon/web/public/js/app.js", import.meta.url);
  let app = await Deno.readTextFile(appUrl);
  for (
    const [old, replacement] of [
      [
        "  model = createModel();",
        "  model = createModel();\nglobalThis.__followModel = model;",
      ],
      ["ctx = finish();", "ctx = finish();\nglobalThis.__followCtx = ctx;"],
    ]
  ) {
    assert.equal(app.split(old).length, 2);
    app = app.replace(old, replacement);
  }
  await context.route(
    "**/js/app.js",
    (route) => route.fulfill({ contentType: "text/javascript", body: app }),
  );
}

async function reactDuringEmptyPage(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 360, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const now = Date.now();
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: String(100 + index),
    chat: CHAT,
    from: "u-window-peer",
    fromName: "Peer",
    time: now + index * 1000,
    text: `Race message ${index}`,
    contentType: "NONE",
  }));
  let release;
  await tapSocket(page, {
    client(frame, connection) {
      if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
      const reply = JSON.stringify({
        id: frame.id,
        ok: true,
        data: frame.before ? [] : messages,
      });
      if (frame.before) release = () => connection.socket.send(reply);
      else connection.socket.send(reply);
      return false;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByText("Race message 19", { exact: true }).waitFor();
  await page.locator("#messages").evaluate((list) => {
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
  });
  await until(() => release, "held empty older page");
  const row = page.locator('article[data-message-id="100"]');
  const react = row.getByRole("button", { name: "React", exact: true });
  await react.scrollIntoViewIfNeeded();
  const before = await react.boundingBox();
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  release();
  await page.getByRole("button", { name: "Load older messages" }).waitFor({
    state: "hidden",
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const after = await react.boundingBox();
  await page.mouse.up();
  assert.ok(Math.abs(after.y - before.y) <= 1, "React moves during the press");
  await row.getByRole("button", { name: "NICE", exact: true }).waitFor();
  await react.tap();
  await row.getByRole("button", { name: "NICE", exact: true }).waitFor({
    state: "hidden",
  });
  await react.tap();
  await row.getByRole("button", { name: "NICE", exact: true }).waitFor();
  await context.close();
  h.step("empty older page keeps React stable during pointer and touch input");
}

async function touchDuringAccountChange(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await exposeFollowContext(context);
  const page = await context.newPage();
  const now = Date.now();
  const messages = Array.from({ length: 50 }, (_, i) => ({
    id: String(5000 + i),
    chat: CHAT,
    from: "u-window-peer",
    time: now + i * 1000,
    text: `Account touch message ${i}`,
    contentType: "NONE",
  }));
  const tap = await tapSocket(page, {
    client(frame, connection) {
      if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
      connection.socket.send(JSON.stringify({
        id: frame.id,
        ok: true,
        data: frame.before ? [] : messages,
      }));
      return false;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  const row = page.locator('article[data-message-id="5049"] .message-text');
  await row.waitFor();
  await page.waitForFunction(() => {
    const list = document.getElementById("messages");
    return !globalThis.__followModel.loading &&
      list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
  });
  const cdp = h.browserName === "chromium"
    ? await context.newCDPSession(page)
    : null;
  if (cdp) {
    const box = await row.boundingBox();
    assert.ok(box);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        id: 1,
      }],
    });
  } else {
    // The old touch target is removed before it can deliver touchend.
    await row.evaluate((node) => {
      const event = new Event("touchstart", { bubbles: true });
      Object.defineProperty(event, "touches", { value: [{ clientY: 200 }] });
      node.dispatchEvent(event);
    });
  }
  const state = await h.state();
  tap.socket.send(JSON.stringify({
    web: "state",
    state: { ...state, me: { mid: "u-touch-switch", displayName: "Other" } },
  }));
  await page.getByText("Other", { exact: true }).waitFor();
  if (cdp) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await row.waitFor();
  await page.waitForFunction(() => !globalThis.__followModel.loading);
  await page.locator("#messages").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await page.waitForFunction(() => {
    const list = document.getElementById("messages");
    return list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
  });
  await page.evaluate(() => {
    const model = globalThis.__followModel;
    globalThis.__followCtx.onFrame({
      boot: model.boot,
      event: {
        seq: model.seq + 1,
        kind: "message",
        chat: model.active,
        message: {
          id: "6000",
          chat: model.active,
          from: model.account,
          time: Date.now() + 600000,
          text: "Follow after account touch",
          contentType: "NONE",
        },
      },
    });
  });
  await page.getByText("Follow after account touch", { exact: true }).waitFor();
  await page.waitForFunction(
    () => {
      const list = document.getElementById("messages");
      return list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
    },
    null,
    { timeout: 5000 },
  );
  await cdp?.detach();
  await context.close();
  h.step("account change during touch does not block following");
}

async function touchPagingNearTop(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const messages = Array.from({ length: 30 }, (_, i) => ({
    id: String(7000 + i),
    chat: CHAT,
    from: "u-window-peer",
    time: Date.now() + i * 1000,
    text: `Touch paging message ${i}`,
    contentType: "NONE",
  }));
  const requests = [];
  await tapSocket(page, {
    client(frame, connection) {
      if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
      requests.push(frame);
      connection.socket.send(JSON.stringify({
        id: frame.id,
        ok: true,
        data: frame.before ? [] : messages,
      }));
      return false;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByText("Touch paging message 29", { exact: true }).waitFor();
  await page.locator("#messages").evaluate((list) => {
    list.scrollTop = 200;
  });
  const before = requests.length;
  await page.locator("#messages").evaluate((list) => {
    const touch = (type, touches) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", { value: touches });
      list.dispatchEvent(event);
    };
    touch("touchstart", [{ clientY: 200 }]);
    touch("touchmove", [{ clientY: 220 }]);
    // Model the browser applying the gesture after touchmove returns.
    list.scrollTop = 100;
    list.dispatchEvent(new Event("scroll"));
    touch("touchend", []);
  });
  await until(() => requests.length > before, "touch paging");
  assert.ok(requests.slice(before).some((frame) => frame.before));
  await context.close();
  h.step("touch movement toward older messages still pages");
}

async function quoteDuringOlder(h) {
  const viewUrl = new URL(
    "../../daemon/web/public/js/view-messages.js",
    import.meta.url,
  );
  let view = await Deno.readTextFile(viewUrl);
  const marker = "  return { renderMessages, closeOpenReactions };";
  assert.equal(view.split(marker).length, 2);
  view = view.replace(
    marker,
    "  globalThis.__jumpActive = () => programmaticScroll;\n" +
      "  globalThis.__jumpState = () => ({ programmaticScroll, " +
      "programmaticMoved, quoteJumpTarget });\n" + marker,
  );
  const anchor = '    if (mode === "anchor") {';
  assert.equal(view.split(anchor).length, 2);
  view = view.replace(
    anchor,
    anchor + "\n      globalThis.__anchorDuringJump = programmaticScroll;",
  );
  for (
    const { motion, interrupt } of [
      { motion: "no-preference", interrupt: false },
      { motion: "reduce", interrupt: false },
      { motion: "no-preference", interrupt: true },
    ]
  ) {
    const context = await h.context({
      locale: "en-US",
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await exposeFollowContext(context);
    await context.route(
      "**/js/view-messages.js",
      (route) => route.fulfill({ contentType: "text/javascript", body: view }),
    );
    await context.addInitScript(() => {
      const original = Element.prototype.scrollIntoView;
      globalThis.__quoteAlignments = [];
      Element.prototype.scrollIntoView = function (options) {
        if (this.dataset.messageId === "10002") {
          globalThis.__quoteAlignments.push(options?.behavior);
        }
        return original.call(this, options);
      };
    });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: motion });
    const now = Date.now();
    const history = Array.from({ length: 50 }, (_, i) => ({
      id: String(10000 + i),
      chat: CHAT,
      from: "u-window-peer",
      time: now + i * 1000,
      text: `Quote race message ${i}`,
      contentType: "NONE",
      ...(i === 5 ? { replyTo: { id: "10002", text: "origin" } } : {}),
    }));
    const older = Array.from({ length: 30 }, (_, i) => ({
      id: String(9000 + i),
      chat: CHAT,
      from: "u-window-peer",
      time: now - (30 - i) * 1000,
      text: `Quote race older ${i}`,
      contentType: "NONE",
    }));
    let releaseOlder;
    await tapSocket(page, {
      client(frame, connection) {
        if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
        const reply = JSON.stringify({
          id: frame.id,
          ok: true,
          data: frame.before ? older : history,
        });
        if (frame.before) releaseOlder = () => connection.socket.send(reply);
        else connection.socket.send(reply);
        return false;
      },
    });
    await h.signIn(page);
    await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
    await page.getByText("Quote race message 49", { exact: true }).waitFor();
    await page.waitForFunction(() => !globalThis.__followModel.loading);
    await page.waitForTimeout(300);
    await page.locator("#messages").evaluate((list) => {
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll"));
    });
    await until(() => releaseOlder, "held older response");
    const quote = page.locator('article[data-message-id="10005"] .quote');
    if (!interrupt) {
      await page.exposeFunction("__releaseQuoteOlder", () => releaseOlder());
      await quote.evaluate((node) => {
        node.addEventListener("click", () => {
          globalThis.__jumpAtClick = globalThis.__jumpActive();
          void globalThis.__releaseQuoteOlder();
        }, { once: true });
      });
    }
    await quote.click();
    let alignmentsBefore;
    if (interrupt) {
      await page.locator("#messages").focus();
      await page.keyboard.press("End");
      await page.waitForFunction(() => !globalThis.__jumpActive());
      alignmentsBefore = await page.evaluate(() =>
        globalThis.__quoteAlignments.length
      );
      releaseOlder();
    } else {
      assert.equal(await page.evaluate(() => globalThis.__jumpAtClick), true);
    }
    await page.waitForFunction(() =>
      !globalThis.__followModel.loadingOlder &&
      !!document.querySelector('article[data-message-id="9000"]')
    );
    if (interrupt) {
      await page.waitForTimeout(300);
      assert.equal(
        await page.evaluate(() => globalThis.__quoteAlignments.length),
        alignmentsBefore,
        "older response restarted an interrupted quote jump",
      );
    } else {
      assert.equal(
        await page.evaluate(() => globalThis.__anchorDuringJump),
        true,
      );
      try {
        await page.waitForFunction(
          () => {
            const list = document.getElementById("messages")
              .getBoundingClientRect();
            const target = document.querySelector(
              'article[data-message-id="10002"]',
            ).getBoundingClientRect();
            return target.bottom > list.top && target.top < list.bottom;
          },
          null,
          { timeout: 5000 },
        );
      } catch (error) {
        const detail = await page.evaluate(() => {
          const list = document.getElementById("messages");
          const area = list.getBoundingClientRect();
          const target = list.querySelector(
            'article[data-message-id="10002"]',
          )?.getBoundingClientRect();
          return {
            top: list.scrollTop,
            height: list.scrollHeight,
            listTop: area.top,
            listBottom: area.bottom,
            targetTop: target?.top,
            targetBottom: target?.bottom,
            alignments: globalThis.__quoteAlignments,
            jump: globalThis.__jumpState(),
          };
        });
        throw new Error(`quote target not visible: ${JSON.stringify(detail)}`, {
          cause: error,
        });
      }
      const alignments = await page.evaluate(() =>
        globalThis.__quoteAlignments
      );
      assert.ok(alignments.length >= 2);
      assert.ok(
        alignments.every((value) =>
          value === (motion === "reduce" ? "auto" : "smooth")
        ),
      );
    }
    await context.close();
    h.step(
      `older reply during quote: ${motion}${interrupt ? " interrupted" : ""}`,
    );
  }
}

async function scrollFollow(h) {
  const context = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await exposeFollowContext(context);
  const page = await context.newPage();
  const now = Date.now();
  const messages = Array.from({ length: 30 }, (_, i) => ({
    id: String(100 + i),
    chat: CHAT,
    from: "u-window-peer",
    fromName: "Peer",
    time: now + i * 1000,
    text: `Follow message ${i}`,
    contentType: "NONE",
    ...(i === 29
      ? { replyTo: { id: "100", fromName: "Peer", text: "origin" } }
      : {}),
  }));
  const requests = [];
  await tapSocket(page, {
    client(frame, connection) {
      if (frame.cmd === "markRead") {
        connection.socket.send(JSON.stringify({ id: frame.id, ok: true }));
        return false;
      }
      if (frame.cmd !== "history" || frame.chat !== CHAT) return true;
      requests.push(frame);
      connection.socket.send(JSON.stringify({
        id: frame.id,
        ok: true,
        data: frame.before ? [] : messages,
      }));
      return false;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByText("Follow message 29", { exact: true }).waitFor();

  async function stableBottom() {
    await page.locator("#messages").evaluate((list) => {
      list.scrollTop = list.scrollHeight;
      list.__followTest = { height: 0, stable: 0 };
    });
    await page.waitForFunction(
      () => {
        const list = document.getElementById("messages"),
          state = list.__followTest;
        const height = list.scrollHeight;
        const bottom = height - list.clientHeight - list.scrollTop;
        if (Math.abs(bottom) > 2) list.scrollTop = height;
        state.stable = height === state.height && Math.abs(bottom) <= 2
          ? state.stable + 1
          : 0;
        state.height = height;
        if (state.stable < 3) return false;
        delete list.__followTest;
        return true;
      },
      null,
      { polling: "raf" },
    );
  }

  for (const motion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion: motion });
    await stableBottom();
    const before = requests.length;
    await page.locator('article[data-message-id="129"] .quote').click();
    await page.waitForFunction(
      () => document.getElementById("messages").scrollTop < 150,
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(300);
    assert.equal(
      requests.length,
      before,
      `${motion} quote paged automatically`,
    );
  }
  h.step("quote jumps from a stable bottom with and without reduced motion");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await stableBottom();
  await page.locator('article[data-message-id="129"] .quote').evaluate((
    quote,
  ) => {
    quote.addEventListener("click", () => {
      const model = globalThis.__followModel;
      globalThis.__followCtx.onFrame({
        boot: model.boot,
        event: {
          seq: model.seq + 1,
          kind: "message",
          chat: model.active,
          message: {
            id: "130",
            chat: model.active,
            from: model.account,
            time: Date.now() + 60000,
            text: "Incoming during quote jump",
            contentType: "NONE",
          },
        },
      });
    }, { once: true });
  });
  await page.locator('article[data-message-id="129"] .quote').click();
  await page.getByText("Incoming during quote jump").waitFor();
  await page.waitForFunction(
    () => document.getElementById("messages").scrollTop < 150,
    null,
    { timeout: 5000 },
  );
  h.step("an incoming message does not interrupt a quote jump");

  await page.evaluate(() => {
    const list = document.getElementById("messages");
    globalThis.__followLastScroll = performance.now();
    list.addEventListener("scroll", () => {
      globalThis.__followLastScroll = performance.now();
    });
    globalThis.__blockFollowScrollEnd = (event) => {
      if (event.target === list) event.stopImmediatePropagation();
    };
    globalThis.addEventListener(
      "scrollend",
      globalThis.__blockFollowScrollEnd,
      true,
    );
  });
  await stableBottom();
  await page.locator('article[data-message-id="129"] .quote').click();
  await page.waitForFunction(
    () => document.getElementById("messages").scrollTop < 150,
    null,
    { timeout: 5000 },
  );
  await page.waitForFunction(() =>
    performance.now() - globalThis.__followLastScroll > 300
  );
  await stableBottom();
  await page.waitForFunction(() =>
    performance.now() - globalThis.__followLastScroll > 300
  );
  await page.evaluate(() => {
    const model = globalThis.__followModel;
    globalThis.__followCtx.onFrame({
      boot: model.boot,
      event: {
        seq: model.seq + 1,
        kind: "message",
        chat: model.active,
        message: {
          id: "131",
          chat: model.active,
          from: model.account,
          time: Date.now() + 120000,
          text: "Follow after quote fallback",
          contentType: "NONE",
        },
      },
    });
  });
  await page.getByText("Follow after quote fallback").waitFor();
  await page.waitForFunction(() => {
    const list = document.getElementById("messages");
    return list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
  });
  h.step("quote following resumes without scrollend support");

  await stableBottom();
  await page.locator("#messages").evaluate((list) => {
    list.style.overflowAnchor = "none";
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    );
    const trace = globalThis.__followTouch = {
      active: false,
      starts: 0,
      ends: 0,
      writes: [],
    };
    list.addEventListener("touchstart", () => {
      trace.active = true;
      trace.starts++;
    }, true);
    for (const type of ["touchend", "touchcancel"]) {
      list.addEventListener(type, () => {
        trace.active = false;
        trace.ends++;
      }, true);
    }
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        trace.writes.push({ active: trace.active, value });
        descriptor.set.call(this, value);
      },
    });
    list.addEventListener("touchstart", () => {
      const grow = document.createElement("div");
      grow.style.height = "87px";
      list.querySelector(".message-row:last-child .bubble").append(grow);
      globalThis.__followGrow = grow;
    }, { once: true });
  });
  const box = await page.locator("#messages").boundingBox();
  await page.touchscreen.tap(box.x + box.width - 5, box.y + box.height / 2);
  await page.waitForFunction(
    () => {
      const list = document.getElementById("messages");
      return list.scrollHeight - list.clientHeight - list.scrollTop <= 2 &&
        globalThis.__followTouch.writes.some((entry) => !entry.active);
    },
    null,
    { timeout: 5000 },
  );
  const tapped = await page.evaluate(() => globalThis.__followTouch);
  assert.equal(tapped.starts, 1);
  assert.equal(tapped.ends, 1);
  assert.deepEqual(tapped.writes.filter((entry) => entry.active), []);
  await page.evaluate(() => {
    globalThis.removeEventListener(
      "scrollend",
      globalThis.__blockFollowScrollEnd,
      true,
    );
    globalThis.__followGrow.remove();
  });
  h.step("touch release settles delayed growth without scrollend support");

  if (h.browserName === "chromium") {
    await stableBottom();
    await page.locator('article[data-message-id="129"] .quote').click();
    await page.waitForFunction(() => {
      const list = document.getElementById("messages");
      return list.scrollTop > 150 &&
        list.scrollHeight - list.clientHeight - list.scrollTop > 50;
    });
    await page.locator("#messages").evaluate((list) =>
      list.focus({ preventScroll: true })
    );
    await page.keyboard.press("End");
    await page.waitForFunction(
      () => {
        const list = document.getElementById("messages");
        return list.scrollHeight - list.clientHeight - list.scrollTop <= 2 &&
          performance.now() - globalThis.__followLastScroll > 300;
      },
      null,
      { timeout: 5000 },
    );
    h.step("keyboard input interrupts an ongoing quote jump");

    await stableBottom();
    await page.locator("#messages").evaluate((list) => {
      list.scrollTop = list.scrollHeight - list.clientHeight - 100;
    });
    await page.waitForFunction(() => {
      const list = document.getElementById("messages");
      return Math.abs(
        list.scrollHeight - list.clientHeight - list.scrollTop - 100,
      ) <= 2;
    });
    await page.evaluate(() => globalThis.__followTouch.writes = []);
    const cdp = await context.newCDPSession(page);
    const x = box.x + box.width / 2, y = box.y + box.height * 0.75;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    for (const distance of [40, 80, 120, 160, 200, 240]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - distance, id: 1 }],
      });
    }
    await page.waitForFunction(() => {
      const list = document.getElementById("messages");
      return list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
    });
    await page.locator("#messages").evaluate((list) => {
      const grow = document.createElement("div");
      grow.style.height = "87px";
      list.querySelector(".message-row:last-child .bubble").append(grow);
    });
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
    const held = await page.evaluate(() => globalThis.__followTouch);
    assert.equal(held.active, true);
    assert.deepEqual(held.writes.filter((entry) => entry.active), []);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(
      () => {
        const list = document.getElementById("messages");
        return list.scrollHeight - list.clientHeight - list.scrollTop <= 2 &&
          globalThis.__followTouch.writes.some((entry) => !entry.active);
      },
      null,
      { timeout: 5000 },
    );
    assert.deepEqual(
      (await page.evaluate(() => globalThis.__followTouch.writes)).filter((
        entry,
      ) => entry.active),
      [],
    );

    await page.evaluate(() => {
      const model = globalThis.__followModel, ctx = globalThis.__followCtx;
      const now = Date.now();
      model.messages = Array.from({ length: 1300 }, (_, i) => ({
        id: String(10000000 + i),
        chat: model.active,
        from: model.account,
        time: now + i * 1000,
        text: `Touch trim ${i}`,
        contentType: "NONE",
      }));
      model.unreadMarkId = "";
      model.noOlder = true;
      model.loading = false;
      model.loadingOlder = false;
      ctx.renderMessages("bottom");
    });
    await stableBottom();
    await page.evaluate(() => globalThis.__followTouch.writes = []);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.evaluate(() => {
      const model = globalThis.__followModel;
      globalThis.__followCtx.onFrame({
        boot: model.boot,
        event: {
          seq: model.seq + 1,
          kind: "message",
          chat: model.active,
          message: {
            id: "10001300",
            chat: model.active,
            from: model.account,
            time: Date.now() + 1300 * 1000,
            text: "Touch trim incoming",
            contentType: "NONE",
          },
        },
      });
    });
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
    const heldTrim = await page.evaluate(() => ({
      rows: globalThis.__followModel.messages.length,
      active: globalThis.__followTouch.active,
      writes: globalThis.__followTouch.writes.filter((entry) => entry.active),
    }));
    assert.equal(heldTrim.active, true);
    assert.equal(heldTrim.rows, 1301);
    assert.deepEqual(heldTrim.writes, []);
    const heldTop = await page.locator("#messages").evaluate((list) =>
      list.scrollTop
    );
    for (const distance of [40, 80, 120]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + distance, id: 1 }],
      });
    }
    await page.waitForFunction(
      (top) => top - document.getElementById("messages").scrollTop > 50,
      heldTop,
    );
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(
      () => {
        const list = document.getElementById("messages");
        return list.scrollHeight - list.clientHeight - list.scrollTop > 50 &&
          performance.now() - globalThis.__followLastScroll > 300;
      },
      null,
      { timeout: 5000 },
    );
    assert.equal(
      await page.evaluate(() => globalThis.__followModel.messages.length),
      1301,
    );
    assert.deepEqual(
      (await page.evaluate(() => globalThis.__followTouch.writes)).filter((
        entry,
      ) => entry.active),
      [],
    );

    await stableBottom();
    await page.evaluate(() => globalThis.__followTouch.writes = []);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.evaluate(() => {
      const model = globalThis.__followModel;
      globalThis.__followCtx.onFrame({
        boot: model.boot,
        event: {
          seq: model.seq + 1,
          kind: "message",
          chat: model.active,
          message: {
            id: "10001301",
            chat: model.active,
            from: model.account,
            time: Date.now() + 1301 * 1000,
            text: "Touch trim resumes",
            contentType: "NONE",
          },
        },
      });
    });
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
    assert.equal(
      await page.evaluate(() => globalThis.__followModel.messages.length),
      1302,
    );
    assert.deepEqual(
      (await page.evaluate(() => globalThis.__followTouch.writes)).filter((
        entry,
      ) => entry.active),
      [],
    );
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(
      () => {
        const list = document.getElementById("messages");
        return globalThis.__followModel.messages.length === 500 &&
          list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
      },
      null,
      { timeout: 10000 },
    );
    assert.deepEqual(
      (await page.evaluate(() => globalThis.__followTouch.writes)).filter((
        entry,
      ) => entry.active),
      [],
    );
    await cdp.detach();
    h.step("touch holds bottom without writes, then settles delayed growth");
    h.step(
      "touch cancels or resumes deferred trim according to scroll position",
    );
  }

  await page.evaluate(() => {
    const model = globalThis.__followModel, now = Date.now();
    model.messages = [
      {
        id: "900",
        chat: model.active,
        from: "u-peer",
        time: now,
        text: "Visible origin",
        contentType: "NONE",
      },
      {
        id: "901",
        chat: model.active,
        from: "u-peer",
        time: now + 1000,
        text: "Visible reply",
        contentType: "NONE",
        replyTo: { id: "900", text: "Visible origin" },
      },
    ];
    model.noOlder = true;
    model.loading = false;
    model.loadingOlder = false;
    globalThis.__followCtx.renderMessages("bottom");
  });
  await page.getByText("Visible reply").waitFor();
  assert.equal(
    await page.locator("#messages").evaluate((list) =>
      list.scrollHeight <= list.clientHeight
    ),
    true,
  );
  await page.locator('article[data-message-id="901"] .quote').evaluate(
    (quote) => {
      quote.addEventListener("click", () => {
        const model = globalThis.__followModel;
        globalThis.__followCtx.onFrame({
          boot: model.boot,
          event: {
            seq: model.seq + 1,
            kind: "message",
            chat: model.active,
            message: {
              id: "902",
              chat: model.active,
              from: model.account,
              time: Date.now() + 2000,
              text: "new line\n".repeat(100),
              contentType: "NONE",
            },
          },
        });
      }, { once: true });
    },
  );
  await page.locator('article[data-message-id="901"] .quote').click();
  await page.waitForFunction(
    () => {
      const list = document.getElementById("messages");
      return !!list.querySelector('article[data-message-id="902"]') &&
        list.scrollHeight > list.clientHeight &&
        list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
    },
    null,
    { timeout: 5000 },
  );
  h.step("a quote that cannot scroll does not block new-message following");

  await page.evaluate(() => {
    const model = globalThis.__followModel, now = Date.now();
    model.messages = [
      {
        id: "900",
        chat: model.active,
        from: "u-peer",
        time: now,
        text: "Short history",
        contentType: "NONE",
      },
    ];
    model.noOlder = false;
    model.loading = false;
    model.loadingOlder = false;
    globalThis.__followCtx.renderMessages("bottom");
  });
  await page.getByText("Short history", { exact: true }).waitFor();
  await page.locator("#messages").evaluate((list) => {
    globalThis.__followTouch.writes = [];
    list.addEventListener("touchstart", () => {
      const grow = document.createElement("div");
      grow.style.height = "1000px";
      list.querySelector(".message-row:last-child .bubble").append(grow);
      const overflow = list.scrollHeight - list.clientHeight;
      grow.style.height = `${1000 - overflow + 60}px`;
      // A delayed scroll from the previous layout can arrive during a tap.
      list.scrollTop = 1;
    }, { once: true });
  });
  const beforeTouchGrowth = requests.length;
  await page.touchscreen.tap(box.x + box.width - 5, box.y + box.height / 2);
  await page.waitForFunction(
    () => {
      const list = document.getElementById("messages");
      return list.scrollTop > 10 && list.scrollTop < 150 &&
        list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
    },
    null,
    { timeout: 5000 },
  );
  await page.waitForTimeout(300);
  assert.equal(
    requests.length,
    beforeTouchGrowth,
    "bottom settling paged older",
  );
  await page.locator("#messages").evaluate((list) => {
    list.dispatchEvent(new Event("scroll"));
    list.focus({ preventScroll: true });
  });
  await page.keyboard.press("ArrowUp");
  await until(() => requests.length > beforeTouchGrowth, "user paging");
  h.step("touch settling near the top does not page older automatically");

  const alignment = await page.evaluate(() => {
    const model = globalThis.__followModel, now = Date.now();
    model.messages = Array.from({ length: 30 }, (_, i) => ({
      id: String(200 + i),
      chat: model.active,
      from: "u-peer",
      time: now + i * 1000,
      text: `Aligned message ${i}`,
      contentType: "NONE",
      ...(i === 29 ? { replyTo: { id: "228", text: "origin" } } : {}),
    }));
    globalThis.__followCtx.renderMessages("bottom");
    const list = document.getElementById("messages");
    for (const row of list.querySelectorAll(".message-row")) {
      row.style.contentVisibility = "visible";
    }
    list.scrollTop = list.scrollHeight;
    const target = list.querySelector('article[data-message-id="228"]');
    const area = list.getBoundingClientRect(),
      rect = target.getBoundingClientRect();
    const distance = (rect.top + rect.bottom - area.top - area.bottom) / 2;
    const spacer = document.createElement("div");
    spacer.style.height = `${distance}px`;
    list.querySelector('article[data-message-id="229"] .bubble').append(spacer);
    list.scrollTop = list.scrollHeight;
    return distance;
  });
  assert.ok(alignment > 0);
  await stableBottom();
  const centered = await page.locator('article[data-message-id="228"]')
    .evaluate((target) => {
      const area = document.getElementById("messages").getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      return (rect.top + rect.bottom - area.top - area.bottom) / 2;
    });
  assert.ok(Math.abs(centered) <= 2, `target is ${centered}px from center`);
  await page.locator('article[data-message-id="229"] .quote').evaluate(
    (quote) => {
      quote.addEventListener("click", () => {
        const model = globalThis.__followModel;
        globalThis.__followCtx.onFrame({
          boot: model.boot,
          event: {
            seq: model.seq + 1,
            kind: "message",
            chat: model.active,
            message: {
              id: "230",
              chat: model.active,
              from: model.account,
              time: Date.now() + 60000,
              text: "after centered quote\n".repeat(100),
              contentType: "NONE",
            },
          },
        });
        const list = document.getElementById("messages");
        globalThis.__alignedPendingBottom = list.scrollHeight -
          list.clientHeight -
          list.scrollTop;
      }, { once: true });
    },
  );
  await page.locator('article[data-message-id="229"] .quote').click();
  assert.ok(await page.evaluate(() => globalThis.__alignedPendingBottom) > 2);
  await page.waitForFunction(
    () => {
      const list = document.getElementById("messages");
      return !!list.querySelector('article[data-message-id="230"]') &&
        list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
    },
    null,
    { timeout: 5000 },
  );
  h.step("a centered quote restores deferred following after an idle scroll");
  await context.close();
}

export async function messageWindow(h) {
  await reactDuringEmptyPage(h);
  await touchDuringAccountChange(h);
  await touchPagingNearTop(h);
  await quoteDuringOlder(h);
  await scrollFollow(h);
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
  let forcedPages = null;
  const tap = await tapSocket(page, {
    client(frame, connection) {
      if (frame.cmd === "markRead") {
        connection.socket.send(JSON.stringify({ id: frame.id, ok: true }));
        return false;
      }
      if (frame.cmd !== "history") return true;
      requests.push(frame);
      if (frame.before && forcedPages) {
        connection.socket.send(JSON.stringify({
          id: frame.id,
          ok: true,
          data: forcedPages[frame.before] || [],
        }));
        return false;
      }
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
    // Revealing offscreen rows can change the height after the first frame.
    // Keep this test setup at the bottom until layout is stable.
    await page.locator("#messages").evaluate((list) => {
      list.scrollTop = list.scrollHeight;
      list.__testBottom = { height: -1, stable: 0 };
    });
    try {
      await page.waitForFunction(
        () => {
          const list = document.getElementById("messages");
          const state = list.__testBottom, height = list.scrollHeight;
          if (height - list.clientHeight - list.scrollTop > 2) {
            list.scrollTop = height;
            state.height = height;
            state.stable = 0;
          } else if (height !== state.height) {
            state.height = height;
            state.stable = 0;
          } else if (++state.stable >= 2) {
            delete list.__testBottom;
            return true;
          }
          return false;
        },
        null,
        { polling: "raf" },
      );
    } catch (error) {
      try {
        await reportBottom(await current());
      } catch (diagnosticError) {
        console.error("  bottom diagnostics unavailable", diagnosticError);
      }
      throw error;
    }
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
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        bottom: list.scrollHeight - list.clientHeight - list.scrollTop,
        noOlder: model.noOlder,
      };
    });
  }
  async function reportBottom(state) {
    const rows = await page.locator("#messages .message-row").evaluateAll((
      all,
    ) =>
      all.slice(-5).map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          id: row.dataset.messageId,
          top: rect.top,
          height: rect.height,
          visibility: getComputedStyle(row).contentVisibility,
        };
      })
    );
    console.error(
      "  bottom diagnostic",
      JSON.stringify({
        bottom: state.bottom,
        scrollTop: state.scrollTop,
        scrollHeight: state.scrollHeight,
        clientHeight: state.clientHeight,
        rows,
      }),
    );
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
      model.messages = Array.from({ length: options.count ?? 500 }, (_, i) => ({
        id: String(10_000_000 + i),
        chat,
        from: "u-window-peer",
        fromName: "Peer",
        time: now + i * (options.days ? 3_600_000 : 1000),
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
  async function fixtureMessage(long = false) {
    const id = nextFixtureId++;
    const message = {
      ...row(id),
      id: String(id),
      time: now + id * 1000,
      text: `Fixture live ${id}${long ? " long".repeat(50) : ""}`,
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
  await page.locator("#messages").evaluate((list) => {
    const rows = [...list.querySelectorAll(".message-row")];
    const visibility = rows.map((row) => row.style.contentVisibility);
    for (const row of rows) row.style.contentVisibility = "visible";
    const grow = document.createElement("div");
    grow.style.height = "0px";
    list.querySelector(".message-row:last-child .bubble").append(grow);
    const state = { grow, rows, visibility, started: false, done: false };
    state.onScroll = () => {
      if (
        !state.started &&
        list.scrollHeight - list.clientHeight - list.scrollTop <= 2
      ) {
        state.started = true;
        requestAnimationFrame(() => {
          grow.style.height = "87px";
          state.done = true;
        });
      }
    };
    globalThis.__bottomGrowth = state;
    list.addEventListener("scroll", state.onScroll);
    list.scrollTop = list.scrollHeight;
  });
  await page.waitForFunction(() => globalThis.__bottomGrowth.done);
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  const afterGrowth = await current();
  if (afterGrowth.bottom > 2) await reportBottom(afterGrowth);
  assert.ok(
    afterGrowth.bottom <= 2,
    `bottom after growth ${afterGrowth.bottom}`,
  );
  const readingTop = await page.locator("#messages").evaluate((list) => {
    list.dispatchEvent(new Event("scroll"));
    list.scrollTop -= 200;
    list.dispatchEvent(new Event("scroll"));
    globalThis.__bottomGrowth.grow.style.height = "174px";
    return list.scrollTop;
  });
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  const reading = await current();
  assert.ok(reading.bottom > 2);
  assert.ok(Math.abs(reading.scrollTop - readingTop) <= 2);
  await page.locator("#messages").evaluate((list) => {
    const state = globalThis.__bottomGrowth;
    list.removeEventListener("scroll", state.onScroll);
    state.grow.remove();
    state.rows.forEach((row, i) => {
      row.style.contentVisibility = state.visibility[i];
    });
    delete globalThis.__bottomGrowth;
  });
  h.step("returning to bottom settles deferred layout without pulling readers");
  await atBottom();
  const initialBottom = await current();
  if (initialBottom.bottom > 2) await reportBottom(initialBottom);
  assert.ok(
    initialBottom.bottom <= 2,
    `bottom distance ${initialBottom.bottom}`,
  );
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
    } else if (i === 500) {
      await deliver([row(i)]);
      const older = page.getByRole("button", { name: "Load older messages" });
      assert.equal((await current()).noOlder, false);
      assert.equal(await older.isVisible(), true);
      assert.equal(await older.isEnabled(), true);
      await deliver(Array.from({ length: 24 }, (_, j) => row(i + j + 1)));
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

  const originalNextFixtureId = nextFixtureId;
  await fixture({ count: 1300, days: true });
  const deferred = await page.evaluate(({ chat, now }) => {
    const model = globalThis.__windowModel, ctx = globalThis.__windowCtx;
    const list = document.getElementById("messages");
    const edited = {
      ...model.messages[1250],
      text: "History edit during trim",
    };
    ctx.onFrame({
      boot: model.boot,
      event: {
        seq: model.seq + 1,
        kind: "history",
        chat,
        messages: [edited, {
          id: "10001300",
          chat,
          from: model.account,
          time: now + 1300 * 3_600_000,
          contentType: "NONE",
          text: "Deferred trim message",
        }],
      },
    });
    const beforeScroll = model.messages.length;
    const text = document.querySelector(
      'article[data-message-id="10001250"] .message-text',
    )?.textContent;
    list.scrollTop -= 600;
    list.dispatchEvent(new Event("scroll"));
    return { count: beforeScroll, text };
  }, { chat: CHAT, now });
  assert.equal(deferred.count, 1301);
  assert.equal(deferred.text, "History edit during trim");
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  assert.equal((await current()).ids.length, 1301);
  assert.ok((await current()).bottom > 2);
  await atBottom();
  const batchFrames = await page.evaluate(({ chat, now }) => {
    const model = globalThis.__windowModel, ctx = globalThis.__windowCtx;
    const list = document.getElementById("messages");
    ctx.onFrame({
      boot: model.boot,
      event: {
        seq: model.seq + 1,
        kind: "message",
        chat,
        message: {
          id: "10001301",
          chat,
          from: model.account,
          time: now + 1301 * 3_600_000,
          contentType: "NONE",
          text: "Resume deferred trim",
        },
      },
    });
    const tail = list.querySelector(".message-row:last-child");
    const tailBottom = tail.getBoundingClientRect().bottom;
    const samples = [{
      count: model.messages.length,
      bottom: 0,
      tail: tailBottom,
    }];
    return new Promise((resolve, reject) => {
      function sample() {
        samples.push({
          count: model.messages.length,
          bottom: list.scrollHeight - list.clientHeight - list.scrollTop,
          tail: tail.getBoundingClientRect().bottom,
        });
        if (model.messages.length === 500) return resolve(samples);
        if (samples.length > 100) {
          return reject(new Error("trim did not finish"));
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
  }, { chat: CHAT, now });
  seq = await page.evaluate(() => globalThis.__windowModel.seq);
  assert.ok(batchFrames.length > 3);
  for (let i = 1; i < batchFrames.length; i++) {
    assert.ok(batchFrames[i - 1].count - batchFrames[i].count <= 200);
    assert.ok(Math.abs(batchFrames[i].bottom) <= 2);
    assert.ok(Math.abs(batchFrames[i].tail - batchFrames[0].tail) <= 2);
  }
  state = await current();
  assert.ok(state.bottom <= 2);
  assert.equal(state.noOlder, false);
  assert.deepEqual(
    await page.locator(".message-row").evaluateAll((rows) =>
      rows.map((row) => row.dataset.messageId)
    ),
    state.ids,
  );
  assert.equal(
    await page.locator(".day-divider").evaluateAll((days) =>
      days.every((day) => {
        let node = day.nextElementSibling;
        while (node && !node.classList.contains("day-divider")) {
          if (node.classList.contains("message-row")) return true;
          node = node.nextElementSibling;
        }
        return false;
      })
    ),
    true,
  );
  const archiveStart = archive.length;
  archive.push(...Array.from({ length: 1302 }, (_, i) => ({
    ...row(i),
    id: String(10_000_000 + i),
    time: now + i * 3_600_000,
  })));
  const requestsBeforeBatchPage = requests.length;
  await page.locator("#messages > button.text-button").evaluate((node) =>
    node.click()
  );
  await page.waitForFunction(() =>
    !globalThis.__windowModel.loadingOlder &&
    globalThis.__windowModel.messages.length === 550
  );
  assert.equal(requests.length, requestsBeforeBatchPage + 1);
  assert.equal(requests.at(-1).before, "10000802");
  state = await current();
  assert.deepEqual(
    state.ids,
    Array.from({ length: 550 }, (_, i) => String(10_000_752 + i)),
  );
  assert.deepEqual(
    await page.locator(".message-row").evaluateAll((rows) =>
      rows.map((row) => row.dataset.messageId)
    ),
    state.ids,
  );
  archive.splice(archiveStart);
  nextFixtureId = originalNextFixtureId;
  h.step("large trims pause while reading, resume in batches and page back");

  await page.evaluate(({ chat, now }) => {
    const model = globalThis.__windowModel, ctx = globalThis.__windowCtx;
    model.messages = [{
      id: "701",
      chat,
      from: model.account,
      time: now,
      contentType: "NONE",
      text: "Cursor 701",
    }];
    model.unreadMarkId = "";
    model.noOlder = false;
    ctx.renderMessages("bottom");
  }, { chat: CHAT, now });
  forcedPages = {
    "701": [{
      id: "701",
      chat: CHAT,
      from: "ume",
      time: now,
      contentType: "NONE",
      text: "Cursor 701",
    }],
    "700": [{
      id: "699",
      chat: CHAT,
      from: "ume",
      time: now - 2000,
      contentType: "NONE",
      text: "Cursor 699",
    }],
  };
  const beforeStalled = requests.length;
  await page.locator("#messages > button.text-button").evaluate((node) =>
    node.click()
  );
  await page.waitForFunction(() =>
    !globalThis.__windowModel.loadingOlder && globalThis.__windowModel.noOlder
  );
  assert.equal(requests.length, beforeStalled + 1);
  assert.equal(requests.at(-1).before, "701");
  await page.evaluate(() => globalThis.__windowCtx.loadOlder());
  assert.equal(requests.length, beforeStalled + 1);
  await page.evaluate(({ chat, now }) => {
    const model = globalThis.__windowModel;
    globalThis.__windowCtx.onFrame({
      boot: model.boot,
      event: {
        seq: model.seq + 1,
        kind: "message",
        chat,
        message: {
          id: "700",
          chat,
          from: model.account,
          time: now - 1000,
          contentType: "NONE",
          text: "Cursor 700",
        },
      },
    });
  }, { chat: CHAT, now });
  assert.equal(
    await page.evaluate(() => globalThis.__windowModel.noOlder),
    false,
  );
  await page.locator("#messages > button.text-button").evaluate((node) =>
    node.click()
  );
  await page.waitForFunction(() =>
    !globalThis.__windowModel.loadingOlder &&
    globalThis.__windowModel.messages[0]?.id === "699"
  );
  assert.equal(requests.length, beforeStalled + 2);
  assert.equal(requests.at(-1).before, "700");
  forcedPages = null;
  seq = await page.evaluate(() => globalThis.__windowModel.seq);
  h.step("paging resumes after a stopped cursor receives an older row");

  await fixture({ count: 1300 });
  await page.evaluate(({ chat, now }) => {
    const model = globalThis.__windowModel, ctx = globalThis.__windowCtx;
    const list = document.getElementById("messages");
    ctx.onFrame({
      boot: model.boot,
      event: {
        seq: model.seq + 1,
        kind: "message",
        chat,
        message: {
          id: "10001300",
          chat,
          from: model.account,
          time: now + 1300 * 1000,
          contentType: "NONE",
          text: "Before moving during trim",
        },
      },
    });
    requestAnimationFrame(() => {
      list.scrollTop -= 600;
      list.dispatchEvent(new Event("scroll"));
    });
  }, { chat: CHAT, now });
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    )
  );
  assert.equal((await current()).ids.length, 1101);
  assert.ok((await current()).bottom > 2);
  seq = await page.evaluate(() => globalThis.__windowModel.seq);
  h.step("moving after a trim batch cancels its pending scroll correction");

  await fixture({ count: 1300 });
  await page.evaluate(({ chat, now }) => {
    const model = globalThis.__windowModel, ctx = globalThis.__windowCtx;
    const list = document.getElementById("messages");
    ctx.onFrame({
      boot: model.boot,
      event: {
        seq: model.seq + 1,
        kind: "message",
        chat,
        message: {
          id: "10001300",
          chat,
          from: model.account,
          time: now + 1300 * 1000,
          contentType: "NONE",
          text: "Before selection",
        },
      },
    });
    const text = document.querySelector(
      'article[data-message-id="10000000"] .message-text',
    );
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    list.scrollTop = list.scrollHeight;
  }, { chat: CHAT, now });
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  assert.equal((await current()).ids.length, 1301);
  assert.ok(
    (await page.evaluate(() => getSelection().toString())).includes(
      "Fixture 0",
    ),
  );
  await page.evaluate(() => getSelection().removeAllRanges());
  seq = await page.evaluate(() => globalThis.__windowModel.seq);
  h.step("a selection made before a deferred trim protects its row");

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
  await atBottom();
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
  const selectedRow = page.locator('article[data-message-id="10000499"]');
  assert.equal(
    await selectedRow.evaluate((row) =>
      getComputedStyle(row).contentVisibility
    ),
    "visible",
  );
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => {
    const row = document.querySelector('article[data-message-id="10000499"]');
    return getComputedStyle(row).contentVisibility === "auto";
  });
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

  await fixture();
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  const previousBottom = await page.locator("#messages").evaluate((list) =>
    list.scrollTop
  );
  await page.locator("#messages").evaluate((list) => list.scrollTop -= 600);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  for (let i = 0; i < 5; i++) await fixtureMessage(true);
  assert.equal((await current()).ids.length, 505);
  if (h.browserName === "webkit") {
    // Mobile WebKit does not support Playwright wheel input.
    await page.locator("#messages").evaluate((list, top) => {
      list.scrollTop = top;
    }, previousBottom);
  } else {
    const box = await page.locator("#messages").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 5; i++) {
      const top = await page.locator("#messages").evaluate((list) =>
        list.scrollTop
      );
      if (Math.abs(top - previousBottom) <= 2) break;
      await page.mouse.wheel(0, previousBottom - top);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
  }
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const oldPosition = await page.locator("#messages").evaluate((list) => ({
    top: list.scrollTop,
    bottom: list.scrollHeight - list.clientHeight - list.scrollTop,
  }));
  assert.ok(Math.abs(oldPosition.top - previousBottom) <= 2);
  assert.ok(oldPosition.bottom > 140);
  await fixtureMessage(true);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const afterOldPosition = await current();
  assert.equal(afterOldPosition.ids.length, 506);
  assert.ok(afterOldPosition.bottom > 140);
  h.step("the previous bottom position does not resume following");

  await fixture({ quote: true });
  await page.evaluate(() => globalThis.__windowModel.noOlder = false);
  const beforeQuote = requests.length;
  await page.locator('article[data-message-id="10000499"] .quote').click();
  await page.waitForFunction(() =>
    document.getElementById("messages").scrollTop < 150
  );
  await page.waitForTimeout(400);
  assert.equal(requests.length, beforeQuote);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("k");
  await page.waitForTimeout(200);
  assert.equal(requests.length, beforeQuote, "body must not enable k shortcut");
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

// Message list DOM, actions and scroll anchoring. Uses protocol and DOM
// helpers.
import { $, el, formatTime, richText } from "./dom.js";
import { compareMessages, trimHistory } from "./protocol.js";
import { placeKeyedNodes, planKeyChanges } from "./keyed.js";
const HISTORY_LIMIT = 500, TRIM_BATCH = 200;
export function createMessagesView(ctx) {
  const model = ctx.model, t = ctx.t, english = ctx.english;
  const records = new Map();
  const rowMessages = new WeakMap();
  let order = [], renderedChat = "", renderedAccount = "", renderedTail = null;
  let renderedRows = [], renderedDesired = [], renderedToday = "";
  let renderedUnread = "";
  let followedTop = null;
  let followFrame = 0, trimFrame = 0;
  let suppressPaging = false, pagingTimer = 0, touchY = null;
  const command = (...args) => ctx.command(...args);
  const displayError = (error) => ctx.displayError(error);
  const pendingFor = (...args) => ctx.pendingFor(...args);
  const addMedia = (...args) => ctx.addMedia(...args);
  const retrySend = (...args) => ctx.retrySend(...args);
  const reactionTypes = {
    NICE: "👍",
    LOVE: "❤️",
    FUN: "😆",
    AMAZING: "😲",
    SAD: "😢",
    OMG: "😱",
  };
  function scrollToMessage(id) {
    const target = [...$("messages").querySelectorAll(".message-row")].find(
      (row) => row.dataset.messageId === String(id || ""),
    );
    if (!id || !target) {
      ctx.toast(t("missingOrigin"));
      return;
    }
    interruptFollowing();
    // A quote jump can pass the paging threshold without the reader scrolling.
    suspendPaging(1000);
    target.scrollIntoView({
      block: "center",
      behavior:
        globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
    });
    target.classList.add("quote-target");
    setTimeout(() => target.classList.remove("quote-target"), 2000);
  }
  function closeOpenReactions() {
    for (const picker of $("messages").querySelectorAll(".reaction-picker")) {
      if (picker.contains(document.activeElement)) {
        picker.parentElement.querySelector(
          ".message-actions button:nth-child(2)",
        )?.focus();
      }
      picker.remove();
    }
    ctx.resetReactionPickers();
  }
  function messageNode(message, includeMedia = true) {
    const chat = model.active,
      own = message.from === model.account,
      row = el("article", `message-row${own ? " own" : ""}`),
      column = el("div", "message-column");
    rowMessages.set(row, message);
    row.dataset.messageId = String(message.id || "");
    if (
      !own && (chat.startsWith("c") || chat.startsWith("r")) && message.fromName
    ) column.append(el("div", "sender", message.fromName));
    const system = message.unsent || message.decryptFailed ||
      ["CHATEVENT", "POSTNOTIFICATION"].includes(message.contentType);
    const bubble = el("div", `bubble${system ? " system" : ""}`);
    if (message.replyTo && !message.unsent) {
      const quote = message.replyTo,
        text = `${quote.fromName ? `${quote.fromName}: ` : ""}${
          quote.text || t("message")
        }`;
      const button = el("button", "quote", text);
      button.type = "button";
      button.title = t("jumpToOrigin");
      button.addEventListener("click", () => scrollToMessage(quote.id));
      bubble.append(button);
    }
    let body = message.unsent
      ? t("unsent")
      : message.decryptFailed
      ? t("decryptFailed")
      : String(message.text || "");
    if (message.contentType === "FLEX" && message.altText) {
      body = String(message.altText);
    }
    if (
      ["CHATEVENT", "POSTNOTIFICATION"].includes(message.contentType) &&
      (!body || body.toUpperCase() === message.contentType)
    ) {
      body = message.contentType === "CHATEVENT"
        ? t("systemEvent")
        : t("postEvent");
    }
    if (body) {
      const content = el("div", "message-text");
      content.append(richText(body, message.mentions));
      bubble.append(content);
    }
    if (
      !message.unsent &&
      ["STICKER", "FLEX", "IMAGE", "VIDEO", "FILE"].includes(
        message.contentType,
      )
    ) {
      const media = el("div", "message-media");
      if (includeMedia) addMedia(media, message, chat);
      bubble.append(media);
    }
    column.append(bubble);
    if (
      !message.unsent && Array.isArray(message.reactions) &&
      message.reactions.length
    ) {
      const reactions = el("div", "reactions");
      for (const reaction of message.reactions) {
        const type = String(reaction.type || ""),
          button = el(
            "button",
            `reaction-pill${reaction.mine ? " mine" : ""}`,
            `${reactionTypes[type] || type} ${Number(reaction.count || 0)}`,
          );
        button.type = "button";
        button.title = reaction.mine ? t("undoReaction") : t("reaction");
        button.addEventListener(
          "click",
          () =>
            command("react", {
              chat,
              messageId: String(message.id),
              type: reaction.mine ? "UNDO" : type,
            }).catch(displayError),
        );
        reactions.append(button);
      }
      column.append(reactions);
    }
    const meta = el("div", "message-meta");
    if (
      own && message.readBy?.count > 0 && !message.pending && !message.unsent
    ) {
      meta.append(
        el(
          "span",
          "",
          message.readBy.all
            ? t("read")
            : `${t("read")} ${message.readBy.count}`,
        ),
      );
    }
    if (message.pending) {
      const status = message.status === "failed"
        ? t("failed")
        : message.status === "uncertain"
        ? t("uncertain")
        : message.status === "sent"
        ? t("sent")
        : t("sending");
      meta.append(
        el(
          "span",
          `message-state${message.status === "failed" ? " failed" : ""}`,
          status,
        ),
      );
      if (message.status === "failed" || message.status === "uncertain") {
        const retry = el("button", "retry-button", t("retry"));
        retry.type = "button";
        retry.addEventListener("click", () => retrySend(chat, message));
        meta.append(retry);
      }
    }
    meta.append(el("time", "", formatTime(message.time, english)));
    if (
      !message.pending && !message.unsent &&
      !["CHATEVENT", "POSTNOTIFICATION"].includes(message.contentType)
    ) {
      const actions = el("span", "message-actions");
      const reply = el("button", "", t("reply"));
      reply.type = "button";
      reply.addEventListener("click", () => {
        const current = rowMessages.get(reply.closest(".message-row"));
        if (current) ctx.startReply(current);
      });
      actions.append(reply);
      const react = el("button", "", t("reaction"));
      react.type = "button";
      react.addEventListener("click", () => {
        const currentColumn = react.closest(".message-column");
        if (!currentColumn) return;
        const id = String(message.id);
        if (!ctx.toggleReactionPicker(id)) {
          currentColumn.querySelector(".reaction-picker")?.remove();
          return;
        }
        const picker = el("div", "reaction-picker");
        for (const [type, emoji] of Object.entries(reactionTypes)) {
          const button = el("button", "", emoji);
          button.type = "button";
          button.title = type;
          button.setAttribute("aria-label", type);
          button.addEventListener("click", () => {
            ctx.closeReactionPicker(id);
            picker.remove();
            command("react", { chat, messageId: String(message.id), type })
              .catch(
                displayError,
              );
          });
          picker.append(button);
        }
        const undo = el("button", "", "×");
        undo.type = "button";
        undo.title = t("undoReaction");
        undo.setAttribute("aria-label", t("undoReaction"));
        undo.addEventListener("click", () => {
          ctx.closeReactionPicker(id);
          picker.remove();
          command("react", {
            chat,
            messageId: String(message.id),
            type: "UNDO",
          })
            .catch(displayError);
        });
        picker.append(undo);
        currentColumn.append(picker);
      });
      actions.append(react);
      if (own) {
        const unsend = el("button", "", t("unsend"));
        unsend.type = "button";
        unsend.addEventListener("click", () => {
          if (confirm(t("confirmUnsend"))) {
            command("unsend", { chat, messageId: String(message.id) }).catch(
              displayError,
            );
          }
        });
        actions.append(unsend);
      }
      meta.append(actions);
    }
    column.append(meta);
    row.append(column);
    return row;
  }
  // Keep unchanged media and message actions connected across updates.
  function updateMessageParts(oldRow, newRow, keepMedia, id) {
    const oldColumn = oldRow.firstElementChild;
    const newColumn = newRow.firstElementChild;
    const oldBubble = oldColumn.querySelector(":scope > .bubble");
    const newBubble = newColumn.querySelector(":scope > .bubble");
    const media = oldBubble.querySelector(":scope > .message-media");
    const oldMeta = oldColumn.querySelector(":scope > .message-meta");
    const newMeta = newColumn.querySelector(":scope > .message-meta");
    const oldActions = oldMeta.querySelector(":scope > .message-actions");
    const newActions = newMeta.querySelector(":scope > .message-actions");
    const keepActions = oldActions && newActions &&
      oldActions.children.length === newActions.children.length &&
      [...oldActions.children].every((button, index) =>
        button.textContent === newActions.children[index].textContent
      );
    const picker = oldColumn.querySelector(":scope > .reaction-picker");
    if (!keepActions) {
      ctx.closeReactionPicker(id);
      picker?.remove();
    }
    oldRow.className = newRow.className;
    oldBubble.className = newBubble.className;
    for (const child of [...oldBubble.children]) {
      if (!keepMedia || child !== media) child.remove();
    }
    for (const child of [...newBubble.children]) {
      if (keepMedia && child.classList.contains("message-media")) continue;
      oldBubble.insertBefore(child, keepMedia ? media : null);
    }
    if (keepActions) {
      for (const child of [...oldMeta.children]) {
        if (child !== oldActions) child.remove();
      }
      for (const child of [...newMeta.children]) {
        if (child !== newActions) oldMeta.insertBefore(child, oldActions);
      }
    } else {
      oldMeta.replaceWith(newMeta);
    }
    for (const child of [...oldColumn.children]) {
      if (
        child !== oldBubble && child !== (keepActions ? oldMeta : newMeta) &&
        (!keepActions || child !== picker)
      ) child.remove();
    }
    for (const child of [...newColumn.children]) {
      if (child === newBubble || child === newMeta) continue;
      if (child.classList.contains("sender")) {
        oldColumn.insertBefore(child, oldBubble);
      } else oldColumn.insertBefore(child, keepActions ? oldMeta : newMeta);
    }
  }
  function protectedMessageIds(list) {
    const protectedIds = new Set();
    if (model.unreadMarkId) protectedIds.add(model.unreadMarkId);
    const pending = pendingFor();
    if (pending.length || model.sent.size) {
      const pendingIds = new Set(pending.map((row) => row.requestId));
      for (const message of model.messages) {
        if (
          message.from === model.account && message.requestId &&
          (model.sent.has(message.requestId) ||
            pendingIds.has(message.requestId))
        ) protectedIds.add(String(message.id || ""));
      }
    }
    function rowOf(node) {
      const element = node instanceof Element ? node : node?.parentElement;
      const row = element?.closest(".message-row");
      return row && list.contains(row) ? row : null;
    }
    function protect(row) {
      if (row?.dataset.messageId) protectedIds.add(row.dataset.messageId);
    }
    protect(rowOf(document.activeElement));
    for (const video of list.getElementsByTagName("video")) {
      if (!video.paused && !video.ended) protect(rowOf(video));
    }
    const selection = globalThis.getSelection();
    if (selection && !selection.isCollapsed) {
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        const first = rowOf(range.startContainer),
          last = rowOf(range.endContainer);
        if (first && first === last) {
          protect(first);
        } else {
          for (const record of records.values()) {
            if (record.message && range.intersectsNode(record.node)) {
              protect(record.node);
            }
          }
        }
      }
    }
    return protectedIds;
  }
  function lastConfirmed(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].pending && rows[i].id) return rows[i];
    }
    return null;
  }
  function followBottom(list) {
    if (followFrame) cancelAnimationFrame(followFrame);
    list.scrollTop = list.scrollHeight;
    followedTop = list.scrollTop;
    const chat = renderedChat, account = renderedAccount;
    let frames = 2;
    function settle() {
      followFrame = 0;
      if (
        chat !== renderedChat || account !== renderedAccount ||
        followedTop === null || Math.abs(list.scrollTop - followedTop) > 2
      ) return;
      list.scrollTop = list.scrollHeight;
      followedTop = list.scrollTop;
      if (--frames) followFrame = requestAnimationFrame(settle);
    }
    followFrame = requestAnimationFrame(settle);
  }
  function removeRecord(key) {
    const record = records.get(key);
    if (record.message) {
      ctx.unobservePreviews(record.node);
      ctx.closeReactionPicker(String(record.message.id || ""));
    }
    record.node.remove();
    records.delete(key);
  }
  function setOlderAvailable(node, available) {
    node.disabled = !available;
    node.style.visibility = available ? "" : "hidden";
  }
  function interruptFollowing() {
    followedTop = null;
    if (followFrame) cancelAnimationFrame(followFrame);
    if (trimFrame) cancelAnimationFrame(trimFrame);
    followFrame = 0;
    trimFrame = 0;
  }
  function scheduleTrim(list) {
    if (trimFrame) return;
    const chat = renderedChat, account = renderedAccount;
    trimFrame = requestAnimationFrame(() => {
      trimFrame = 0;
      if (
        chat !== renderedChat || account !== renderedAccount ||
        chat !== model.active || account !== model.account ||
        model.loading || model.loadingOlder || $("lightbox").open ||
        !ctx.isViewingChat()
      ) return;
      const top = list.scrollTop;
      if (
        list.scrollHeight - top - list.clientHeight > 2 &&
        (followedTop === null || Math.abs(top - followedTop) > 2)
      ) return;
      const kept = trimHistory(
        model.messages,
        HISTORY_LIMIT,
        protectedMessageIds(list),
        TRIM_BATCH,
      );
      if (kept === model.messages) return;
      const removed = new Set(model.messages);
      for (const row of kept) removed.delete(row);
      model.messages = kept;
      model.noOlder = false;
      const removedKeys = new Set();
      for (const [key, record] of records) {
        if (record.message && removed.has(record.message)) {
          removeRecord(key);
          removedKeys.add(key);
        }
      }
      // A day heading with no remaining row must leave with its last row.
      let dayKey = "", hasMessage = false;
      function removeEmptyDay() {
        if (dayKey && !hasMessage) {
          removeRecord(dayKey);
          removedKeys.add(dayKey);
        }
      }
      for (const key of order) {
        if (removedKeys.has(key)) continue;
        if (key.startsWith("day:")) {
          removeEmptyDay();
          dayKey = key;
          hasMessage = false;
        } else if (key.startsWith("message:")) hasMessage = true;
      }
      removeEmptyDay();
      order = order.filter((key) => !removedKeys.has(key));
      renderedRows = renderedRows.filter((row) => !removed.has(row));
      renderedDesired = renderedDesired.filter((item) =>
        !removedKeys.has(item.key)
      );
      if (!records.has("control:older")) {
        const node = el("button", "text-button", t("older"));
        node.type = "button";
        node.addEventListener("click", () => ctx.loadOlder());
        list.insertBefore(node, list.firstChild);
        records.set("control:older", { node });
        order.unshift("control:older");
        renderedDesired.unshift({ key: "control:older", type: "older" });
      } else setOlderAvailable(records.get("control:older").node, true);
      // Let the browser clamp the scroll position after the removals. Read
      // and correct it in the next frame, after layout has caught up.
      trimFrame = requestAnimationFrame(() => {
        trimFrame = 0;
        if (
          chat !== renderedChat || account !== renderedAccount ||
          chat !== model.active || account !== model.account ||
          model.loading || model.loadingOlder || $("lightbox").open ||
          !ctx.isViewingChat()
        ) return;
        const current = list.scrollTop;
        const max = Math.max(0, list.scrollHeight - list.clientHeight);
        if (
          max - current > 2 && Math.abs(current - Math.min(top, max)) > 2
        ) return;
        followBottom(list);
        scheduleTrim(list);
      });
    });
  }
  function suspendPaging(delay) {
    suppressPaging = true;
    clearTimeout(pagingTimer);
    pagingTimer = setTimeout(() => suppressPaging = false, delay);
  }
  function renderMessages(mode = "preserve") {
    if (model.noOlder) ctx.refreshOlderAvailability();
    if ((mode === "bottom" || mode === "anchor") && trimFrame) {
      cancelAnimationFrame(trimFrame);
      trimFrame = 0;
    }
    const list = $("messages"),
      oldHeight = list.scrollHeight,
      oldTop = list.scrollTop;
    let anchor, anchorTop;
    if (mode === "anchor") {
      suspendPaging(200);
      const area = list.getBoundingClientRect();
      anchor = [...list.querySelectorAll(".message-row")].find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > area.top && rect.top < area.bottom;
      });
      anchorTop = anchor?.getBoundingClientRect().top;
    }
    const atBottom = oldHeight - oldTop - list.clientHeight <= 2;
    // Deferred layout can grow the list without moving its scroll position.
    // A user who moved away from the last pinned position is reading history.
    const following = atBottom ||
      (followedTop !== null && Math.abs(oldTop - followedTop) <= 2);
    const chatChanged = renderedChat !== model.active ||
      renderedAccount !== model.account;
    if (chatChanged) {
      suppressPaging = false;
      clearTimeout(pagingTimer);
      if (followFrame) cancelAnimationFrame(followFrame);
      if (trimFrame) cancelAnimationFrame(trimFrame);
      followFrame = 0;
      trimFrame = 0;
      ctx.resetReactionPickers();
      for (const record of records.values()) {
        if (record.message) ctx.unobservePreviews(record.node);
        record.node.remove();
      }
      records.clear();
      order = [];
      renderedRows = [];
      renderedDesired = [];
      renderedToday = "";
      renderedUnread = "";
      renderedTail = null;
      followedTop = null;
      renderedChat = model.active;
      renderedAccount = model.account;
    }
    const newest = lastConfirmed(model.messages);
    const appended = newest && renderedTail &&
      String(newest.id) !== String(renderedTail.id) &&
      compareMessages(newest, renderedTail) > 0 &&
      !records.has(`message:${newest.id}:0`);
    let deferTrim = false;
    if (
      mode === "follow" && following && appended && !chatChanged &&
      !model.loading && !model.loadingOlder &&
      model.messages.length > HISTORY_LIMIT &&
      !$("lightbox").open && ctx.isViewingChat()
    ) {
      if (model.messages.length > HISTORY_LIMIT + TRIM_BATCH) deferTrim = true;
      else {
        const kept = trimHistory(
          model.messages,
          HISTORY_LIMIT,
          protectedMessageIds(list),
        );
        if (kept !== model.messages) {
          model.messages = kept;
          model.noOlder = false;
        }
      }
    }
    const olderControl = records.get("control:older");
    if (olderControl) setOlderAvailable(olderControl.node, !model.noOlder);
    const rows = model.messages.slice();
    const pendingRows = pendingFor();
    if (pendingRows.length) {
      const requestIds = new Set(
        rows.filter((m) => m.from === model.account && m.requestId).map((m) =>
          m.requestId
        ),
      );
      for (const pending of pendingRows) {
        if (!requestIds.has(pending.requestId)) {
          rows.push({
            ...pending,
            status: pending.status === "sending" ? "uncertain" : pending.status,
          });
        }
      }
    }
    rows.sort(compareMessages);
    const today = new Date().toDateString();
    let appendOnly = false, tail, tailTime = 0, tailDay = "";
    if (
      deferTrim && !pendingRows.length && !model.sent.size &&
      rows.length === renderedRows.length + 1 && renderedToday === today &&
      renderedUnread === model.unreadMarkId &&
      (model.noOlder || records.has("control:older"))
    ) {
      tail = rows[rows.length - 1];
      const lastItem = renderedDesired[renderedDesired.length - 1];
      tailTime = Number(tail?.time || 0);
      const tailDate = new Date(tailTime);
      tailDay = Number.isNaN(tailDate.getTime()) ? "" : tailDate.toDateString();
      appendOnly = tail === newest && lastItem?.type === "message" &&
        !!lastItem.day && lastItem.day === tailDay &&
        String(tail.id || "") !== model.unreadMarkId;
    }
    if (appendOnly) {
      for (let i = 0; i < renderedRows.length; i++) {
        if (rows[i] !== renderedRows[i] || rows[i].pending) {
          appendOnly = false;
          break;
        }
      }
    }
    let desired;
    if (appendOnly) {
      desired = renderedDesired.slice();
      desired.push({
        key: `message:${tail.id}:0`,
        type: "message",
        message: tail,
        time: tailTime,
        day: tailDay,
        today,
      });
    } else {
      desired = [];
      // Keep the control's space after an empty page: removing it at the top
      // can move a message between pointer down and pointer up.
      if (
        rows.some((m) => !m.pending) &&
        (!model.noOlder || records.has("control:older"))
      ) {
        desired.push({ key: "control:older", type: "older" });
      }
      if (!rows.length) {
        desired.push({
          key: "control:empty",
          type: "empty",
          text: model.loading ? t("loading") : t("noMessages"),
        });
      }
      let previousDay = "", unreadPlaced = false;
      const counts = new Map(), dayCounts = new Map();
      for (const message of rows) {
        const id = String(message.id || ""), count = counts.get(id) || 0;
        counts.set(id, count + 1);
        const key = `message:${id}:${count}`;
        const prior = records.get(key);
        const time = Number(message.time || 0);
        let day = prior?.time === time ? prior.day : undefined;
        if (day === undefined) {
          const date = new Date(time);
          day = Number.isNaN(date.getTime()) ? "" : date.toDateString();
        }
        if (day && day !== previousDay) {
          const dayCount = dayCounts.get(day) || 0;
          dayCounts.set(day, dayCount + 1);
          desired.push({ key: `day:${day}:${dayCount}`, type: "day", time });
          previousDay = day;
        }
        if (
          !unreadPlaced && model.unreadMarkId &&
          String(message.id || "") === model.unreadMarkId
        ) {
          desired.push({ key: "control:unread", type: "unread" });
          unreadPlaced = true;
        }
        desired.push({ key, type: "message", message, time, day, today });
      }
    }
    renderedTail = lastConfirmed(rows);
    renderedRows = rows;
    renderedDesired = desired;
    renderedToday = today;
    renderedUnread = model.unreadMarkId;
    const keys = desired.map((item) => item.key);
    const changes = planKeyChanges(order, keys);
    for (const key of changes.removed) {
      removeRecord(key);
    }
    for (const item of desired) {
      const prior = records.get(item.key);
      if (item.type === "message") {
        const id = String(item.message.id || "");
        const preview = model.previews.get(id),
          hasPreview = model.previews.has(id);
        const unchanged = prior?.message === item.message &&
          prior.preview === preview && prior.hasPreview === hasPreview &&
          prior.today === today;
        if (unchanged) continue;
        const signature = JSON.stringify([
          item.message,
          preview,
          hasPreview,
          today,
        ]);
        if (prior?.signature === signature) {
          prior.message = item.message;
          continue;
        }
        const mediaSignature = JSON.stringify([
          item.message.contentType,
          item.message.unsent,
          item.message.pending,
          item.message.mediaState,
          item.message.previewable,
          item.message.mediaPath,
          item.message.hasMedia,
          item.message.stickerUrl,
          item.message.flexImages,
          item.message.fileName,
          item.message.fileSize,
          preview,
          hasPreview,
        ]);
        const keepMedia = prior?.mediaSignature === mediaSignature;
        let node = messageNode(item.message, !keepMedia);
        if (prior) {
          if (!keepMedia) ctx.unobservePreviews(prior.node);
          updateMessageParts(prior.node, node, keepMedia, id);
          rowMessages.set(prior.node, item.message);
          node = prior.node;
        }
        records.set(item.key, {
          node,
          message: item.message,
          signature,
          mediaSignature,
          preview,
          hasPreview,
          today,
          time: item.time,
          day: item.day,
        });
      } else if (
        !prior || (item.type === "empty" && prior.text !== item.text)
      ) {
        let node;
        if (item.type === "older") {
          node = el("button", "text-button", t("older"));
          node.type = "button";
          node.addEventListener("click", () => ctx.loadOlder());
        } else if (item.type === "day") {
          node = el(
            "div",
            "day-divider",
            new Date(item.time).toLocaleDateString(
              english ? "en" : "zh-TW",
              { year: "numeric", month: "short", day: "numeric" },
            ),
          );
        } else if (item.type === "unread") {
          node = el("div", "unread-divider", t("unreadDivider"));
        } else node = el("div", "loading-message", item.text);
        if (prior) prior.node.replaceWith(node);
        records.set(item.key, { node, text: item.text });
      }
    }
    // A top trim followed by an append leaves all retained nodes in order.
    if (
      changes.removed.length && !changes.moved.length &&
      changes.added.length &&
      changes.added.every((key, index) =>
        key === keys[keys.length - changes.added.length + index]
      )
    ) {
      for (const key of changes.added) list.append(records.get(key).node);
    } else placeKeyedNodes(list, keys, records, changes);
    order = keys;
    ctx.refreshLightbox();
    if (mode === "bottom" || (mode === "follow" && following)) {
      followBottom(list);
    } else if (mode === "anchor") {
      if (!anchor?.isConnected) {
        list.scrollTop = oldTop + list.scrollHeight - oldHeight;
      } else {
        const chat = renderedChat, account = renderedAccount;
        let expectedTop = list.scrollTop, frames = 3;
        const settleAnchor = () => {
          if (
            chat !== renderedChat || account !== renderedAccount ||
            !anchor.isConnected || Math.abs(list.scrollTop - expectedTop) > 2
          ) return;
          list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
          expectedTop = list.scrollTop;
          if (--frames) requestAnimationFrame(settleAnchor);
        };
        settleAnchor();
      }
    } else list.scrollTop = oldTop;
    if (deferTrim) scheduleTrim(list);
  }
  const list = $("messages");
  function loadNearTop() {
    if (list.scrollTop < 150 && list.scrollHeight > list.clientHeight + 10) {
      ctx.loadOlder();
    }
  }
  function resumePaging(up) {
    interruptFollowing();
    suppressPaging = false;
    clearTimeout(pagingTimer);
    // A gesture at the top may not produce a scroll event at all.
    if (up) loadNearTop();
  }
  list.addEventListener("scroll", () => {
    // Remember a reader's return to the bottom before deferred layout grows.
    if (list.scrollHeight - list.scrollTop - list.clientHeight <= 2) {
      followedTop = list.scrollTop;
    } else if (
      followedTop !== null && Math.abs(list.scrollTop - followedTop) > 2
    ) {
      followedTop = null;
    }
    if (suppressPaging) {
      suspendPaging(200);
      return;
    }
    loadNearTop();
  });
  list.addEventListener("wheel", (event) => resumePaging(event.deltaY < 0), {
    passive: true,
  });
  list.addEventListener("touchstart", (event) => {
    touchY = event.touches[0]?.clientY ?? null;
  }, { passive: true });
  list.addEventListener("touchmove", (event) => {
    const y = event.touches[0]?.clientY;
    resumePaging(touchY !== null && y > touchY);
    touchY = y ?? null;
  }, { passive: true });
  list.addEventListener("pointerdown", (event) => {
    if (event.target === list && event.pointerType === "mouse") {
      resumePaging(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      !ctx.isViewingChat() || $("lightbox").open || event.defaultPrevented ||
      event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
      event.shiftKey ||
      !(event.target === document.body || list.contains(event.target))
    ) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(
        target.tagName,
      ))
    ) return;
    if (event.key === "j" || event.key === "k") {
      if (!(target instanceof Element) || !list.contains(target)) return;
      const control = target.closest(
        'a[href], button, input, select, textarea, [role="button"], ' +
          '[contenteditable]:not([contenteditable="false"]), [tabindex], ' +
          "audio[controls], video[controls]",
      );
      if (control && control !== list) return;
    }
    if (["ArrowUp", "PageUp", "Home", "k"].includes(event.key)) {
      resumePaging(true);
    } else if (["ArrowDown", "PageDown", "End", "j"].includes(event.key)) {
      resumePaging(false);
    }
  }, true);
  return { renderMessages, closeOpenReactions };
}

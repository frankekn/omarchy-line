// Message list DOM, actions and scroll anchoring. Uses protocol and DOM
// helpers.
import { $, el, formatTime, richText } from "./dom.js";
import { compareMessages } from "./protocol.js";
import { placeKeyedNodes, planKeyChanges } from "./keyed.js";
export function createMessagesView(ctx) {
  const model = ctx.model, t = ctx.t, english = ctx.english;
  const records = new Map();
  let order = [], renderedChat = "", renderedAccount = "";
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
    target.scrollIntoView({ block: "center", behavior: "smooth" });
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
        ctx.startReply(message);
      });
      actions.append(reply);
      const react = el("button", "", t("reaction"));
      react.type = "button";
      react.addEventListener("click", () => {
        const id = String(message.id);
        if (!ctx.toggleReactionPicker(id)) {
          column.querySelector(".reaction-picker")?.remove();
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
        column.append(picker);
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
  // Keep media connected when an edit, reaction or read receipt only changes
  // the rest of the message. A playing video must not be removed from the DOM.
  function updateMessageParts(oldRow, newRow) {
    const oldColumn = oldRow.firstElementChild;
    const newColumn = newRow.firstElementChild;
    const oldBubble = oldColumn.querySelector(":scope > .bubble");
    const newBubble = newColumn.querySelector(":scope > .bubble");
    const media = oldBubble.querySelector(":scope > .message-media");
    oldRow.className = newRow.className;
    oldBubble.className = newBubble.className;
    for (const child of [...oldBubble.children]) {
      if (child !== media) child.remove();
    }
    for (const child of [...newBubble.children]) {
      if (!child.classList.contains("message-media")) {
        oldBubble.insertBefore(child, media);
      }
    }
    for (const child of [...oldColumn.children]) {
      if (child !== oldBubble) child.remove();
    }
    for (const child of [...newColumn.children]) {
      if (child === newBubble) continue;
      if (child.classList.contains("sender")) {
        oldColumn.insertBefore(child, oldBubble);
      } else oldColumn.append(child);
    }
  }
  function renderMessages(mode = "preserve") {
    const list = $("messages"),
      oldHeight = list.scrollHeight,
      oldTop = list.scrollTop;
    const nearBottom = oldHeight - oldTop - list.clientHeight < 140;
    if (renderedChat !== model.active || renderedAccount !== model.account) {
      ctx.resetReactionPickers();
      for (const record of records.values()) {
        if (record.message) ctx.unobservePreviews(record.node);
        record.node.remove();
      }
      records.clear();
      order = [];
      renderedChat = model.active;
      renderedAccount = model.account;
    }
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
    const desired = [];
    if (!model.noOlder && rows.some((m) => !m.pending)) {
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
    const today = new Date().toDateString();
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
    const keys = desired.map((item) => item.key);
    const changes = planKeyChanges(order, keys);
    for (const key of changes.removed) {
      const record = records.get(key);
      if (record.message) {
        ctx.unobservePreviews(record.node);
        ctx.closeReactionPicker(String(record.message.id || ""));
      }
      record.node.remove();
      records.delete(key);
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
          ctx.closeReactionPicker(id);
          if (keepMedia) {
            updateMessageParts(prior.node, node);
            node = prior.node;
          } else {
            ctx.unobservePreviews(prior.node);
            prior.node.replaceWith(node);
          }
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
    placeKeyedNodes(list, keys, records, changes);
    order = keys;
    if (mode === "bottom" || (mode === "follow" && nearBottom)) {
      list.scrollTop = list.scrollHeight;
    } else if (mode === "anchor") {
      list.scrollTop = oldTop + list.scrollHeight - oldHeight;
    } else list.scrollTop = oldTop;
  }
  $("messages").addEventListener("scroll", () => {
    const list = $("messages");
    if (list.scrollTop < 150 && list.scrollHeight > list.clientHeight + 10) {
      ctx.loadOlder();
    }
  });
  return { renderMessages, closeOpenReactions };
}

// Message list DOM, actions and scroll anchoring. Uses protocol and DOM
// helpers.
import { $, el, formatTime, icon, richText } from "./dom.js";
import { compareMessages, trimHistory } from "./protocol.js";
import { placeKeyedNodes, planKeyChanges } from "./keyed.js";
import { continuesMessageRun } from "./message-grouping.js";
import { makeMessageMenu } from "./view-message-menu.js";
const HISTORY_LIMIT = 500, TRIM_BATCH = 200;
export function createMessagesView(ctx) {
  const model = ctx.model, t = ctx.t, english = ctx.english;
  const records = new Map();
  const actionMenu = makeMessageMenu(t, resumeMenuFollowing);
  const actionFocus = (button) =>
    button?.closest(".message-actions")?.querySelector(".message-more");
  const rowMessages = new WeakMap();
  const selectionVisibility = new Map();
  let order = [], renderedChat = "", renderedAccount = "", renderedTail = null;
  let renderedRows = [], renderedDesired = [], renderedToday = "";
  let renderedUnread = "";
  let followedTop = null, menuWasFollowing = false;
  let followFrame = 0, trimFrame = 0, quoteFrame = 0;
  let suppressPaging = false, pagingTimer = 0, touchY = null;
  let programmaticScroll = false, programmaticMoved = false;
  let programmaticTop = 0, programmaticTimer = 0;
  let quoteJumpTarget = "";
  let followAfterProgrammatic = false;
  let touchPhase = "idle", touchTimer = 0;
  let touchPaging = false;
  let trimAfterTouch = false, followAfterTouch = false;
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
  function alignQuoteTarget(target) {
    if (quoteFrame) cancelAnimationFrame(quoteFrame);
    const chat = renderedChat, account = renderedAccount;
    const id = target.dataset.messageId;
    let frames = 3;
    function align() {
      quoteFrame = 0;
      if (
        !target.isConnected || chat !== renderedChat ||
        account !== renderedAccount || !programmaticScroll ||
        quoteJumpTarget !== id
      ) return;
      // Deferred rows change height when revealed. Settle locally instead of
      // animating toward an estimate through an unlaid-out history window.
      target.scrollIntoView({ block: "center", behavior: "instant" });
      if (--frames) quoteFrame = requestAnimationFrame(align);
    }
    align();
  }
  function scrollToMessage(id) {
    const list = $("messages");
    const target = [...list.querySelectorAll(".message-row")].find(
      (row) => row.dataset.messageId === String(id || ""),
    );
    if (!id || !target) {
      ctx.toast(t("missingOrigin"));
      return;
    }
    interruptFollowing();
    beginProgrammaticScroll(String(id));
    // A quote jump can pass the paging threshold without the reader scrolling.
    suspendPaging(1000);
    target.classList.add("quote-target");
    alignQuoteTarget(target);
    if (list.scrollHeight <= list.clientHeight) {
      endProgrammaticScroll();
    }
    setTimeout(() => target.classList.remove("quote-target"), 2000);
  }
  function closeOpenReactions() {
    for (const picker of $("messages").querySelectorAll(".reaction-picker")) {
      const trigger = picker.parentElement.querySelector(
        ".message-action[data-action='reaction']",
      );
      trigger?.setAttribute("aria-expanded", "false");
      trigger?.removeAttribute("aria-controls");
      if (picker.contains(document.activeElement)) {
        actionFocus(trigger)?.focus({ preventScroll: true });
      }
      picker.remove();
    }
    ctx.resetReactionPickers();
  }
  // enil:message-actions-begin
  function locationCard(place) {
    const card = el("div", "location-card");
    const title = String(place.title || ""),
      address = String(place.address || "");
    card.append(el("strong", "location-title", title || t("location")));
    if (address) card.append(el("span", "location-address", address));
    const lat = Number(place.latitude), lng = Number(place.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const link = el("a", "location-link", t("openInMaps"));
      link.href = `https://www.google.com/maps?q=${lat},${lng}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }
    return card;
  }
  function messageAction(label, symbol) {
    const button = el("button", "message-action");
    button.type = "button";
    button.dataset.action = label;
    button.title = t(label);
    button.append(icon(symbol), el("span", "sr-only", t(label)));
    return button;
  }
  function appendMessageActions(actions, chat, message, text) {
    if (text) {
      const copy = messageAction("copy", "copy");
      copy.addEventListener(
        "click",
        () => void ctx.copyText(actionText(copy)),
      );
      actions.append(copy);
    }
    if (
      ["IMAGE", "VIDEO", "FILE", "AUDIO"].includes(message.contentType) &&
      message.hasMedia && (!message.mediaState || message.mediaState === "ok")
    ) {
      const save = messageAction("save", "download");
      save.addEventListener("click", () => {
        const current = rowMessages.get(save.closest(".message-row"));
        void ctx.downloadMessage(chat, current || message);
      });
      actions.append(save);
    }
    if (
      text && message.contentType === "NONE" && !message.decryptFailed
    ) {
      const forward = messageAction("forward", "forward");
      forward.addEventListener(
        "click",
        () =>
          ctx.forwardText(
            actionText(forward),
            actionFocus(forward),
          ),
      );
      actions.append(forward);
    }
  }
  function actionText(button) {
    const current = rowMessages.get(button.closest(".message-row"));
    return current ? messageBody(current) : "";
  }
  function messageBody(message) {
    if (message.unsent) return t("unsent");
    if (message.decryptFailed) return t("decryptFailed");
    if (
      message.contentType === "CHATEVENT" &&
      message.chatEvent?.kind === "announcement"
    ) {
      return t("announcementSet").replace(
        "{actor}",
        () => message.chatEvent.actor || t("eventMember"),
      );
    }
    const post = message.contentType === "POSTNOTIFICATION"
      ? message.postEvent
      : null;
    if (post?.kind === "album") {
      // Function replacers: a `$` in an album name is not a pattern.
      if (post.count === 1) {
        return t("postAlbumAddOne").replace("{album}", () => post.album);
      }
      return post.count > 0
        ? t("postAlbumAdd").replace("{count}", () => String(post.count))
          .replace("{album}", () => post.album)
        : t("postAlbum").replace("{album}", () => post.album);
    }
    if (post?.kind === "note") {
      return post.text
        ? t("postNote").replace("{text}", () => post.text)
        : t("postNoteBare");
    }
    const body = message.contentType === "FLEX" && message.altText
      ? String(message.altText)
      : String(message.text || "");
    // LINE repeats a place's title as the message text.
    if (
      message.contentType === "LOCATION" && message.location &&
      body.trim() === String(message.location.title || "")
    ) return "";
    if (
      ["CHATEVENT", "POSTNOTIFICATION"].includes(message.contentType) &&
      (!body || body.toUpperCase() === message.contentType)
    ) {
      return t(
        message.contentType === "CHATEVENT" ? "systemEvent" : "postEvent",
      );
    }
    return body;
  }
  function openMessageMenu(trigger) {
    const owner = actionMenu.row;
    const resume = owner ? menuWasFollowing : isFollowing(list);
    if (owner && owner !== trigger.closest(".message-row")) {
      actionMenu.close(false, false);
    }
    endProgrammaticScroll();
    cancelTouchSettling();
    interruptFollowing();
    menuWasFollowing = resume;
    actionMenu.open(trigger);
    updateNavigation();
  }
  function resumeMenuFollowing(allowed) {
    const resume = allowed && menuWasFollowing;
    menuWasFollowing = false;
    if (!resume) return;
    followBottom(list);
    const focus = document.activeElement;
    if (list.contains(focus)) {
      const rect = focus.getBoundingClientRect(),
        area = list.getBoundingClientRect();
      if (rect.top < area.top || rect.bottom > area.bottom) {
        list.focus({ preventScroll: true });
      }
    }
    updateNavigation();
  }
  // enil:message-actions-end
  function messageNode(message, includeMedia = true) {
    const chat = model.active,
      own = message.from === model.account,
      eventNotice = message.contentType === "CHATEVENT" &&
        !message.unsent && !message.decryptFailed,
      row = el(
        "article",
        `message-row${own ? " own" : ""}${message.unsent ? " unsent" : ""}${
          eventNotice ? " event-notice" : ""
        }`,
      ),
      column = el("div", "message-column"),
      footer = el("div", "message-footer");
    rowMessages.set(row, message);
    row.dataset.messageId = String(message.id || "");
    if (
      !own && !(eventNotice && message.chatEvent) &&
      (chat.startsWith("c") || chat.startsWith("r")) && message.fromName
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
    const body = messageBody(message);
    const place = message.contentType === "LOCATION" && !message.unsent
      ? message.location
      : null;
    if (body) {
      const content = el("div", "message-text");
      content.append(richText(body, message.mentions));
      bubble.append(content);
    }
    if (
      !message.unsent &&
      (["STICKER", "FLEX", "IMAGE", "VIDEO", "FILE", "AUDIO"].includes(
        message.contentType,
      ) || (message.contentType === "POSTNOTIFICATION" && message.postEvent))
    ) {
      const media = el("div", "message-media");
      if (includeMedia) addMedia(media, message, chat);
      bubble.append(media);
    } else if (place) {
      const media = el("div", "message-media");
      if (includeMedia) media.append(locationCard(place));
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
          known = Object.hasOwn(reactionTypes, type),
          reactionName = known ? t(`reaction${type}`) : type,
          button = el(
            "button",
            `reaction-pill${reaction.mine ? " mine" : ""}`,
            `${known ? reactionTypes[type] : type} ${
              Number(reaction.count || 0)
            }`,
          );
        button.type = "button";
        button.dataset.reactionType = type;
        button.setAttribute("aria-pressed", String(Boolean(reaction.mine)));
        button.setAttribute(
          "aria-label",
          `${reactionName} ${Number(reaction.count || 0)}`,
        );
        button.title = reaction.mine ? t("undoReaction") : t("reaction");
        button.addEventListener(
          "click",
          () =>
            command("react", {
              chat,
              messageId: String(message.id),
              type: button.classList.contains("mine") ? "UNDO" : type,
            }).catch(displayError),
        );
        reactions.append(button);
      }
      footer.append(reactions);
    }
    const meta = el("div", "message-meta");
    if (
      own && !eventNotice && message.readBy?.count > 0 && !message.pending &&
      !message.unsent
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
      const reply = messageAction("reply", "reply");
      reply.addEventListener("click", () => {
        const current = rowMessages.get(reply.closest(".message-row"));
        if (current) ctx.startReply(current);
      });
      actions.append(reply);
      const react = messageAction("reaction", "sticker");
      const reactionId = encodeURIComponent(String(message.id));
      react.id = `reaction-trigger-${reactionId}`;
      react.setAttribute("aria-expanded", "false");
      const closePicker = (picker) => {
        ctx.closeReactionPicker(String(message.id));
        react.setAttribute("aria-expanded", "false");
        react.removeAttribute("aria-controls");
        actionFocus(react)?.focus({ preventScroll: true });
        picker?.remove();
      };
      react.addEventListener("click", () => {
        const currentColumn = react.closest(".message-column");
        if (!currentColumn) return;
        const id = String(message.id);
        if (!ctx.toggleReactionPicker(id)) {
          closePicker(currentColumn.querySelector(".reaction-picker"));
          return;
        }
        const picker = el("div", "reaction-picker");
        picker.id = `reaction-picker-${reactionId}`;
        picker.setAttribute("role", "group");
        picker.setAttribute("aria-labelledby", react.id);
        react.setAttribute("aria-expanded", "true");
        react.setAttribute("aria-controls", picker.id);
        for (const [type, emoji] of Object.entries(reactionTypes)) {
          const button = el("button", "", emoji);
          button.type = "button";
          button.title = t(`reaction${type}`);
          button.setAttribute("aria-label", t(`reaction${type}`));
          button.addEventListener("click", () => {
            closePicker(picker);
            command("react", { chat, messageId: String(message.id), type })
              .catch(
                displayError,
              );
          });
          picker.append(button);
        }
        const undo = el("button");
        undo.append(icon("close"));
        undo.type = "button";
        undo.title = t("undoReaction");
        undo.setAttribute("aria-label", t("undoReaction"));
        undo.addEventListener("click", () => {
          closePicker(picker);
          command("react", {
            chat,
            messageId: String(message.id),
            type: "UNDO",
          })
            .catch(displayError);
        });
        picker.append(undo);
        currentColumn.append(picker);
        picker.firstElementChild.focus({ preventScroll: true });
        suspendPaging(200);
        picker.scrollIntoView({ block: "nearest", behavior: "instant" });
      });
      actions.append(react);
      appendMessageActions(actions, chat, message, system ? "" : body);
      if (own) {
        const unsend = messageAction("unsend", "unsend");
        unsend.addEventListener("click", () => {
          if (confirm(t("confirmUnsend"))) {
            command("unsend", { chat, messageId: String(message.id) }).catch(
              displayError,
            );
          }
        });
        actions.append(unsend);
      }
      const more = el("button", "message-more");
      more.type = "button";
      more.title = t("messageActions");
      more.setAttribute("aria-label", t("messageActions"));
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-controls", "message-action-menu");
      more.append(icon("more"));
      more.setAttribute("popovertarget", "message-action-menu");
      more.addEventListener("click", (event) => {
        event.preventDefault();
        openMessageMenu(more);
      });
      more.addEventListener("keydown", (event) => {
        if (
          event.isComposing || event.ctrlKey || event.metaKey || event.altKey
        ) {
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          openMessageMenu(more);
        }
      });
      actions.append(more);
      meta.append(actions);
    }
    footer.append(meta);
    column.append(footer);
    row.append(column);
    return row;
  }
  function updateReactions(oldReactions, newReactions) {
    const oldButtons = [...oldReactions.children];
    const available = new Map();
    for (const button of oldButtons) {
      const type = button.dataset.reactionType;
      if (!available.has(type)) available.set(type, []);
      available.get(type).push(button);
    }
    const buttons = [...newReactions.children].map((next) => {
      const button = available.get(next.dataset.reactionType)?.shift();
      if (!button) return next;
      if (button.className !== next.className) {
        button.className = next.className;
      }
      if (button.textContent !== next.textContent) {
        button.textContent = next.textContent;
      }
      if (button.title !== next.title) button.title = next.title;
      for (const attribute of ["aria-pressed", "aria-label"]) {
        const value = next.getAttribute(attribute);
        if (button.getAttribute(attribute) !== value) {
          button.setAttribute(attribute, value);
        }
      }
      return button;
    });
    const focused = oldButtons.includes(document.activeElement)
      ? document.activeElement
      : null;
    const retained = new Set(buttons);
    for (const button of oldButtons) {
      if (!retained.has(button)) button.remove();
    }
    let next = null;
    for (let i = buttons.length - 1; i >= 0; i--) {
      const button = buttons[i];
      if (button.parentNode !== oldReactions || button.nextSibling !== next) {
        oldReactions.insertBefore(button, next);
      }
      next = button;
    }
    if (
      focused && retained.has(focused) && document.activeElement !== focused
    ) {
      focused.focus({ preventScroll: true });
    }
  }
  // Keep unchanged interactive and media nodes connected across updates.
  function updateMessageParts(
    oldRow,
    newRow,
    keepMedia,
    id,
    oldMessage,
    message,
  ) {
    const oldColumn = oldRow.firstElementChild;
    const newColumn = newRow.firstElementChild;
    const oldBubble = oldColumn.querySelector(":scope > .bubble");
    const newBubble = newColumn.querySelector(":scope > .bubble");
    const oldFooter = oldColumn.querySelector(":scope > .message-footer");
    const newFooter = newColumn.querySelector(":scope > .message-footer");
    const oldMeta = oldFooter.querySelector(":scope > .message-meta");
    const newMeta = newFooter.querySelector(":scope > .message-meta");
    const oldActions = oldMeta.querySelector(":scope > .message-actions");
    const newActions = newMeta.querySelector(":scope > .message-actions");
    const keepActions = oldActions && newActions &&
      oldActions.children.length === newActions.children.length &&
      [...oldActions.children].every((button, index) =>
        button.textContent === newActions.children[index].textContent
      );
    const picker = oldColumn.querySelector(":scope > .reaction-picker");
    if (!keepActions) {
      actionMenu.closeRow(oldRow);
      if (oldActions?.contains(document.activeElement)) {
        $("messages").focus({ preventScroll: true });
      }
      ctx.closeReactionPicker(id);
      picker?.remove();
    }
    const highlighted = oldRow.classList.contains("quote-target");
    oldRow.className = newRow.className;
    if (highlighted) oldRow.classList.add("quote-target");
    oldBubble.className = newBubble.className;
    function updateBubblePart(selector, keep, before) {
      const old = oldBubble.querySelector(`:scope > ${selector}`);
      const fresh = newBubble.querySelector(`:scope > ${selector}`);
      if (old && fresh && keep) return old;
      if (old && fresh) old.replaceWith(fresh);
      else if (old) old.remove();
      else if (fresh) oldBubble.insertBefore(fresh, before);
      return fresh;
    }
    const oldText = oldBubble.querySelector(":scope > .message-text");
    const newText = newBubble.querySelector(":scope > .message-text");
    const oldQuote = oldBubble.querySelector(":scope > .quote");
    const newQuote = newBubble.querySelector(":scope > .quote");
    const keepText = oldText && newText && oldText.isEqualNode(newText) &&
      Boolean(oldMessage.unsent) === Boolean(message.unsent) &&
      Boolean(oldMessage.decryptFailed) === Boolean(message.decryptFailed) &&
      JSON.stringify(oldMessage.mentions || []) ===
        JSON.stringify(message.mentions || []);
    const keepQuote = oldQuote && newQuote && oldQuote.isEqualNode(newQuote) &&
      String(oldMessage.replyTo?.id || "") ===
        String(message.replyTo?.id || "");
    const media = updateBubblePart(".message-media", keepMedia, null);
    const text = updateBubblePart(".message-text", keepText, media);
    updateBubblePart(".quote", keepQuote, text || media);
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
    const oldReactions = oldFooter.querySelector(":scope > .reactions");
    const newReactions = newFooter.querySelector(":scope > .reactions");
    if (oldReactions && newReactions) {
      updateReactions(oldReactions, newReactions);
    } else if (oldReactions) oldReactions.remove();
    else if (newReactions) {
      oldFooter.insertBefore(newReactions, keepActions ? oldMeta : newMeta);
    }
    for (const child of [...oldColumn.children]) {
      if (
        child !== oldBubble && child !== oldFooter &&
        (!keepActions || child !== picker)
      ) child.remove();
    }
    for (const child of [...newColumn.children]) {
      if (child === newBubble || child === newFooter) {
        continue;
      }
      if (child.classList.contains("sender")) {
        oldColumn.insertBefore(child, oldBubble);
      } else oldColumn.insertBefore(child, oldFooter);
    }
  }
  function selectionIncludes(row, selection) {
    if (!row.isConnected || !selection || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
      if (selection.getRangeAt(i).intersectsNode(row)) return true;
    }
    return false;
  }
  function releaseSelectionVisibility() {
    if (!selectionVisibility.size) return;
    const selection = globalThis.getSelection();
    for (const [row, previous] of selectionVisibility) {
      if (selectionIncludes(row, selection)) continue;
      if (previous.value) {
        row.style.setProperty(
          "content-visibility",
          previous.value,
          previous.priority,
        );
      } else row.style.removeProperty("content-visibility");
      selectionVisibility.delete(row);
    }
  }
  function keepSelectedTailVisible(list) {
    releaseSelectionVisibility();
    const tail = list.lastElementChild;
    if (
      !tail?.classList.contains("message-row") ||
      selectionVisibility.has(tail) ||
      !selectionIncludes(tail, globalThis.getSelection())
    ) return;
    // WebKit can temporarily lose selected text when the old last row
    // changes from content-visibility: visible to auto on an append.
    selectionVisibility.set(tail, {
      value: tail.style.getPropertyValue("content-visibility"),
      priority: tail.style.getPropertyPriority("content-visibility"),
    });
    tail.style.setProperty("content-visibility", "visible");
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
    protect(actionMenu.row);
    for (const video of list.getElementsByTagName("video")) {
      if (!video.paused && !video.ended) protect(rowOf(video));
    }
    for (const audio of list.getElementsByTagName("audio")) {
      if (!audio.paused && !audio.ended) protect(rowOf(audio));
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
  function isFollowing(list) {
    if (actionMenu.row) return false;
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 2 ||
      (followedTop !== null && Math.abs(list.scrollTop - followedTop) <= 2);
  }
  function followBottom(list) {
    if (actionMenu.row || programmaticScroll || touchPhase !== "idle") return;
    if (followFrame) cancelAnimationFrame(followFrame);
    list.scrollTop = list.scrollHeight;
    followedTop = list.scrollTop;
    const chat = renderedChat, account = renderedAccount;
    let frames = 2;
    function settle() {
      followFrame = 0;
      if (
        chat !== renderedChat || account !== renderedAccount ||
        programmaticScroll || touchPhase !== "idle" ||
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
    actionMenu.closeRow(record.node);
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
    menuWasFollowing = false;
    followedTop = null;
    if (followFrame) cancelAnimationFrame(followFrame);
    if (trimFrame) cancelAnimationFrame(trimFrame);
    followFrame = 0;
    trimFrame = 0;
  }
  function endProgrammaticScroll(settle = false) {
    const follow = settle && programmaticScroll && !programmaticMoved &&
      followAfterProgrammatic &&
      Math.abs(list.scrollTop - programmaticTop) <= 2;
    clearTimeout(programmaticTimer);
    if (quoteFrame) cancelAnimationFrame(quoteFrame);
    quoteFrame = 0;
    programmaticTimer = 0;
    programmaticScroll = false;
    programmaticMoved = false;
    quoteJumpTarget = "";
    followAfterProgrammatic = false;
    if (
      follow && touchPhase === "idle" && model.active === renderedChat &&
      model.account === renderedAccount && ctx.isViewingChat()
    ) {
      suspendPaging(200);
      followBottom(list);
      if (model.messages.length > HISTORY_LIMIT) scheduleTrim(list);
    }
  }
  function waitForProgrammaticScroll(delay) {
    clearTimeout(programmaticTimer);
    programmaticTimer = setTimeout(() => endProgrammaticScroll(true), delay);
  }
  function cancelTouchSettling() {
    clearTimeout(touchTimer);
    touchTimer = 0;
    if (touchPhase !== "active") touchPhase = "idle";
    touchPaging = false;
    trimAfterTouch = false;
    followAfterTouch = false;
  }
  function beginProgrammaticScroll(target = "") {
    cancelTouchSettling();
    programmaticScroll = true;
    programmaticMoved = false;
    quoteJumpTarget = target;
    followAfterProgrammatic = false;
    programmaticTop = $("messages").scrollTop;
    // A scrollend is not emitted when the target is already in view.
    waitForProgrammaticScroll(1000);
  }
  function finishTouchScroll() {
    if (touchPhase !== "settling") return;
    clearTimeout(touchTimer);
    touchTimer = 0;
    touchPhase = "idle";
    const shouldFollow = followAfterTouch || isFollowing(list);
    const shouldTrim = trimAfterTouch;
    touchPaging = false;
    followAfterTouch = false;
    trimAfterTouch = false;
    if (!programmaticScroll && shouldFollow) {
      // A short chat can be at both the bottom and the paging threshold.
      suspendPaging(200);
      followBottom(list);
      if (shouldTrim) scheduleTrim(list);
    }
  }
  function waitForTouchScroll() {
    clearTimeout(touchTimer);
    // Safari versions without scrollend settle after scrolling becomes idle.
    touchTimer = setTimeout(finishTouchScroll, 200);
  }
  function scheduleTrim(list) {
    if (touchPhase !== "idle") {
      trimAfterTouch = true;
      return;
    }
    if (trimFrame) return;
    const chat = renderedChat, account = renderedAccount;
    trimFrame = requestAnimationFrame(() => {
      trimFrame = 0;
      if (
        chat !== renderedChat || account !== renderedAccount ||
        chat !== model.active || account !== model.account ||
        model.loading || model.loadingOlder || $("lightbox").open ||
        programmaticScroll || touchPhase !== "idle" ||
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
      let previous = null;
      renderedDesired = renderedDesired.filter((item) => {
        if (removedKeys.has(item.key)) return false;
        if (item.type === "message") {
          const continuation = continuesMessageRun(previous, item);
          if (item.continuation !== continuation) {
            item.continuation = continuation;
            const record = records.get(item.key);
            record.continuation = continuation;
            record.node.classList.toggle("continuation", continuation);
          }
        }
        previous = item;
        return true;
      });
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
          programmaticScroll || touchPhase !== "idle" ||
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
    keepSelectedTailVisible($("messages"));
    if (model.noOlder) ctx.refreshOlderAvailability();
    if (mode === "bottom") {
      menuWasFollowing = false;
      actionMenu.close(false);
      endProgrammaticScroll();
    }
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
    // Deferred layout can grow the list without moving its scroll position.
    // A user who moved away from the last pinned position is reading history.
    const wasFollowing = isFollowing(list);
    if (
      mode === "follow" && programmaticScroll && !programmaticMoved &&
      wasFollowing && Math.abs(oldTop - programmaticTop) <= 2
    ) followAfterProgrammatic = true;
    const following = !programmaticScroll && wasFollowing;
    if (following && (touchPhase !== "idle")) followedTop = oldTop;
    const chatChanged = renderedChat !== model.active ||
      renderedAccount !== model.account;
    if (chatChanged) {
      menuWasFollowing = false;
      actionMenu.close(false);
      suppressPaging = false;
      clearTimeout(pagingTimer);
      endProgrammaticScroll();
      cancelTouchSettling();
      touchPhase = "idle";
      touchY = null;
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
      releaseSelectionVisibility();
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
      if (touchPhase !== "idle") trimAfterTouch = true;
      else if (model.messages.length > HISTORY_LIMIT + TRIM_BATCH) {
        deferTrim = true;
      } else {
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
    const currentDate = new Date();
    const today = currentDate.toDateString();
    const previousDate = new Date(currentDate);
    previousDate.setDate(previousDate.getDate() - 1);
    const yesterday = previousDate.toDateString();
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
      const item = {
        key: `message:${tail.id}:0`,
        type: "message",
        message: tail,
        time: tailTime,
        day: tailDay,
        today,
      };
      item.continuation = continuesMessageRun(desired.at(-1), item);
      desired.push(item);
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
          desired.push({
            key: `day:${day}:${dayCount}`,
            type: "day",
            time,
            day,
          });
          previousDay = day;
        }
        if (
          !unreadPlaced && model.unreadMarkId &&
          String(message.id || "") === model.unreadMarkId
        ) {
          desired.push({ key: "control:unread", type: "unread" });
          unreadPlaced = true;
        }
        const item = { key, type: "message", message, time, day, today };
        item.continuation = continuesMessageRun(desired.at(-1), item);
        desired.push(item);
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
          prior.today === today && prior.continuation === item.continuation;
        if (unchanged) continue;
        const signature = JSON.stringify([
          item.message,
          preview,
          hasPreview,
          today,
        ]);
        if (prior?.signature === signature) {
          // Boundary-only changes must retain every child, including selection.
          if (prior.continuation !== item.continuation) {
            prior.node.classList.toggle("continuation", item.continuation);
          }
          prior.message = item.message;
          prior.continuation = item.continuation;
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
          item.message.audioMs,
          item.message.location,
          preview,
          hasPreview,
        ]);
        const keepMedia = prior?.mediaSignature === mediaSignature;
        let node = messageNode(item.message, !keepMedia);
        node.classList.toggle("continuation", item.continuation);
        if (prior) {
          if (!keepMedia) ctx.unobservePreviews(prior.node);
          updateMessageParts(
            prior.node,
            node,
            keepMedia,
            id,
            prior.message,
            item.message,
          );
          rowMessages.set(prior.node, item.message);
          node = prior.node;
        }
        records.set(item.key, {
          node,
          message: item.message,
          signature,
          continuation: item.continuation,
          mediaSignature,
          preview,
          hasPreview,
          today,
          time: item.time,
          day: item.day,
        });
      } else if (
        !prior || (item.type === "empty" && prior.text !== item.text) ||
        (item.type === "day" && prior.today !== today)
      ) {
        let node;
        if (item.type === "older") {
          node = el("button", "text-button", t("older"));
          node.type = "button";
          node.addEventListener("click", () => ctx.loadOlder());
        } else if (item.type === "day") {
          const date = new Date(item.time), locale = english ? "en" : "zh-TW";
          const caption = item.day === today
            ? t("today")
            : item.day === yesterday
            ? t("yesterday")
            : date.toLocaleDateString(locale, {
              year: date.getFullYear() === currentDate.getFullYear()
                ? undefined
                : "numeric",
              month: "short",
              day: "numeric",
            });
          node = el("h2", "day-divider", caption);
          node.title = date.toLocaleDateString(locale, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          });
          node.setAttribute("aria-label", `${caption} · ${node.title}`);
        } else if (item.type === "unread") {
          node = el("div", "unread-divider", t("unreadDivider"));
        } else node = el("div", "loading-message", item.text);
        if (prior) prior.node.replaceWith(node);
        records.set(item.key, { node, text: item.text, today });
      }
    }
    if (order.at(-1) !== keys.at(-1)) {
      const formerTail = records.get(order.at(-1));
      if (formerTail?.message) {
        // WebKit can discard the measured size when the visible tail becomes
        // deferred. Preserve its block size before changing the last child.
        // This is a fallback, not fixed sizing. Edits, resizing or text-size
        // changes can leave offscreen estimates stale until the row is laid out.
        const height = formerTail.node.getBoundingClientRect().height;
        if (height > 0) {
          formerTail.node.style.containIntrinsicBlockSize = `auto ${height}px`;
        }
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
      if (mode === "bottom" && (touchPhase !== "idle")) {
        followAfterTouch = true;
      }
      followBottom(list);
    } else if (mode === "anchor" && programmaticScroll && quoteJumpTarget) {
      const target = [...list.querySelectorAll(".message-row")].find((row) =>
        row.dataset.messageId === quoteJumpTarget
      );
      if (target) {
        const distance = anchor?.isConnected
          ? anchor.getBoundingClientRect().top - anchorTop
          : list.scrollHeight - oldHeight;
        if (distance) list.scrollTop += distance;
        alignQuoteTarget(target);
      }
    } else if (mode === "anchor" && !programmaticScroll) {
      if (!anchor?.isConnected) {
        const position = oldTop + list.scrollHeight - oldHeight;
        if (position !== list.scrollTop) {
          if (touchPhase === "idle") beginProgrammaticScroll();
          list.scrollTop = position;
        }
      } else {
        const chat = renderedChat, account = renderedAccount;
        let expectedTop = list.scrollTop, frames = 3;
        const settleAnchor = () => {
          if (
            chat !== renderedChat || account !== renderedAccount ||
            !anchor.isConnected || Math.abs(list.scrollTop - expectedTop) > 2
          ) return;
          const distance = anchor.getBoundingClientRect().top - anchorTop;
          if (distance) {
            if (!programmaticScroll && touchPhase === "idle") {
              beginProgrammaticScroll();
            }
            list.scrollTop += distance;
          }
          expectedTop = list.scrollTop;
          if (--frames) requestAnimationFrame(settleAnchor);
        };
        settleAnchor();
      }
    } else if (!programmaticScroll && touchPhase === "idle") {
      list.scrollTop = oldTop;
    }
    if (deferTrim) scheduleTrim(list);
    updateNavigation();
  }
  const list = $("messages"), jumpLatest = $("jump-latest");
  function updateNavigation() {
    const hidden = !model.active || isFollowing(list) ||
      list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (jumpLatest.hidden !== hidden) jumpLatest.hidden = hidden;
  }
  jumpLatest.addEventListener("click", () => {
    resumePaging(false);
    suspendPaging(200);
    list.focus({ preventScroll: true });
    followBottom(list);
    updateNavigation();
  });
  document.addEventListener("selectionchange", releaseSelectionVisibility);
  function loadNearTop() {
    if (list.scrollTop < 150 && list.scrollHeight > list.clientHeight + 10) {
      ctx.loadOlder();
    }
  }
  function resumePaging(up, touch = false) {
    endProgrammaticScroll();
    if (!touch) cancelTouchSettling();
    interruptFollowing();
    suppressPaging = false;
    clearTimeout(pagingTimer);
    // A gesture at the top may not produce a scroll event at all.
    if (up) loadNearTop();
  }
  for (const type of ["load", "error"]) {
    list.addEventListener(type, () => {
      if (isFollowing(list)) followBottom(list);
    }, true);
  }
  // A phone keyboard, a growing composer or a reply bar shortens the list
  // without scrolling it. Keep the newest message in view when it was.
  new ResizeObserver(() => {
    if (isFollowing(list)) followBottom(list);
  }).observe(list);
  list.addEventListener("scroll", () => {
    updateNavigation();
    // Settle after a reader reaches the bottom, including deferred layout.
    if (programmaticScroll) {
      if (Math.abs(list.scrollTop - programmaticTop) > 2) {
        programmaticMoved = true;
      }
      waitForProgrammaticScroll(200);
    } else if (list.scrollHeight - list.scrollTop - list.clientHeight <= 2) {
      followedTop = list.scrollTop;
      if (touchPhase === "idle" && !followFrame) followBottom(list);
    } else if (
      followedTop !== null && Math.abs(list.scrollTop - followedTop) > 2
    ) {
      followedTop = null;
      followAfterTouch = false;
    }
    if (touchPhase === "settling") waitForTouchScroll();
    // Layout can dispatch scroll during a tap without a paging gesture.
    if (touchPhase !== "idle" && !touchPaging) return;
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
    if (touchPhase !== "active") {
      const following = isFollowing(list);
      if (trimFrame) trimAfterTouch = true;
      resumePaging(false, true);
      touchPhase = "active";
      touchPaging = false;
      clearTimeout(touchTimer);
      if (following) followedTop = list.scrollTop;
    }
    touchY = event.touches[0]?.clientY ?? null;
  }, { passive: true });
  list.addEventListener("touchmove", (event) => {
    const y = event.touches[0]?.clientY;
    const up = touchY !== null && y > touchY;
    const following = isFollowing(list);
    if (up) touchPaging = true;
    resumePaging(up, true);
    if (up) followAfterTouch = false;
    else if (following) followedTop = list.scrollTop;
    touchY = y ?? null;
  }, { passive: true });
  for (const type of ["touchend", "touchcancel"]) {
    document.addEventListener(type, (event) => {
      if (touchPhase !== "active" || event.touches.length) return;
      touchPhase = "settling";
      touchY = null;
      waitForTouchScroll();
    }, { passive: true });
  }
  list.addEventListener("scrollend", () => {
    if (programmaticScroll && programmaticMoved) endProgrammaticScroll();
    finishTouchScroll();
  });
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
  return { renderMessages, closeOpenReactions, scrollToMessage };
}

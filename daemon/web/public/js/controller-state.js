// Apply server frames to the shared model and notify views; depends on pure
// protocol helpers.
import {
  acceptEvent,
  applyChatPush,
  applyChatState,
  applyEvent as projectEvent,
  reconcilePending as reconcileRows,
  resetBoot,
} from "./protocol.js";

export function createStateController(ctx) {
  const model = ctx.model;
  function changeBoot(boot) {
    const result = resetBoot({
      boot: model.boot,
      seq: model.seq,
      eventsSeen: model.eventsSeen,
    }, boot);
    Object.assign(model, result.watermark);
    return result.changed;
  }
  function applyState(state) {
    if (!state || typeof state !== "object") return;
    const boot = String(state.bootId || ""), changedBoot = changeBoot(boot);
    Object.assign(model, applyChatState(model, state));
    const previousAccount = model.account;
    model.state = state;
    const account = String(state.me?.mid || "");
    if (account) {
      if (previousAccount && previousAccount !== account) {
        ctx.saveComposer();
        ctx.closeChat();
        model.stickerPacks = null;
      }
      model.account = account;
      ctx.setLastAccount(account);
    } else if (
      state.login?.status === "idle" ||
      (state.login?.status === "error" && state.login?.settled === true)
    ) {
      ctx.clearLastAccount(previousAccount);
      model.account = "";
      ctx.closeChat();
      model.stickerPacks = null;
    }
    ctx.renderLogin(state);
    ctx.renderAccount(state.me, account);
    ctx.renderNotices();
    ctx.renderChats();
    if (model.active) ctx.renderActiveHeader();
    // Older stub versions keep the event ring in state.json.
    if (Array.isArray(state.events)) {
      consumeEvents({ bootId: boot, events: state.events });
    }
    if (changedBoot && model.active && model.connected) {
      ctx.loadHistory(model.active, ctx.isViewingChat());
    }
  }
  function applyChatPatch(row, revision, boot) {
    const updated = applyChatPush(model, row, revision, boot);
    if (updated === model) return;
    Object.assign(model, updated);
    ctx.renderChats();
    if (model.active === String(row.mid)) ctx.renderActiveHeader();
  }
  function consumeEvents(payload) {
    if (!payload || typeof payload !== "object") return;
    const boot = String(payload.bootId || ""), changed = changeBoot(boot);
    const events = Array.isArray(payload.events)
      ? payload.events.filter((event) => Number.isFinite(event?.seq)).sort((
        a,
        b,
      ) => a.seq - b.seq)
      : [];
    const gap = model.eventsSeen && model.seq > 0 && events.length > 0 &&
      events[0].seq > model.seq + 1;
    if ((changed || gap) && model.active && model.connected) {
      ctx.loadHistory(model.active, ctx.isViewingChat());
    }
    for (const event of events) consumeEvent(event, boot);
    model.eventsSeen = true;
  }
  function reconcilePending(chat, rows) {
    const pending = ctx.pendingFor(chat);
    const remaining = reconcileRows(pending, rows, model.account);
    if (remaining !== pending) ctx.writePending(chat, remaining);
  }
  function consumeEvent(event, boot) {
    const result = acceptEvent(
      { boot: model.boot, seq: model.seq, eventsSeen: model.eventsSeen },
      event,
      boot,
    );
    Object.assign(model, result.watermark);
    if (result.changed && model.active && model.connected) {
      ctx.loadHistory(model.active, ctx.isViewingChat());
    }
    if (!result.accepted) return;
    const chat = String(event.chat || "");
    if (
      event.kind === "message" && event.message?.requestId &&
      event.message.from === model.account
    ) {
      ctx.forgetPending(chat, String(event.message.requestId));
    }
    if (event.kind === "history" && Array.isArray(event.messages)) {
      reconcilePending(chat, event.messages);
    }
    if (chat !== model.active) return;
    if (model.loading) {
      model.historyEvents.push(event);
      return;
    }
    applyEvent(event);
  }
  function applyEvent(event, render = true) {
    model.messages = projectEvent(
      model.messages,
      event,
      model.account,
      model.readerCount,
    );
    if (
      event.kind === "message" && event.message &&
      event.message.from !== model.account &&
      event.message.id && ctx.isViewingChat()
    ) {
      ctx.command("markRead", {
        chat: model.active,
        upTo: String(event.message.id),
      }).catch(() => {});
    }
    if (render) ctx.renderMessages("follow");
  }
  function onFrame(frame) {
    if (frame.web === "state") applyState(frame.state);
    else if (frame.web === "events") consumeEvents(frame.events);
    else if (frame.event) consumeEvent(frame.event, frame.boot);
    else if (frame.chat) {
      applyChatPatch(frame.chat, frame.chatsRevision, frame.boot);
    }
  }
  function scheduleToastHide(callback) {
    clearTimeout(model.toastTimer);
    model.toastTimer = setTimeout(callback, 6000);
  }
  function toggleReactionPicker(id) {
    if (model.openReactions.has(id)) {
      model.openReactions.delete(id);
      return false;
    }
    model.openReactions.add(id);
    return true;
  }
  function closeReactionPicker(id) {
    model.openReactions.delete(id);
  }
  function resetReactionPickers() {
    model.openReactions.clear();
  }
  return {
    onFrame,
    applyEvent,
    reconcilePending,
    scheduleToastHide,
    toggleReactionPicker,
    closeReactionPicker,
    resetReactionPickers,
  };
}

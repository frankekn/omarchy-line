// Optimistic sends, retries and replies. Uses protocol projections and injected
// views.
import { uuid } from "./ids.js";
import { mergeMessage } from "./protocol.js";
export function createSendController(ctx) {
  const model = ctx.model, t = ctx.t;
  const writePending = (...args) => ctx.writePending(...args);
  const pendingFor = (...args) => ctx.pendingFor(...args);
  const forgetPending = (...args) => ctx.forgetPending(...args);
  const renderMessages = (...args) => ctx.renderMessages(...args);
  const command = (...args) => ctx.command(...args);
  const displayError = (error) => ctx.displayError(error);
  const toast = (message) => ctx.toast(message);
  const sendFiles = (...args) => ctx.sendFiles(...args);
  function optimistic(chat, cmd, payload, details) {
    const requestId = uuid();
    return {
      id: `pending-${requestId}`,
      chat,
      from: model.account,
      fromName: model.state?.me?.displayName || "",
      text: details.text || "",
      time: Date.now(),
      contentType: details.contentType || "NONE",
      pending: true,
      status: "sending",
      requestId,
      replyTo: details.replyTo || undefined,
      stickerUrl: details.stickerUrl || undefined,
      fileName: details.fileName || undefined,
      fileSize: details.fileSize,
      cmd,
      payload,
    };
  }
  function sendOptimistic(chat, message) {
    const account = message.from;
    writePending(chat, [
      ...pendingFor(chat, account).filter((m) =>
        m.requestId !== message.requestId
      ),
      message,
    ], account);
    if (model.account === account && model.active === chat) {
      model.messages = mergeMessage(model.messages, message, model.account);
      renderMessages("bottom");
    }
    command(message.cmd, {
      chat,
      ...message.payload,
      requestId: message.requestId,
    }).then(() => {
      // Like the panel, a success spends the durable draft immediately, but
      // its bubble remains visible until LINE's echo or refreshed history.
      // An echo may already have removed the pending row before this reply.
      if (
        pendingFor(chat, account).some((m) => m.requestId === message.requestId)
      ) {
        model.sent.set(message.requestId, { ...message, status: "sent" });
        if (model.sent.size > 500) {
          model.sent.delete(model.sent.keys().next().value);
        }
      }
      forgetPending(chat, message.requestId, account);
      if (model.account === account && model.active === chat) {
        model.messages = model.messages.map((m) =>
          m.pending && m.requestId === message.requestId
            ? { ...m, status: "sent" }
            : m
        );
        renderMessages("preserve");
      }
    }).catch((error) => {
      const status = error.ambiguous ? "uncertain" : "failed";
      const rows = pendingFor(chat, account);
      // An echo can prove delivery before a failed socket reply arrives.
      if (!rows.some((m) => m.requestId === message.requestId)) return;
      writePending(
        chat,
        rows.map((m) =>
          m.requestId === message.requestId ? { ...m, status } : m
        ),
        account,
      );
      if (model.account === account && model.active === chat) {
        model.messages = model.messages.map((m) =>
          m.pending && m.requestId === message.requestId ? { ...m, status } : m
        );
        renderMessages("preserve");
      }
      if (model.account === account && (error.refused || error.unsent)) {
        displayError(error);
      }
    });
  }
  function retrySend(chat, message) {
    if (message.status === "uncertain" && !confirm(t("confirmRetry"))) return;
    if (!model.connected) {
      toast(t("offlineAction"));
      return;
    }
    if (message.cmd === "sendFile") {
      const retry = { chat, requestId: message.requestId };
      const file = model.files.get(message.requestId);
      if (file) sendFiles([file], retry);
      else {
        model.retryFile = retry;
        toast(t("reselectFile"));
        ctx.openFilePicker();
      }
      return;
    }
    forgetPending(chat, message.requestId);
    if (model.active === chat) {
      model.messages = model.messages.filter((m) =>
        !(m.pending && m.requestId === message.requestId)
      );
    }
    const fresh = optimistic(chat, message.cmd, message.payload, message);
    sendOptimistic(chat, fresh);
  }
  function startReply(message) {
    model.reply = {
      id: String(message.id),
      fromName: String(message.fromName || ""),
      text: String(message.text || message.altText || ""),
    };
    ctx.updateReply();
    ctx.saveComposer();
    ctx.focusComposer();
  }
  function cancelReply() {
    model.reply = null;
    ctx.updateReply();
    ctx.saveComposer();
  }
  function submitText(text) {
    const chat = model.active;
    if (!chat || !text.trim()) return;
    if (!model.connected) {
      ctx.toast(t("offlineAction"));
      return;
    }
    const reply = model.reply,
      cmd = reply ? "reply" : "send",
      payload = { text };
    if (reply) payload.replyTo = reply.id;
    const mentions = model.mentions.filter((item) =>
      text.slice(item.start, item.end) === item.label
    ).map((item) =>
      item.all
        ? { start: item.start, end: item.end, all: true }
        : { start: item.start, end: item.end, mid: item.mid }
    );
    if (mentions.length) payload.mentions = mentions;
    sendOptimistic(
      chat,
      optimistic(chat, cmd, payload, { text, replyTo: reply }),
    );
    model.mentionText = "";
    model.mentions = [];
    model.reply = null;
    ctx.setMentionOpen(false);
    ctx.clearComposer();
    ctx.saveComposer();
    ctx.focusComposer();
  }
  return {
    optimistic,
    sendOptimistic,
    retrySend,
    startReply,
    cancelReply,
    submitText,
  };
}

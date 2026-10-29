// Chat navigation and history requests. Uses protocol projections and injected
// view actions.
import { applyEvent, firstUnreadIndex, mergeHistory } from "./protocol.js";
export function createChatController(ctx) {
  const model = ctx.model;
  let membersGeneration = 0;
  function markCurrentRead() {
    if (!ctx.isViewingChat()) return;
    const latest = [...model.messages].reverse().find((message) =>
      !message.pending && message.from !== model.account && message.id
    );
    if (latest) {
      ctx.command("markRead", { chat: model.active, upTo: String(latest.id) })
        .catch(() => {});
    }
  }
  function closeChat() {
    membersGeneration++;
    model.historyGeneration++;
    model.active = "";
    model.chatOpen = false;
    model.messages = [];
    model.unreadMarkCount = 0;
    model.unreadMarkId = "";
    model.reply = null;
    model.loading = false;
    model.loadingOlder = false;
    model.historyEvents = [];
    ctx.closeStickerPicker();
    ctx.setMentionOpen(false);
    ctx.hideChat();
    ctx.renderMessages("preserve");
  }
  function openChat(chat) {
    const generation = ++membersGeneration, account = model.account;
    if (model.active) ctx.saveComposer();
    model.historyGeneration++;
    model.active = chat;
    const row = model.chats.find((item) => String(item.mid) === chat);
    model.unreadMarkCount = Number(row?.unread || 0);
    model.unreadMarkId = "";
    model.chatOpen = true;
    model.messages = [...model.sent.values()].filter((message) =>
      message.chat === chat && message.from === model.account
    );
    model.loading = false;
    model.loadingOlder = false;
    model.noOlder = false;
    model.historyEvents = [];
    model.previews.clear();
    model.previewPending.clear();
    model.members = [];
    model.readerCount = chat.startsWith("u") ? 1 : 0;
    ctx.closeStickerPicker();
    ctx.showChat();
    ctx.restoreComposer();
    ctx.renderActiveHeader();
    ctx.renderChats();
    ctx.renderMessages("bottom");
    loadHistory(chat, true);
    if (chat.startsWith("c") || chat.startsWith("r")) {
      ctx.command("members", { chat }).then((members) => {
        if (
          generation === membersGeneration && model.account === account &&
          model.active === chat && Array.isArray(members)
        ) {
          model.readerCount = members.length;
          model.members = members;
          ctx.updateMentionPicker();
        }
      }).catch(() => {});
    }
    ctx.focusComposer();
  }
  function backToList() {
    ctx.saveComposer();
    model.chatOpen = false;
    if (globalThis.innerWidth <= 700) {
      model.unreadMarkCount = 0;
      model.unreadMarkId = "";
    }
    ctx.showChatList();
    ctx.renderChats();
  }
  function replayHistoryEvents() {
    for (const { event, applied } of model.historyEvents) {
      if (applied) {
        model.messages = applyEvent(
          model.messages,
          event,
          model.account,
          model.readerCount,
        );
      } else ctx.applyEvent(event, false);
    }
  }
  async function loadHistory(chat, markRead, replaceLoading = false) {
    const sameChat = model.active === chat;
    const continuing = sameChat && (model.loading || model.loadingOlder);
    if (sameChat && model.loading && !replaceLoading) return;
    const generation = ++model.historyGeneration;
    model.loading = true;
    model.loadingOlder = false;
    model.noOlder = false;
    if (!continuing) model.historyEvents = [];
    ctx.renderMessages("bottom");
    try {
      const rows = await ctx.command("history", {
        chat,
        count: 50,
        markRead: !!markRead,
      });
      if (generation !== model.historyGeneration || model.active !== chat) {
        return;
      }
      const fresh = Array.isArray(rows) ? rows : [];
      ctx.reconcilePending(chat, fresh);
      model.messages = mergeHistory(
        model.messages.filter((m) => !m.pending || m.status === "sent"),
        fresh,
        model.account,
      );
      replayHistoryEvents();
      model.historyEvents = [];
      if (model.unreadMarkCount > 0) {
        const index = firstUnreadIndex(
          model.messages,
          model.unreadMarkCount,
          model.account,
        );
        model.unreadMarkId = index < 0
          ? ""
          : String(model.messages[index].id || "");
        model.unreadMarkCount = 0;
      }
      model.noOlder = fresh.length < 50;
    } catch (error) {
      if (generation === model.historyGeneration && model.active === chat) {
        replayHistoryEvents();
        model.historyEvents = [];
        ctx.displayError(error);
      }
    } finally {
      if (generation === model.historyGeneration && model.active === chat) {
        model.loading = false;
        ctx.renderMessages("bottom");
      }
    }
  }
  async function loadOlder() {
    if (model.loading || model.loadingOlder || model.noOlder || !model.active) {
      return;
    }
    const first = model.messages.find((m) => !m.pending && m.id);
    if (!first) return;
    const chat = model.active, generation = model.historyGeneration;
    model.loadingOlder = true;
    model.historyEvents = [];
    try {
      const rows = await ctx.command("history", {
        chat,
        count: 50,
        before: String(first.id),
        markRead: false,
      });
      if (generation !== model.historyGeneration || model.active !== chat) {
        return;
      }
      const fresh = Array.isArray(rows) ? rows : [];
      ctx.reconcilePending(chat, fresh);
      model.messages = mergeHistory(model.messages, fresh, model.account);
      // Live events were already shown, but the older page may predate them.
      // Project them again without repeating side effects such as markRead.
      for (const { event } of model.historyEvents) {
        model.messages = applyEvent(
          model.messages,
          event,
          model.account,
          model.readerCount,
        );
      }
      model.noOlder = fresh.length < 50;
      ctx.renderMessages("anchor");
    } catch (error) {
      if (generation === model.historyGeneration && model.active === chat) {
        ctx.displayError(error);
      }
    } finally {
      if (generation === model.historyGeneration && model.active === chat) {
        model.loadingOlder = false;
        model.historyEvents = [];
      }
    }
  }
  function requestPreview(id, chat) {
    if (!id || model.previewPending.has(id) || model.previews.has(id)) return;
    model.previewPending.add(id);
    ctx.command("preview", { chat, messageId: id }).then((data) => {
      if (model.active !== chat) return;
      model.previews.set(id, data?.path ? String(data.path) : "");
      ctx.renderMessages("preserve");
    }).catch(() => {
      if (model.active === chat) {
        model.previews.set(id, "");
        ctx.renderMessages("preserve");
      }
    }).finally(() => model.previewPending.delete(id));
  }
  return {
    markCurrentRead,
    closeChat,
    openChat,
    backToList,
    loadHistory,
    loadOlder,
    requestPreview,
  };
}

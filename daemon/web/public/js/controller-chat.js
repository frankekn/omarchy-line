// Chat navigation and history requests. Uses protocol projections and injected
// view actions.
import { firstUnreadIndex, mergeHistory } from "./protocol.js";
export function createChatController(ctx) {
  const model = ctx.model;
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
  }
  function openChat(chat) {
    if (model.active) ctx.saveComposer();
    model.historyGeneration++;
    model.active = chat;
    const row = model.chats.find((item) => String(item.mid) === chat);
    model.unreadMarkCount = Number(row?.unread || 0);
    model.unreadMarkId = "";
    model.chatOpen = true;
    model.messages = [];
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
        if (model.active === chat && Array.isArray(members)) {
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
  async function loadHistory(chat, markRead, replaceLoading = false) {
    const continuing = model.loading && model.active === chat;
    if (continuing && !replaceLoading) return;
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
        model.messages.filter((m) => !m.pending),
        fresh,
        model.account,
      );
      for (const event of model.historyEvents) ctx.applyEvent(event, false);
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
        for (const event of model.historyEvents) ctx.applyEvent(event, false);
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
      model.noOlder = fresh.length < 50;
      ctx.renderMessages("anchor");
    } catch (error) {
      if (generation === model.historyGeneration && model.active === chat) {
        ctx.displayError(error);
      }
    } finally {
      if (generation === model.historyGeneration && model.active === chat) {
        model.loadingOlder = false;
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

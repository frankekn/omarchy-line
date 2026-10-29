// Chat navigation and history requests. Uses protocol projections and injected
// view actions.
import { applyEvent, firstUnreadIndex, mergeHistory } from "./protocol.js";
import { PREVIEW_CACHE_MAX, putPreview } from "./preview-cache.js";
export function createChatController(ctx) {
  const model = ctx.model;
  let membersGeneration = 0;
  let stoppedBefore = null;
  function firstConfirmed() {
    return model.messages.find((m) => !m.pending && m.id);
  }
  function refreshOlderAvailability() {
    if (!model.noOlder) {
      stoppedBefore = null;
      return;
    }
    if (
      !stoppedBefore || stoppedBefore.chat !== model.active ||
      stoppedBefore.generation !== model.historyGeneration
    ) {
      stoppedBefore = null;
      return;
    }
    const first = firstConfirmed();
    if (first && String(first.id) !== stoppedBefore.id) {
      model.noOlder = false;
      stoppedBefore = null;
    }
  }
  function markCurrentRead() {
    if (!ctx.isViewingChat()) return;
    const latest = [...model.messages].reverse().find((message) =>
      !message.pending && message.from !== model.account && message.id
    );
    if (latest) {
      ctx.command("markRead", { chat: model.active, upTo: String(latest.id) })
        .catch(() => console.debug("[markRead] failed"));
    }
  }
  function closeChat() {
    membersGeneration++;
    stoppedBefore = null;
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
    stoppedBefore = null;
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
    model.membersError = "";
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
          model.membersError = "";
          ctx.updateMentionPicker();
        }
      }).catch((error) => {
        if (
          generation !== membersGeneration || model.account !== account ||
          model.active !== chat
        ) return;
        model.membersError = error?.message || ctx.t("membersUnavailable");
        ctx.updateMentionPicker();
      });
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
    stoppedBefore = null;
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
      if (model.unreadMarkCount > 0) {
        const newIds = new Set(
          model.historyEvents.map(({ event }) => event).filter((event) =>
            event.kind === "message" && event.message?.id
          ).map((event) => String(event.message.id)),
        );
        const openingMessages = model.messages.filter((message) =>
          !newIds.has(String(message.id))
        );
        const index = firstUnreadIndex(
          openingMessages,
          model.unreadMarkCount,
          model.account,
        );
        model.unreadMarkId = index < 0
          ? ""
          : String(openingMessages[index].id || "");
        model.unreadMarkCount = 0;
      }
      replayHistoryEvents();
      model.historyEvents = [];
      // The store can answer a short head page before revalidation too.
      model.noOlder = fresh.length === 0;
    } catch (error) {
      if (generation === model.historyGeneration && model.active === chat) {
        replayHistoryEvents();
        model.historyEvents = [];
        if (!error?.resync) ctx.displayError(error);
      }
    } finally {
      if (generation === model.historyGeneration && model.active === chat) {
        model.loading = false;
        ctx.renderMessages("bottom");
      }
    }
  }
  async function loadOlder() {
    refreshOlderAvailability();
    if (model.loading || model.loadingOlder || model.noOlder || !model.active) {
      return;
    }
    const first = firstConfirmed();
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
      // A short cached page can still advance. Stop only if its merged and
      // replayed rows do not move the numeric cursor towards older messages.
      const next = firstConfirmed();
      const before = String(first.id), after = String(next?.id || "");
      const numeric = /^\d+$/.test(before) && /^\d+$/.test(after);
      const advanced = after &&
        (numeric ? BigInt(after) < BigInt(before) : after !== before);
      model.noOlder = !advanced;
      stoppedBefore = model.noOlder
        ? { chat, generation, id: after || before }
        : null;
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
    const generation = membersGeneration, account = model.account;
    model.previewPending.add(id);
    function remember(path) {
      if (
        generation !== membersGeneration || model.active !== chat ||
        model.account !== account
      ) return;
      const visible = model.previews.size >= PREVIEW_CACHE_MAX
        ? ctx.visiblePreviewIds()
        : new Set();
      if (!putPreview(model.previews, id, path, visible)) {
        ctx.deferPreview(id, chat);
        return;
      }
      ctx.renderMessages("preserve");
    }
    ctx.command("preview", { chat, messageId: id }).then((data) => {
      remember(data?.path ? String(data.path) : "");
    }).catch(() => remember("")).finally(() => {
      if (generation === membersGeneration) model.previewPending.delete(id);
    });
  }
  return {
    markCurrentRead,
    closeChat,
    openChat,
    backToList,
    loadHistory,
    loadOlder,
    refreshOlderAvailability,
    requestPreview,
  };
}

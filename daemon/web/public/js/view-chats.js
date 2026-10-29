// Chat list and navigation DOM. Uses protocol sorting and forwards user actions
// to the controller.
import { $, el, formatTime, setAvatar } from "./dom.js";
import { visibleChats } from "./protocol.js";
import { placeKeyedNodes, planKeyChanges } from "./keyed.js";
export function createChatsView(ctx) {
  const model = ctx.model, t = ctx.t, english = ctx.english;
  const records = new Map();
  let order = [];
  function chatRecord(chat) {
    const mid = String(chat.mid), button = el("button", "chat-row");
    button.type = "button";
    button.dataset.chatId = mid;
    button.addEventListener("focus", () => {
      model.selectedChat = mid;
      for (const record of records.values()) {
        if (!record.mid) continue;
        const selected = record.mid === mid;
        if (record.selected !== selected) {
          record.node.classList.toggle("keyboard-selected", selected);
          record.selected = selected;
        }
      }
    });
    const avatar = el("span", "avatar");
    const content = el("span", "row-content"),
      top = el("span", "row-top"),
      bottom = el("span", "row-bottom");
    const name = el("span", "row-name"),
      time = el("time", "row-time"),
      preview = el("span", "row-preview"),
      badge = el("span", "badge");
    const timeText = document.createTextNode("");
    time.append(timeText);
    top.append(name, time);
    bottom.append(preview);
    content.append(top, bottom);
    button.append(avatar, content);
    button.addEventListener("click", () => ctx.openChat(mid));
    return {
      node: button,
      mid,
      avatar,
      name,
      timeText,
      preview,
      badge,
      bottom,
    };
  }
  function updateChat(record, chat, today, times) {
    const unread = Number(chat.unread);
    const values = {
      label: `${chat.name || chat.mid}${
        chat.hidden ? ` · ${t("hidden")}` : ""
      }`,
      avatarPath: chat.avatarPath || "",
      avatarName: chat.name || "",
      lastTime: Number(chat.lastTime || 0),
      today,
      preview: `${chat.lastFrom ? `${chat.lastFrom}: ` : ""}${
        chat.lastText || ""
      }`,
      unread: unread > 0 ? unread : 0,
    };
    const previous = record.values;
    if (!previous || previous.label !== values.label) {
      record.name.textContent = values.label;
    }
    if (
      !previous || previous.avatarPath !== values.avatarPath ||
      previous.avatarName !== values.avatarName
    ) {
      setAvatar(record.avatar, values.avatarPath, values.avatarName);
    }
    if (
      !previous || previous.lastTime !== values.lastTime ||
      previous.today !== today
    ) {
      const minute = values.lastTime ? Math.floor(values.lastTime / 60000) : "";
      if (!times.has(minute)) {
        times.set(minute, formatTime(values.lastTime, english));
      }
      const label = times.get(minute);
      if (record.timeText.data !== label) record.timeText.data = label;
    }
    if (!previous || previous.preview !== values.preview) {
      record.preview.textContent = values.preview;
    }
    if (!previous || previous.unread !== values.unread) {
      if (values.unread) {
        record.badge.textContent = values.unread > 99 ? "99+" : values.unread;
        if (!record.badge.parentNode) record.bottom.append(record.badge);
      } else record.badge.remove();
    }
    record.values = values;
    const active = record.mid === model.active;
    if (record.active !== active) {
      record.node.classList.toggle("active", active);
      record.active = active;
    }
    const selected = record.mid === model.selectedChat;
    if (record.selected !== selected) {
      record.node.classList.toggle("keyboard-selected", selected);
      record.selected = selected;
    }
  }
  function renderChats() {
    const list = $("chat-list"),
      rows = visibleChats(model.chats, $("search").value);
    if (!rows.some((chat) => String(chat.mid) === model.selectedChat)) {
      model.selectedChat = String(rows[0]?.mid || "");
    }
    const counts = new Map();
    const desired = rows.map((chat) => {
      const mid = String(chat.mid), count = counts.get(mid) || 0;
      counts.set(mid, count + 1);
      return { key: `chat:${mid}:${count}`, chat };
    });
    if (!desired.length) desired.push({ key: "control:empty", chat: null });
    const keys = desired.map((item) => item.key);
    const changes = planKeyChanges(order, keys);
    const focused = list.contains(document.activeElement)
      ? document.activeElement
      : null;
    for (const key of changes.removed) {
      records.get(key).node.remove();
      records.delete(key);
    }
    const today = new Date().toDateString(), times = new Map();
    for (const { key, chat } of desired) {
      let record = records.get(key);
      if (!record) {
        record = chat
          ? chatRecord(chat)
          : { node: el("div", "empty-list", t("noChats")) };
        records.set(key, record);
      }
      if (chat) updateChat(record, chat, today, times);
    }
    placeKeyedNodes(list, keys, records, changes);
    order = keys;
    if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
    const count = String(rows.length).padStart(2, "0");
    if ($("chat-count").textContent !== count) {
      $("chat-count").textContent = count;
    }
    const incomplete = model.chatList?.complete === false;
    const warning = incomplete ? t("incomplete") : "";
    if ($("list-warning").hidden === incomplete) {
      $("list-warning").hidden = !incomplete;
    }
    if ($("list-warning").textContent !== warning) {
      $("list-warning").textContent = warning;
    }
    const unread = model.chats.filter((c) => !c.hidden).reduce(
      (sum, c) => sum + Math.max(0, Number(c.unread) || 0),
      0,
    );
    const title = unread ? `(${unread}) enil` : "enil";
    if (document.title !== title) document.title = title;
  }
  function renderActiveHeader() {
    const chat = model.chats.find((row) => String(row.mid) === model.active);
    if (!chat) return;
    $("active-name").textContent = String(chat.name || chat.mid);
    $("active-subtitle").textContent =
      model.active.startsWith("c") || model.active.startsWith("r")
        ? t("group")
        : t("direct");
    setAvatar($("active-avatar"), chat.avatarPath, chat.name);
    $("hide-chat").textContent = chat.hidden ? t("unhide") : t("hide");
  }
  function isViewingChat() {
    return !!model.active && !document.hidden &&
      (globalThis.innerWidth > 700 || model.chatOpen);
  }
  function showChat() {
    $("workspace").classList.add("chat-open");
    $("empty-chat").hidden = true;
    $("chat-view").hidden = false;
  }
  function hideChat() {
    $("workspace").classList.remove("chat-open");
    $("chat-view").hidden = true;
    $("empty-chat").hidden = false;
  }
  function showChatList() {
    $("workspace").classList.remove("chat-open");
  }
  $("search").addEventListener("input", renderChats);
  $("hide-chat").addEventListener("click", () => {
    const chat = model.chats.find((row) => String(row.mid) === model.active);
    if (chat) {
      ctx.command(chat.hidden ? "unhide" : "hide", { chat: model.active })
        .catch(ctx.displayError);
    }
  });
  $("back").addEventListener("click", () => ctx.backToList());
  document.addEventListener("visibilitychange", () => ctx.markCurrentRead());
  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented || event.isComposing || event.ctrlKey ||
      event.metaKey || event.altKey || $("lightbox").open ||
      $("workspace").hidden
    ) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(
        target.tagName,
      ))
    ) return;
    if (event.key === "Escape") {
      if (model.stickerOpen) ctx.closeStickerPicker();
      else if (model.mentionOpen) ctx.setMentionOpen(false);
      else if (model.reply) ctx.cancelReply();
      else if (model.chatOpen) ctx.backToList();
      else if ($("search").value) {
        $("search").value = "";
        renderChats();
      } else return;
      event.preventDefault();
      return;
    }
    if (event.key === "/" && !event.shiftKey) {
      if (model.chatOpen) ctx.backToList();
      $("search").focus();
      event.preventDefault();
      return;
    }
    if (event.key === "r" && !event.shiftKey) {
      $("sync").click();
      event.preventDefault();
      return;
    }
    const inList = !model.chatOpen || $("sidebar").contains(target);
    const step = event.key === "ArrowDown" || event.key === "j"
      ? 1
      : event.key === "ArrowUp" || event.key === "k"
      ? -1
      : 0;
    if (step && !event.shiftKey) {
      if (inList) {
        const rows = [...$("chat-list").querySelectorAll(".chat-row")];
        if (!rows.length) return;
        const index = rows.findIndex((row) =>
          row.dataset.chatId === model.selectedChat
        );
        const next = Math.max(0, Math.min(rows.length - 1, index + step));
        rows[next].focus();
        rows[next].scrollIntoView({ block: "nearest" });
      } else $("messages").scrollBy({ top: step * 80 });
      event.preventDefault();
    } else if (
      event.key === "Enter" && inList && model.selectedChat &&
      (!(target instanceof HTMLElement) || target === document.body ||
        target.classList.contains("chat-row"))
    ) {
      ctx.openChat(model.selectedChat);
      event.preventDefault();
    }
  });
  return {
    renderChats,
    renderActiveHeader,
    isViewingChat,
    showChat,
    hideChat,
    showChatList,
  };
}

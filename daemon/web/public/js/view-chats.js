// Chat list and navigation DOM. Uses protocol sorting and forwards user actions
// to the controller.
import { $, el, formatTime, setAvatar } from "./dom.js";
import { visibleChats } from "./protocol.js";
export function createChatsView(ctx) {
  const model = ctx.model, t = ctx.t, english = ctx.english;
  function renderChats() {
    const rows = visibleChats(model.chats, $("search").value);
    const nodes = rows.map((chat) => {
      const button = el(
        "button",
        `chat-row${String(chat.mid) === model.active ? " active" : ""}`,
      );
      button.type = "button";
      const avatar = el("span", "avatar");
      setAvatar(avatar, chat.avatarPath, chat.name);
      const content = el("span", "row-content"),
        top = el("span", "row-top"),
        bottom = el("span", "row-bottom");
      const name = el(
        "span",
        "row-name",
        `${chat.name || chat.mid}${chat.hidden ? ` · ${t("hidden")}` : ""}`,
      );
      top.append(
        name,
        el("time", "row-time", formatTime(chat.lastTime, english)),
      );
      bottom.append(
        el(
          "span",
          "row-preview",
          `${chat.lastFrom ? `${chat.lastFrom}: ` : ""}${chat.lastText || ""}`,
        ),
      );
      if (Number(chat.unread) > 0) {
        bottom.append(
          el("span", "badge", Number(chat.unread) > 99 ? "99+" : chat.unread),
        );
      }
      content.append(top, bottom);
      button.append(avatar, content);
      button.addEventListener("click", () => ctx.openChat(String(chat.mid)));
      return button;
    });
    $("chat-list").replaceChildren(
      ...(nodes.length ? nodes : [el("div", "empty-list", t("noChats"))]),
    );
    $("chat-count").textContent = String(rows.length).padStart(2, "0");
    const incomplete = model.chatList?.complete === false;
    $("list-warning").hidden = !incomplete;
    $("list-warning").textContent = incomplete ? t("incomplete") : "";
    const unread = model.chats.filter((c) => !c.hidden).reduce(
      (sum, c) => sum + Math.max(0, Number(c.unread) || 0),
      0,
    );
    document.title = unread ? `(${unread}) enil` : "enil";
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
  return {
    renderChats,
    renderActiveHeader,
    isViewingChat,
    showChat,
    hideChat,
    showChatList,
  };
}

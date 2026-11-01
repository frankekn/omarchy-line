// Quick switcher dialog (Ctrl+K / Cmd+K), the unread tab title and favicon,
// and the next-unread action. Reads the model; opens chats through ctx.
import { $, el } from "./dom.js";
import { visibleChats } from "./protocol.js";

const MAX_RESULTS = 50;
const BASE_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const DOT_ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<circle cx="11" cy="5" r="4.5" fill="#06c755"/></svg>',
);
const fold = (text) => String(text || "").normalize("NFKC").toLowerCase();

function fuzzy(name, query) {
  let at = 0;
  for (const char of query) {
    at = name.indexOf(char, at);
    if (at < 0) return false;
    at += char.length;
  }
  return true;
}

/** Rank chats by name: exact, prefix, substring, then subsequence. */
export function rankChats(chats, query) {
  const q = fold(query).trim();
  const ranked = [];
  for (const chat of chats) {
    const name = fold(chat.name || chat.mid);
    const tier = !q
      ? 0
      : name === q
      ? 0
      : name.startsWith(q)
      ? 1
      : name.includes(q)
      ? 2
      : fuzzy(name, q)
      ? 3
      : -1;
    if (tier >= 0) ranked.push({ chat, tier });
  }
  ranked.sort((a, b) =>
    a.tier - b.tier ||
    Number(Number(b.chat.unread) > 0) - Number(Number(a.chat.unread) > 0) ||
    Number(b.chat.lastTime || 0) - Number(a.chat.lastTime || 0)
  );
  return ranked.map((item) => item.chat);
}

export function unreadTotal(chats) {
  let total = 0;
  for (const chat of chats) {
    if (!chat.hidden) total += Math.max(0, Number(chat.unread) || 0);
  }
  return total;
}

export function createSwitcherView(ctx) {
  const model = ctx.model, t = ctx.t;
  const dialog = $("switcher"),
    input = $("switcher-input"),
    list = $("switcher-list"),
    status = $("switcher-status");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  let results = [], index = 0, returnFocus = null;
  let seenChats = null, seenStatus = "", total = 0, shownTitle = "";

  function titleStatus() {
    if (!$("signin-screen").hidden) return "titleSignin";
    const text = $("connection-text").textContent;
    if (text === (ctx.english ? "Sign-in required" : "需要重新登入")) {
      return "titleSignin";
    }
    if (!$("app").hidden && !$("connection").classList.contains("connected")) {
      return model.everConnected ? "titleOffline" : "";
    }
    return "";
  }
  // Called from the chat list render and connection changes. Work happens
  // only when the chat array or the connection status changed.
  function renderTitle() {
    const state = titleStatus();
    if (model.chats === seenChats && state === seenStatus) return;
    seenStatus = state;
    if (model.chats !== seenChats) {
      seenChats = model.chats;
      const next = unreadTotal(model.chats);
      if (next !== total || !shownTitle) {
        total = next;
        const icon = document.querySelector('link[rel="icon"]');
        const href = total ? DOT_ICON : BASE_ICON;
        if (icon && icon.getAttribute("href") !== href) {
          icon.setAttribute("href", href);
        }
        $("next-unread").hidden = total === 0;
      }
    }
    const count = total ? `(${total > 99 ? "99+" : total}) ` : "";
    const title = `${count}enil${state ? ` · ${t(state)}` : ""}`;
    shownTitle = title;
    if (document.title !== title) document.title = title;
  }

  function nextUnread() {
    const search = $("search").value;
    let rows = visibleChats(model.chats, search);
    const unread = (chat) => !chat.hidden && Number(chat.unread) > 0;
    if (!rows.some(unread)) rows = visibleChats(model.chats, "");
    const start = rows.findIndex((chat) => String(chat.mid) === model.active);
    for (let step = 1; step <= rows.length; step++) {
      const chat = rows[(start + step) % rows.length];
      if (unread(chat) && String(chat.mid) !== model.active) {
        ctx.openChat(String(chat.mid));
        return true;
      }
    }
    return false;
  }

  function renderResults() {
    results = rankChats(model.chats, input.value).slice(0, MAX_RESULTS);
    index = Math.min(index, Math.max(0, results.length - 1));
    const nodes = results.map((chat, i) => {
      const option = el("li", "switcher-option");
      option.id = `switcher-option-${i}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(i === index));
      option.dataset.chatId = String(chat.mid);
      option.append(el("span", "switcher-name", String(chat.name || chat.mid)));
      if (chat.hidden) {
        option.append(el("span", "switcher-tag", t("hidden")));
      }
      const unread = Number(chat.unread) || 0;
      if (unread > 0) {
        const badge = el("span", "badge", unread > 99 ? "99+" : String(unread));
        badge.setAttribute("aria-label", `${t("unreadCount")} ${unread}`);
        option.append(badge);
      }
      return option;
    });
    list.replaceChildren(...nodes);
    if (!nodes.length) {
      list.append(el("li", "switcher-empty", t("noChats")));
    }
    select(index);
    status.textContent = `${results.length} ${t("switcherResults")}`;
  }
  function select(next) {
    if (!results.length) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const old = list.children[index];
    old?.setAttribute("aria-selected", "false");
    index = (next + results.length) % results.length;
    const option = list.children[index];
    option.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  }
  function open() {
    if (dialog.open || $("workspace").hidden || $("lightbox").open) return;
    returnFocus = document.activeElement;
    input.value = "";
    index = 0;
    renderResults();
    dialog.showModal();
    input.focus();
  }
  function close(focusBack = true) {
    if (!dialog.open) return;
    dialog.close();
    if (focusBack && returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }
  function choose(i) {
    const chat = results[i];
    if (!chat) return;
    close(false);
    ctx.openChat(String(chat.mid));
    const coarse = globalThis.matchMedia("(pointer: coarse)").matches;
    (coarse ? $("messages") : $("message-input")).focus({
      preventScroll: true,
    });
  }

  input.addEventListener("input", () => {
    index = 0;
    renderResults();
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      select(index + (event.key === "ArrowDown" ? 1 : -1));
      event.preventDefault();
    } else if (event.key === "Enter") {
      choose(index);
      event.preventDefault();
    }
  });
  list.addEventListener("click", (event) => {
    const option = event.target instanceof Element
      ? event.target.closest(".switcher-option")
      : null;
    if (option) choose([...list.children].indexOf(option));
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  $("switcher-open").addEventListener("click", open);
  $("next-unread").addEventListener("click", () => nextUnread());
  $("switcher-open").setAttribute(
    "aria-keyshortcuts",
    mac ? "Meta+K" : "Control+K",
  );
  $("switcher-open").title = `${t("switcher")} (${mac ? "⌘K" : "Ctrl+K"})`;

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if (
      event.key.toLowerCase() === "k" && !event.altKey && !event.shiftKey &&
      (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    ) {
      if (dialog.open) close();
      else open();
      if (dialog.open || !$("workspace").hidden) event.preventDefault();
      return;
    }
    if (
      dialog.open || $("lightbox").open || $("workspace").hidden ||
      event.ctrlKey || event.metaKey || event.shiftKey
    ) return;
    const target = event.target instanceof Element ? event.target : null;
    const editable = target instanceof HTMLElement &&
      (target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    let go = false;
    if (event.key === "ArrowDown" && event.altKey) go = !editable;
    else if (event.key === "]" && !event.altKey && target) {
      // Single-character shortcuts stay inside the chat list and messages.
      const inList = $("chat-list").contains(target) &&
        (target === $("chat-list") || target.classList.contains("chat-row"));
      go = inList || target === $("messages");
    }
    if (go && nextUnread()) event.preventDefault();
  });

  return { renderTitle, openSwitcher: open, nextUnread };
}

// Full message search dialog: asks the daemon's `search` command, lists the
// hits and opens a chosen one at its message. Reads the model; opens chats and
// pages history through ctx.
import { $, el, formatTime } from "./dom.js";

const LIMIT = 30;
/** Older pages fetched while looking for a hit before giving up. */
const JUMP_PAGES = 20;
const QUERY_MAX = 100;

/** Snippet text with the [start, end) hit wrapped in <mark>. */
export function markedSnippet(snippet, match) {
  const text = String(snippet || "");
  const node = el("span", "search-snippet");
  const [start, end] = Array.isArray(match) ? match.map(Number) : [];
  if (
    !Number.isInteger(start) || !Number.isInteger(end) || start < 0 ||
    end <= start || end > text.length
  ) {
    node.textContent = text;
    return node;
  }
  node.append(
    text.slice(0, start),
    el("mark", "", text.slice(start, end)),
    text.slice(end),
  );
  return node;
}

export function createSearchView(ctx) {
  const model = ctx.model, t = ctx.t, english = ctx.english;
  const dialog = $("message-search"),
    input = $("message-search-input"),
    list = $("message-search-list"),
    status = $("message-search-status");
  let results = [], index = 0, returnFocus = null;
  let scope = "", searched = null, more = false, partial = false;
  let generation = 0, busy = false, jumpGeneration = 0;

  function chatName(mid) {
    const chat = model.chats.find((row) => String(row.mid) === mid);
    return String(chat?.name || mid);
  }
  function renderScope() {
    $("message-search-chat").hidden = !scope;
    $("message-search-all").hidden = !scope;
    $("message-search-chat-name").textContent = scope ? chatName(scope) : "";
  }
  function option(id, className) {
    const node = el("li", `switcher-option ${className}`);
    node.id = id;
    node.setAttribute("role", "option");
    node.setAttribute("aria-selected", "false");
    return node;
  }
  function render() {
    const today = new Date().toDateString();
    const nodes = results.map((hit, i) => {
      const node = option(`message-search-option-${i}`, "search-option");
      const meta = el("span", "search-meta");
      meta.append(el("span", "switcher-name", chatName(String(hit.chat))));
      const when = el("time", "", formatTime(hit.time, english));
      const date = new Date(Number(hit.time));
      if (!Number.isNaN(date.getTime())) {
        when.dateTime = date.toISOString();
        // formatTime only prints the clock for today's messages.
        if (date.toDateString() === today) when.title = date.toLocaleString();
      }
      meta.append(when);
      node.append(meta);
      const line = el("span", "");
      if (hit.fromName) line.append(`${hit.fromName}: `);
      line.append(markedSnippet(hit.snippet, hit.match));
      node.append(line);
      return node;
    });
    if (more && results.length) {
      nodes.push(
        option(`message-search-option-${results.length}`, "search-more"),
      );
      nodes.at(-1).textContent = t("searchMore");
    }
    list.replaceChildren(...nodes);
    if (!nodes.length && searched !== null && !busy) {
      list.append(el("li", "switcher-empty", t("searchNoResults")));
    }
    select(index);
    status.textContent = busy
      ? t("searching")
      : searched === null
      ? ""
      : `${results.length} ${t("searchResults")}${
        partial ? ` · ${t("searchPartial")}` : ""
      }`;
  }
  function options() {
    return [...list.querySelectorAll('[role="option"]')];
  }
  function select(next) {
    const all = options();
    if (!all.length) {
      index = 0;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    all[index]?.setAttribute("aria-selected", "false");
    index = (next + all.length) % all.length;
    all[index].setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", all[index].id);
    all[index].scrollIntoView({ block: "nearest" });
  }
  async function search(append = false) {
    const q = input.value.trim().slice(0, QUERY_MAX);
    if (!q) return;
    const run = ++generation;
    const request = { q, limit: LIMIT };
    if (scope) request.chat = scope;
    if (append && results.length) request.before = results.at(-1).time;
    busy = true;
    if (!append) {
      results = [];
      index = 0;
    }
    searched = q;
    render();
    try {
      const data = await ctx.command("search", request);
      if (run !== generation) return;
      const hits = Array.isArray(data?.results) ? data.results : [];
      results = append ? results.concat(hits) : hits;
      more = data?.more === true;
      partial = data?.partial === true;
    } catch (error) {
      if (run !== generation) return;
      more = false;
      partial = false;
      ctx.displayError(error);
    } finally {
      if (run === generation) {
        busy = false;
        render();
      }
    }
  }
  function openMessageSearch(query = "", chat = "") {
    if ($("workspace").hidden || $("lightbox").open) return;
    if (!dialog.open) returnFocus = document.activeElement;
    scope = chat;
    renderScope();
    input.value = query;
    results = [];
    searched = null;
    more = false;
    partial = false;
    busy = false;
    index = 0;
    generation++;
    render();
    if (!dialog.open) dialog.showModal();
    input.focus();
    if (query.trim()) search();
  }
  function close(focusBack = true) {
    if (!dialog.open) return;
    generation++;
    dialog.close();
    if (focusBack && returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }
  function settled(predicate, timeout = 15000) {
    // Bounded wait while a jump is in progress; nothing runs when idle.
    return new Promise((resolve) => {
      const deadline = Date.now() + timeout;
      const check = () => {
        if (predicate()) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(check, 50);
      };
      check();
    });
  }
  async function jump(chat, id) {
    const run = ++jumpGeneration, account = model.account;
    const current = () =>
      run === jumpGeneration && model.account === account &&
      model.active === chat;
    // Opening goes through the same path as a click on the chat row, so the
    // chat is marked read exactly as it would be then.
    if (model.active !== chat || !model.chatOpen) ctx.openChat(chat);
    $("messages").focus({ preventScroll: true });
    const has = () => model.messages.some((m) => String(m.id) === id);
    for (let page = 0; page <= JUMP_PAGES; page++) {
      if (!await settled(() => !model.loading && !model.loadingOlder)) break;
      if (!current()) return;
      if (has()) {
        ctx.scrollToMessage(id);
        return;
      }
      if (model.noOlder) break;
      if (page === 1) ctx.toast(t("searchJumping"), true);
      await ctx.loadOlder();
    }
    if (current()) ctx.toast(t("searchMissing"));
  }
  function choose(i) {
    if (i === results.length && more) {
      search(true);
      return;
    }
    const hit = results[i];
    if (!hit) return;
    close(false);
    jump(String(hit.chat), String(hit.id));
  }

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      select(index + (event.key === "ArrowDown" ? 1 : -1));
      event.preventDefault();
    } else if (event.key === "Enter") {
      event.preventDefault();
      // A changed query searches; an unchanged one opens the selected hit.
      if (input.value.trim() !== searched || !options().length) search();
      else choose(index);
    }
  });
  list.addEventListener("click", (event) => {
    const node = event.target instanceof Element
      ? event.target.closest('[role="option"]')
      : null;
    if (node) choose(options().indexOf(node));
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  $("message-search-all").addEventListener("click", () => {
    scope = "";
    renderScope();
    input.focus();
    if (input.value.trim()) search();
  });
  $("message-search-open").addEventListener("click", () => {
    openMessageSearch($("search").value);
  });
  $("chat-search").addEventListener("click", () => {
    if (model.active) openMessageSearch("", model.active);
  });
  // Enter in the chat filter turns its text into a message search.
  $("search").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (!$("search").value.trim()) return;
    event.preventDefault();
    openMessageSearch($("search").value);
  });
  return {};
}

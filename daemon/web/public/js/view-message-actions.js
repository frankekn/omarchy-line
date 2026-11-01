// Copy and forward for a message's text. The forward picker reuses the quick
// switcher's ranking; sending goes through the existing send command.
import { el } from "./dom.js";
import { uuid } from "./ids.js";
import { rankChats } from "./view-switcher.js";

const MAX_RESULTS = 50;

/**
 * Copy through a selected, off-screen text area. This is the path a plain
 * HTTP origin needs: navigator.clipboard exists only in a secure context.
 */
export function copyBySelection(text) {
  const area = el("textarea", "copy-buffer");
  area.value = text;
  area.readOnly = true;
  area.tabIndex = -1;
  area.setAttribute("aria-hidden", "true");
  const focused = document.activeElement;
  document.body.append(area);
  let copied = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    area.remove();
    if (focused instanceof HTMLElement && focused.isConnected) {
      focused.focus({ preventScroll: true });
    }
  }
  return copied;
}

export function createMessageActionsView(ctx) {
  const model = ctx.model, t = ctx.t;
  let copyDialog = null, forwardDialog = null;

  function dialogShell(className, titleText) {
    const dialog = el("dialog", className);
    const title = el("h2", "action-dialog-title", titleText);
    title.id = `${className.split(" ")[0]}-title`;
    dialog.setAttribute("aria-labelledby", title.id);
    dialog.append(title);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
    return { dialog, title };
  }

  // The last resort when the browser refuses both copy paths: show the text
  // already selected so the reader can copy it by hand.
  function showCopyDialog(text, returnFocus) {
    if (!copyDialog) {
      const { dialog } = dialogShell("copy-dialog", t("copyManual"));
      const area = el("textarea", "copy-text");
      area.readOnly = true;
      area.rows = 5;
      area.setAttribute("aria-labelledby", "copy-dialog-title");
      const close = el("button", "secondary", t("close"));
      close.type = "button";
      close.addEventListener("click", () => dialog.close());
      const row = el("div", "action-dialog-buttons");
      row.append(close);
      dialog.append(area, row);
      copyDialog = { dialog, area, returnFocus: null };
      dialog.addEventListener("close", () => {
        const target = copyDialog.returnFocus;
        copyDialog.returnFocus = null;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    }
    copyDialog.returnFocus = returnFocus;
    copyDialog.area.value = text;
    copyDialog.dialog.showModal();
    copyDialog.area.focus();
    copyDialog.area.select();
  }

  async function copyText(text) {
    const returnFocus = document.activeElement;
    const value = String(text || "");
    if (!value) return;
    let copied = false;
    if (typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch { /* Fall back to a selection below. */ }
    }
    if (!copied) copied = copyBySelection(value);
    if (copied) ctx.toast(t("copied"), true);
    else showCopyDialog(value, returnFocus);
  }

  function buildForwardDialog() {
    const { dialog } = dialogShell("forward-dialog switcher", t("forwardTo"));
    const input = el("input");
    input.type = "text";
    input.id = "forward-input";
    input.placeholder = t("switcherPlaceholder");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-labelledby", "forward-dialog-title");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "forward-list");
    input.setAttribute("aria-autocomplete", "list");
    const list = el("ul", "switcher-list");
    list.id = "forward-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", "forward-dialog-title");
    const preview = el("p", "forward-preview");
    dialog.append(preview, input, list);
    const state = {
      dialog,
      input,
      list,
      preview,
      results: [],
      index: 0,
      text: "",
      returnFocus: null,
    };
    function render() {
      state.results = rankChats(
        model.chats.filter((chat) => !chat.hidden),
        input.value,
      ).slice(0, MAX_RESULTS);
      state.index = Math.min(
        state.index,
        Math.max(0, state.results.length - 1),
      );
      list.replaceChildren(...state.results.map((chat, i) => {
        const option = el("li", "switcher-option");
        option.id = `forward-option-${i}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(i === state.index));
        option.dataset.chatId = String(chat.mid);
        option.append(
          el("span", "switcher-name", String(chat.name || chat.mid)),
        );
        return option;
      }));
      if (!state.results.length) {
        list.append(el("li", "switcher-empty", t("noChats")));
        input.removeAttribute("aria-activedescendant");
      } else select(state.index);
    }
    function select(next) {
      if (!state.results.length) return;
      list.children[state.index]?.setAttribute("aria-selected", "false");
      state.index = (next + state.results.length) % state.results.length;
      const option = list.children[state.index];
      option.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
    function choose(i) {
      const chat = state.results[i];
      if (!chat) return;
      const name = String(chat.name || chat.mid);
      if (!confirm(`${t("confirmForward")} ${name}`)) return;
      const text = state.text;
      dialog.close();
      if (!model.connected) {
        ctx.toast(t("offlineAction"));
        return;
      }
      ctx.command("send", {
        chat: String(chat.mid),
        text,
        requestId: uuid(),
      }).then(
        () => ctx.toast(`${t("forwarded")} ${name}`, true),
        (error) => ctx.displayError(error),
      );
    }
    input.addEventListener("input", () => {
      state.index = 0;
      render();
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        select(state.index + (event.key === "ArrowDown" ? 1 : -1));
        event.preventDefault();
      } else if (event.key === "Enter") {
        choose(state.index);
        event.preventDefault();
      }
    });
    list.addEventListener("click", (event) => {
      const option = event.target instanceof Element
        ? event.target.closest(".switcher-option")
        : null;
      if (option) choose([...list.children].indexOf(option));
    });
    dialog.addEventListener("close", () => {
      const target = state.returnFocus;
      state.returnFocus = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
    state.render = render;
    return state;
  }

  function forwardText(text, returnFocus) {
    forwardDialog ??= buildForwardDialog();
    const state = forwardDialog;
    if (state.dialog.open) return;
    state.text = String(text || "");
    state.returnFocus = returnFocus || document.activeElement;
    state.preview.textContent = state.text;
    state.input.value = "";
    state.index = 0;
    state.render();
    state.dialog.showModal();
    state.input.focus();
  }

  return { copyText, forwardText };
}

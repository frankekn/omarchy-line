// One native top-layer menu; original action buttons and handlers stay in rows.
import { el } from "./dom.js";

export function makeMessageMenu(t) {
  const menu = el("div", "message-menu");
  menu.id = "message-action-menu";
  menu.setAttribute("popover", "auto");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("messageActions"));
  document.body.append(menu);
  let owner = null, anchorPosition = null;
  function close(restore = true) {
    if (!owner) return;
    const trigger = owner;
    owner = null;
    trigger.setAttribute("aria-expanded", "false");
    if (menu.matches(":popover-open")) menu.hidePopover();
    if (restore && trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  function open(trigger) {
    if (owner === trigger) return close();
    close(false);
    owner = trigger;
    menu.replaceChildren();
    for (
      const original of trigger.parentElement.querySelectorAll(
        ".message-action",
      )
    ) {
      const button = el("button", "message-menu-item", original.title);
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.tabIndex = -1;
      button.disabled = original.disabled;
      for (const name of ["aria-expanded", "aria-controls"]) {
        if (original.hasAttribute(name)) {
          button.setAttribute(name, original.getAttribute(name));
        }
      }
      button.addEventListener("click", () => {
        close();
        if (original.isConnected) original.click();
      });
      menu.append(button);
    }
    trigger.setAttribute("aria-expanded", "true");
    menu.showPopover({ source: trigger });
    const anchor = trigger.getBoundingClientRect();
    anchorPosition = { left: anchor.left, top: anchor.top };
    const rect = menu.getBoundingClientRect();
    const viewport = globalThis.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth,
      height = viewport?.height || innerHeight;
    menu.style.left = `${
      Math.max(left + 8, Math.min(anchor.left, left + width - rect.width - 8))
    }px`;
    menu.style.top = `${
      Math.max(
        top + 8,
        Math.min(anchor.bottom + 4, top + height - rect.height - 8),
      )
    }px`;
    menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }
  // Run before the conversation's Escape handler (including reaction pickers).
  globalThis.addEventListener("keydown", (event) => {
    if (owner && event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }, true);
  menu.addEventListener("keydown", (event) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const items = [...menu.children].filter((button) => !button.disabled);
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp") {
      next = (index - 1 + items.length) % items.length;
    }
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus({ preventScroll: true });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") close();
  });
  menu.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "closed" || !owner) return;
    const restore = menu.contains(document.activeElement);
    const trigger = owner;
    owner = null;
    trigger.setAttribute("aria-expanded", "false");
    if (restore && trigger.isConnected) trigger.focus({ preventScroll: true });
  });
  document.addEventListener("scroll", (event) => {
    if (owner && event.target.contains?.(owner)) {
      const anchor = owner.getBoundingClientRect();
      // A queued scroll from focusing the trigger can arrive after opening.
      if (
        Math.abs(anchor.top - anchorPosition.top) > 1 ||
        Math.abs(anchor.left - anchorPosition.left) > 1
      ) close(menu.contains(document.activeElement));
    }
  }, true);
  globalThis.addEventListener("resize", () => close());
  globalThis.visualViewport?.addEventListener("resize", () => close());
  globalThis.visualViewport?.addEventListener("scroll", () => close());
  return {
    open,
    close,
    closeRow(row) {
      if (owner && row.contains(owner)) {
        const focused = menu.contains(document.activeElement);
        close(false);
        if (focused) row.closest(".messages")?.focus({ preventScroll: true });
      }
    },
    get row() {
      return owner?.closest(".message-row");
    },
  };
}

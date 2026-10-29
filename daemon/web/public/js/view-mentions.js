// Mention suggestion DOM and keyboard events. Reads shared state and forwards
// choices to the controller.
import { $, el } from "./dom.js";
export function createMentionsView(ctx) {
  const model = ctx.model, t = ctx.t;
  function setMentionVisibility(visible) {
    $("mention-picker").setAttribute("aria-label", t("mention"));
    $("mention-picker").hidden = !visible;
  }
  function renderMentionChoices(choices) {
    $("mention-picker").replaceChildren(...choices.map((item, index) => {
      const button = el(
        "button",
        `mention-option${index === model.mentionIndex ? " selected" : ""}`,
        `@${item.name}`,
      );
      button.type = "button";
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => ctx.chooseMention(index));
      return button;
    }));
  }
  function handleMentionKey(event) {
    if (!model.mentionOpen || event.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      ctx.moveMention(event.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      ctx.chooseMention(model.mentionIndex);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      ctx.setMentionOpen(false);
      return true;
    }
    return false;
  }
  return { setMentionVisibility, renderMentionChoices, handleMentionKey };
}

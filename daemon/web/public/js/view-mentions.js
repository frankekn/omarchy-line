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
    const nodes = choices.map((item, index) => {
      const button = el(
        "button",
        `mention-option${index === model.mentionIndex ? " selected" : ""}`,
        `@${item.name}`,
      );
      button.type = "button";
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => ctx.chooseMention(index));
      return button;
    });
    if (model.membersError) {
      const error = el("div", "mention-error", model.membersError);
      error.setAttribute("role", "status");
      nodes.unshift(error);
    }
    $("mention-picker").replaceChildren(...nodes);
  }
  function handleMentionKey(event) {
    if (!model.mentionOpen || event.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      ctx.setMentionOpen(false);
      return true;
    }
    if (!model.mentionChoices.length) return false;
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
    return false;
  }
  return { setMentionVisibility, renderMentionChoices, handleMentionKey };
}

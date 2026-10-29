// Composer DOM and keyboard events. State changes are sent to controller
// actions.
import { $ } from "./dom.js";
export function createComposerView(ctx) {
  const model = ctx.model, t = ctx.t;
  function readComposer() {
    const input = $("message-input");
    return {
      text: input.value,
      cursor: input.selectionStart,
      end: input.selectionEnd,
    };
  }
  function writeComposer(text, pos) {
    const input = $("message-input");
    input.value = text;
    input.setSelectionRange(pos, pos);
  }
  function replaceComposerRange(text, start, end) {
    $("message-input").setRangeText(text, start, end, "end");
  }
  function resizeComposer() {
    const input = $("message-input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  }
  function updateReply() {
    $("reply-target").hidden = !model.reply;
    $("reply-label").textContent = model.reply
      ? `${t("reply")} · ${
        model.reply.fromName ? `${model.reply.fromName}: ` : ""
      }${model.reply.text || t("message")}`
      : "";
  }
  function focusComposer() {
    $("message-input").focus();
  }
  function clearComposer() {
    $("message-input").value = "";
    updateReply();
    resizeComposer();
  }
  $("cancel-reply").addEventListener("click", () => ctx.cancelReply());
  $("message-input").addEventListener("input", () => ctx.composerInput());
  $("message-input").addEventListener("click", () => {
    ctx.saveComposer();
    ctx.updateMentionPicker();
  });
  $("message-input").addEventListener("keyup", (event) => {
    ctx.saveComposer();
    if (event.key !== "Escape") ctx.updateMentionPicker();
  });
  $("message-input").addEventListener("keydown", (event) => {
    if (ctx.handleMentionKey(event)) return;
    if (
      event.key === "Enter" && !event.shiftKey && !event.isComposing &&
      globalThis.matchMedia("(min-width: 701px) and (pointer: fine)").matches
    ) {
      event.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    ctx.submitText($("message-input").value);
  });
  return {
    readComposer,
    writeComposer,
    replaceComposerRange,
    resizeComposer,
    updateReply,
    focusComposer,
    clearComposer,
  };
}

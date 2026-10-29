// Draft, reply and mention state for the composer. Uses the injected draft
// store and view actions.
export function createComposerController(ctx) {
  const model = ctx.model;
  function saveComposer() {
    const draft = ctx.chatDraft();
    if (!draft) return;
    const { text, cursor } = ctx.readComposer();
    draft.text = text;
    draft.reply = model.reply;
    draft.mentions = model.mentions;
    draft.cursor = cursor;
    ctx.saveStorage();
  }
  function restoreComposer() {
    const draft = ctx.chatDraft(), text = draft?.text || "";
    model.reply = draft?.reply || null;
    model.mentionText = text;
    model.mentions = Array.isArray(draft?.mentions)
      ? draft.mentions.filter((item) =>
        Number.isInteger(item.start) && Number.isInteger(item.end) &&
        item.start >= 0 &&
        item.end > item.start && text.slice(item.start, item.end) === item.label
      )
      : [];
    const pos = Math.min(Number(draft?.cursor ?? text.length), text.length);
    ctx.writeComposer(text, pos);
    ctx.updateReply();
    ctx.resizeComposer();
    ctx.updateMentionPicker();
  }
  function adjustMentions(previous, next) {
    let start = 0;
    while (
      start < previous.length && start < next.length &&
      previous[start] === next[start]
    ) start++;
    let suffix = 0;
    while (
      suffix < previous.length - start && suffix < next.length - start &&
      previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) suffix++;
    const oldEnd = previous.length - suffix,
      delta = next.length - previous.length;
    model.mentions = model.mentions.flatMap((item) => {
      if (oldEnd <= item.start) {
        return [{ ...item, start: item.start + delta, end: item.end + delta }];
      }
      if (start >= item.end) return [item];
      return [];
    });
    model.mentionText = next;
  }
  function composerInput() {
    adjustMentions(model.mentionText, ctx.readComposer().text);
    ctx.resizeComposer();
    saveComposer();
    ctx.updateMentionPicker();
  }
  function setMentionChoices(start, choices) {
    model.mentionStart = start;
    model.mentionChoices = choices;
    model.mentionIndex = Math.min(
      model.mentionIndex,
      Math.max(0, choices.length - 1),
    );
  }
  function setMentionOpen(open) {
    model.mentionOpen = open;
    ctx.setMentionVisibility(open);
  }
  function updateMentionPicker() {
    const { text, cursor, end } = ctx.readComposer();
    if (
      !(model.active.startsWith("c") || model.active.startsWith("r")) ||
      cursor !== end
    ) {
      setMentionOpen(false);
      return;
    }
    const match = text.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/u);
    const start = match ? cursor - match[1].length - 1 : -1;
    if (
      !match ||
      model.mentions.some((item) => start >= item.start && start < item.end)
    ) {
      setMentionOpen(false);
      return;
    }
    const query = match[1].toLocaleLowerCase();
    const choices = [
      { name: "All", all: true },
      ...model.members.filter((item) =>
        /^u[0-9a-f]{32}$/.test(String(item.mid || "")) && item.name
      ),
    ].filter((item) => String(item.name).toLocaleLowerCase().includes(query))
      .slice(0, 20);
    setMentionChoices(start, choices);
    ctx.renderMentionChoices(choices);
    setMentionOpen(choices.length > 0);
  }
  function moveMention(step) {
    const n = model.mentionChoices.length;
    if (!n) return;
    model.mentionIndex = (model.mentionIndex + (step > 0 ? 1 : n - 1)) % n;
    ctx.updateMentionPicker();
  }
  function chooseMention(index) {
    const item = model.mentionChoices[index];
    if (!item) return;
    const { text, cursor } = ctx.readComposer(), start = model.mentionStart;
    const label = `@${item.name}`;
    ctx.replaceComposerRange(`${label} `, start, cursor);
    adjustMentions(text, ctx.readComposer().text);
    model.mentions.push({
      start,
      end: start + label.length,
      label,
      ...(item.all ? { all: true } : { mid: String(item.mid) }),
    });
    model.mentionIndex = 0;
    setMentionOpen(false);
    ctx.resizeComposer();
    saveComposer();
    ctx.focusComposer();
  }
  return {
    saveComposer,
    restoreComposer,
    composerInput,
    setMentionOpen,
    updateMentionPicker,
    moveMention,
    chooseMention,
  };
}

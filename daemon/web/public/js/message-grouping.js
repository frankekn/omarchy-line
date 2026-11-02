// Only adjacent desired message items can share a visual conversation run.
export function continuesMessageRun(previous, current) {
  if (previous?.type !== "message" || current.type !== "message") return false;
  const before = previous.message, message = current.message;
  const breaksRun = (row) =>
    row.pending || row.unsent || row.decryptFailed || row.replyTo ||
    ["CHATEVENT", "POSTNOTIFICATION"].includes(row.contentType);
  if (
    !before.from || before.from !== message.from ||
    breaksRun(before) || breaksRun(message) ||
    !previous.day || previous.day !== current.day ||
    before.time == null || message.time == null
  ) return false;
  const elapsed = current.time - previous.time;
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 5 * 60 * 1000;
}

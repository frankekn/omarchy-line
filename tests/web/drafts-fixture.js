// Keep the pointer fixtures independent of the stub's delayed read updates.
export function withoutReadUpdates(frame, connection) {
  if (frame.cmd === "history" && frame.markRead) {
    connection.server.send(JSON.stringify({ ...frame, markRead: false }));
    return false;
  }
  if (frame.cmd === "markRead") {
    connection.socket.send(JSON.stringify({
      id: frame.id,
      ok: true,
      data: { marked: false },
    }));
    return false;
  }
  return true;
}

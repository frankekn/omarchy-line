import { assertEquals } from "@std/assert";
import { continuesMessageRun } from "./public/js/message-grouping.js";

const time = new Date(2026, 5, 1, 12).getTime();
function item(overrides = {}) {
  const message = { from: "peer", time, contentType: "NONE", ...overrides };
  return {
    type: "message",
    message,
    time: Number(message.time),
    day: new Date(message.time).toDateString(),
  };
}

Deno.test("conversation runs require adjacent authors within five minutes", () => {
  const first = item();
  assertEquals(continuesMessageRun(first, item()), true);
  assertEquals(
    continuesMessageRun(first, item({ time: time + 300_000 })),
    true,
  );
  assertEquals(
    continuesMessageRun(first, item({ time: time + 300_001 })),
    false,
  );
  assertEquals(continuesMessageRun(first, item({ time: time - 1 })), false);
  assertEquals(continuesMessageRun(first, item({ from: "other" })), false);
  assertEquals(
    continuesMessageRun(item({ from: "" }), item({ from: "" })),
    false,
  );
  assertEquals(continuesMessageRun(undefined, first), false);
  for (const type of ["day", "unread", "older"]) {
    assertEquals(continuesMessageRun({ ...first, type }, first), false);
  }
});

Deno.test("conversation boundaries preserve exceptional messages and local days", () => {
  for (
    const boundary of [
      { pending: true },
      { unsent: true },
      { decryptFailed: true },
      { replyTo: { id: "origin" } },
      { contentType: "CHATEVENT" },
      { contentType: "POSTNOTIFICATION" },
      { time: null },
      { time: NaN },
    ]
  ) {
    assertEquals(continuesMessageRun(item(boundary), item()), false);
    assertEquals(continuesMessageRun(item(), item(boundary)), false);
  }
  const midnight = new Date(2026, 5, 2).getTime();
  assertEquals(
    continuesMessageRun(item({ time: midnight - 1 }), item({ time: midnight })),
    false,
  );
});

// Only an echo from our account may reconcile an unconfirmed send.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function reconcile(h) {
  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  let blocked;
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.text !== "unconfirmed original") return true;
      blocked = frame;
      return false;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  await page.getByLabel("Message", { exact: true }).fill(
    "unconfirmed original",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(() => blocked, "captured unconfirmed send");
  const state = await h.state();
  let seq = Math.max(0, ...state.events.map((event) => event.seq)) + 20;
  const message = {
    id: "forged-id",
    chat: CHAT,
    from: "u-other",
    fromName: "Other",
    text: "other sender",
    time: Date.now(),
    contentType: "NONE",
    requestId: blocked.requestId,
  };
  tap.socket.send(JSON.stringify({
    event: { seq: seq++, at: Date.now(), kind: "message", chat: CHAT, message },
    boot: state.bootId,
  }));
  await page.getByRole("log").getByText("other sender", { exact: true })
    .waitFor();
  await page.getByRole("log").getByText("unconfirmed original", { exact: true })
    .waitFor();
  const pending = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem("enil.web.drafts.v1"),
    )["ustub-me-0000"]["cstub-family"].pending
  );
  assert.equal(pending.length, 1);
  tap.socket.send(JSON.stringify({
    event: {
      seq: seq++,
      at: Date.now(),
      kind: "message",
      chat: CHAT,
      message: {
        ...message,
        id: "delivered-id",
        from: "ustub-me-0000",
        text: "unconfirmed original",
      },
    },
    boot: state.bootId,
  }));
  await page.waitForFunction(() =>
    (JSON.parse(
      localStorage.getItem("enil.web.drafts.v1") || "{}",
    )["ustub-me-0000"]?.["cstub-family"]?.pending?.length || 0) === 0
  );
  assert.equal(
    await page.getByRole("log").getByText("unconfirmed original", {
      exact: true,
    }).count(),
    1,
  );
  h.step("sender-boundary");
}

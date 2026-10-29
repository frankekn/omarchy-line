// A late failure stays with the account that initiated the send.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function account(h) {
  const context = await h.context({ locale: "en-US" });
  const page = await context.newPage();
  let blocked;
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.text !== "Account boundary test") return true;
      blocked = frame;
      return false;
    },
  });
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  await page.getByLabel("Message", { exact: true }).fill(
    "Account boundary test",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(() => blocked, "captured in-flight send");
  const state = await h.state();
  tap.socket.send(JSON.stringify({
    web: "state",
    state: { ...state, me: { mid: "u-other-account", displayName: "Other" } },
  }));
  await page.locator("#account-name").getByText("Other", { exact: true })
    .waitFor();
  tap.socket.send(
    JSON.stringify({ id: blocked.id, ok: false, error: "test refusal" }),
  );
  await page.waitForFunction(() => {
    const drafts = JSON.parse(
      localStorage.getItem("enil.web.drafts.v1") || "{}",
    );
    return drafts["ustub-me-0000"]?.["cstub-family"]?.pending?.[0]?.status ===
      "failed";
  });
  const drafts = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("enil.web.drafts.v1"))
  );
  assert.equal(
    drafts["ustub-me-0000"][CHAT].pending[0].requestId,
    blocked.requestId,
  );
  assert.equal(drafts["u-other-account"]?.[CHAT]?.pending?.length || 0, 0);
  h.step("account-scoped-pending");
}

// Empty drafts are removed while text, replies and pending sends stay scoped.
import { assert, CHAT, tapSocket, until } from "./harness.js";

export async function drafts(h) {
  const state = await h.state();
  const alice = state.chats.find((chat) => chat.name.includes("Alice"));
  assert.ok(alice);
  const accountA = state.me.mid, accountB = "u-draft-other";
  const seed = {
    [accountA]: {
      [CHAT]: { text: "", reply: null, pending: [], mentions: [], cursor: 0 },
      [alice.mid]: { text: "Alice draft", reply: null, pending: [] },
    },
    "u-draft-empty": { [CHAT]: { text: "", reply: null, pending: [] } },
    [accountB]: {
      [CHAT]: {
        text: "Other draft",
        reply: null,
        pending: [{
          id: "pending-other",
          chat: CHAT,
          from: accountB,
          text: "Other failed",
          time: Date.now(),
          contentType: "NONE",
          pending: true,
          status: "failed",
          requestId: "other-failed",
          cmd: "send",
          payload: { text: "Other failed" },
        }],
      },
    },
  };
  const context = await h.context({ locale: "en-US" });
  await context.addInitScript(({ origin, value }) => {
    if (location.origin !== origin) return;
    if (sessionStorage.getItem("soak-drafts-seeded")) return;
    sessionStorage.setItem("soak-drafts-seeded", "1");
    localStorage.setItem("enil.web.drafts.v1", JSON.stringify(value));
  }, { origin: h.base, value: seed });
  const page = await context.newPage();
  let activeAccount = state.me, blocked;
  const tap = await tapSocket(page, {
    client(frame) {
      if (frame.cmd === "send" && frame.text === "Account A failed") {
        blocked = frame;
        return false;
      }
      return true;
    },
    server(frame) {
      if (frame.web === "state") frame.state.me = activeAccount;
      return true;
    },
  });
  const saved = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("enil.web.drafts.v1") || "{}")
    );
  await h.signIn(page);
  await page.waitForFunction(
    ({ a, chat }) => {
      const data = JSON.parse(
        localStorage.getItem("enil.web.drafts.v1") || "{}",
      );
      return !data[a]?.[chat] && !data["u-draft-empty"];
    },
    { a: accountA, chat: CHAT },
    { timeout: 3000 },
  );
  let data = await saved();
  assert.equal(data[accountA][alice.mid].text, "Alice draft");
  assert.equal(data[accountB][CHAT].pending[0].status, "failed");
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByRole("log").getByText("晚上回來吃飯嗎？").waitFor();
  const input = page.getByLabel("Message", { exact: true });
  assert.equal(await input.inputValue(), "");
  await page.getByRole("button", { name: /STUB Alice/ }).click();
  assert.equal(await input.inputValue(), "Alice draft");
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  assert.equal(await input.inputValue(), "");
  data = await saved();
  assert.equal(data[accountA]?.[CHAT], undefined);

  await input.fill("temporary draft");
  assert.equal((await saved())[accountA][CHAT].text, "temporary draft");
  await input.fill("");
  assert.equal((await saved())[accountA]?.[CHAT], undefined);
  const incoming = page.locator("article.message-row").filter({
    hasText: "晚上回來吃飯嗎？",
  });
  await incoming.getByRole("button", { name: "Reply", exact: true }).click();
  assert.ok((await saved())[accountA][CHAT].reply);
  await page.locator("#cancel-reply").click();
  assert.equal((await saved())[accountA]?.[CHAT], undefined);

  await input.fill("Account A failed");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(() => blocked, "blocked account A send");
  tap.socket.send(
    JSON.stringify({ id: blocked.id, ok: false, error: "test refusal" }),
  );
  await page.waitForFunction(({ a, chat }) => {
    const data = JSON.parse(localStorage.getItem("enil.web.drafts.v1") || "{}");
    return data[a]?.[chat]?.pending?.[0]?.status === "failed";
  }, { a: accountA, chat: CHAT });
  activeAccount = { mid: accountB, displayName: "Other account" };
  tap.socket.send(
    JSON.stringify({ web: "state", state: { ...state, me: activeAccount } }),
  );
  await page.getByText("Other account", { exact: true }).waitFor();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  assert.equal(await input.inputValue(), "Other draft");
  await page.locator("article.message-row").filter({ hasText: "Other failed" })
    .waitFor();
  assert.equal(
    await page.getByText("Account A failed", { exact: true }).count(),
    0,
  );
  activeAccount = state.me;
  tap.socket.send(
    JSON.stringify({ web: "state", state: { ...state, me: activeAccount } }),
  );
  await page.getByText(state.me.displayName, { exact: true }).waitFor();
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.locator("article.message-row").filter({
    hasText: "Account A failed",
  }).waitFor();
  data = await saved();
  assert.equal(data[accountA][CHAT].pending[0].status, "failed");
  assert.equal(data[accountB][CHAT].text, "Other draft");
  assert.equal(data[accountB][CHAT].pending[0].status, "failed");
  await context.close();
  h.step("draft-pruning-preserves-account-and-pending");

  const unavailable = await h.context({ locale: "en-US" });
  await unavailable.addInitScript(({ origin, account, chat }) => {
    if (location.origin !== origin) return;
    const key = "enil.web.drafts.v1";
    localStorage.setItem(
      key,
      JSON.stringify({
        [account]: { [chat]: { text: "", reply: null, pending: [] } },
      }),
    );
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (this === localStorage && name === key) throw new Error("unavailable");
      return removeItem.call(this, name);
    };
  }, { origin: h.base, account: accountA, chat: CHAT });
  const unavailablePage = await unavailable.newPage();
  unavailablePage.setDefaultTimeout(5000);
  await h.signIn(unavailablePage);
  await unavailablePage.getByText(
    "Drafts could not be saved and may be lost on reload.",
  ).waitFor();
  await unavailable.close();
  h.step("draft-cleanup-storage-failure-keeps-startup-working");
}

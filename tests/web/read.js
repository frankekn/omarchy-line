// A peer's read event updates an outgoing message.
import { assert } from "./harness.js";

export async function read(h) {
  const context = await h.context({ locale: "zh-TW" });
  const page = await context.newPage();
  await h.signIn(page);
  await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
  await page.getByLabel("訊息", { exact: true }).fill("read receipt test");
  await page.getByRole("button", { name: "送出", exact: true }).click();
  const row = page.locator("article.message-row").filter({
    hasText: "read receipt test",
  });
  await row.getByText("已讀 1", { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await row.getByText("已讀 1", { exact: true }).count(), 1);
  h.step("peer-read");
}

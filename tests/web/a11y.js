// Mobile touch targets and text contrast in both color schemes.
import axe from "npm:axe-core@4.10.3";
import { assert, KEY } from "./harness.js";

const pixel = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

export async function a11y(h) {
  for (
    const { width, height, colorScheme } of [
      { width: 390, height: 844, colorScheme: "light" },
      { width: 360, height: 780, colorScheme: "dark" },
    ]
  ) {
    const context = await h.context({
      viewport: { width, height },
      isMobile: true,
      hasTouch: true,
      locale: "en-US",
      colorScheme,
      // axe is injected into this test context; the application CSP is intact.
      bypassCSP: true,
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === h.base) return await route.continue();
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: pixel,
      });
    });
    const page = await context.newPage();
    await page.goto(h.base, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: axe.source });
    const targets = async (screen) => {
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("button")].flatMap((button) => {
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          if (
            !rect.width || !rect.height || style.visibility === "hidden" ||
            style.display === "none"
          ) return [];
          return rect.width < 44 || rect.height < 44
            ? [{
              id: button.id,
              label: button.getAttribute("aria-label") || button.textContent,
              width: rect.width,
              height: rect.height,
            }]
            : [];
        })
      );
      assert.deepEqual(small, [], `${colorScheme} ${width} ${screen}`);
    };
    const contrast = async (screen) => {
      const result = await page.evaluate(async () => {
        const scan = await globalThis.axe.run(document, {
          runOnly: { type: "rule", values: ["color-contrast"] },
          resultTypes: ["violations", "incomplete"],
        });
        return {
          violations: scan.violations.map((rule) => ({
            id: rule.id,
            nodes: rule.nodes.map((node) => ({
              target: node.target,
              failure: node.failureSummary,
            })),
          })),
          incomplete: scan.incomplete.flatMap((rule) => rule.nodes).length,
        };
      });
      console.log(
        `  axe ${colorScheme} ${width} ${screen}: ` +
          `${result.violations.length} violations, ` +
          `${result.incomplete} incomplete`,
      );
      assert.deepEqual(result.violations, [], `${colorScheme} ${screen}`);
    };
    await targets("signin");
    await contrast("signin");
    await page.getByLabel("Web key").fill(KEY);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("#connection.connected").waitFor();
    await targets("list");
    await contrast("list");
    await page.getByRole("button", { name: /STUB 家庭群組/ }).click();
    await page.getByRole("log").getByText("晚上回來吃飯嗎？", { exact: true })
      .waitFor();
    await targets("chat");
    await contrast("chat");
    await page.getByRole("button", { name: "React", exact: true }).first()
      .click();
    await page.getByRole("button", { name: "NICE", exact: true }).waitFor();
    await targets("reaction");
    await page.locator("#stickers").click();
    await page.locator("#sticker-picker:not([hidden])").waitFor();
    await targets("stickers");
    await page.locator("#close-stickers").click();
    await page.getByLabel("Message", { exact: true }).fill("@");
    await page.getByRole("button", { name: "@All" }).waitFor();
    await targets("mention");
    await page.getByLabel("Message", { exact: true }).fill("");
    await page.getByRole("button", { name: "Reply", exact: true }).first()
      .click();
    await page.locator("#reply-target:not([hidden])").waitFor();
    await targets("reply");
    await contrast("reply");
    await context.close();
    h.step(`touch-and-contrast-${width}-${colorScheme}`);
  }
}

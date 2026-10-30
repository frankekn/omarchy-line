// Mobile touch targets and text contrast in both color schemes.
import axe from "npm:axe-core@4.10.3";
import { assert, CHAT, KEY, tapSocket } from "./harness.js";

const pixel = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

export async function a11y(h) {
  const invalidPath = `${h.stateDir}/media/a11y-invalid.jpg`;
  await Deno.writeFile(
    invalidPath,
    new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  );
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
    const histories = new Set();
    const goodId = `a11y-good-${width}`, badId = `a11y-bad-${width}`;
    await tapSocket(page, {
      client(frame) {
        if (frame.cmd === "history" && frame.chat === CHAT) {
          histories.add(frame.id);
        }
        if (
          frame.cmd === "download" && [goodId, badId].includes(frame.messageId)
        ) {
          return false;
        }
        return true;
      },
      server(frame) {
        if (histories.delete(frame.id)) {
          const now = Date.now();
          const image = (id, path, time) => ({
            id,
            chat: CHAT,
            from: "peer",
            fromName: "Peer",
            text: id,
            time,
            contentType: "IMAGE",
            hasMedia: true,
            previewable: true,
            mediaState: "ok",
            mediaPath: path,
          });
          frame.data.push(
            image(goodId, `${h.stateDir}/media/stub-shot1.png`, now),
            image(badId, invalidPath, now + 1000),
          );
        }
        return true;
      },
    });
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
      const webkitLightbox = h.browserName === "webkit" &&
        screen.startsWith("lightbox");
      if (webkitLightbox) {
        const surface = await page.evaluate(() => {
          const dialog = document.getElementById("lightbox");
          const name = document.getElementById("lightbox-name");
          const bounds = dialog.getBoundingClientRect();
          const nameBounds = name.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(name);
          const points = [...range.getClientRects()].flatMap((rect) => {
            const left = Math.max(rect.left, nameBounds.left);
            const right = Math.min(rect.right, nameBounds.right);
            const top = Math.max(rect.top, nameBounds.top);
            const bottom = Math.min(rect.bottom, nameBounds.bottom);
            if (right <= left || bottom <= top) return [];
            return [
              document.elementFromPoint(
                (left + right) / 2,
                (top + bottom) / 2,
              ) === name,
            ];
          });
          const color = getComputedStyle(dialog).backgroundColor;
          const components = (color.match(/[\d.]+/g) || []).map(Number);
          return {
            coversViewport: dialog.open && bounds.left <= 0 &&
              bounds.top <= 0 && bounds.right >= innerWidth &&
              bounds.bottom >= innerHeight,
            alpha: components[3] ?? 1,
            points,
          };
        });
        assert.equal(surface.coversViewport, true);
        assert.equal(surface.alpha, 1);
        assert.ok(surface.points.length > 0);
        assert.ok(surface.points.every(Boolean), "lightbox name is unobscured");
      }
      const result = await page.evaluate(async (hideCoveredApp) => {
        const app = document.getElementById("app");
        const originalStyle = app.getAttribute("style");
        // WebKit splits the name into text rects; axe can mistake covered
        // app elements for overlap even though the opaque dialog is on top.
        if (hideCoveredApp) app.style.visibility = "hidden";
        try {
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
            incomplete: scan.incomplete.flatMap((rule) =>
              rule.nodes.map((node) => ({
                target: node.target,
                details: node.any.map((check) => check.message),
              }))
            ),
          };
        } finally {
          if (hideCoveredApp) {
            if (originalStyle === null) app.removeAttribute("style");
            else app.setAttribute("style", originalStyle);
          }
        }
      }, webkitLightbox);
      console.log(
        `  axe ${colorScheme} ${width} ${screen}: ` +
          `${result.violations.length} violations, ` +
          `${result.incomplete.length} incomplete`,
      );
      assert.deepEqual(result.violations, [], `${colorScheme} ${screen}`);
      if (screen.startsWith("lightbox")) {
        result.incomplete = result.incomplete.filter((item) =>
          !item.target.every((target) =>
            /^#lightbox-(prev|next|zoom-in|zoom-out|close)$/.test(target)
          ) || !item.details.every((detail) =>
            detail === "Element content contains only non-text characters"
          )
        );
        assert.deepEqual(
          result.incomplete,
          [],
          `${colorScheme} ${screen} incomplete`,
        );
      }
    };
    const iconContrast = async (id) => {
      const button = page.locator(`#${id}`);
      const measure = () =>
        button.evaluate((node) => {
          const parse = (value) => (value.match(/[\d.]+/g) || []).map(Number);
          const style = getComputedStyle(node);
          const foreground = parse(style.color),
            background = parse(style.backgroundColor);
          const dialog = parse(
            getComputedStyle(document.getElementById("lightbox"))
              .backgroundColor,
          );
          const alpha = background[3] ?? 1;
          const composite = background.slice(0, 3).map((value, index) =>
            value * alpha + dialog[index] * (1 - alpha)
          );
          const luminance = (color) =>
            color.slice(0, 3).map((value) => {
              const channel = value / 255;
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            }).reduce(
              (sum, value, index) =>
                sum + value * [0.2126, 0.7152, 0.0722][index],
              0,
            );
          const first = luminance(foreground), second = luminance(composite);
          return {
            ratio: (Math.max(first, second) + 0.05) /
              (Math.min(first, second) + 0.05),
            dialogAlpha: dialog[3] ?? 1,
          };
        });
      await page.mouse.move(1, 1);
      const normal = await measure();
      await button.hover();
      const hover = await measure();
      assert.equal(normal.dialogAlpha, 1);
      assert.equal(hover.dialogAlpha, 1);
      assert.ok(
        normal.ratio >= 4.5,
        `${colorScheme} ${id} contrast ${normal.ratio}`,
      );
      assert.ok(
        hover.ratio >= 4.5,
        `${colorScheme} ${id} hover contrast ${hover.ratio}`,
      );
      console.log(
        `  icon ${colorScheme} ${id}: ${normal.ratio.toFixed(2)} normal, ${
          hover.ratio.toFixed(2)
        } hover`,
      );
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
    const good = page.locator(
      `article[data-message-id="${goodId}"] img.media-image`,
    );
    await good.scrollIntoViewIfNeeded();
    await good.click();
    await page.locator("#lightbox[open]").waitFor();
    await targets("lightbox");
    await contrast("lightbox");
    for (const id of ["lightbox-next", "lightbox-zoom-in", "lightbox-close"]) {
      await iconContrast(id);
    }
    await page.locator("#lightbox-zoom-in").click();
    await iconContrast("lightbox-zoom-out");
    await page.locator("#lightbox-next").click();
    await page.locator("#lightbox-error:not([hidden])").waitFor();
    await iconContrast("lightbox-prev");
    await targets("lightbox-error");
    await contrast("lightbox-error");
    await context.close();
    h.step(`touch-and-contrast-${width}-${colorScheme}`);
  }
}

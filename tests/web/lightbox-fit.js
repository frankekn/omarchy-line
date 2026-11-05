// A picture larger than the lightbox fits inside it, centred.
import { assert } from "./harness.js";

export async function lightboxFit(h) {
  for (
    const viewport of [{ width: 390, height: 844 }, {
      width: 1280,
      height: 800,
    }]
  ) {
    const context = await h.context({ locale: "en-US", viewport });
    const page = await context.newPage();
    await h.signIn(page);
    for (const [width, height] of [[1477, 1108], [1108, 1477], [868, 1886]]) {
      const r = await page.evaluate(
        ([w, hgt]) =>
          new Promise((resolve, reject) => {
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = hgt;
            canvas.getContext("2d").fillRect(0, 0, w, hgt);
            const dialog = document.getElementById("lightbox");
            if (!dialog.open) dialog.showModal();
            const image = document.getElementById("lightbox-image");
            image.onload = () =>
              requestAnimationFrame(() => {
                const s = document.getElementById("lightbox-stage")
                  .getBoundingClientRect();
                const i = image.getBoundingClientRect();
                resolve({
                  dx: i.x + i.width / 2 - (s.x + s.width / 2),
                  dy: i.y + i.height / 2 - (s.y + s.height / 2),
                  inside: i.x >= s.x - 1 && i.y >= s.y - 1 &&
                    i.right <= s.right + 1 && i.bottom <= s.bottom + 1,
                });
              });
            image.onerror = () => reject(new Error(`${w}x${hgt} did not load`));
            image.src = canvas.toDataURL("image/png");
          }),
        [width, height],
      );
      const label = `${width}x${height} at ${viewport.width}px`;
      assert.ok(
        r.inside,
        `${label} fits inside the stage: ${JSON.stringify(r)}`,
      );
      assert.ok(
        Math.abs(r.dx) <= 1 && Math.abs(r.dy) <= 1,
        `${label} is centred: ${JSON.stringify(r)}`,
      );
    }
    await context.close();
  }
  h.step("large pictures fit the lightbox, centred");
}

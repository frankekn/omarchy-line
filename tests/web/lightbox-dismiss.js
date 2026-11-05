// The lightbox closes from the dark space around the picture and, on touch,
// from a downward swipe; the picture itself and a drag do not close it.
import { assert } from "./harness.js";

async function open(page) {
  await page.evaluate(() =>
    new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 400;
      canvas.getContext("2d").fillRect(0, 0, 600, 400);
      const image = document.getElementById("lightbox-image");
      image.onload = () => requestAnimationFrame(() => resolve());
      image.onerror = () => reject(new Error("picture did not load"));
      image.style.transform = "";
      image.src = canvas.toDataURL("image/png");
      const dialog = document.getElementById("lightbox");
      if (!dialog.open) dialog.showModal();
    })
  );
}
const isOpen = (page) =>
  page.evaluate(() => document.getElementById("lightbox").open);

async function swipe(page, dy) {
  await page.evaluate((distance) => {
    const stage = document.getElementById("lightbox-stage");
    const box = stage.getBoundingClientRect();
    const x = box.left + 20, y = box.top + 40;
    // WebKit has no Touch constructor; the viewer only reads these fields.
    const touch = (clientY) => ({ identifier: 1, clientX: x, clientY });
    const send = (type, touches, changed) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: changed });
      stage.dispatchEvent(event);
    };
    send("touchstart", [touch(y)], [touch(y)]);
    send("touchmove", [touch(y + distance)], [touch(y + distance)]);
    send("touchend", [], [touch(y + distance)]);
  }, dy);
}

export async function lightboxDismiss(h) {
  const desktop = await h.context({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
  const page = await desktop.newPage();
  await h.signIn(page);
  await open(page);
  const image = await page.locator("#lightbox-image").boundingBox();
  await page.mouse.click(image.x + image.width / 2, image.y + image.height / 2);
  assert.equal(await isOpen(page), true, "clicking the picture keeps it open");
  const stage = await page.locator("#lightbox-stage").boundingBox();
  await page.mouse.click(stage.x + 10, stage.y + stage.height - 10);
  assert.equal(await isOpen(page), false, "the dark space closes it");
  await open(page);
  await page.locator("#lightbox-zoom-in").click();
  await page.locator("#lightbox-zoom-in").click();
  const x = stage.x + stage.width / 2, y = stage.y + stage.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.up();
  assert.equal(await isOpen(page), true, "ending a drag does not close it");
  await page.mouse.click(stage.x + 10, stage.y + stage.height - 10);
  assert.equal(
    await isOpen(page),
    true,
    "zoomed in, the dark space is not a dismiss",
  );
  const margin = await page.locator("#lightbox").boundingBox();
  await page.mouse.click(margin.x + 5, margin.y + margin.height - 5);
  assert.equal(
    await isOpen(page),
    false,
    "zoomed in, the margin still closes it",
  );
  await open(page);
  await page.keyboard.press("Escape");
  assert.equal(await isOpen(page), false, "Escape still closes it");
  await desktop.close();

  const phone = await h.context({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const mobile = await phone.newPage();
  await h.signIn(mobile);
  await open(mobile);
  const phoneStage = await mobile.locator("#lightbox-stage").boundingBox();
  await mobile.touchscreen.tap(
    phoneStage.x + 10,
    phoneStage.y + phoneStage.height - 10,
  );
  assert.equal(
    await isOpen(mobile),
    false,
    "a tap on the dark space closes it",
  );
  await open(mobile);
  await swipe(mobile, 30);
  assert.equal(await isOpen(mobile), true, "a short drag is not a dismiss");
  await swipe(mobile, 160);
  assert.equal(await isOpen(mobile), false, "a downward swipe closes it");
  await phone.close();
  h.step("tap outside or swipe down closes the lightbox");
}

// Sticker picker DOM. Reads shared state and forwards actions to the
// controller.
import { $, el, httpsUrl, safeImage } from "./dom.js";
export function createStickersView(ctx) {
  const model = ctx.model, t = ctx.t;
  function showStickerLoading() {
    $("sticker-content").replaceChildren(
      el("div", "loading-message", t("loading")),
    );
  }
  function showStickerError(error) {
    $("sticker-content").replaceChildren(el("div", "loading-message", error));
  }
  function setStickerVisible(visible) {
    $("sticker-picker").hidden = !visible;
  }
  function renderStickers() {
    const content = $("sticker-content"), nodes = [];
    for (const pack of model.stickerPacks || []) {
      nodes.push(el("div", "sticker-pack-title", pack.name || pack.id));
      const grid = el("div", "sticker-grid");
      for (const sticker of Array.isArray(pack.stickers) ? pack.stickers : []) {
        const url = httpsUrl(sticker.url);
        if (!url) continue;
        const button = el("button", "sticker-cell");
        button.type = "button";
        button.setAttribute(
          "aria-label",
          `${String(pack.name || t("stickers"))} ${String(sticker.id || "")}`,
        );
        button.append(safeImage(url, "", ""));
        button.addEventListener(
          "click",
          () => ctx.selectSticker(pack, sticker, url),
        );
        grid.append(button);
      }
      nodes.push(grid);
    }
    content.replaceChildren(
      ...(nodes.length
        ? nodes
        : [el("div", "loading-message", t("noStickers"))]),
    );
  }
  $("stickers").addEventListener("click", () => ctx.toggleStickers());
  $("refresh-stickers").addEventListener("click", () => ctx.loadStickers(true));
  $("close-stickers").addEventListener("click", () => ctx.closeStickerPicker());
  return {
    showStickerLoading,
    showStickerError,
    setStickerVisible,
    renderStickers,
  };
}

// Sticker loading and sends. Uses connection and injected view actions.
export function createStickersController(ctx) {
  const model = ctx.model, t = ctx.t;
  function closeStickerPicker() {
    model.stickerOpen = false;
    ctx.setStickerVisible(false);
  }
  function toggleStickers() {
    model.stickerOpen = !model.stickerOpen;
    ctx.setStickerVisible(model.stickerOpen);
    if (model.stickerOpen) {
      if (model.stickerPacks) ctx.renderStickers();
      else loadStickers();
    }
  }
  async function loadStickers(refresh = false) {
    ctx.showStickerLoading();
    try {
      const data = await ctx.command(
        "stickers",
        refresh ? { refresh: true } : {},
      );
      model.stickerPacks = Array.isArray(data?.packages) ? data.packages : [];
      ctx.renderStickers();
    } catch (error) {
      ctx.showStickerError(error.message || t("genericError"));
    }
  }
  function selectSticker(pack, sticker, url) {
    const chat = model.active;
    if (!chat || !model.connected) {
      ctx.toast(t("offlineAction"));
      return;
    }
    const payload = {
      packageId: String(pack.id),
      stickerId: String(sticker.id),
    };
    if (Number(pack.version) > 0) payload.version = Number(pack.version);
    ctx.sendOptimistic(
      chat,
      ctx.optimistic(chat, "sendSticker", payload, {
        contentType: "STICKER",
        stickerUrl: url,
      }),
    );
    closeStickerPicker();
  }
  return { loadStickers, selectSticker, closeStickerPicker, toggleStickers };
}

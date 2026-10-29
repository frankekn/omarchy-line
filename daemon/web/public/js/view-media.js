// Attachment rendering, lightbox and preview observation. Uses DOM helpers and
// injected actions.
import { $, el, fileUrl, httpsUrl, safeImage, sizeText } from "./dom.js";
export function createMediaView(ctx) {
  const model = ctx.model, t = ctx.t;
  const command = (...args) => ctx.command(...args);
  const displayError = (error) => ctx.displayError(error);
  async function downloadMessage(chat, message) {
    try {
      const data = await command("download", {
        chat,
        messageId: String(message.id),
      });
      if (!data?.path) throw new Error(t("mediaFailed"));
      const link = el("a");
      link.href = fileUrl(data.path, true);
      link.download = String(message.fileName || "");
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      displayError(error);
    }
  }
  function openLightbox(chat, message, url) {
    $("lightbox-name").textContent = String(message.fileName || t("image"));
    $("lightbox-image").src = url;
    $("lightbox-image").alt = String(message.fileName || t("image"));
    $("lightbox-download").onclick = () => downloadMessage(chat, message);
    if (!$("lightbox").open) $("lightbox").showModal();
  }
  $("lightbox-close").addEventListener("click", () => $("lightbox").close());
  $("lightbox").addEventListener("click", (event) => {
    if (event.target === $("lightbox")) $("lightbox").close();
  });
  const previewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      previewObserver.unobserve(entry.target);
      const id = entry.target.dataset.messageId,
        chat = entry.target.dataset.chat;
      ctx.requestPreview(id, chat);
    }
  }, { root: $("messages"), rootMargin: "400px 0px" });
  function addMedia(bubble, message, chat) {
    const type = String(message.contentType || "");
    const state = message.mediaState || "ok";
    if (message.unsent) return;
    if (type === "STICKER") {
      const url = httpsUrl(message.stickerUrl);
      if (url) bubble.append(safeImage(url, "sticker-image", t("stickers")));
    }
    if (type === "FLEX" && Array.isArray(message.flexImages)) {
      for (const value of message.flexImages) {
        const url = httpsUrl(value);
        if (!url) {
          continue;
        }
        const img = safeImage(url, "media-image", t("image"));
        img.addEventListener("click", () => openLightbox(chat, message, url));
        bubble.append(img);
      }
    }
    if (message.pending) return;
    if (!["IMAGE", "VIDEO", "FILE"].includes(type)) return;
    if (state !== "ok") {
      bubble.append(el("div", "muted", t("mediaExpired")));
      return;
    }
    if (message.previewable) {
      const id = String(message.id),
        path = model.previews.get(id) || message.mediaPath;
      if (path) {
        const url = fileUrl(path),
          image = safeImage(
            url,
            "media-image",
            type === "VIDEO" ? t("video") : t("image"),
          );
        if (type === "IMAGE") {
          image.addEventListener(
            "click",
            () => openLightbox(chat, message, url),
          );
        }
        bubble.append(image);
      } else {
        const placeholder = el(
          "div",
          "media-placeholder",
          model.previews.has(id) ? t("mediaFailed") : t("loading"),
        );
        placeholder.dataset.messageId = id;
        placeholder.dataset.chat = chat;
        bubble.append(placeholder);
        if (!model.previews.has(id)) previewObserver.observe(placeholder);
      }
    }
    if (type === "FILE" || type === "VIDEO" || !message.previewable) {
      const card = el("div", "file-card"), info = el("span", "file-details");
      info.append(
        el(
          "strong",
          "",
          message.fileName ||
            (type === "VIDEO"
              ? t("video")
              : type === "IMAGE"
              ? t("image")
              : t("file")),
        ),
      );
      if (message.fileSize !== undefined) {
        info.append(el("small", "", sizeText(message.fileSize)));
      }
      const button = el("button", "download-button", t("download"));
      button.type = "button";
      button.addEventListener("click", () => downloadMessage(chat, message));
      card.append(
        el("span", "file-icon", type === "VIDEO" ? "▷" : "↓"),
        info,
        button,
      );
      bubble.append(card);
    }
  }
  function disconnectPreviews() {
    previewObserver.disconnect();
  }
  return { addMedia, disconnectPreviews };
}

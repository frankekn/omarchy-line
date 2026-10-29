// Attachment rendering, lightbox and preview observation. Uses DOM helpers and
// injected actions.
import { $, el, fileUrl, httpsUrl, safeImage, sizeText } from "./dom.js";
export function createMediaView(ctx) {
  const model = ctx.model, t = ctx.t;
  const command = (...args) => ctx.command(...args);
  const displayError = (error) => ctx.displayError(error);
  let pictures = [], pictureIndex = 0, scale = 1, panX = 0, panY = 0;
  let lightboxChat = "", lightboxAccount = "";
  let lightboxGeneration = 0, pictureGeneration = 0;
  const downloads = new Map(), originals = new Map();
  let pinch = null, drag = null;
  function originalKey(account, chat, message) {
    return JSON.stringify([account, chat, String(message.id)]);
  }
  function requestOriginal(account, chat, message, session) {
    const key = originalKey(account, chat, message);
    const existing = downloads.get(key);
    if (existing) return existing;
    const promise = command("download", {
      chat,
      messageId: String(message.id),
    }).then((data) => {
      if (!data?.path) throw new Error(t("mediaFailed"));
      return String(data.path);
    }).finally(() => {
      if (downloads.get(key)?.promise === promise) downloads.delete(key);
    });
    const request = { promise, session };
    downloads.set(key, request);
    return request;
  }
  async function downloadMessage(chat, message) {
    const account = model.account;
    try {
      const inViewer = $("lightbox").open && lightboxAccount === account &&
        lightboxChat === chat;
      const path =
        (inViewer && originals.get(originalKey(account, chat, message))) ||
        await requestOriginal(
          account,
          chat,
          message,
          inViewer ? lightboxGeneration : null,
        ).promise;
      if (model.account !== account) return;
      const link = el("a");
      link.href = fileUrl(path, true);
      link.download = String(message.fileName || "");
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      displayError(error);
    }
  }
  function applyPan(x, y) {
    const image = $("lightbox-image"), stage = $("lightbox-stage");
    const limitX = Math.max(
      0,
      (image.clientWidth * scale - stage.clientWidth) / 2,
    );
    const limitY = Math.max(
      0,
      (image.clientHeight * scale - stage.clientHeight) / 2,
    );
    panX = Math.max(-limitX, Math.min(limitX, x));
    panY = Math.max(-limitY, Math.min(limitY, y));
    image.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }
  function setScale(value, x = 0, y = 0) {
    const next = Math.max(1, Math.min(4, value));
    const ratio = next / scale;
    panX = next === 1 ? 0 : x - (x - panX) * ratio;
    panY = next === 1 ? 0 : y - (y - panY) * ratio;
    scale = next;
    applyPan(panX, panY);
    $("lightbox-zoom-out").disabled = scale <= 1;
    $("lightbox-zoom-in").disabled = scale >= 4;
  }
  function updatePictureControls() {
    const item = pictures[pictureIndex];
    $("lightbox-name").textContent = `${item.name}  ${
      pictureIndex + 1
    } / ${pictures.length}`;
    $("lightbox-image").alt = item.name;
    $("lightbox-download").hidden = !item.download;
    $("lightbox-download").onclick = item.download;
    $("lightbox-prev").disabled = pictureIndex === 0;
    $("lightbox-next").disabled = pictureIndex === pictures.length - 1;
  }
  function setPictureSource(url) {
    $("lightbox-error").hidden = true;
    $("lightbox-image").src = url;
  }
  async function loadOriginal(item) {
    if (!item.message) return;
    const session = lightboxGeneration, version = pictureGeneration;
    const account = lightboxAccount, chat = lightboxChat;
    const key = originalKey(account, chat, item.message);
    const isCurrent = () =>
      $("lightbox").open &&
      lightboxGeneration === session && pictureGeneration === version &&
      model.account === account && model.active === chat &&
      pictures[pictureIndex]?.key === item.key;
    const cached = originals.get(key);
    if (cached) {
      setPictureSource(fileUrl(cached));
      return;
    }
    const previous = downloads.get(key);
    if (previous && previous.session !== session) {
      try {
        await previous.promise;
      } catch { /* A new opening can retry. */ }
      if (!isCurrent()) return;
    }
    try {
      const path = await requestOriginal(account, chat, item.message, session)
        .promise;
      if (
        $("lightbox").open && lightboxGeneration === session &&
        model.account === account && model.active === chat
      ) originals.set(key, path);
      if (isCurrent()) setPictureSource(fileUrl(path));
    } catch { /* Keep the preview; a later opening can retry. */ }
  }
  function showPicture() {
    pictureGeneration++;
    updatePictureControls();
    setPictureSource(pictures[pictureIndex].url);
    setScale(1);
    void loadOriginal(pictures[pictureIndex]);
  }
  function stepPicture(delta) {
    const next = pictureIndex + delta;
    if (next < 0 || next >= pictures.length) return;
    pictureIndex = next;
    showPicture();
  }
  function flexPictureKey(id, source, occurrence) {
    return JSON.stringify(["flex", String(id), source, occurrence]);
  }
  function pictureList(chat) {
    const list = [];
    for (const row of model.messages) {
      if (row.unsent || row.pending) continue;
      if (row.contentType === "FLEX" && Array.isArray(row.flexImages)) {
        const occurrences = new Map();
        for (const value of row.flexImages) {
          const source = httpsUrl(value);
          if (source) {
            const occurrence = occurrences.get(source) || 0;
            occurrences.set(source, occurrence + 1);
            list.push({
              key: flexPictureKey(row.id, source, occurrence),
              id: String(row.id),
              url: source,
              name: t("image"),
              download: null,
            });
          }
        }
      } else if (
        row.contentType === "IMAGE" && row.hasMedia &&
        (!row.mediaState || row.mediaState === "ok")
      ) {
        const path = model.previews.get(String(row.id)) || row.mediaPath;
        if (path) {
          list.push({
            key: JSON.stringify(["image", String(row.id)]),
            id: String(row.id),
            url: fileUrl(path),
            name: String(row.fileName || t("image")),
            message: row,
            download: () => downloadMessage(chat, row),
          });
        }
      }
    }
    return list;
  }
  function openLightbox(chat, message, url, key = "") {
    pictures = pictureList(chat);
    pictureIndex = pictures.findIndex((item) =>
      item.id === String(message.id) && item.url === url &&
      (!key || item.key === key)
    );
    if (pictureIndex < 0) return;
    lightboxChat = chat;
    lightboxAccount = model.account;
    lightboxGeneration++;
    originals.clear();
    showPicture();
    if (!$("lightbox").open) $("lightbox").showModal();
  }
  function refreshLightbox() {
    if (!$("lightbox").open) return;
    if (lightboxChat !== model.active || lightboxAccount !== model.account) {
      $("lightbox").close();
      return;
    }
    const current = pictures[pictureIndex];
    const updated = pictureList(lightboxChat);
    if (!updated.length) {
      $("lightbox").close();
      return;
    }
    const index = updated.findIndex((item) => item.key === current.key);
    pictures = updated;
    if (index < 0) {
      pictureIndex = Math.min(pictureIndex, pictures.length - 1);
      showPicture();
      return;
    }
    pictureIndex = index;
    updatePictureControls();
    if (
      current.url !== pictures[index].url &&
      (!pictures[index].message ||
        !originals.has(
          originalKey(lightboxAccount, lightboxChat, pictures[index].message),
        ))
    ) {
      setPictureSource(pictures[index].url);
    }
  }
  function clickableImage(image, chat, message, url, key = "") {
    image.tabIndex = 0;
    image.setAttribute("role", "button");
    image.addEventListener(
      "click",
      () => openLightbox(chat, message, url, key),
    );
    image.addEventListener("keydown", (event) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openLightbox(chat, message, url, key);
      }
    });
  }
  $("lightbox-prev").addEventListener("click", () => stepPicture(-1));
  $("lightbox-image").addEventListener("error", () => {
    $("lightbox-error").hidden = false;
  });
  $("lightbox-image").addEventListener("load", () => {
    $("lightbox-error").hidden = true;
  });
  $("lightbox-next").addEventListener("click", () => stepPicture(1));
  $("lightbox-zoom-in").addEventListener("click", () => setScale(scale * 1.2));
  $("lightbox-zoom-out").addEventListener("click", () => setScale(scale / 1.2));
  $("lightbox").addEventListener("keydown", (event) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (event.shiftKey && event.key.startsWith("Arrow")) {
      const x = event.key === "ArrowLeft"
        ? 40
        : event.key === "ArrowRight"
        ? -40
        : 0;
      const y = event.key === "ArrowUp"
        ? 40
        : event.key === "ArrowDown"
        ? -40
        : 0;
      applyPan(panX + x, panY + y);
    } else if (event.key === "ArrowLeft") stepPicture(-1);
    else if (event.key === "ArrowRight") stepPicture(1);
    else if (event.key === "+" || event.key === "=") setScale(scale * 1.2);
    else if (event.key === "-") setScale(scale / 1.2);
    else return;
    event.preventDefault();
  });
  function pointInStage(x, y) {
    const bounds = $("lightbox-stage").getBoundingClientRect();
    return {
      x: x - bounds.left - bounds.width / 2,
      y: y - bounds.top - bounds.height / 2,
    };
  }
  $("lightbox-stage").addEventListener("wheel", (event) => {
    event.preventDefault();
    const point = pointInStage(event.clientX, event.clientY);
    if (event.deltaY) {
      setScale(scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), point.x, point.y);
    }
  }, { passive: false });
  $("lightbox-stage").addEventListener("dblclick", (event) => {
    const point = pointInStage(event.clientX, event.clientY);
    setScale(scale > 1 ? 1 : 2, point.x, point.y);
  });
  $("lightbox-stage").addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || scale <= 1) {
      return;
    }
    drag = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  $("lightbox-stage").addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" || !drag) return;
    applyPan(panX + event.clientX - drag.x, panY + event.clientY - drag.y);
    drag = { x: event.clientX, y: event.clientY };
  });
  $("lightbox-stage").addEventListener("pointerup", () => drag = null);
  $("lightbox-stage").addEventListener("pointercancel", () => drag = null);
  function touchDistance(touches) {
    return Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
  }
  $("lightbox-stage").addEventListener("touchstart", (event) => {
    if (event.touches.length === 2) {
      pinch = { distance: touchDistance(event.touches), scale };
      drag = null;
    } else if (event.touches.length === 1 && scale > 1) {
      drag = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
  }, { passive: true });
  $("lightbox-stage").addEventListener("touchmove", (event) => {
    if (pinch && event.touches.length === 2 && pinch.distance) {
      event.preventDefault();
      const point = pointInStage(
        (event.touches[0].clientX + event.touches[1].clientX) / 2,
        (event.touches[0].clientY + event.touches[1].clientY) / 2,
      );
      setScale(
        pinch.scale * touchDistance(event.touches) / pinch.distance,
        point.x,
        point.y,
      );
    } else if (drag && event.touches.length === 1) {
      event.preventDefault();
      const touch = event.touches[0];
      applyPan(panX + touch.clientX - drag.x, panY + touch.clientY - drag.y);
      drag = { x: touch.clientX, y: touch.clientY };
    }
  }, { passive: false });
  function endTouch() {
    pinch = null;
    drag = null;
  }
  $("lightbox-stage").addEventListener("touchend", endTouch);
  $("lightbox-stage").addEventListener("touchcancel", endTouch);
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
      const occurrences = new Map();
      for (const value of message.flexImages) {
        const url = httpsUrl(value);
        if (!url) {
          continue;
        }
        const img = safeImage(url, "media-image", t("image"));
        const occurrence = occurrences.get(url) || 0;
        occurrences.set(url, occurrence + 1);
        clickableImage(
          img,
          chat,
          message,
          url,
          flexPictureKey(message.id, url, occurrence),
        );
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
          clickableImage(image, chat, message, url);
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
  function unobservePreviews(row) {
    for (const node of row.querySelectorAll(".media-placeholder")) {
      previewObserver.unobserve(node);
    }
  }
  return { addMedia, unobservePreviews, refreshLightbox };
}

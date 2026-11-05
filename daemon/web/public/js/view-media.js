// Attachment rendering, lightbox and preview observation. Uses DOM helpers and
// injected actions.
import {
  $,
  durationText,
  el,
  fileUrl,
  httpsUrl,
  icon,
  safeImage,
  sizeText,
} from "./dom.js";
const AUDIO_URL_MAX = 16;
/** The name a saved attachment gets; the cache stores it by message id. */
export function downloadName(message) {
  if (message.fileName) return String(message.fileName);
  const id = String(message.id || "");
  const type = String(message.contentType || "");
  if (type === "AUDIO") return `line-voice-${id}.m4a`;
  if (type === "VIDEO") return `line-video-${id}.mp4`;
  return `line-${type === "IMAGE" ? "image" : "file"}-${id}`;
}
export function createMediaView(ctx) {
  const model = ctx.model, t = ctx.t;
  const command = (...args) => ctx.command(...args);
  const displayError = (error) => ctx.displayError(error);
  let pictures = [], pictureIndex = 0, scale = 1, panX = 0, panY = 0;
  let lightboxChat = "", lightboxAccount = "";
  let lightboxGeneration = 0, pictureGeneration = 0;
  const downloads = new Map(), originals = new Map();
  const audioUrls = new Map();
  let pinch = null, touchDrag = null, mouseDrag = null;
  // A gesture that moved the picture must not also count as a dismissing tap;
  // swipe tracks a one-finger drag at normal size, which closes when it is a
  // clear downward flick.
  let gestureMoved = false, swipe = null;
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
      const name = downloadName(message);
      link.href = fileUrl(path, true, name);
      link.download = name;
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
    const out = $("lightbox-zoom-out"), zoomIn = $("lightbox-zoom-in");
    const focused = document.activeElement;
    out.disabled = scale <= 1;
    zoomIn.disabled = scale >= 4;
    if (focused === out && out.disabled) zoomIn.focus({ preventScroll: true });
    else if (focused === zoomIn && zoomIn.disabled) {
      out.focus({ preventScroll: true });
    }
  }
  function updatePictureControls() {
    const item = pictures[pictureIndex];
    $("lightbox-name").textContent = `${item.name}  ${
      pictureIndex + 1
    } / ${pictures.length}`;
    $("lightbox-image").alt = item.name;
    $("lightbox-download").hidden = !item.download;
    $("lightbox-download").onclick = item.download;
    const prev = $("lightbox-prev"), next = $("lightbox-next");
    const focused = document.activeElement;
    prev.disabled = pictureIndex === 0;
    next.disabled = pictureIndex === pictures.length - 1;
    if (focused === prev && prev.disabled) {
      (next.disabled ? $("lightbox-close") : next).focus({
        preventScroll: true,
      });
    } else if (focused === next && next.disabled) {
      (prev.disabled ? $("lightbox-close") : prev).focus({
        preventScroll: true,
      });
    }
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
    pinch = null;
    touchDrag = null;
    mouseDrag = null;
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
        row.contentType === "POSTNOTIFICATION" && row.previewable &&
        row.postEvent
      ) {
        const path = model.previews.get(String(row.id)) || row.mediaPath;
        if (path) {
          list.push({
            key: JSON.stringify(["post", String(row.id)]),
            id: String(row.id),
            url: fileUrl(path),
            name: t("image"),
            download: null,
          });
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
    if (event.pointerType === "mouse") gestureMoved = false;
    if (event.pointerType !== "mouse" || event.button !== 0 || scale <= 1) {
      return;
    }
    mouseDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  $("lightbox-stage").addEventListener("pointermove", (event) => {
    if (
      event.pointerType !== "mouse" || !mouseDrag ||
      event.pointerId !== mouseDrag.id
    ) return;
    gestureMoved = true;
    applyPan(
      panX + event.clientX - mouseDrag.x,
      panY + event.clientY - mouseDrag.y,
    );
    mouseDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  function endMouse(event) {
    if (event.pointerType === "mouse" && event.pointerId === mouseDrag?.id) {
      mouseDrag = null;
    }
  }
  $("lightbox-stage").addEventListener("pointerup", endMouse);
  $("lightbox-stage").addEventListener("pointercancel", endMouse);
  function touchDistance(first, second) {
    return Math.hypot(
      first.clientX - second.clientX,
      first.clientY - second.clientY,
    );
  }
  function findTouch(touches, id) {
    return Array.from(touches).find((touch) => touch.identifier === id);
  }
  $("lightbox-stage").addEventListener("touchstart", (event) => {
    if (event.touches.length === 1) gestureMoved = false;
    const only = event.touches.length === 1 ? event.touches[0] : null;
    swipe = only && scale <= 1
      ? { id: only.identifier, x: only.clientX, y: only.clientY }
      : null;
    if (event.touches.length === 2) {
      const first = event.touches[0], second = event.touches[1];
      pinch = {
        ids: [first.identifier, second.identifier],
        distance: touchDistance(first, second),
        scale,
      };
      touchDrag = null;
    } else if (event.touches.length === 1 && scale > 1) {
      const touch = event.touches[0];
      touchDrag = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    }
  }, { passive: true });
  $("lightbox-stage").addEventListener("touchmove", (event) => {
    const first = pinch && findTouch(event.touches, pinch.ids[0]);
    const second = pinch && findTouch(event.touches, pinch.ids[1]);
    const touch = touchDrag && findTouch(event.touches, touchDrag.id);
    if (swipe) {
      const moving = findTouch(event.touches, swipe.id);
      if (
        moving &&
        Math.hypot(moving.clientX - swipe.x, moving.clientY - swipe.y) >
          10
      ) gestureMoved = true;
    }
    if (
      pinch && first && second && event.touches.length === 2 && pinch.distance
    ) {
      gestureMoved = true;
      event.preventDefault();
      const point = pointInStage(
        (first.clientX + second.clientX) / 2,
        (first.clientY + second.clientY) / 2,
      );
      setScale(
        pinch.scale * touchDistance(first, second) / pinch.distance,
        point.x,
        point.y,
      );
    } else if (touchDrag && touch && event.touches.length === 1) {
      gestureMoved = true;
      event.preventDefault();
      applyPan(
        panX + touch.clientX - touchDrag.x,
        panY + touch.clientY - touchDrag.y,
      );
      touchDrag = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    }
  }, { passive: false });
  function endTouch(event) {
    const lifted = swipe && findTouch(event.changedTouches, swipe.id);
    if (lifted && !event.touches.length && scale <= 1) {
      const dx = lifted.clientX - swipe.x, dy = lifted.clientY - swipe.y;
      swipe = null;
      if (dy > 80 && Math.abs(dx) < dy / 2) {
        $("lightbox").close();
        return;
      }
    }
    if (event.touches.length !== 1) swipe = null;
    if (
      pinch && (!findTouch(event.touches, pinch.ids[0]) ||
        !findTouch(event.touches, pinch.ids[1]))
    ) pinch = null;
    if (touchDrag && !findTouch(event.touches, touchDrag.id)) touchDrag = null;
    if (!pinch && !touchDrag && event.touches.length === 1 && scale > 1) {
      const touch = event.touches[0];
      touchDrag = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    }
  }
  $("lightbox-stage").addEventListener("touchend", endTouch);
  $("lightbox-stage").addEventListener("touchcancel", endTouch);
  $("lightbox-close").addEventListener("click", () => $("lightbox").close());
  $("lightbox").addEventListener("click", (event) => {
    // At normal size the dark space around the picture closes the viewer,
    // like the margin; the picture itself and the toolbar do not, nor the end
    // of a drag. Zoomed in, the space is where you double-click back to size.
    const backdrop = event.target === $("lightbox") ||
      event.target === $("lightbox-stage");
    if (backdrop && !gestureMoved && scale <= 1) $("lightbox").close();
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
  const deferredPreviews = new Map();
  function visiblePreviewIds() {
    const list = $("messages"), area = list.getBoundingClientRect();
    const visible = new Set();
    for (const image of list.querySelectorAll(".message-row img.media-image")) {
      const rect = image.getBoundingClientRect();
      if (
        rect.width > 0 && rect.height > 0 && rect.bottom > area.top &&
        rect.top < area.bottom && rect.right > area.left &&
        rect.left < area.right
      ) {
        const id = image.closest(".message-row")?.dataset.messageId;
        if (id) visible.add(id);
      }
    }
    return visible;
  }
  function deferPreview(id, chat) {
    deferredPreviews.set(id, chat);
  }
  function retryDeferredPreviews() {
    if (!deferredPreviews.size) return;
    for (const node of $("messages").querySelectorAll(".media-placeholder")) {
      const id = node.dataset.messageId, chat = node.dataset.chat;
      if (deferredPreviews.get(id) !== chat || chat !== model.active) continue;
      deferredPreviews.delete(id);
      previewObserver.observe(node);
    }
  }
  $("messages").addEventListener("scroll", retryDeferredPreviews);
  globalThis.addEventListener("resize", retryDeferredPreviews);
  globalThis.visualViewport?.addEventListener("resize", retryDeferredPreviews);
  // A post notification: its note picture when the daemon can fetch one,
  // and a link that hands the post to the LINE app (a browser cannot show it).
  function addPost(bubble, message, chat) {
    if (message.decryptFailed || !message.postEvent) return;
    if (message.previewable) {
      const id = String(message.id),
        path = model.previews.get(id) || message.mediaPath;
      if (path) {
        const url = fileUrl(path),
          image = safeImage(url, "media-image", t("image"));
        clickableImage(
          image,
          chat,
          message,
          url,
          JSON.stringify(["post", id]),
        );
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
    const url = lineUrl(message.postEvent.url);
    if (url) {
      const link = el("a", "post-link", t("openInLine"));
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      bubble.append(link);
    }
  }
  // The daemon only sends line.me/R/ links; check again before rendering one.
  function lineUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" && url.host === "line.me" &&
          url.pathname.startsWith("/R/")
        ? url.href
        : "";
    } catch {
      return "";
    }
  }
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
    if (type === "POSTNOTIFICATION") {
      addPost(bubble, message, chat);
      return;
    }
    if (!["IMAGE", "VIDEO", "FILE", "AUDIO"].includes(type)) return;
    if (state !== "ok") {
      bubble.append(el("div", "muted", t("mediaExpired")));
      return;
    }
    if (type === "AUDIO") {
      if (message.hasMedia) addVoice(bubble, message, chat);
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
      const mark = el("span", "file-icon");
      mark.append(icon(type === "VIDEO" ? "play" : "download"));
      card.append(mark, info, button);
      bubble.append(card);
    }
  }
  // A blob URL plays without range requests, which iOS Safari needs for
  // /api/file, and keeps the auth cookie on a same-origin fetch.
  async function audioSource(chat, message) {
    const account = model.account;
    const key = originalKey(account, chat, message);
    const cached = audioUrls.get(key);
    if (cached) return cached;
    const path = await requestOriginal(account, chat, message, null).promise;
    const response = await fetch(fileUrl(path));
    if (!response.ok) throw new Error(t("mediaFailed"));
    const bytes = await response.arrayBuffer();
    const type = response.headers.get("content-type") === "video/mp4"
      ? "audio/mp4"
      : "";
    const url = URL.createObjectURL(new Blob([bytes], type ? { type } : {}));
    audioUrls.set(key, url);
    if (audioUrls.size > AUDIO_URL_MAX) {
      const [oldest, old] = audioUrls.entries().next().value;
      audioUrls.delete(oldest);
      URL.revokeObjectURL(old);
    }
    return url;
  }
  function addVoice(bubble, message, chat) {
    const card = el("div", "voice-card");
    const length = el(
      "span",
      "voice-length",
      message.audioMs ? durationText(message.audioMs) : "",
    );
    const play = el("button", "voice-play", t("playVoice"));
    play.type = "button";
    play.addEventListener("click", async () => {
      play.disabled = true;
      play.textContent = t("loading");
      try {
        const url = await audioSource(chat, message);
        if (!play.isConnected) return;
        const audio = el("audio", "voice-player");
        audio.controls = true;
        audio.preload = "metadata";
        audio.setAttribute("aria-label", t("voiceMessage"));
        audio.addEventListener("loadedmetadata", () => {
          if (!length.textContent && Number.isFinite(audio.duration)) {
            length.textContent = durationText(audio.duration * 1000);
          }
        });
        audio.src = url;
        const focused = document.activeElement === play;
        play.replaceWith(audio);
        if (focused) audio.focus({ preventScroll: true });
        audio.play().catch(() => {});
      } catch (error) {
        play.disabled = false;
        play.textContent = t("playVoice");
        displayError(error);
      }
    });
    card.append(play, length);
    bubble.append(card);
  }
  function unobservePreviews(row) {
    for (const node of row.querySelectorAll(".media-placeholder")) {
      previewObserver.unobserve(node);
      deferredPreviews.delete(node.dataset.messageId);
    }
  }
  return {
    addMedia,
    downloadMessage,
    unobservePreviews,
    refreshLightbox,
    visiblePreviewIds,
    deferPreview,
  };
}

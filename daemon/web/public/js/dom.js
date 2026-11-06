// Small DOM and display helpers; depends on the pure text segmenter.
import { avatarInitial, splitText } from "./text.js";
export const $ = (id) => document.getElementById(id);
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
/** A stroke icon from the sprite in index.html. */
export function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
export const fileUrl = (path, download = false, name = "") =>
  `/api/file?path=${encodeURIComponent(String(path))}${
    download ? "&download=1" : ""
  }${download && name ? `&name=${encodeURIComponent(String(name))}` : ""}`;
/** Minutes and seconds of a clip length in milliseconds. */
export function durationText(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total < 0) return "";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
export function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
const avatars = new WeakMap();
export function setAvatar(node, path, name) {
  const source = path ? String(path) : "";
  const previous = avatars.get(node);
  if (previous?.source === source) {
    previous.name = name;
    if (!previous.image || previous.image.parentNode !== node) {
      node.textContent = avatarInitial(name);
    }
    return;
  }
  const current = { source, name, image: null };
  avatars.set(node, current);
  node.replaceChildren();
  if (source) {
    const image = el("img");
    current.image = image;
    image.alt = "";
    image.loading = "lazy";
    image.src = fileUrl(source);
    image.addEventListener("error", () => {
      if (avatars.get(node) !== current) return;
      node.replaceChildren(
        document.createTextNode(avatarInitial(current.name)),
      );
    }, { once: true });
    node.append(image);
  } else node.textContent = avatarInitial(name);
}
export function formatTime(ms, english) {
  if (!Number(ms)) return "";
  const date = new Date(Number(ms)), now = new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString(english ? "en" : "zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
    })
    : date.toLocaleDateString(english ? "en" : "zh-TW", {
      month: "short",
      day: "numeric",
    });
}
export function safeImage(url, className, alt) {
  const image = el("img", className);
  image.alt = alt;
  image.loading = "lazy";
  image.src = url;
  return image;
}
export function sizeText(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
/**
 * `openMention(mid)` makes a person's mention a button, except for the mids in
 * `plain` (the reader, or the 1:1 chat already open).
 */
export function richText(text, mentions, openMention, plain = []) {
  const fragment = document.createDocumentFragment();
  for (const segment of splitText(text, mentions)) {
    let part = document.createTextNode(segment.text);
    if (
      segment.mid && openMention && !segment.url &&
      !plain.includes(segment.mid)
    ) {
      const button = el("button", "mention");
      button.type = "button";
      button.append(part);
      button.addEventListener("click", () => openMention(segment.mid));
      part = button;
    } else if (segment.mention) {
      const strong = el("strong", "mention");
      strong.append(part);
      part = strong;
    }
    if (segment.url) {
      const anchor = el("a");
      anchor.href = segment.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.append(part);
      part = anchor;
    }
    fragment.append(part);
  }
  return fragment;
}

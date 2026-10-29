// Small DOM and display helpers; depends on the pure text segmenter.
import { splitText } from "./text.js";
export const $ = (id) => document.getElementById(id);
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
export const fileUrl = (path, download = false) =>
  `/api/file?path=${encodeURIComponent(String(path))}${
    download ? "&download=1" : ""
  }`;
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
export function setAvatar(node, path, name) {
  node.replaceChildren();
  if (path) {
    const image = el("img");
    image.alt = "";
    image.src = fileUrl(path);
    image.addEventListener("error", () => {
      node.replaceChildren(
        document.createTextNode(
          String(name || "?").trim().slice(0, 1).toUpperCase() || "?",
        ),
      );
    }, { once: true });
    node.append(image);
  } else {node.textContent =
      String(name || "?").trim().slice(0, 1).toUpperCase() || "?";}
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
export function richText(text, mentions) {
  const fragment = document.createDocumentFragment();
  for (const segment of splitText(text, mentions)) {
    let part = document.createTextNode(segment.text);
    if (segment.mention) {
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

// Match media-send.ts: magic bytes take precedence over the upload name.
const extensions = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  heic: "image",
  heif: "image",
  avif: "image",
  gif: "gif",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
};
const imageBrands = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "avif",
  "avis",
];
const audioBrands = ["M4A ", "M4B ", "M4P ", "F4A ", "F4B "];

function tag(head, at, length) {
  if (head.length < at + length) return "";
  return String.fromCharCode(...head.subarray(at, at + length));
}

export function mediaKind(name, head) {
  const starts = (bytes) =>
    head.length >= bytes.length &&
    bytes.every((value, index) => head[index] === value);
  if (starts([0xff, 0xd8, 0xff])) return "image";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image";
  }
  if (["GIF87a", "GIF89a"].includes(tag(head, 0, 6))) return "gif";
  if (tag(head, 0, 4) === "RIFF") {
    if (tag(head, 8, 4) === "WEBP") return "image";
    if (tag(head, 8, 4) === "AVI ") return "video";
  } else if (tag(head, 4, 4) === "ftyp") {
    const brand = tag(head, 8, 4);
    if (brand) {
      if (imageBrands.includes(brand)) return "image";
      return audioBrands.includes(brand) ? "file" : "video";
    }
  } else if (starts([0x1a, 0x45, 0xdf, 0xa3])) return "video";

  // files.ts sanitizes and truncates the name before media-send sees it.
  const base = String(name || "image.png").split(/[\\/]/).pop();
  // deno-lint-ignore no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const safe = clean === "." || clean === ".." ? "" : clean;
  const uploaded = (safe || "file").slice(0, 200);
  const dot = uploaded.lastIndexOf(".");
  const extension = dot > 0 ? uploaded.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(extensions, extension) ? extensions[extension] : "file";
}

export function sizeRefusal(kind, size) {
  const image = kind === "image" || kind === "gif";
  const cap = image ? 20 * 1024 * 1024 : 1024 * 1024 * 1024;
  return size <= cap
    ? ""
    : image
    ? "imageTooLarge"
    : kind === "video"
    ? "videoTooLarge"
    : "fileTooLarge";
}

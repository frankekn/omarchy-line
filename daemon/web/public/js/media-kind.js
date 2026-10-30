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

const NAME_MAX_BYTES = 200;

function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

function utf8Prefix(text, max) {
  let bytes = 0, end = 0;
  for (const ch of text) {
    const point = ch.codePointAt(0) ?? 0;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + size > max) break;
    bytes += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

// files.ts sanitizes and truncates the name before media-send sees it; this
// is its uploadName, so the page predicts the same type.
function uploadedName(raw) {
  const base = raw.split(/[\\/]/).pop();
  // deno-lint-ignore no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const name = (clean === "." || clean === ".." ? "" : clean) || "file";
  if (utf8Length(name) <= NAME_MAX_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = utf8Prefix(name.slice(0, dot), NAME_MAX_BYTES - utf8Length(ext));
  return ext && stem ? stem + ext : utf8Prefix(name, NAME_MAX_BYTES);
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

  const uploaded = uploadedName(String(name || "image.png"));
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

/**
 * Files in and out of the state directory: /api/file reads the media cache and
 * the login QR, /api/upload stores what the browser sends so sendFile can
 * pick it up.
 *
 * Every path is resolved through symlinks before it is judged, so a link in
 * media/ cannot reach storage.json. A file is served inline only when its
 * bytes say image or MP4; anything else downloads, so a cached file can never
 * run as this origin's page.
 *
 * Dependency direction: imports only ./http.ts.
 */
import { FILE_CSP, json, securityHeaders, status } from "./http.ts";

const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const UPLOAD_MAX_AGE_MS = 24 * 3600 * 1000;
const UPLOAD_SWEEP_MS = 3600 * 1000;

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

/** Inside `realDir` after symlinks resolve; `realDir` must already be real. */
function inside(realDir: string, realPath: string): boolean {
  return realPath.startsWith(realDir + "/");
}

/** Type by content, so a cached download named .jpg cannot render as HTML. */
export function sniffInline(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    return "video/mp4";
  }
  return null;
}

/** One path component a user picked, safe to create under the upload dir. */
export function uploadName(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // deno-lint-ignore no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const name = clean === "." || clean === ".." ? "" : clean;
  return (name || "file").slice(0, 200);
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${
    encodeURIComponent(name)
  }`;
}

/** GET /api/file?path=…[&download=1] */
export async function serveFile(stateDir: string, url: URL): Promise<Response> {
  const asked = url.searchParams.get("path");
  if (!asked || !asked.startsWith("/")) return status(404);
  const [real, realState, realMedia] = await Promise.all([
    realOrNull(asked),
    realOrNull(stateDir),
    realOrNull(`${stateDir}/media`),
  ]);
  if (!real || !realState || !realMedia) return status(404);
  const slash = real.lastIndexOf("/");
  const name = real.slice(slash + 1);
  const isQr = real.slice(0, slash) === realState &&
    /^qr-[0-9]+\.png$/.test(name);
  if (!isQr && !inside(realMedia, real)) return status(404);
  let file: Deno.FsFile;
  try {
    file = await Deno.open(real, { read: true });
  } catch {
    return status(404);
  }
  const info = await file.stat();
  if (!info.isFile) {
    file.close();
    return status(404);
  }
  const head = new Uint8Array(12);
  const n = await file.read(head) ?? 0;
  await file.seek(0, Deno.SeekMode.Start);
  const inline = n >= 12 ? sniffInline(head) : null;
  const headers = securityHeaders({
    "Content-Type": inline ?? "application/octet-stream",
    "Content-Length": String(info.size),
    "Cache-Control": "private, max-age=86400",
    "Content-Security-Policy": FILE_CSP,
  });
  if (url.searchParams.get("download") === "1" || !inline) {
    headers.set("Content-Disposition", contentDisposition(name));
  }
  return new Response(file.readable, { headers });
}

/**
 * media/web-uploads/<uuid>/<name>: one directory per upload, removed once
 * the daemon has answered the sendFile, or by the sweep a day later.
 */
export class Uploads {
  readonly dir: string;
  #timer: ReturnType<typeof setInterval> | undefined;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(stateDir: string): Promise<Uploads> {
    const dir = `${stateDir}/media/web-uploads`;
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    const uploads = new Uploads(await Deno.realPath(dir));
    await uploads.sweep();
    uploads.#timer = setInterval(() => void uploads.sweep(), UPLOAD_SWEEP_MS);
    return uploads;
  }

  close(): void {
    clearInterval(this.#timer);
  }

  /** POST /api/upload?name=…, body = the file's bytes. */
  async receive(req: Request, url: URL): Promise<Response> {
    if (!req.body) return status(400, "empty upload");
    const dir = `${this.dir}/${crypto.randomUUID()}`;
    await Deno.mkdir(dir, { mode: 0o700 });
    const path = `${dir}/${uploadName(url.searchParams.get("name"))}`;
    const file = await Deno.open(path, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    let size = 0;
    try {
      for await (const chunk of req.body) {
        size += chunk.length;
        if (size > UPLOAD_MAX_BYTES) throw new RangeError("too large");
        let off = 0;
        while (off < chunk.length) off += await file.write(chunk.subarray(off));
      }
    } catch (e) {
      file.close();
      await this.discard(path);
      return e instanceof RangeError
        ? status(413, "檔案太大（超過 1 GB）")
        : status(400, "上傳中斷");
    }
    file.close();
    if (size === 0) {
      await this.discard(path);
      return status(400, "empty upload");
    }
    return json({ path });
  }

  /** The real path when `path` is a file this server stored, else null. */
  async owned(path: unknown): Promise<string | null> {
    if (typeof path !== "string") return null;
    const real = await realOrNull(path);
    return real && inside(this.dir, real) ? real : null;
  }

  /** Remove the upload that `path` belongs to. */
  async discard(path: string): Promise<void> {
    const rest = path.slice(this.dir.length + 1);
    const id = rest.split("/")[0];
    if (!path.startsWith(this.dir + "/") || !id) return;
    await Deno.remove(`${this.dir}/${id}`, { recursive: true }).catch(() => {});
  }

  async sweep(): Promise<void> {
    try {
      for await (const entry of Deno.readDir(this.dir)) {
        const path = `${this.dir}/${entry.name}`;
        const info = await Deno.lstat(path).catch(() => null);
        const age = Date.now() - (info?.mtime?.getTime() ?? 0);
        if (age > UPLOAD_MAX_AGE_MS) {
          await Deno.remove(path, { recursive: true }).catch(() => {});
        }
      }
    } catch { /* the dir went away; nothing to sweep */ }
  }
}

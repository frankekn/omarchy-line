/** Optional owner login through the local Tailscale daemon, never HTTP headers. */
import { isIP } from "node:net";

const CACHE_MS = 15_000;
const MAX_ENTRIES = 128;
const MAX_PENDING = 8;
const LOOKUP_TIMEOUT_MS = 2_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only native tailnet addresses can identify a browser; no LAN or proxy IPs. */
export function tailnetIp(address: string): string | null {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
      ? address
      : null;
  }
  if (isIP(address) !== 6) return null;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return normalized.startsWith("fd7a:115c:a1e0:") ? normalized : null;
}

/** Reject shared/tagged nodes even if a user profile is present. */
export function ownsAddress(
  value: unknown,
  ip: string,
  login: string,
): boolean {
  if (!record(value) || !record(value.Node) || !record(value.UserProfile)) {
    return false;
  }
  const node = value.Node;
  if (
    node.IsTagged === true || node.MachineAuthorized === false ||
    (node.Tags !== undefined &&
      (!Array.isArray(node.Tags) || node.Tags.length !== 0))
  ) return false;
  return value.UserProfile.LoginName === login &&
    Array.isArray(node.Addresses) && node.Addresses.some((address: unknown) => {
      if (typeof address !== "string") return false;
      const [host, mask] = address.split("/");
      return tailnetIp(host) === ip &&
        mask === (isIP(host) === 4 ? "32" : "128");
    });
}

/** Bound execution and reap the child even when the local daemon is unavailable. */
export async function whois(ip: string): Promise<unknown> {
  const binary = Deno.build.os === "darwin"
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : "tailscale";
  try {
    const child = new Deno.Command(binary, {
      args: ["whois", "--json", ip],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* The process may already have exited. */ }
    }, LOOKUP_TIMEOUT_MS);
    try {
      const output = await child.output();
      return output.success
        ? JSON.parse(new TextDecoder().decode(output.stdout))
        : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Missing CLI, permissions, invalid JSON and daemon failures require a key.
    return null;
  }
}

export class TailscaleAuth {
  readonly #cache = new Map<string, { until: number; allowed: boolean }>();
  readonly #pending = new Map<string, Promise<boolean>>();

  constructor(
    private readonly login: string,
    private readonly lookup: (ip: string) => Promise<unknown> = whois,
    private readonly now: () => number = Date.now,
  ) {}

  async signedIn(req: Request, remoteAddress?: string): Promise<boolean> {
    if (!this.login || !remoteAddress) return false;
    const ip = tailnetIp(remoteAddress);
    if (!ip) return false;
    // A proxy's address identifies the proxy, not the browser behind it.
    if (
      ["forwarded", "x-forwarded-for", "tailscale-user-login"].some((name) =>
        req.headers.has(name)
      )
    ) return false;
    const cached = this.#cache.get(ip);
    if (cached && cached.until > this.now()) return cached.allowed;
    const pending = this.#pending.get(ip);
    if (pending) return await pending;
    if (this.#pending.size >= MAX_PENDING) return false;
    const task = this.check(ip);
    this.#pending.set(ip, task);
    try {
      return await task;
    } finally {
      this.#pending.delete(ip);
    }
  }

  private async check(ip: string): Promise<boolean> {
    let allowed = false;
    try {
      allowed = ownsAddress(await this.lookup(ip), ip, this.login);
    } catch { /* A failed identity lookup never grants access. */ }
    if (this.#cache.size >= MAX_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(ip, { allowed, until: this.now() + CACHE_MS });
    return allowed;
  }
}

/**
 * Who may use the page: the web key, the cookie it buys, the cap on wrong
 * guesses, and the same-origin rule for anything that changes state.
 *
 * The model is magpie's. ENIL_WEB_KEY (16+ of A-Z a-z 0-9 - . _ ~) is the
 * key; without one a fresh key is minted per start. The cookie is derived from
 * the key, so it survives restarts and changing the key signs every browser
 * out. It is HttpOnly and SameSite=Strict, and lives 400 days.
 *
 * Dependency direction: a leaf; imports nothing.
 */

const KEY_RE = /^[A-Za-z0-9._~-]{16,}$/;
const COOKIE = "enil_web";
const COOKIE_MAX_AGE_S = 400 * 24 * 3600;
const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
const SIGNIN_MAX_FAILURES = 10;

export function usableKey(key: string | undefined): key is string {
  return key !== undefined && KEY_RE.test(key);
}

export function mintKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-")
    .replace(/\//g, "_").replace(/=+$/, "");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * A browser always sends Origin on a WebSocket handshake and on a POST fetch.
 * When it does, it must be this page's own; otherwise any site the user visits
 * could open the socket with the user's cookie. A client that sends no Origin
 * is not a browser and has no cookie to borrow.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    const target = new URL(req.url);
    const from = new URL(origin);
    const header = new URL(`${target.protocol}//${host}`);
    return from.origin === target.origin && from.href === `${from.origin}/` &&
      header.host === target.host && !header.username && !header.password &&
      header.pathname === "/" && !header.search && !header.hash;
  } catch {
    return false;
  }
}

export type SigninResult = "ok" | "wrong" | "blocked";
type SigninSource = "link" | "form";

export class WebAuth {
  readonly key: string;
  readonly #token: string;
  #failures: Record<SigninSource, number[]> = { link: [], form: [] };
  #now: () => number;

  private constructor(key: string, token: string, now: () => number) {
    this.key = key;
    this.#token = token;
    this.#now = now;
  }

  /** `key` when usable, a minted one otherwise. */
  static async create(
    key: string | undefined,
    now: () => number = Date.now,
  ): Promise<WebAuth> {
    const k = usableKey(key) ? key : mintKey();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`enil-web-cookie:${k}`),
    );
    const token = Array.from(
      new Uint8Array(digest),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    return new WebAuth(k, token, now);
  }

  signedIn(req: Request): boolean {
    const got = cookieValue(req, COOKIE);
    return got !== null && sameText(got, this.#token);
  }

  /** Count wrong link and form keys against separate caps. */
  signin(given: unknown, source: SigninSource): SigninResult {
    const failures = this.#failures[source], now = this.#now();
    const since = now - SIGNIN_WINDOW_MS;
    while (failures.length && failures[0] < since) {
      failures.shift();
    }
    if (failures.length >= SIGNIN_MAX_FAILURES) return "blocked";
    if (typeof given === "string" && sameText(given, this.key)) return "ok";
    failures.push(now);
    return "wrong";
  }

  signinCookie(): string {
    return `${COOKIE}=${this.#token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`;
  }

  signoutCookie(): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}

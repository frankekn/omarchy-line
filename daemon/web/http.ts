/**
 * Response helpers shared by every web route: the security headers each
 * answer carries, and the small status and JSON answers.
 *
 * Dependency direction: a leaf; imports nothing.
 */

/** The page's policy: its own scripts and styles only, no inline code. */
export const PAGE_CSP =
  "default-src 'self'; img-src 'self' https: data: blob:; " +
  "media-src 'self' blob:; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
  "form-action 'self'";

/** For files from the media cache: never a document of this origin. */
export const FILE_CSP = "default-src 'none'; sandbox";

export function securityHeaders(extra: HeadersInit = {}): Headers {
  const h = new Headers(extra);
  if (!h.has("Content-Security-Policy")) {
    h.set("Content-Security-Policy", PAGE_CSP);
  }
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return h;
}

export function status(code: number, body = ""): Response {
  return new Response(body || null, {
    status: code,
    headers: securityHeaders(
      body ? { "Content-Type": "text/plain; charset=utf-8" } : {},
    ),
  });
}

export function json(
  value: unknown,
  code = 200,
  extra: HeadersInit = {},
): Response {
  const headers = securityHeaders(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status: code, headers });
}

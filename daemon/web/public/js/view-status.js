// Daemon status in the settings dialog: read-only, from metadata state.json
// already carries. A field the daemon does not write is not shown; state.json
// has no daemon version, so there is no version row.
import { $, el } from "./dom.js";

const LOGIN_KEYS = {
  ok: "statusLoggedIn",
  idle: "statusLoggedOut",
  error: "statusLoginError",
};

/**
 * The rows to show, as [label key, value] pairs. Pure: `format` turns a ms
 * timestamp into text, `t` translates.
 * @param {object | null} state
 * @param {(key: string) => string} t
 * @param {(ms: number) => string} format
 * @returns {[string, string][]}
 */
export function statusRows(state, t, format) {
  if (!state || typeof state !== "object") return [];
  const rows = [];
  const time = (value) => {
    const ms = Number(value);
    return Number.isFinite(ms) && ms > 0 ? format(ms) : "";
  };
  const login = state.login && typeof state.login === "object"
    ? state.login
    : null;
  if (typeof login?.status === "string" && login.status) {
    let text = t(LOGIN_KEYS[login.status] || "statusLoggingIn");
    const name = state.me?.displayName;
    if (login.status === "ok" && typeof name === "string" && name) {
      text += ` (${name})`;
    }
    rows.push(["statusLogin", text]);
  }
  const link = state.link && typeof state.link === "object" ? state.link : null;
  if (link?.push === "up" || link?.push === "down") {
    let text = t(link.push === "up" ? "statusPushUp" : "statusPushDown");
    if (link.reason === "restricted") {
      text = `${t("statusPushHalted")} (${String(link.code || "?")})`;
    }
    const since = time(link.since);
    if (since) text += ` · ${t("statusSince")} ${since}`;
    rows.push(["statusPush", text]);
  }
  const refresh = state.refresh && typeof state.refresh === "object"
    ? state.refresh
    : null;
  const synced = time(refresh?.at);
  if (synced) rows.push(["statusSynced", synced]);
  const failures = Number(refresh?.failures);
  if (Number.isSafeInteger(failures) && failures >= 0) {
    const reason = failures > 0 && typeof refresh.reason === "string"
      ? ` (${refresh.reason})`
      : "";
    rows.push(["statusFailures", `${failures}${reason}`]);
  }
  const updated = time(state.updatedAt);
  if (updated) rows.push(["statusUpdated", updated]);
  return rows;
}

/**
 * A short status time: the clock alone for today, the month and day before
 * it for another day, and the year too for another year. Short enough that a
 * normal value fits on one line in the settings dialog.
 * @param {number} ms
 * @param {Date} now
 * @param {string} locale
 * @returns {string}
 */
export function statusTime(ms, now, locale) {
  const date = new Date(ms);
  /** @type {Intl.DateTimeFormatOptions} */
  const options = { hour: "numeric", minute: "2-digit" };
  if (date.toDateString() !== now.toDateString()) {
    options.month = "numeric";
    options.day = "numeric";
    if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  }
  return date.toLocaleString(locale, options);
}

export function createStatusView(ctx) {
  const model = ctx.model, t = ctx.t;
  const list = $("daemon-status-list"), section = $("daemon-status");
  const locale = ctx.english ? "en-US" : "zh-TW";
  function render() {
    const now = new Date();
    const rows = statusRows(
      model.state,
      t,
      (ms) => statusTime(ms, now, locale),
    );
    section.hidden = rows.length === 0;
    // One wrapper per pair, so a value that does not fit beside its label
    // moves below it instead of breaking.
    list.replaceChildren(
      ...rows.map(([key, value]) => {
        const row = el("div"), term = el("dt"), detail = el("dd");
        term.textContent = t(key);
        detail.textContent = value;
        row.append(term, detail);
        return row;
      }),
    );
  }
  // Rendered when the dialog opens; it does not poll while open.
  for (const id of ["settings-open", "corner-settings"]) {
    $(id).addEventListener("click", render);
  }
  return {};
}

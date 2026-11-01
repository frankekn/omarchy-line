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

export function createStatusView(ctx) {
  const model = ctx.model, t = ctx.t;
  const list = $("daemon-status-list"), section = $("daemon-status");
  const formatter = new Intl.DateTimeFormat(ctx.english ? "en-US" : "zh-TW", {
    dateStyle: "short",
    timeStyle: "medium",
  });
  function render() {
    const rows = statusRows(model.state, t, (ms) => formatter.format(ms));
    section.hidden = rows.length === 0;
    list.replaceChildren(
      ...rows.flatMap(([key, value]) => {
        const term = el("dt"), detail = el("dd");
        term.textContent = t(key);
        detail.textContent = value;
        return [term, detail];
      }),
    );
  }
  // Rendered when the dialog opens; it does not poll while open.
  $("settings-open").addEventListener("click", render);
  return {};
}

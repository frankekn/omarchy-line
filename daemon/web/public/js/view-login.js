// Authentication, LINE login and connection notices. Uses shared model and DOM
// helpers.
import { $, el, fileUrl, setAvatar } from "./dom.js";

export function createLoginView(ctx) {
  const model = ctx.model, t = ctx.t;
  function toast(message) {
    $("toast").textContent = String(message || t("genericError"));
    $("toast").hidden = false;
    ctx.scheduleToastHide(() => {
      $("toast").hidden = true;
    });
  }
  function displayError(error) {
    toast(error?.message || t("genericError"));
  }
  function renderNotices() {
    const notices = [], state = model.state;
    if (
      !model.connected ||
      (state?.updatedAt && Date.now() - Number(state.updatedAt) > 180000)
    ) notices.push(t("daemonOffline"));
    if (state?.link?.reason === "restricted") {
      const button = el(
        "button",
        "notice notice-action",
        `${t("restricted")} (${String(state.link.code || "?")}) — ${
          t(model.syncing ? "syncing" : "retrySync")
        }`,
      );
      button.type = "button";
      button.disabled = model.syncing;
      button.addEventListener("click", syncNow);
      notices.push(button);
    } else if (state?.link?.push === "down") {
      const button = el(
        "button",
        "notice notice-action",
        `${t("pushDown")} — ${t(model.syncing ? "syncing" : "retrySync")}`,
      );
      button.type = "button";
      button.disabled = model.syncing;
      button.addEventListener("click", syncNow);
      notices.push(button);
    }
    if (Number(state?.refresh?.failures || 0) >= 2) notices.push(t("stale"));
    $("notices").replaceChildren(
      ...notices.map((s) => typeof s === "string" ? el("div", "notice", s) : s),
    );
    $("notices").hidden = notices.length === 0;
  }
  async function syncNow() {
    if (model.syncing) return;
    model.syncing = true;
    $("sync").disabled = true;
    $("sync").textContent = t("syncing");
    renderNotices();
    try {
      const data = await ctx.command("sync");
      const at = Number(data?.at) || Date.now();
      toast(`${t("synced")} ${
        new Date(at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      }`);
      if (model.active) {
        ctx.loadHistory(model.active, ctx.isViewingChat(), true);
      }
    } catch (error) {
      displayError(error);
    } finally {
      model.syncing = false;
      $("sync").disabled = false;
      $("sync").textContent = t("sync");
      renderNotices();
    }
  }
  function connectionStatus(status) {
    $("connection-text").textContent = t(status);
    $("connection").classList.toggle("connected", status === "connected");
    renderNotices();
  }
  function renderLogin(state) {
    const login = state.login || { status: "idle" },
      loggedIn = login.status === "ok";
    $("workspace").hidden = !loggedIn;
    $("line-login").hidden = loggedIn;
    if (loggedIn) return;
    const text = login.status === "qr"
      ? t("lineQr")
      : login.status === "pin"
      ? t("linePin")
      : login.status === "error"
      ? `${t("lineError")} ${String(login.error || "")}`
      : login.status === "starting"
      ? t("lineStarting")
      : t("lineIdle");
    $("line-login-message").textContent = text;
    $("line-login-button").hidden = !["idle", "error"].includes(login.status);
    $("line-login-button").textContent = login.status === "error"
      ? t("lineRetry")
      : t("lineLogin");
    $("qr-image").hidden = login.status !== "qr" || !login.qrPng;
    if (!$("qr-image").hidden) $("qr-image").src = fileUrl(login.qrPng);
    $("login-pin").hidden = login.status !== "pin";
    $("login-pin").textContent = String(login.pin || "");
  }
  function renderAccount(me, account) {
    $("account-name").textContent = String(me?.displayName || account);
    setAvatar($("account-avatar"), "", me?.displayName || account);
  }
  function showApp() {
    $("signin-screen").hidden = true;
    $("app").hidden = false;
    ctx.start();
  }
  async function beginSession() {
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      if (response.ok && (await response.json()).signedIn === true) {
        showApp();
        return;
      }
    } catch { /* The sign-in screen also reports connection failures. */ }
    $("signin-screen").hidden = false;
  }
  $("signin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    $("signin-error").hidden = true;
    try {
      const response = await fetch("/api/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: $("web-key").value }),
      });
      if (response.status !== 204) {
        $("signin-error").textContent = response.status === 401
          ? t("invalidKey")
          : response.status === 429
          ? t("rateLimited")
          : t("signinFailed");
        $("signin-error").hidden = false;
        return;
      }
      $("web-key").value = "";
      showApp();
    } catch {
      $("signin-error").textContent = t("signinFailed");
      $("signin-error").hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  $("web-signout").addEventListener("click", async () => {
    try {
      const response = await fetch("/api/signout", { method: "POST" });
      if (!response.ok) throw new Error(t("genericError"));
      ctx.stop();
      location.href = "/";
    } catch (error) {
      displayError(error);
    }
  });
  $("line-login-button").addEventListener(
    "click",
    () => ctx.command("login").catch(displayError),
  );
  $("line-logout").addEventListener("click", () => {
    if (confirm(t("confirmLogout"))) ctx.command("logout").catch(displayError);
  });
  $("sync").addEventListener("click", syncNow);
  return {
    toast,
    displayError,
    renderNotices,
    connectionStatus,
    renderLogin,
    renderAccount,
    beginSession,
  };
}

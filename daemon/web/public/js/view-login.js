// Authentication, LINE login and connection notices. Uses shared model and DOM
// helpers.
import { $, el, fileUrl, setAvatar } from "./dom.js";

export function createLoginView(ctx) {
  const model = ctx.model, t = ctx.t;
  let noticeSignature = "";
  let webSessionExpired = false;
  let syncGeneration = 0, syncAccount = model.account;
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
    const offline = !model.connected ||
      Boolean(
        state?.updatedAt && Date.now() - Number(state.updatedAt) > 180000,
      );
    const restricted = state?.link?.reason === "restricted";
    const pushDown = !restricted && state?.link?.push === "down";
    const stale = Number(state?.refresh?.failures || 0) >= 2;
    const signature = webSessionExpired ? "expired" : JSON.stringify([
      offline,
      restricted,
      restricted ? state?.link?.code : "",
      pushDown,
      stale,
      model.syncing,
    ]);
    if (signature === noticeSignature) return;
    noticeSignature = signature;
    if (webSessionExpired) {
      const notice = el(
        "div",
        "notice",
        ctx.english
          ? "Your web session expired. Copy any draft before signing in again."
          : "網頁登入已失效。請先複製需要的草稿，再重新登入。",
      );
      const link = el(
        "a",
        "notice-action",
        ctx.english ? "Sign in again" : "重新登入",
      );
      link.href = "/";
      notice.append(link);
      $("notices").replaceChildren(notice);
      $("notices").hidden = false;
      return;
    }
    if (offline) notices.push(t("daemonOffline"));
    if (restricted) {
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
    } else if (pushDown) {
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
    if (stale) notices.push(t("stale"));
    $("notices").replaceChildren(
      ...notices.map((s) => typeof s === "string" ? el("div", "notice", s) : s),
    );
    $("notices").hidden = notices.length === 0;
  }
  async function syncNow() {
    if (model.syncing) return;
    const generation = ++syncGeneration, account = model.account;
    model.syncing = true;
    $("sync").disabled = true;
    $("sync").textContent = t("syncing");
    renderNotices();
    try {
      const data = await ctx.command("sync");
      if (generation !== syncGeneration || account !== model.account) return;
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
      if (generation === syncGeneration && account === model.account) {
        displayError(error);
      }
    } finally {
      if (generation === syncGeneration && account === model.account) {
        resetSync();
      }
    }
  }
  function resetSync() {
    model.syncing = false;
    $("sync").disabled = false;
    $("sync").textContent = t("sync");
    renderNotices();
  }
  function connectionStatus(status) {
    $("connection-text").textContent = webSessionExpired
      ? ctx.english ? "Sign-in required" : "需要重新登入"
      : t(status);
    $("connection").classList.toggle(
      "connected",
      !webSessionExpired && status === "connected",
    );
    renderNotices();
  }
  function renderLogin(state) {
    const login = state.login || { status: "idle" },
      loggedIn = login.status === "ok";
    if ($("workspace").hidden === loggedIn) $("workspace").hidden = !loggedIn;
    if ($("line-login").hidden !== loggedIn) $("line-login").hidden = loggedIn;
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
    if (account !== syncAccount) {
      syncAccount = account;
      syncGeneration++;
      if (model.syncing) resetSync();
    }
    const name = String(me?.displayName || account);
    if ($("account-name").textContent !== name) {
      $("account-name").textContent = name;
    }
    setAvatar($("account-avatar"), "", me?.displayName || account);
  }
  function showApp() {
    webSessionExpired = false;
    $("signin-screen").hidden = true;
    $("app").hidden = false;
    ctx.start();
  }
  async function beginSession() {
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      if (response.status !== 401) {
        if (!response.ok) throw new Error("session unavailable");
        const { signedIn } = await response.json();
        if (signedIn === true) {
          showApp();
          return;
        }
        if (signedIn !== false) throw new Error("invalid session response");
      }
    } catch {
      $("signin-error").textContent = t("signinFailed");
      $("signin-error").hidden = false;
    }
    $("signin-screen").hidden = false;
  }
  async function checkRejectedSession(signal) {
    const response = await fetch("/api/session", { cache: "no-store", signal });
    if (response.status === 401) return true;
    if (!response.ok) return false;
    return (await response.json())?.signedIn === false;
  }
  function sessionExpired() {
    webSessionExpired = true;
    connectionStatus("reconnecting");
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
    checkRejectedSession,
    sessionExpired,
  };
}

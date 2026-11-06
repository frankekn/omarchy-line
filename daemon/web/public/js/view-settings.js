// Settings dialog: font sizes, theme and the new-message sound. js/boot.js owns
// storage and applies the theme before the first paint; this view edits it.
import { $, el } from "./dom.js";

const THEME_NAMES = {
  "catppuccin": "Catppuccin",
  "catppuccin-latte": "Catppuccin Latte",
  "everforest": "Everforest",
  "flexoki-light": "Flexoki Light",
  "gruvbox": "Gruvbox",
  "kanagawa": "Kanagawa",
  "matte-black": "Matte Black",
  "nord": "Nord",
  "rose-pine": "Rosé Pine",
  "tokyo-night": "Tokyo Night",
};
// One chat sounds at most once in this window, so albums stay quiet.
const SOUND_GAP_MS = 2000;

export function createSettingsView(ctx) {
  const model = ctx.model, t = ctx.t;
  const store = globalThis.enilSettings;
  let settings = store.read();
  let audio = null;
  const lastSound = new Map();
  const dialog = $("settings");
  // The sidebar button, or the corner button while the sidebar is hidden.
  const openers = [$("settings-open"), $("corner-settings")];
  let opener = openers[0];

  function save() {
    store.apply(settings);
    if (!store.write(settings)) ctx.toast(t("settingsSaveFailed"));
  }
  function unlockAudio() {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) return;
    audio ??= new Context();
    // The toggle's click is the user gesture that lets audio start.
    audio.resume?.().catch(() => console.debug("[sound] resume failed"));
  }
  function beep() {
    if (!audio) unlockAudio();
    if (!audio) return;
    const now = audio.currentTime;
    const tone = audio.createOscillator(), gain = audio.createGain();
    tone.type = "sine";
    tone.frequency.setValueAtTime(880, now);
    tone.frequency.exponentialRampToValueAtTime(660, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    tone.connect(gain).connect(audio.destination);
    tone.start(now);
    tone.stop(now + 0.2);
  }
  /** Play the new-message sound for a live message from someone else. */
  function messageSound(chat, message) {
    if (!settings.sound || !message || message.from === model.account) return;
    if (
      chat === model.active && ctx.isViewingChat() && document.hasFocus()
    ) return;
    const row = model.chats.find((item) => String(item.mid) === chat);
    if (row?.hidden || row?.muted) return;
    const now = Date.now(), last = lastSound.get(chat);
    if (last !== undefined && now - last < SOUND_GAP_MS) return;
    lastSound.set(chat, now);
    beep();
  }

  function radio(group, name, value, text, checked, change) {
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = checked;
    input.addEventListener("change", change);
    const label = el("label");
    label.append(input, text);
    group.append(label);
  }
  const sizes = $("text-sizes");
  for (
    const [group, name, key] of [
      [sizes, "text-size", "textSize"],
      [$("message-text-sizes"), "message-text-size", "messageTextSize"],
    ]
  ) {
    for (const size of store.sizes) {
      radio(
        group,
        name,
        String(size),
        `${size}%`,
        size === settings[key],
        () => {
          settings = { ...settings, [key]: size };
          save();
        },
      );
    }
  }
  // Radios, not a <select>: WebKit reports a style-src-attr CSP violation
  // whenever a <select> element is created.
  const themes = $("themes");
  for (const id of ["system", ...store.themes]) {
    radio(
      themes,
      "theme",
      id,
      id === "system" ? t("themeSystem") : THEME_NAMES[id] || id,
      id === settings.theme,
      () => {
        settings = { ...settings, theme: id };
        save();
      },
    );
  }
  const sound = $("sound-toggle");
  sound.checked = settings.sound;
  sound.addEventListener("change", () => {
    settings = { ...settings, sound: sound.checked };
    if (settings.sound) unlockAudio();
    save();
  });

  function closeSettings() {
    if (!dialog.open) return;
    dialog.close();
    opener.focus();
  }
  for (const button of openers) {
    button.addEventListener("click", () => {
      opener = button;
      dialog.showModal();
      sizes.querySelector("input:checked")?.focus();
    });
  }
  $("settings-close").addEventListener("click", closeSettings);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeSettings();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSettings();
  });
  // Keep the app's global shortcuts away from the open dialog. Native controls
  // still get their default key handling.
  globalThis.addEventListener("keydown", (event) => {
    if (!dialog.open) return;
    event.stopPropagation();
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      closeSettings();
    }
  }, true);
  // A system theme follows the OS scheme, so keep theme-color in step.
  matchMedia("(prefers-color-scheme: light)").addEventListener(
    "change",
    () => store.apply(settings),
  );
  // Drag the sidebar's edge, or focus it and use the arrow keys. The width is
  // a setting like the font sizes; a double-click returns to the default.
  const resizer = $("sidebar-resizer"), sidebar = $("sidebar");
  const DEFAULT_SIDEBAR = 350;
  resizer.setAttribute(
    "aria-valuenow",
    String(settings.sidebarWidth ?? DEFAULT_SIDEBAR),
  );
  function setSidebarWidth(width, persist) {
    const room = $("workspace").clientWidth - 360;
    const next = Math.round(Math.max(240, Math.min(width, room)));
    settings.sidebarWidth = next;
    store.apply(settings);
    resizer.setAttribute("aria-valuenow", String(next));
    if (persist) save();
  }
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
  });
  resizer.addEventListener("pointermove", (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    setSidebarWidth(event.clientX - sidebar.getBoundingClientRect().left);
  });
  for (const type of ["pointerup", "pointercancel"]) {
    resizer.addEventListener(type, (event) => {
      if (!resizer.hasPointerCapture(event.pointerId)) return;
      resizer.releasePointerCapture(event.pointerId);
      resizer.classList.remove("dragging");
      save();
    });
  }
  resizer.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
    if (!step) return;
    event.preventDefault();
    setSidebarWidth(sidebar.getBoundingClientRect().width + step, true);
  });
  resizer.addEventListener("dblclick", () => {
    delete settings.sidebarWidth;
    resizer.setAttribute("aria-valuenow", String(DEFAULT_SIDEBAR));
    save();
  });
  resizer.addEventListener("focus", () => {
    const width = Math.round(sidebar.getBoundingClientRect().width);
    resizer.setAttribute("aria-valuenow", String(width));
  });

  return { messageSound, closeSettings };
}

// Settings dialog: text size, theme and the new-message sound. js/boot.js owns
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
  const dialog = $("settings"), opener = $("settings-open");

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
    if (model.chats.find((row) => String(row.mid) === chat)?.hidden) return;
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
  for (const size of store.sizes) {
    radio(
      sizes,
      "text-size",
      String(size),
      `${size}%`,
      size === settings.textSize,
      () => {
        settings = { ...settings, textSize: size };
        save();
      },
    );
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

  function close() {
    if (!dialog.open) return;
    dialog.close();
    opener.focus();
  }
  opener.addEventListener("click", () => {
    dialog.showModal();
    sizes.querySelector("input:checked")?.focus();
  });
  $("settings-close").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  // Keep the app's global shortcuts away from the open dialog. Native controls
  // still get their default key handling.
  globalThis.addEventListener("keydown", (event) => {
    if (!dialog.open) return;
    event.stopPropagation();
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      close();
    }
  }, true);
  // A system theme follows the OS scheme, so keep theme-color in step.
  matchMedia("(prefers-color-scheme: light)").addEventListener(
    "change",
    () => store.apply(settings),
  );
  return { messageSound };
}

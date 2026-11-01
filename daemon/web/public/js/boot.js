// Apply the saved theme and text size before the first paint. index.html loads
// this classic script synchronously in <head>; the page CSP forbids inline
// scripts. view-settings.js uses the same functions through enilSettings.
(() => {
  const KEY = "enil.settings";
  // [id, color scheme, theme-color]; the colors live in app.css.
  const THEMES = [
    ["catppuccin", "dark", "#1e1e2e"],
    ["catppuccin-latte", "light", "#eff1f5"],
    ["everforest", "dark", "#2d353b"],
    ["flexoki-light", "light", "#fffcf0"],
    ["gruvbox", "dark", "#282828"],
    ["kanagawa", "dark", "#1f1f28"],
    ["matte-black", "dark", "#121212"],
    ["nord", "dark", "#2e3440"],
    ["rose-pine", "light", "#faf4ed"],
    ["tokyo-night", "dark", "#1a1b26"],
  ];
  const SIZES = [85, 100, 115, 130, 150];
  const DEFAULTS = { theme: "system", textSize: 100, sound: false };
  function read() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch { /* Unreadable storage keeps the defaults. */ }
    return {
      theme: THEMES.some(([id]) => id === saved.theme)
        ? saved.theme
        : DEFAULTS.theme,
      textSize: SIZES.includes(saved.textSize)
        ? saved.textSize
        : DEFAULTS.textSize,
      sound: saved.sound === true,
    };
  }
  function apply(settings) {
    const root = document.documentElement;
    const theme = THEMES.find(([id]) => id === settings.theme);
    if (theme) root.dataset.theme = theme[0];
    else delete root.dataset.theme;
    if (settings.textSize === 100) delete root.dataset.textSize;
    else root.dataset.textSize = String(settings.textSize);
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.content = theme ? theme[1] : "dark light";
    const color = document.querySelector('meta[name="theme-color"]');
    if (color) {
      color.content = theme
        ? theme[2]
        : matchMedia("(prefers-color-scheme: light)").matches
        ? "#f9fbf7"
        : "#171c19";
    }
  }
  function write(settings) {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
      return true;
    } catch {
      return false;
    }
  }
  apply(read());
  globalThis.enilSettings = {
    themes: THEMES.map(([id]) => id),
    sizes: SIZES,
    read,
    apply,
    write,
  };
})();

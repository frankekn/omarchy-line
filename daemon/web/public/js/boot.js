// Apply the saved theme and font sizes before the first paint. index.html loads
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
  function textSize(value, fallback = DEFAULTS.textSize) {
    return SIZES.includes(value) ? value : fallback;
  }
  function read() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch { /* Unreadable storage keeps the defaults. */ }
    const interfaceSize = textSize(saved.textSize);
    return {
      theme: THEMES.some(([id]) => id === saved.theme)
        ? saved.theme
        : DEFAULTS.theme,
      textSize: interfaceSize,
      // Older browsers saved one size for the whole page. Keep that appearance
      // until the user chooses different interface and message sizes.
      messageTextSize: textSize(saved.messageTextSize, interfaceSize),
      sound: saved.sound === true,
      // Pixels from dragging the sidebar edge; undefined keeps the CSS
      // default and stays out of the saved JSON.
      sidebarWidth: Number.isInteger(saved.sidebarWidth) &&
          saved.sidebarWidth >= 200 && saved.sidebarWidth <= 1000
        ? saved.sidebarWidth
        : undefined,
    };
  }
  function apply(settings) {
    const root = document.documentElement;
    const theme = THEMES.find(([id]) => id === settings.theme);
    if (theme) root.dataset.theme = theme[0];
    else delete root.dataset.theme;
    const interfaceSize = textSize(settings.textSize);
    const messageSize = textSize(settings.messageTextSize, interfaceSize);
    if (interfaceSize === 100) delete root.dataset.textSize;
    else root.dataset.textSize = String(interfaceSize);
    if (messageSize === 100) delete root.dataset.messageTextSize;
    else root.dataset.messageTextSize = String(messageSize);
    if (settings.sidebarWidth) {
      root.style.setProperty("--sidebar-width", `${settings.sidebarWidth}px`);
    } else root.style.removeProperty("--sidebar-width");
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

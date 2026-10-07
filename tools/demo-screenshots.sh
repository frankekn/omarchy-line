#!/bin/bash
# Captures the README screenshots from the stub's demo fixtures.
#
#   tools/demo-screenshots.sh            # en and zh
#   tools/demo-screenshots.sh zh         # one locale
#
# Writes docs/images/panel-<locale>.png (the panel window only) and
# docs/images/bar-badge.png (the bar icon with its unread count).
#
# Needs a running Hyprland session (0.56+, Lua dispatchers) with omarchy-shell,
# plus quickshell, grim, hyprctl, jq, magick and python3. For each locale it
# starts the stub with
# `--fixture demo-<locale>` in a throwaway state dir and a second, throwaway
# shell next to yours, in a scratch HOME whose bar holds only this plugin
# (linked from this checkout) set to App window. That shell gets its own
# OMARCHY_PATH, a mirror of yours without the global shortcuts file, so it
# binds neither your shell's IPC socket nor its key bindings. Your config,
# state and daemon are never touched. Its bar shows up under yours for the
# few seconds it runs; only the panel window and the bar icon are captured.

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT=${DEMO_OUT:-$REPO/docs/images}
WIDTH=${DEMO_WIDTH:-1040}
HEIGHT=${DEMO_HEIGHT:-860}
MAX_BYTES=$((400 * 1024))
# Seconds for avatars, photos and the FLEX cards to load after the chat opens.
SETTLE=${DEMO_SETTLE:-4}
PLUGIN_ID=io.github.frankekn.line
SYSTEM_OMARCHY=${OMARCHY_PATH:-/usr/share/omarchy}

declare -A CHAT=([en]=cdemo-work [zh]=cdemo-family)
declare -A LANGUAGE=([en]=English [zh]=繁體中文)

die() { echo "demo-screenshots: $*" >&2; exit 1; }

for tool in quickshell grim hyprctl jq magick python3; do
  command -v "$tool" >/dev/null || die "needs $tool"
done
[[ -n ${HYPRLAND_INSTANCE_SIGNATURE:-} ]] || die "run this inside a Hyprland session"
[[ -d $SYSTEM_OMARCHY/shell ]] || die "no omarchy shell under $SYSTEM_OMARCHY"

locales=("$@")
(( ${#locales[@]} )) || locales=(en zh)
for loc in "${locales[@]}"; do
  [[ -n ${CHAT[$loc]:-} ]] || die "unknown locale $loc (en or zh)"
done

WORK=""
STUB_PID=""
SHELL_PID=""

stop() {
  local pid=$1
  [[ -n $pid ]] && kill "$pid" 2>/dev/null || return 0
  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  stop "$SHELL_PID"
  stop "$STUB_PID"
  # The shell's plugin watcher (inotifywait) outlives it; everything still
  # pointing into the work dir goes.
  [[ -n $WORK ]] && pkill -f -- "$WORK/" 2>/dev/null || true
  if [[ -n $WORK ]] && (( status )); then
    echo "demo-screenshots: kept $WORK for its logs" >&2
  elif [[ -n $WORK ]]; then
    rm -rf "$WORK"
  fi
  SHELL_PID="" STUB_PID="" WORK=""
}
trap cleanup EXIT

wait_for() {
  local what=$1 tries=$2
  shift 2
  for ((i = 0; i < tries; i++)); do
    "$@" && return 0
    sleep 0.25
  done
  die "timed out waiting for $what (log: $WORK/shell.log)"
}

# A copy of the omarchy tree made of symlinks, minus default/omarchy/shortcuts.
mirror_omarchy() {
  local dst=$1 entry
  mkdir -p "$dst/default/omarchy"
  for entry in "$SYSTEM_OMARCHY"/*; do
    [[ ${entry##*/} == default ]] || ln -s "$entry" "$dst/"
  done
  for entry in "$SYSTEM_OMARCHY"/default/*; do
    [[ ${entry##*/} == omarchy ]] || ln -s "$entry" "$dst/default/"
  done
  for entry in "$SYSTEM_OMARCHY"/default/omarchy/*; do
    [[ ${entry##*/} == shortcuts ]] || ln -s "$entry" "$dst/default/omarchy/"
  done
}

# Every first-party plugin except the bar is switched off: no second idle
# timer, lock screen, notification daemon or wallpaper.
shell_json() {
  local loc=$1
  jq -n \
    --arg id "$PLUGIN_ID" --arg lang "${LANGUAGE[$loc]}" \
    --argjson w "$WIDTH" --argjson h "$HEIGHT" \
    --argjson off "$(find "$SYSTEM_OMARCHY/shell/plugins" -name manifest.json \
      -exec cat {} + | jq -s '[.[] | select((.kinds | index("bar")) | not) | .id]')" '
    {
      version: 1,
      bar: {position: "top", layout: {left: [], center: [], right: [{
        id: $id, language: $lang, placement: "App window",
        windowWidth: $w, windowHeight: $h, textScale: 100,
        scrollSpeed: 100, historyPage: 60
      }]}},
      plugins: [],
      disabledPlugins: $off
    }'
}

scratch_home() {
  local home=$1 loc=$2 path
  mkdir -p "$home/.config/omarchy/plugins" "$home/.local/state" "$home/.local/share"
  shell_json "$loc" >"$home/.config/omarchy/shell.json"
  ln -s "$REPO" "$home/.config/omarchy/plugins/$PLUGIN_ID"
  # Theme, fonts and shell styling come from the real account, read-only.
  for path in .local/state/omarchy .config/omarchy/shell.toml .config/fontconfig .local/share/fonts; do
    [[ -e $HOME/$path ]] && ln -s "$HOME/$path" "$home/$path"
  done
}

# The plugin restarts enil.service when it thinks the daemon is down; here
# that would be your real daemon, so the demo shell gets a systemctl that
# does nothing.
demo_shell() {
  PATH=$WORK/bin:$PATH HOME=$WORK/home OMARCHY_PATH=$WORK/omarchy XDG_STATE_HOME=$WORK/state \
    XDG_CONFIG_HOME=$WORK/home/.config XDG_CACHE_HOME=$WORK/home/.cache \
    XDG_DATA_HOME=$WORK/home/.local/share "$@"
}

stub_call() {
  python3 - "$WORK/state/enil/sock" "$1" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
s.sendall(sys.argv[2].encode() + b"\n")
reply = s.makefile().readline()
if '"ok": true' not in reply:
    sys.exit("stub refused: " + reply)
PY
}

panel_window() {
  hyprctl clients -j | jq -e --argjson pid "$SHELL_PID" \
    'first(.[] | select(.pid == $pid and .title == "LINE"))'
}

line_slot() {
  demo_shell omarchy-shell shell debugBarGeometry 2>/dev/null |
    jq -e --arg id "$PLUGIN_ID" 'first(.[] | select(.id == $id and .visible))'
}

bar_layer() {
  hyprctl layers -j | jq -e --argjson pid "$SHELL_PID" \
    'first(.[].levels[][] | select(.pid == $pid and .namespace == "omarchy-bar"))'
}

window_sized() {
  panel_window | jq -e --argjson w "$WIDTH" --argjson h "$HEIGHT" \
    '.floating and .size == [$w, $h]' >/dev/null
}

# `poke` is the notification-click hand-off: the panel jumps to that chat. It
# is only taken once the panel is connected, so it is repeated until the
# panel's markRead for the chat shows up in the stub's state.
chat_opened() {
  stub_call "{\"cmd\":\"poke\",\"chat\":\"$1\"}" || return 1
  sleep 0.5
  jq -e --arg chat "$1" '.chats[] | select(.mid == $chat) | .unread == 0' \
    "$WORK/state/enil/state.json" >/dev/null
}

# Full colour while it fits the README budget, 256 colours past it: photos
# push a HiDPI capture over, and the dithering is not visible at that size.
capture() {
  local geometry=$1 path=$2
  grim -g "$geometry" "$path.raw.png"
  magick "$path.raw.png" -strip -define png:compression-level=9 "$path"
  if (( $(stat -c %s "$path") > MAX_BYTES )); then
    magick "$path.raw.png" -colors 256 -strip -define png:compression-level=9 "$path"
  fi
  rm -f "$path.raw.png"
  echo "wrote $path ($(du -k "$path" | cut -f1) KB)"
}

shoot() {
  local loc=$1 badge=$2 window addr geo bar slot
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/enil-demo-$loc.XXXXXX")
  mkdir -p "$WORK/state" "$WORK/bin"
  printf '#!/bin/sh\nexit 0\n' >"$WORK/bin/systemctl"
  chmod +x "$WORK/bin/systemctl"
  mirror_omarchy "$WORK/omarchy"
  scratch_home "$WORK/home" "$loc"

  XDG_STATE_HOME=$WORK/state python3 "$REPO/daemon/stub.py" --fixture "demo-$loc" \
    >"$WORK/stub.log" 2>&1 &
  STUB_PID=$!
  wait_for "the stub" 40 test -S "$WORK/state/enil/sock"

  # exec, so $! is quickshell itself and not a subshell around it.
  demo_shell exec quickshell -p "$WORK/omarchy/shell" >"$WORK/shell.log" 2>&1 &
  SHELL_PID=$!
  wait_for "the demo bar" 80 bar_layer >/dev/null
  wait_for "the LINE bar widget" 80 line_slot >/dev/null

  # Before the chat opens: opening it marks it read and the count drops. The
  # widget is up before it has read state.json, so give it a moment.
  sleep 1
  if [[ $badge == 1 ]]; then
    bar=$(bar_layer)
    slot=$(line_slot)
    geo=$(jq -rn --argjson bar "$bar" --argjson slot "$slot" '
      ([$bar.x + $bar.w - ($bar.x + $slot.x + $slot.width), $bar.h / 2 | floor]
        | min) as $pad
      | "\($bar.x + $slot.x - $pad),\($bar.y) \($slot.width + 2 * $pad)x\($bar.h)"')
    capture "$geo" "$OUT/bar-badge.png"
  fi

  demo_shell omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null
  window=$(wait_for "the panel window" 80 panel_window)
  addr=$(jq -r .address <<<"$window")
  hyprctl --batch "\
    dispatch hl.dsp.window.float({ action = 'enable', window = 'address:$addr' }); \
    dispatch hl.dsp.window.resize({ x = $WIDTH, y = $HEIGHT, window = 'address:$addr' }); \
    dispatch hl.dsp.window.center({ window = 'address:$addr' }); \
    dispatch hl.dsp.focus({ window = 'address:$addr' }); \
    dispatch hl.dsp.window.set_prop({ prop = 'opaque', value = '1', window = 'address:$addr' })" \
    >"$WORK/hyprctl.log"
  wait_for "the window to float at ${WIDTH}x$HEIGHT" 20 window_sized

  wait_for "the panel to open ${CHAT[$loc]}" 40 chat_opened "${CHAT[$loc]}"
  sleep "$SETTLE"
  geo=$(panel_window | jq -r '"\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"')
  capture "$geo" "$OUT/panel-$loc.png"
  cleanup
}

mkdir -p "$OUT"
badge=1
for loc in "${locales[@]}"; do
  shoot "$loc" "$badge"
  badge=0
done

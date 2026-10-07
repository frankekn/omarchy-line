#!/bin/sh
# Installs or refreshes the enil user service for this checkout. Safe to run
# after every `omarchy plugin update`, and from a fresh clone: each step
# converges on the same end state, so a rerun changes nothing but restarting
# the daemon onto the new sources.
#
#   1. vendored linejs at the pinned commit (submodule sync + update)
#   2. a Deno 2 on PATH or at ~/.deno/bin
#   3. ~/.config/systemd/user/enil.service matching daemon/enil.service
#   4. the unit enabled and (re)started
#
# The state dir (~/.local/state/enil: token, media, event ring) is the
# daemon's alone and is never touched here.
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin=$(CDPATH= cd -- "$dir/.." && pwd)
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/enil.service"
installed_plugin="$HOME/.config/omarchy/plugins/io.github.frankekn.line"

say() { printf 'enil install: %s\n' "$*"; }
die() { printf 'enil install: %s\n' "$*" >&2; exit 1; }

# 1. The vendored linejs. sync first: a plugin update can move the submodule
# URL, and update alone would keep fetching from the old one.
if git -C "$plugin" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$plugin" submodule sync --quiet --recursive
  git -C "$plugin" submodule update --init --recursive --quiet
  say "vendored linejs at $(git -C "$plugin" submodule status -- daemon/vendor/linejs | cut -c2-9)"
else
  [ -f "$dir/vendor/linejs/packages/linejs/client/mod.ts" ] \
    || die "not a git checkout and daemon/vendor/linejs is empty; clone with --recurse-submodules"
  say "not a git checkout; vendored linejs present"
fi

# 2. Deno 2. Same lookup order as enil-run.sh.
if deno=$(command -v deno 2>/dev/null) && [ -n "$deno" ]; then
  :
elif [ -x "$HOME/.deno/bin/deno" ]; then
  deno="$HOME/.deno/bin/deno"
else
  die "deno not found; install Deno 2 (sudo pacman -S deno) and rerun"
fi
version=$("$deno" --version 2>/dev/null | sed -n 's/^deno \([0-9][0-9.]*\).*/\1/p' | head -n 1)
[ -n "$version" ] || die "could not read a version from '$deno --version'"
case "$version" in
  1.*|0.*) die "deno $version found at $deno; the daemon needs Deno 2" ;;
esac
say "deno $version at $deno"

# 3. The unit file, copied only when it differs so daemon-reload runs only on
# a real change. The unit points at the installed plugin dir, not at this
# checkout; say so when they differ, because the service will not run these
# sources.
if [ "$plugin" != "$installed_plugin" ]; then
  say "note: the unit runs $installed_plugin, not $plugin"
fi
mkdir -p "$unit_dir"
if [ -f "$unit" ] && cmp -s "$dir/enil.service" "$unit"; then
  say "unit unchanged: $unit"
else
  cp "$dir/enil.service" "$unit"
  systemctl --user daemon-reload
  say "unit installed: $unit"
fi

# 4. Enabled, and restarted onto whatever just changed. restart starts a
# stopped unit too, so one verb covers first install and refresh alike.
systemctl --user enable --quiet enil.service
systemctl --user restart enil.service
say "enil.service enabled and restarted"

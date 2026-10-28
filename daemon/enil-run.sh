#!/bin/sh
# Prefer a compiled binary only when its source and binary fingerprints match.
# Keep the vendor gate before either execution path to avoid an import-error
# restart loop when the submodule is missing or at the wrong revision.
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin=$(CDPATH= cd -- "$dir/.." && pwd)
bin="$dir/enil"

# `git submodule status` prefixes "-" for a submodule never checked out and "+"
# for one checked out at a commit other than the one this checkout pins. Both
# mean the daemon would run against the wrong linejs. Outside a git checkout
# (a plugin copied by hand) the file the import map points at is the check.
if git -C "$plugin" rev-parse --git-dir >/dev/null 2>&1; then
  status=$(git -C "$plugin" submodule status -- daemon/vendor/linejs 2>/dev/null || echo "?")
  case "$status" in
    -*|+*|"?")
      echo "enil: daemon/vendor/linejs is missing or out of date (${status%% *}). Fix:" >&2
      echo "  git -C '$plugin' submodule sync --recursive" >&2
      echo "  git -C '$plugin' submodule update --init --recursive" >&2
      exit 78
      ;;
  esac
elif [ ! -f "$dir/vendor/linejs/packages/linejs/client/mod.ts" ]; then
  echo "enil: daemon/vendor/linejs is empty and this is not a git checkout;" \
    "reinstall the plugin or clone it with --recurse-submodules" >&2
  exit 78
fi

if [ -x "$bin" ] && [ -f "$bin.rev" ] \
    && fingerprint=$(sh "$dir/enil-fingerprint.sh" "$bin" 2>/dev/null) \
    && [ -n "$fingerprint" ] && [ "$(cat "$bin.rev")" = "$fingerprint" ]; then
  exec "$bin"
fi

# A user unit's PATH is systemd's, not the login shell's, so a deno installed
# by the upstream installer (~/.deno/bin) is looked for by hand after PATH.
if deno=$(command -v deno 2>/dev/null) && [ -n "$deno" ]; then
  :
elif [ -x "$HOME/.deno/bin/deno" ]; then
  deno="$HOME/.deno/bin/deno"
else
  echo "enil: deno not found on PATH or at ~/.deno/bin/deno;" \
    "install Deno 2 (sudo pacman -S deno) or run daemon/install.sh" >&2
  exit 127
fi

# The permission set, shared with `deno task build` (which bakes it into the
# binary); the flag-by-flag justification lives in enil-flags.sh.
. "$dir/enil-flags.sh"
# shellcheck disable=SC2086  # the flags are a word list on purpose
exec "$deno" run $ENIL_DENO_FLAGS "$dir/daemon.ts"

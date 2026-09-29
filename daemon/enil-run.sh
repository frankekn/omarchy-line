#!/bin/sh
# Prefer a compiled binary, but only one built from this exact checkout: the
# stamp written by `deno task build` stops matching after `omarchy plugin
# update`, and a stale binary must not shadow newer sources. A daemon.ts newer
# than the binary means the checkout was edited by hand -- same answer.
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bin="$dir/enil"
head=$(git -C "$dir/.." rev-parse HEAD 2>/dev/null || echo "")
if [ -n "$head" ] && [ -x "$bin" ] && [ -f "$bin.rev" ] \
    && [ "$(cat "$bin.rev")" = "$head" ] \
    && [ ! "$dir/daemon.ts" -nt "$bin" ]; then
  exec "$bin"
fi
exec /usr/bin/deno run -A "$dir/daemon.ts"

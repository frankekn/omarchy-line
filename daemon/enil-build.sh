#!/bin/sh
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd -- "$dir"

# A failed or interrupted compile must revoke even a previously valid stamp.
rm -f -- enil.rev
work=$(mktemp -d "$dir/.enil-build.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 1' HUP INT TERM
before=$(sh "$dir/enil-fingerprint.sh")
"$@" "$work/enil"
[ -x "$work/enil" ] || exit 1
after=$(sh "$dir/enil-fingerprint.sh" "$work/enil")
if [ "${after%:*}" != "$before" ]; then
  echo 'enil: sources changed during compilation; rebuild before using the binary' >&2
  exit 1
fi
printf '%s\n' "$after" > "$work/enil.rev"
mv -f -- "$work/enil" enil
mv -f -- "$work/enil.rev" enil.rev

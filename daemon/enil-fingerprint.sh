#!/bin/sh
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd -- "$dir"

# Runtime imports stay under daemon/. Include tests and vendor configs too,
# rather than maintain an import parser that can miss a newly added module.
for required in daemon.ts enil-flags.sh deno.json deno.lock; do
  [ -f "$required" ] || exit 1
done
work=$(mktemp -d "${TMPDIR:-/tmp}/.enil-fingerprint.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 1' HUP INT TERM

find . \( -name .git -o -name node_modules -o -name cache -o -name .cache \
  -o -name .deno -o -name .enil-build.\* -o -name .enil-fingerprint.\* \) \
  -prune -o -type l -print > "$work/links"
# Do not follow imports or config symlinks outside the fingerprinted tree.
[ ! -s "$work/links" ] || exit 1
find . \( -name .git -o -name node_modules -o -name cache -o -name .cache \
  -o -name .deno -o -name .enil-build.\* -o -name .enil-fingerprint.\* \) \
  -prune -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' \
  -o -name '*.cts' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \
  -o -name '*.cjs' -o -name '*.json' \
  -o -name '*.jsonc' -o -name '*.lock' -o -name '*.sh' -o -name '*.wasm' \) \
  -print0 > "$work/files"
LC_ALL=C sort -z "$work/files" > "$work/sorted"
xargs -0 sha256sum -- < "$work/sorted" > "$work/manifest"
sha256sum < "$work/manifest" > "$work/hash"
read -r source_hash rest < "$work/hash"
case "$source_hash" in ''|*[!0-9a-f]*) exit 1 ;; esac
[ "${#source_hash}" -eq 64 ] || exit 1

if [ "$#" -eq 1 ]; then
  sha256sum < "$1" > "$work/binary-hash"
  read -r binary_hash rest < "$work/binary-hash"
  case "$binary_hash" in ''|*[!0-9a-f]*) exit 1 ;; esac
  [ "${#binary_hash}" -eq 64 ] || exit 1
  printf 'enil-source-v1:%s:%s\n' "$source_hash" "$binary_hash"
else
  [ "$#" -eq 0 ] || exit 1
  printf 'enil-source-v1:%s\n' "$source_hash"
fi

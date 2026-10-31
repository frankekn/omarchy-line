#!/usr/bin/env bash
set -euo pipefail

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
shell_dir="${OMARCHY_PATH:-/usr/share/omarchy}/shell"

if lint_bin=$(command -v qmllint); then
  :
elif [[ -x /usr/lib/qt6/bin/qmllint ]]; then
  lint_bin=/usr/lib/qt6/bin/qmllint
else
  echo 'qmllint: install qt6-declarative or put qmllint on PATH' >&2
  exit 1
fi

for module in Commons Ui; do
  if [[ ! -f "$shell_dir/$module/qmldir" ]]; then
    echo "qmllint: missing $shell_dir/$module/qmldir; set OMARCHY_PATH to your Omarchy installation" >&2
    exit 1
  fi
done
shell_dir=$(CDPATH= cd -- "$shell_dir" && pwd)

lint_work=$(mktemp -d "${TMPDIR:-/tmp}/enil-qmllint.XXXXXXXX")
trap 'rm -rf -- "$lint_work"' EXIT
trap 'exit 1' HUP INT TERM
ln -s -- "$shell_dir" "$lint_work/qs"

"$lint_bin" -I "$lint_work" "$@" "$repo"/*.qml

#!/usr/bin/env bash
# Offscreen QML cases: key dispatch for the list view (Esc leaves the search
# box, L focuses 登出, Return/Space activate it) and the linkNotice
# binding-loop regression (U74), and the list-pane tool row staying inside
# its pane in both languages. Needs qmltestrunner from qt6-declarative;
# skips cleanly when it is absent so the suite stays runnable on a machine
# without the Qt test tooling.
#
#   tests/qml/keytest/run.sh
set -u
# ${0%/*} rather than dirname(1): the whole point of the skip below is to work
# on a bare machine, so the script should not need coreutils on PATH either.
case "$0" in */*) cd "${0%/*}" || exit 1 ;; esac

runner=""
for c in qmltestrunner qmltestrunner6 qmltestrunner-qt6; do
  if command -v "$c" >/dev/null 2>&1; then runner="$c"; break; fi
done
if [ -z "$runner" ]; then
  echo "SKIP: qmltestrunner not found (install qt6-declarative to run the key tests)"
  exit 0
fi

# QT_QUICK_BACKEND=software: render the scene graph in software so the test
# never needs an OpenGL context. Offscreen GL rides on GLX/Xwayland and can
# fail transiently under memory pressure, which qFatals the whole runner
# (SIGABRT in QSGRenderLoop::handleContextCreationFailure).
#
# The output is captured and grepped: qmltestrunner is QtTest without
# failOnWarning(), so a `Binding loop detected` QWARN passes every compare()
# and the exit code -- the warning in the transcript is the only place the
# regression shows. No coreutils here either, same as the dirname note above.
status=0
for t in tst_logout_key.qml tst_link_notice.qml tst_toolbar_fit.qml; do
  out=$(QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software "$runner" -input "$t" 2>&1)
  rc=$?
  printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then status="$rc"; fi
  case "$out" in *"Binding loop"*)
    echo "FAIL: binding loop detected in $t"
    status=1 ;;
  esac
done
exit "$status"

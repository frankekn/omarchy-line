# The daemon's Deno permission set, one place for both launchers: enil-run.sh
# sources this before `deno run`, and `deno task build` sources it before
# `deno compile`, so the compiled binary and the source run can never drift.
# permissions_test.ts boots daemon.ts with exactly this set.
#
# Sourced, not executed: it sets ENIL_STATE_DIR and ENIL_DENO_FLAGS.
#
#   --allow-net      Broad on purpose. LINE's hosts alone would do for talk and
#                    push, but FLEX messages and link previews fetch images
#                    from whatever https URL the message carries
#                    (imagecache.ts), and that set is not knowable in advance.
#   --allow-read     Broad on purpose. "Send this file" takes any path the
#                    user picks in the panel, and the thumbnailer reads it
#                    wherever it is.
#   --allow-write    The state dir only: state.json, the socket, the lock,
#                    the session token store, decrypted media and avatars.
#                    Every temp file the daemon makes lives under it too
#                    (imagecache.ts downloads into its own dir), so there is
#                    no /tmp entry. The dir is computed here the same way
#                    modules/env.ts computes it. A compiled binary bakes the
#                    dir of the environment `deno task build` ran in; move
#                    XDG_STATE_HOME afterwards and the binary cannot write
#                    the new dir, so rebuild (enil-run.sh falls back to
#                    `deno run` only when the rev stamp is stale).
#   --allow-run      Exactly the six binaries the daemon spawns: dbus-monitor
#                    (watchdog.ts, suspend/resume), wl-paste (clipboard.ts),
#                    ffmpegthumbnailer and ffmpeg (video.ts), omarchy-shell
#                    and notify-send (notify.ts).
#   --allow-env      The variables modules/env.ts reads, plus the two the npm
#                    dependencies read through Node's process.env shim, which
#                    throws NotCapable for an unlisted name rather than
#                    answering undefined: Q_DEBUG (q, loaded by thrift at
#                    import, so the daemon does not boot without it) and
#                    NODE_DEBUG (pngjs, reached when qrcode writes the login
#                    PNG). Deno's own DENO_* settings need no permission.
#                    undici reads more, but linejs only loads undici under
#                    Node (base/core/node_fetch.ts), never under Deno.
#   no --allow-sys   Booting, the QR PNG and the thrift codec raised no
#                    NotCapable for a sys API under this set; if a dependency
#                    ever needs one, permissions_test.ts fails with its name.
ENIL_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/enil"
ENIL_DENO_FLAGS="--allow-net \
--allow-read \
--allow-write=$ENIL_STATE_DIR \
--allow-run=dbus-monitor,wl-paste,ffmpegthumbnailer,ffmpeg,omarchy-shell,notify-send \
--allow-env=HOME,XDG_STATE_HOME,ENIL_DEVICE,ENIL_INCREMENTAL,ENIL_CHAT_LIMIT,ENIL_PUSH_STALE_MS,ENIL_REQUEST_TIMEOUT_MS,Q_DEBUG,NODE_DEBUG"

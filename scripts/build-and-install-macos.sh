#!/usr/bin/env bash
#
# Build CC Switch, and optionally install it over the copy in /Applications.
#
# Usage:
#   scripts/build-and-install-macos.sh [--jobs N] [--install] [--no-open]
#
# Building is the default and stops there. Installing is opt-in via --install
# because it quits the running app and overwrites /Applications/CC Switch.app —
# which kills any session (including an agent) being served by that app. Run it
# without --install from inside the app; run it with --install from a terminal
# that does not depend on the running app.
#
# Only the .app bundle is produced (--bundles app). The DMG step is slow and
# leaves rw.* staging files behind, and neither is needed for a local install.
#
# Concurrency defaults to 2 so a many-core machine does not spin up one rustc
# job per core and heat up during the build. Override with --jobs or $BUILD_JOBS.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

JOBS="${BUILD_JOBS:-2}"
DO_INSTALL=0
OPEN_AFTER=1
SRC="src-tauri/target/release/bundle/macos/CC Switch.app"
APP_BIN="$SRC/Contents/MacOS/cc-switch"
DST="/Applications/CC Switch.app"
RUNNING_PATTERN="CC Switch.app/Contents/MacOS/cc-switch"

while [ $# -gt 0 ]; do
  case "$1" in
    --jobs) JOBS="${2:?--jobs needs a value}"; shift 2 ;;
    --jobs=*) JOBS="${1#*=}"; shift ;;
    --install) DO_INSTALL=1; shift ;;
    --no-open) OPEN_AFTER=0; shift ;;
    # Print the header comment block, so it stays in sync as the header is edited.
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || { echo "this script is macOS-only" >&2; exit 1; }

BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/cc-switch-build.XXXXXX")"
trap 'rm -f "$BUILD_LOG"' EXIT

# ---------------------------------------------------------------- build ------
# Launching the bundle straight out of target/ (rather than /Applications) would
# make the build fail with a bare "Text file busy" when it tries to overwrite the
# running executable. Name that case up front.
if pgrep -f "^$REPO_ROOT/src-tauri/target/release/cc-switch" >/dev/null 2>&1; then
  echo "error: the build output itself is running; quit that instance first" >&2
  exit 1
fi

echo "==> Building (concurrency: $JOBS)"
BUILD_STARTED_AT="$(date +%s)"

set +e
CARGO_BUILD_JOBS="$JOBS" \
MAKEFLAGS="-j$JOBS" \
CMAKE_BUILD_PARALLEL_LEVEL="$JOBS" \
  pnpm tauri build --bundles app 2>&1 | tee "$BUILD_LOG"
BUILD_STATUS="${PIPESTATUS[0]}"
set -e

if [ "$BUILD_STATUS" -ne 0 ]; then
  # `tauri build` signs updater artifacts as its last step and fails without
  # TAURI_SIGNING_PRIVATE_KEY. That happens *after* the .app is bundled, so an
  # updater-signing failure is not a build failure — anything else is.
  if grep -q "TAURI_SIGNING_PRIVATE_KEY" "$BUILD_LOG"; then
    echo "==> Updater signing skipped (no TAURI_SIGNING_PRIVATE_KEY); the .app itself is complete"
  else
    echo "error: build failed — see output above" >&2
    exit "$BUILD_STATUS"
  fi
fi

# ------------------------------------------------------------- verify --------
if [ ! -x "$APP_BIN" ]; then
  echo "error: bundle is missing or not executable: $APP_BIN" >&2
  exit 1
fi
# Guard against installing a leftover artifact when the build died before
# reaching the bundling step. `date -r` rather than `stat -f %m`: the stat on
# PATH may be GNU coreutils (where -f means "file system", not "format"), and
# only BSD stat understands -f %m.
if [ "$(date -r "$APP_BIN" +%s)" -lt "$BUILD_STARTED_AT" ]; then
  echo "error: bundled binary predates this build, refusing to install a stale artifact" >&2
  exit 1
fi
echo "==> Built $(ls -lh "$APP_BIN" | awk '{print $5}') $(basename "$APP_BIN")"

# --------------------------------------------------------- build only --------
# The default stop. Nothing below this point touches the installed app, so the
# build is safe to run from inside a session the app is serving.
if [ "$DO_INSTALL" -eq 0 ]; then
  echo "==> Build only, $DST was left untouched"
  echo "    to install, run this again with --install from a terminal that does not"
  echo "    depend on the running app (it quits the app before overwriting)"
  exit 0
fi

# ------------------------------------------------------------ install --------
[ -d "$DST" ] || echo "note: $DST does not exist yet, this will be a fresh install"
echo "==> Quitting the running instance"
osascript -e 'tell application "CC Switch" to quit' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5; do
  pgrep -f "$RUNNING_PATTERN" >/dev/null || break
  sleep 1
done
if pgrep -f "$RUNNING_PATTERN" >/dev/null; then
  echo "    quit was not honoured, sending TERM"
  pkill -f "$RUNNING_PATTERN" || true
  sleep 2
fi
if pgrep -f "$RUNNING_PATTERN" >/dev/null; then
  echo "error: the old instance is still running, refusing to overwrite it" >&2
  exit 1
fi

echo "==> Installing over $DST"
# rm first: `ditto` merges into an existing bundle, which would leave stale
# files behind from the previous install. ditto (not cp -R) preserves symlinks
# and permission bits.
rm -rf "$DST"
ditto "$SRC" "$DST"
cmp -s "$SRC/Contents/MacOS/cc-switch" "$DST/Contents/MacOS/cc-switch" \
  || { echo "error: installed binary differs from the build output" >&2; exit 1; }
echo "    installed $(defaults read "$DST/Contents/Info.plist" CFBundleShortVersionString)"
codesign -v "$DST" 2>/dev/null && echo "    signature: valid" \
  || echo "    signature: unsigned/ad-hoc (normal for a local build)"

# --------------------------------------------------------------- launch ------
if [ "$OPEN_AFTER" -eq 1 ]; then
  echo "==> Launching"
  open -a "CC Switch"
  sleep 4
  if pgrep -f "$RUNNING_PATTERN" >/dev/null; then
    echo "    running, PID $(pgrep -f "$RUNNING_PATTERN" | tr '\n' ' ')"
  else
    echo "    warning: no running instance detected" >&2
  fi
fi

echo "==> Done"

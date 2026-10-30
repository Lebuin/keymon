#!/bin/bash
# Runs a nested GNOME Shell in a window, for quick iteration without a logout.
# Log lines appear in this terminal. It uses your real dconf settings, so your
# other enabled extensions load in it too.
set -euo pipefail

export MUTTER_DEBUG_DUMMY_MODE_SPECS="${MUTTER_DEBUG_DUMMY_MODE_SPECS:-1600x900}"
exec dbus-run-session -- gnome-shell --nested --wayland

#!/bin/bash
# Removes keymon. See SPEC.md section 13. It leaves ~/.config/keymon and the
# python3-evdev package in place. The steps marked sudo remove the helper's access
# to the keyboards.
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
uuid="keymon@local"
target="$HOME/.local/share/gnome-shell/extensions/$uuid"

if [ "$(id -u)" -eq 0 ]; then
    echo "Run this as your own user, not as root. It calls sudo where it needs to." >&2
    exit 1
fi
# Checked before anything changes, as install.sh does.
if [ -L "$target" ] && [ "$(readlink -f "$target")" != "$repo/extension" ]; then
    echo "Refusing to remove $target: it is a symlink to somewhere else" >&2
    exit 1
fi

current="$(gsettings get org.gnome.shell enabled-extensions)"
updated="$(python3 -c '
import ast, sys
items = ast.literal_eval(sys.argv[1].removeprefix("@as "))
print([item for item in items if item != sys.argv[2]])
' "$current" "$uuid")"
gsettings set org.gnome.shell enabled-extensions "$updated"
dconf reset -f /org/gnome/shell/extensions/keymon/

if [ -L "$target" ]; then
    # A development link goes, and the repo it points to stays.
    rm "$target"
    rm -f "$repo/extension/schemas/gschemas.compiled"
else
    rm -rf "$target"
fi

# sudo: the helper and its units.
sudo systemctl disable --now keymon.socket 2>/dev/null || true
sudo systemctl stop keymon.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/keymon.socket /etc/systemd/system/keymon.service
sudo rm -rf /usr/local/lib/keymon
sudo systemctl daemon-reload
sudo systemctl reset-failed keymon.socket keymon.service 2>/dev/null || true

echo "Uninstalled. Log out and back in so GNOME Shell unloads the extension."
echo "Your config is still in ~/.config/keymon."
echo "python3-evdev is still installed. To remove it: sudo apt-get remove python3-evdev"

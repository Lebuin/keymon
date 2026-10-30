#!/bin/bash
# Installs keymon. See SPEC.md section 13. The steps marked sudo give the helper
# read access to all keyboards while keymon is on.
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
uuid="keymon@local"
target="$HOME/.local/share/gnome-shell/extensions/$uuid"
user="$(id -un)"

if [ "$(id -u)" -eq 0 ]; then
    echo "Run this as your own user, not as root. It calls sudo where it needs to." >&2
    exit 1
fi
case "$(gnome-shell --version)" in
    "GNOME Shell 46"*) ;;
    *) echo "keymon needs GNOME Shell 46, found: $(gnome-shell --version)" >&2; exit 1 ;;
esac
if [ "${XDG_SESSION_TYPE:-}" != "wayland" ]; then
    echo "keymon needs a Wayland session, found: ${XDG_SESSION_TYPE:-unknown}" >&2
    exit 1
fi
# Checked before sudo runs, so a bad symlink changes nothing.
if [ -L "$target" ] && [ "$(readlink -f "$target")" != "$repo/extension" ]; then
    echo "Refusing to replace $target: it is a symlink to somewhere else" >&2
    exit 1
fi

# sudo: the helper's only dependency.
sudo apt-get install -y python3-evdev

# sudo: the helper and its units. A running helper would keep its old code.
sudo systemctl stop keymon.socket keymon.service 2>/dev/null || true
sudo install -d -m 0755 /usr/local/lib/keymon
sudo install -m 0755 "$repo/helper/keymon-helper" /usr/local/lib/keymon/keymon-helper
sudo install -m 0644 "$repo/helper/keymon.service" /etc/systemd/system/keymon.service
sed "s/@USER@/$user/" "$repo/helper/keymon.socket" \
    | sudo tee /etc/systemd/system/keymon.socket >/dev/null
sudo chmod 0644 /etc/systemd/system/keymon.socket
sudo systemctl daemon-reload
sudo systemctl enable --now keymon.socket

if [ -L "$target" ]; then
    # A development link from dev/link-extension.sh stays, so repo edits keep applying.
    glib-compile-schemas "$repo/extension/schemas"
    echo "Kept the development link at $target"
else
    mkdir -p "$(dirname "$target")"
    rm -rf "$target"
    cp -r "$repo/extension" "$target"
    glib-compile-schemas "$target/schemas"
fi

current="$(gsettings get org.gnome.shell enabled-extensions)"
updated="$(python3 -c '
import ast, sys
items = ast.literal_eval(sys.argv[1].removeprefix("@as "))
if sys.argv[2] not in items:
    items.append(sys.argv[2])
print(items)
' "$current" "$uuid")"
gsettings set org.gnome.shell enabled-extensions "$updated"

echo "Installed. Log out and back in so GNOME Shell loads the extension."

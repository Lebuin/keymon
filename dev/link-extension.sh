#!/bin/bash
# Development install: symlinks the extension into place, compiles its schema,
# and adds it to GNOME's enabled list. The running Shell only loads it after a
# logout; a nested session (dev/nested.sh) picks it up straight away.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
uuid="keymon@local"
target="$HOME/.local/share/gnome-shell/extensions/$uuid"

glib-compile-schemas "$repo/extension/schemas"

if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "Refusing to replace $target: it is not a symlink" >&2
    exit 1
fi
ln -sfn "$repo/extension" "$target"

current="$(gsettings get org.gnome.shell enabled-extensions)"
updated="$(python3 -c '
import ast, sys
raw = sys.argv[1].removeprefix("@as ")
items = ast.literal_eval(raw)
if sys.argv[2] not in items:
    items.append(sys.argv[2])
print(items)
' "$current" "$uuid")"
gsettings set org.gnome.shell enabled-extensions "$updated"

echo "Linked $target"

#!/bin/sh
# Installs the extension for the current user (symlink to this folder).
set -e
UUID=claude-usage@bombonato
SRC=$(cd "$(dirname "$0")" && pwd)
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"
python3 "$SRC/po/i18n.py" compile >/dev/null
mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "There is already an installation at $DEST (not a symlink). Remove it first." >&2
    exit 1
fi
ln -sfn "$SRC" "$DEST"
echo "Installed at $DEST"
echo
echo "On Wayland, GNOME Shell only sees new extensions after you log out and back in."
echo "After logging in, enable it with:"
echo "  gnome-extensions enable $UUID"

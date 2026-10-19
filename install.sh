#!/bin/sh
# Installs the extension for the current user (symlink to this folder).
set -e
UUID=claude-juggler@mbombonato.github.io
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

# Pre-release name "Claude Usage": carry its settings over and remove it.
OLD_UUID=claude-usage@bombonato
OLD_DEST="$(dirname "$DEST")/$OLD_UUID"
if command -v dconf >/dev/null &&
   [ -z "$(dconf dump /org/gnome/shell/extensions/claude-juggler/)" ] &&
   [ -n "$(dconf dump /org/gnome/shell/extensions/claude-usage/)" ]; then
    dconf dump /org/gnome/shell/extensions/claude-usage/ | dconf load /org/gnome/shell/extensions/claude-juggler/
    echo "Settings migrated from Claude Usage."
fi
if [ -L "$OLD_DEST" ]; then
    rm "$OLD_DEST"
    echo "Removed the old Claude Usage extension."
fi

# Enable it for the next login (gnome-extensions enable only works once the
# Shell has loaded the extension) and drop the old name from the list, which
# also turns the old extension off right away.
gsettings set org.gnome.shell enabled-extensions "$(python3 -c '
import ast, sys
enabled = ast.literal_eval(sys.argv[1].removeprefix("@as "))
enabled = [uuid for uuid in enabled if uuid != sys.argv[3]]
print(enabled + ([] if sys.argv[2] in enabled else [sys.argv[2]]))' \
    "$(gsettings get org.gnome.shell enabled-extensions)" "$UUID" "$OLD_UUID")"

echo
echo "On Wayland, GNOME Shell only loads new extensions after you log out and back in."

#!/bin/sh
# Reloads the extension in the current session, without logging out (for development).
#
# GJS caches imported modules by file path, so reloading from the same folder
# reuses the old code. The trick is to copy the extension to a new folder each
# time and load it from there.
#
# Requires GNOME Shell's "unsafe mode", which enables the D-Bus Eval method.
# Turn it on once per session: Alt+F2 → lg → Evaluator:
#     global.context.unsafe_mode = true
# While it's on, any program in the session can run code inside the Shell;
# turn it off when done (button in the notification, `false` in lg, or log out).
set -e

UUID=claude-juggler@mbombonato.github.io
SRC=$(cd "$(dirname "$0")" && pwd)
STAGE="${XDG_CACHE_HOME:-$HOME/.cache}/claude-juggler-dev"
# The Shell requires the folder name to be the UUID.
NEW="$STAGE/$(date +%s%N)/$UUID"

glib-compile-schemas "$SRC/schemas"
python3 "$SRC/po/i18n.py" compile >/dev/null

mkdir -p "$NEW"
(cd "$SRC" && cp -r metadata.json extension.js prefs.js base.css stylesheet-*.css lib icons schemas locale "$NEW/")

eval_js() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1"
}

if eval_js 'global.context.unsafe_mode' | grep -q "(false"; then
    rm -rf "$(dirname "$NEW")"
    echo "GNOME Shell is not in unsafe mode. Turn it on once per session:" >&2
    echo "  Alt+F2 → lg → Evaluator tab → global.context.unsafe_mode = true" >&2
    exit 1
fi

# If the new copy fails to load, fall back to the previous folder.
RESULT=$(eval_js "(async () => {
    const m = Main.extensionManager;
    const old = m.lookup('$UUID');
    if (old)
        await m.unloadExtension(old);
    // Indicator left behind by a version that didn't remove itself on disable.
    Main.panel.statusArea['$UUID']?.destroy();
    try {
        await m.loadExtension(m.createExtensionObject('$UUID', Gio.File.new_for_path('$NEW'), 2));
    } catch (e) {
        if (old)
            await m.loadExtension(m.createExtensionObject('$UUID', old.dir, old.type));
        return {error: String(e)};
    }
    if (!m._enabledExtensions.includes('$UUID'))
        m.enableExtension('$UUID');
    const now = m.lookup('$UUID');
    return {state: now.state, error: now.error || null};
})()")

# Keep only the 3 most recent copies.
ls -1d "$STAGE"/*/ 2>/dev/null | sort | head -n -3 | xargs -r rm -rf

case "$RESULT" in
*'"error":null'*) echo "Reloaded from $NEW" ;;
*) echo "Reload failed: $RESULT" >&2; exit 1 ;;
esac

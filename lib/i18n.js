// Translations shared by the shell and the preferences.
//
// Automatic mode: plain gettext. GNOME calls bindtextdomain for us
// (ExtensionBase.initTranslations) using gettext-domain from metadata.json.
// Caveat: GLib refuses to translate when the system language isn't English and
// GNOME Shell itself has no translation installed for it.
//
// Language forced in the preferences: we read the .mo file directly, without
// relying on the process locale (shared with the whole shell, can't be changed).
//
// Only call _() at runtime, never at module top level.

import GLib from 'gi://GLib';
import Gettext from 'gettext';

const DOMAIN = 'claude-usage';
const domain = Gettext.domain(DOMAIN);

let catalog = null; // Map msgid -> translation, when the language is forced
let localeDir = null;
let settings = null;
let settingsId = 0;

export const LANGUAGES = [
    ['', null], // automatic (label is translated in the preferences)
    ['en', 'English'],
    ['pt_BR', 'Português (Brasil)'],
    ['es', 'Español'],
];

function readMo(path) {
    const map = new Map();
    let bytes;
    try {
        [, bytes] = GLib.file_get_contents(path);
    } catch {
        return map;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = view.getUint32(0, true) === 0x950412de;
    const u32 = off => view.getUint32(off, little);
    const decoder = new TextDecoder();
    const str = (len, off) => decoder.decode(bytes.subarray(off, off + len));
    const n = u32(8), origTab = u32(12), transTab = u32(16);
    for (let i = 0; i < n; i++) {
        const id = str(u32(origTab + i * 8), u32(origTab + i * 8 + 4));
        if (id)
            map.set(id, str(u32(transTab + i * 8), u32(transTab + i * 8 + 4)));
    }
    return map;
}

function load() {
    const lang = settings?.get_string('language') ?? '';
    catalog = lang
        ? readMo(GLib.build_filenamev([localeDir, lang, 'LC_MESSAGES', `${DOMAIN}.mo`]))
        : null;
}

export function initI18n(extension) {
    localeDir = extension.dir.get_child('locale').get_path();
    settings = extension.getSettings();
    settingsId = settings.connect('changed::language', load);
    load();
}

export function destroyI18n() {
    if (settingsId)
        settings.disconnect(settingsId);
    settings = null;
    settingsId = 0;
    catalog = null;
}

export function _(msg) {
    return catalog ? catalog.get(msg) || msg : domain.gettext(msg);
}

// Named placeholders ({name}) so translations can reorder the sentence.
export function _f(msg, vars) {
    return _(msg).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

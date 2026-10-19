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
import Gio from 'gi://Gio';
import Gettext from 'gettext';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const DOMAIN = 'claude-juggler';
const domain = Gettext.domain(DOMAIN);

let catalog = null; // Map msgid -> translation, when the language is forced
let localeDir = null;
let settings = null;
let settingsId = 0;
const listeners = new Set();

export const LANGUAGES = [
    ['', null], // automatic (label is translated in the preferences)
    ['en', 'English'],
    ['pt_BR', 'Português (Brasil)'],
    ['es', 'Español'],
];

async function readMo(path) {
    const map = new Map();
    let bytes;
    try {
        [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
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

async function load() {
    const lang = settings?.get_string('language') ?? '';
    catalog = lang
        ? await readMo(GLib.build_filenamev([localeDir, lang, 'LC_MESSAGES', `${DOMAIN}.mo`]))
        : null;
    for (const cb of listeners)
        cb();
}

// Resolves once the catalog for the configured language is loaded.
export function initI18n(extension) {
    localeDir = extension.dir.get_child('locale').get_path();
    settings = extension.getSettings();
    settingsId = settings.connect('changed::language', () => load().catch(logError));
    return load();
}

// Called after the language changes and its catalog is loaded.
export function onLanguageChanged(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function destroyI18n() {
    if (settingsId)
        settings.disconnect(settingsId);
    settings = null;
    settingsId = 0;
    catalog = null;
    listeners.clear();
}

export function _(msg) {
    return catalog ? catalog.get(msg) || msg : domain.gettext(msg);
}

// Named placeholders ({name}) so translations can reorder the sentence.
export function _f(msg, vars) {
    return _(msg).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

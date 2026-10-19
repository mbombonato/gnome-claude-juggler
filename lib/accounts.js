// Account registry (stored in GSettings) and access to the credentials kept in
// each CLAUDE_CONFIG_DIR. Used by both the extension and the preferences.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {_} from './i18n.js';

const CREDENTIALS_FILE = '.credentials.json';

export const PLANS = {
    default_claude_max_20x: {name: 'Max 20x', weight: 20},
    default_claude_max_5x: {name: 'Max 5x', weight: 5},
    default_claude_ai: {name: 'Pro', weight: 1},
};

const SEATS = {
    team_standard: {name: 'Team Standard', weight: 1.25},
    team_premium: {name: 'Team Premium', weight: 6.25},
};

// Pre-release versions were called "Claude Usage" and kept their data in
// ~/.local/share/claude-usage and ~/.cache/claude-usage: move it over once and
// point the accounts at the new folders.
export function migrateLegacyData(store) {
    const move = (from, to) => {
        if (!GLib.file_test(from, GLib.FileTest.IS_DIR) || GLib.file_test(to, GLib.FileTest.EXISTS))
            return false;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(to), 0o700);
            Gio.File.new_for_path(from).move(Gio.File.new_for_path(to), Gio.FileCopyFlags.NONE, null, null);
            return true;
        } catch (e) {
            console.warn(`claude-juggler: cannot move ${from} to ${to}: ${e.message}`);
            return false;
        }
    };
    const legacyData = GLib.build_filenamev([GLib.get_user_data_dir(), 'claude-usage']);
    if (move(legacyData, dataDir())) {
        for (const account of store.list()) {
            if (account.configDir.startsWith(`${legacyData}/`))
                store.update(account.id, {configDir: dataDir() + account.configDir.slice(legacyData.length)});
        }
    }
    move(GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage']),
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-juggler']));
}

export function dataDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'claude-juggler']);
}

export function accountDir(id) {
    return GLib.build_filenamev([dataDir(), 'accounts', id]);
}

export function credentialsPath(account) {
    return GLib.build_filenamev([account.configDir, CREDENTIALS_FILE]);
}

export function displayName(account) {
    return account.label || account.email || _('Not logged in');
}

export function shortName(account) {
    if (account.label)
        return account.label;
    if (account.email)
        return account.email.split('@')[0];
    return '?';
}

// Derives the plan and its relative weight (Pro = 1) from the OAuth profile.
export function planFromProfile(profile) {
    const org = profile?.organization ?? {};
    const seat = SEATS[org.seat_tier];
    if (seat)
        return seat;
    const plan = PLANS[org.rate_limit_tier];
    if (plan)
        return plan;
    switch (org.organization_type) {
    case 'claude_max':
        return {name: 'Max', weight: 5};
    case 'claude_team':
        return {name: 'Team', weight: 1.25};
    case 'claude_enterprise':
        return {name: 'Enterprise', weight: 1.25};
    case 'claude_pro':
        return {name: 'Pro', weight: 1};
    default:
        return {name: org.organization_type ?? '?', weight: 1};
    }
}

// Disabled = still configured, but never fetched and left out of the menu/suggestion.
export function isEnabled(account) {
    return account.enabled !== false;
}

export function effectiveWeight(account) {
    return account.weight > 0 ? account.weight : account.planWeight || 1;
}

export class AccountStore {
    constructor(settings) {
        this._settings = settings;
    }

    list() {
        try {
            const parsed = JSON.parse(this._settings.get_string('accounts'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    get(id) {
        return this.list().find(a => a.id === id) ?? null;
    }

    _save(accounts) {
        this._settings.set_string('accounts', JSON.stringify(accounts));
    }

    // External configDir = linked account: read-only, whoever owns the folder renews the token.
    create(externalDir = null) {
        const id = GLib.uuid_string_random();
        const configDir = externalDir ?? accountDir(id);
        if (!externalDir)
            GLib.mkdir_with_parents(configDir, 0o700);
        const account = {
            id,
            label: '',
            email: '',
            orgName: '',
            plan: '',
            planWeight: 0,
            weight: 0,
            include: true,
            configDir,
            readOnly: !!externalDir,
            createdAt: Date.now(),
        };
        this._save([...this.list(), account]);
        return account;
    }

    // Merges fields into the account, re-reading the current value so we don't
    // overwrite changes made by the other process (prefs <-> shell).
    update(id, fields) {
        const accounts = this.list();
        const account = accounts.find(a => a.id === id);
        if (!account)
            return null;
        let changed = false;
        for (const [k, v] of Object.entries(fields)) {
            if (account[k] !== v) {
                account[k] = v;
                changed = true;
            }
        }
        if (changed)
            this._save(accounts);
        return account;
    }

    move(id, delta) {
        const accounts = this.list();
        const i = accounts.findIndex(a => a.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= accounts.length)
            return;
        [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
        this._save(accounts);
    }

    remove(id, {deleteFiles = true} = {}) {
        const account = this.get(id);
        this._save(this.list().filter(a => a.id !== id));
        // Only delete folders we created.
        if (deleteFiles && account?.configDir?.startsWith(dataDir()))
            deleteRecursive(Gio.File.new_for_path(account.configDir));
    }
}

function deleteRecursive(file) {
    try {
        const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let child;
            while ((child = children.next_file(null)))
                deleteRecursive(file.get_child(child.get_name()));
            children.close(null);
        }
        file.delete(null);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn(`claude-juggler: failed to delete ${file.get_path()}: ${e.message}`);
    }
}

// Always read from disk: the Claude CLI (using the same CLAUDE_CONFIG_DIR) may
// have renewed the token since the last read.
export function readCredentials(account) {
    try {
        const [, bytes] = GLib.file_get_contents(credentialsPath(account));
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return data.claudeAiOauth ? data : null;
    } catch {
        return null;
    }
}

export function hasCredentials(account) {
    return readCredentials(account) !== null;
}

export function writeCredentials(account, data) {
    GLib.file_set_contents_full(
        credentialsPath(account),
        new TextEncoder().encode(JSON.stringify(data)),
        GLib.FileSetContentsFlags.CONSISTENT,
        0o600);
}

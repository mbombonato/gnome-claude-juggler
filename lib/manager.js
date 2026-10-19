// Usage state for all accounts: periodic polling, detection of completed logins
// (by watching .credentials.json) and backoff when the API rate limits us.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {AccountStore, isEnabled, planFromProfile} from './accounts.js';
import {_, _f} from './i18n.js';
import {ClaudeApi, parseUsage} from './api.js';
import {recommend} from './recommend.js';

const PROFILE_MAX_AGE_MS = 24 * 3600e3;
// The usage endpoint has a small per-token budget (shared with Claude Code's
// own /usage): never less than this between requests for the same account,
// not even when the user forces a refresh.
const MIN_SPACING_MS = 2 * 60e3;
// 429 without Retry-After: the wait grows with each consecutive 429.
const BACKOFF_STEPS_MS = [5, 10, 20, 30].map(min => min * 60e3);
// Opening the menu reuses data younger than this (or the refresh interval, if shorter).
const MENU_MAX_AGE_MS = 5 * 60e3;
// Pause between accounts within one round, so a round is never a burst.
const ACCOUNT_STAGGER_MS = 10e3;

// Usage and rate-limit state survive restarts (login, screen unlock, reload),
// so starting up doesn't fire a request for every account at once.
const CACHE_VERSION = 1;
const CACHE_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-juggler', 'state.json']);
const CACHED_FIELDS = ['usage', 'backoffUntil', 'failures', 'lastRequestAt'];

function hhmm(ts) {
    return GLib.DateTime.new_from_unix_local(Math.floor(ts / 1000)).format('%H:%M');
}

function rateLimitMessage(st) {
    return st.usage
        ? _f('API rate limited — data from {time}, retrying at {retry}', {time: hhmm(st.usage.fetchedAt), retry: hhmm(st.backoffUntil)})
        : _f('API rate limited — retrying at {retry}', {retry: hhmm(st.backoffUntil)});
}

export class UsageManager {
    constructor(settings) {
        this._settings = settings;
        this.store = new AccountStore(settings);
        this._api = new ClaudeApi();
        this._cancellable = new Gio.Cancellable();
        this._state = new Map(); // id -> {usage, error, needsLogin, loading, backoffUntil, failures, lastRequestAt}
        this._monitors = new Map(); // id -> {monitor, debounce}
        this._disabled = new Set(); // accounts disabled as of the last sync
        this._listeners = new Set();
        this._timerId = 0;
        this._saveId = 0;
        this._running = false;
        this.lastRefresh = 0;
        this._loadCache();

        this._settingsIds = [
            settings.connect('changed::accounts', () => this._syncAccounts()),
            settings.connect('changed::refresh-interval', () => this._schedule()),
        ];
        this._syncAccounts();
        this._started = true;
        this._schedule();
        this.refreshAll({reason: 'start', maxAge: this._intervalMs()});
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._staggerId)
            GLib.source_remove(this._staggerId);
        this._staggerResolve?.();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._cancellable.cancel();
        if (this._timerId)
            GLib.source_remove(this._timerId);
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveCache();
        }
        for (const id of [...this._monitors.keys()])
            this._unwatch(id);
        this._api.destroy();
        this._listeners.clear();
    }

    connectChanged(cb) {
        this._listeners.add(cb);
        return cb;
    }

    disconnectChanged(cb) {
        this._listeners.delete(cb);
    }

    // Diagnostics: `gsettings set org.gnome.shell.extensions.claude-juggler debug true`
    // then follow with `journalctl --user -f | grep claude-juggler`.
    _debug(msg) {
        if (this._settings.get_boolean('debug'))
            console.log(`claude-juggler: ${msg}`);
    }

    _loadCache() {
        let data;
        try {
            const [, bytes] = GLib.file_get_contents(CACHE_PATH);
            data = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return;
        }
        if (data?.version !== CACHE_VERSION || typeof data.accounts !== 'object')
            return;
        const now = Date.now();
        for (const [id, cached] of Object.entries(data.accounts)) {
            const st = {};
            for (const field of CACHED_FIELDS) {
                if (cached?.[field] !== undefined)
                    st[field] = cached[field];
            }
            if (st.usage && !(st.usage.fetchedAt > 0))
                delete st.usage;
            if (st.backoffUntil > now)
                st.error = rateLimitMessage(st);
            this._state.set(id, st);
            this.lastRefresh = Math.max(this.lastRefresh, st.usage?.fetchedAt ?? 0);
        }
    }

    _saveCache() {
        this._saveId = 0;
        const accounts = {};
        for (const account of this.store.list()) {
            const st = this._state.get(account.id);
            if (!st)
                continue;
            accounts[account.id] = Object.fromEntries(CACHED_FIELDS.filter(f => st[f] !== undefined).map(f => [f, st[f]]));
        }
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE_PATH), 0o700);
            GLib.file_set_contents_full(CACHE_PATH,
                new TextEncoder().encode(JSON.stringify({version: CACHE_VERSION, accounts})),
                GLib.FileSetContentsFlags.CONSISTENT, 0o600);
        } catch (e) {
            console.warn(`claude-juggler: cannot write ${CACHE_PATH}: ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    }

    // Coalesces the writes of a whole refresh round into one.
    _scheduleSave() {
        if (!this._saveId && !this._cancellable.is_cancelled())
            this._saveId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => this._saveCache());
    }

    _intervalMs() {
        return this._settings.get_uint('refresh-interval') * 60e3;
    }

    _emit() {
        if (this._destroyed)
            return;
        for (const cb of this._listeners) {
            try {
                cb();
            } catch (e) {
                logError(e, 'claude-juggler');
            }
        }
    }

    stateFor(id) {
        return this._state.get(id) ?? {};
    }

    // Enabled accounts only; disabled ones are neither shown nor suggested.
    entries() {
        return this.store.list().filter(isEnabled).map(account => ({account, ...this.stateFor(account.id)}));
    }

    recommendation() {
        return recommend(this.entries().filter(e => e.usage && !e.needsLogin));
    }

    get loading() {
        return this._running;
    }

    _schedule() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        const seconds = this._settings.get_uint('refresh-interval') * 60;
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            // Half the interval: skips accounts just fetched by opening the menu.
            this.refreshAll({reason: 'timer', maxAge: seconds * 500});
            return GLib.SOURCE_CONTINUE;
        });
    }

    _syncAccounts() {
        const ids = new Set(this.store.list().map(a => a.id));
        for (const id of [...this._state.keys()]) {
            if (!ids.has(id)) {
                this._state.delete(id);
                this._disabled.delete(id);
            }
        }
        for (const id of [...this._monitors.keys()]) {
            if (!ids.has(id))
                this._unwatch(id);
        }
        for (const account of this.store.list()) {
            if (!this._monitors.has(account.id))
                this._watch(account);
            const isNew = !this._state.has(account.id);
            if (!isEnabled(account)) {
                // Drop stale data: once re-enabled, the account is fetched right away.
                this._state.set(account.id, {});
                this._disabled.add(account.id);
                continue;
            }
            const reenabled = this._disabled.delete(account.id);
            if (isNew)
                this._state.set(account.id, {});
            if ((isNew || reenabled) && this._started)
                this.refreshAccount(account.id, {reason: isNew ? 'new account' : 're-enabled'});
        }
        this._emit();
    }

    // Detects a completed login / a token renewed by the CLI.
    _watch(account) {
        let monitor;
        try {
            GLib.mkdir_with_parents(account.configDir, 0o700);
            monitor = Gio.File.new_for_path(account.configDir)
                .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (e) {
            console.warn(`claude-juggler: cannot monitor ${account.configDir}: ${e.message}`);
            return;
        }
        const entry = {monitor, debounce: 0};
        monitor.connect('changed', (_m, file, other) => {
            const names = [file?.get_basename(), other?.get_basename()];
            if (!names.includes('.credentials.json'))
                return;
            // Only relevant while the account isn't working yet; renewals made by
            // the CLI are picked up naturally on the next fetch.
            const st = this.stateFor(account.id);
            if (st.usage && !st.needsLogin)
                return;
            if (entry.debounce)
                GLib.source_remove(entry.debounce);
            entry.debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                entry.debounce = 0;
                this.refreshAccount(account.id, {reason: 'credentials changed'});
                return GLib.SOURCE_REMOVE;
            });
        });
        this._monitors.set(account.id, entry);
    }

    _unwatch(id) {
        const entry = this._monitors.get(id);
        if (!entry)
            return;
        if (entry.debounce)
            GLib.source_remove(entry.debounce);
        entry.monitor.cancel();
        this._monitors.delete(id);
    }

    // When the next account in backoff may be fetched again (0 if none).
    rateLimitedUntil() {
        const now = Date.now();
        const waits = this.entries().map(e => e.backoffUntil ?? 0).filter(t => t > now);
        return waits.length ? Math.min(...waits) : 0;
    }

    // Opening the menu only refreshes data that is getting old.
    refreshForMenu() {
        return this.refreshAll({reason: 'menu opened', maxAge: Math.min(this._intervalMs(), MENU_MAX_AGE_MS)});
    }

    // maxAge: skip accounts whose data is younger than this (ms).
    _stagger() {
        return new Promise(resolve => {
            this._staggerResolve = resolve;
            this._staggerId = GLib.timeout_add(GLib.PRIORITY_LOW, ACCOUNT_STAGGER_MS, () => {
                this._staggerId = 0;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    async refreshAll({reason = 'manual', maxAge = 0} = {}) {
        if (this._running || this._destroyed)
            return;
        this._running = true;
        this._emit();
        try {
            // Sequential, so we never fire several requests at once.
            let requested = false;
            for (const account of this.store.list().filter(isEnabled)) {
                if (this._destroyed)
                    return;
                const before = this.stateFor(account.id).lastRequestAt;
                // Only wait between accounts that actually hit the network.
                if (requested && this._needsFetch(account.id, maxAge))
                    await this._stagger();
                if (this._destroyed)
                    return;
                await this.refreshAccount(account.id, {quiet: true, reason, maxAge});
                requested ||= this.stateFor(account.id).lastRequestAt !== before;
            }
            // Age of the newest data, not when this round ran: with a fresh
            // cache a round may skip every account.
            this.lastRefresh = Math.max(0, ...this.entries().map(e => e.usage?.fetchedAt ?? 0));
        } finally {
            this._running = false;
            this._emit();
        }
    }

    // No trigger (not even the refresh button) bypasses the backoff or the
    // minimum spacing: insisting during a 429 only extends the block.
    // Whether refreshAccount would actually send a request now.
    _needsFetch(id, maxAge) {
        const st = this.stateFor(id);
        const now = Date.now();
        if (st.loading || st.backoffUntil > now || now - (st.lastRequestAt ?? 0) < MIN_SPACING_MS)
            return false;
        return !(maxAge && st.usage && !st.needsLogin && now - st.usage.fetchedAt < maxAge);
    }

    async refreshAccount(id, {quiet = false, reason = 'manual', maxAge = 0} = {}) {
        const account = this.store.get(id);
        if (!account || !isEnabled(account) || this._destroyed)
            return;
        const st = {...this.stateFor(id)};
        const now = Date.now();
        if (st.loading)
            return;
        if (maxAge && st.usage && !st.needsLogin && now - st.usage.fetchedAt < maxAge) {
            this._debug(`${account.email || id}: skipped (${reason}) — data from ${hhmm(st.usage.fetchedAt)} is fresh`);
            return;
        }
        if (st.backoffUntil > now || now - (st.lastRequestAt ?? 0) < MIN_SPACING_MS) {
            this._debug(`${account.email || id}: skipped (${reason}) — ${st.backoffUntil > now ? `backoff until ${hhmm(st.backoffUntil)}` : 'too soon'}`);
            return;
        }
        this._debug(`${account.email || id}: fetching (${reason})`);

        st.loading = true;
        this._state.set(id, st);
        if (!quiet)
            this._emit();

        try {
            if (!account.email || !(account.profileFetchedAt > now - PROFILE_MAX_AGE_MS)) {
                const profile = await this._api.fetchProfile(account, this._cancellable);
                const plan = planFromProfile(profile);
                this.store.update(id, {
                    email: profile?.account?.email ?? account.email,
                    orgName: profile?.organization?.name ?? '',
                    plan: plan.name,
                    planWeight: plan.weight,
                    profileFetchedAt: now,
                });
            }
            st.usage = parseUsage(await this._api.fetchUsage(account, this._cancellable));
            st.error = null;
            st.needsLogin = false;
            st.backoffUntil = 0;
            st.failures = 0;
            st.lastRequestAt = now;
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            st.error = e.message;
            st.needsLogin = !!e.needsLogin;
            // Login failures happen before any network request (or must be
            // retried right after logging in); everything else counts for spacing.
            if (!e.needsLogin)
                st.lastRequestAt = now;
            if (e.status === 429) {
                st.failures = (st.failures ?? 0) + 1;
                const wait = e.retryAfter
                    ? e.retryAfter * 1000
                    : BACKOFF_STEPS_MS[Math.min(st.failures, BACKOFF_STEPS_MS.length) - 1];
                st.backoffUntil = Math.max(st.backoffUntil ?? 0, now + wait);
                st.error = rateLimitMessage(st);
            }
            if (!e.needsLogin)
                console.warn(`claude-juggler: ${account.email || id}: ${e.message}`);
        } finally {
            st.loading = false;
            if (this._state.has(id))
                this._state.set(id, st);
            this._scheduleSave();
        }
        if (!quiet)
            this._emit();
    }
}

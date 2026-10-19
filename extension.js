import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {displayName, isEnabled, shortName} from './lib/accounts.js';
import {_, _f, destroyI18n, initI18n} from './lib/i18n.js';
import {launchLogin, shellCommandFor} from './lib/launcher.js';
import {UsageManager} from './lib/manager.js';
import {formatDuration} from './lib/recommend.js';

const USAGE_PAGE = 'https://claude.ai/settings/usage';
const SESSION_MS = 5 * 3600e3;
const WEEK_MS = 7 * 24 * 3600e3;
// Bar widths in logical px; must match base.css.
const PILL_METER = 26;
const TILE_BAR = 136;
const EXTRA_BAR = 110;
const ROW_BAR = 44;
const TOOLTIP_DELAY_MS = 400;

function severity(pct) {
    if (pct >= 90)
        return 'cu-crit';
    if (pct >= 60)
        return 'cu-warn';
    return 'cu-ok';
}

function label(text, styleClass, props = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
}

function vbox(styleClass, props = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: styleClass, ...props});
}

function icon(iconName, styleClass, props = {}) {
    return new St.Icon({icon_name: iconName, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
}

function bar(pct, width, styleClass) {
    const track = new St.BoxLayout({
        style_class: `cu-bar ${styleClass}`,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });
    track.set_style(`width: ${width}px;`);
    const value = Math.min(100, Math.max(0, pct ?? 0));
    const fill = new St.Widget({style_class: `cu-bar-fill ${severity(value)}`, y_expand: true});
    fill.set_style(`width: ${Math.round(width * value / 100)}px;`);
    track.add_child(fill);
    return track;
}

// "today 15:59", "tomorrow 09:00", "Tue Oct 21 09:59" (no date when short)
function formatResetAt(ts, {short = false} = {}) {
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(ts / 1000));
    const day = d => new Date(d).toDateString();
    const time = dt.format('%H:%M');
    if (day(ts) === day(Date.now()))
        return short ? time : _f('today {time}', {time});
    // "tomorrow …" doesn't fit the narrow columns; short form uses the weekday.
    if (!short && day(ts) === day(Date.now() + 24 * 3600e3))
        return _f('tomorrow {time}', {time});
    // Translators: strftime format for a reset date in the coming week
    return dt.format(short ? '%a %H:%M' : _('%a %b %-d %H:%M'));
}

// Extrapolates the current window's pace: {hitsIn} if it will run out before
// the reset, {projected} if it ends below the limit.
function projection(win, windowMs) {
    if (!win?.resetsAt || win.used <= 0 || win.used >= 100)
        return null;
    const elapsed = windowMs - (win.resetsAt - Date.now());
    if (elapsed < 20 * 60e3)
        return null;
    const projected = win.used * windowMs / elapsed;
    if (projected >= 100)
        return {hitsIn: (100 - win.used) / (win.used / elapsed)};
    return Math.round(projected) > Math.round(win.used) ? {projected: Math.round(projected)} : null;
}

// One sentence about what matters right now for the account.
function insight(usage) {
    const {session, weekly} = usage;
    if (weekly?.used >= 99 && weekly.resetsAt)
        return {icon: 'alarm-symbolic', cls: 'cu-crit', text: _f('frees up {when}', {when: formatResetAt(weekly.resetsAt)})};
    if (session?.used >= 97 && session.resetsAt)
        return {icon: 'alarm-symbolic', cls: 'cu-crit', text: _f('frees up {when}', {when: formatResetAt(session.resetsAt)})};
    for (const [name, win, ms] of [[_('Session'), session, SESSION_MS], [_('Week'), weekly, WEEK_MS]]) {
        const p = projection(win, ms);
        if (p?.hitsIn) {
            return {icon: 'power-profile-performance-symbolic', cls: 'cu-warn',
                text: `${name}: ${_f('at this pace, hits the limit in ~{time}', {time: formatDuration(p.hitsIn)})}`};
        }
    }
    const p = projection(session, SESSION_MS);
    if (p?.projected)
        return {icon: 'emblem-ok-symbolic', cls: 'cu-ok', text: `${_('Session')}: ${_f('on track for ~{pct}% by reset', {pct: p.projected})}`};
    return null;
}

// St has no tooltip widget: a small label in the UI group, shown after a short
// hover, above the actor (or below it when there's no room). `text` may be a
// function, evaluated each time the tooltip shows.
function addTooltip(actor, text) {
    actor.reactive = true;
    let tip = null;
    let timeoutId = 0;
    const hide = () => {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        timeoutId = 0;
        tip?.destroy();
        tip = null;
    };
    const show = () => {
        timeoutId = 0;
        if (!actor.mapped)
            return GLib.SOURCE_REMOVE;
        const content = typeof text === 'function' ? text() : text;
        if (!content)
            return GLib.SOURCE_REMOVE;
        tip = new St.Label({text: content, style_class: 'cu-tooltip'});
        Main.uiGroup.add_child(tip);
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const [, tw] = tip.get_preferred_width(-1);
        const [, th] = tip.get_preferred_height(-1);
        const mon = Main.layoutManager.findMonitorForActor(actor) ?? Main.layoutManager.primaryMonitor;
        const tx = Math.max(mon.x + 4, Math.min(Math.round(x + w / 2 - tw / 2), mon.x + mon.width - tw - 4));
        let ty = Math.round(y - th - 6);
        if (ty < mon.y + 4)
            ty = Math.round(y + h + 6);
        tip.set_position(tx, ty);
        return GLib.SOURCE_REMOVE;
    };
    // Crossing events instead of track_hover/notify::hover, which doesn't update
    // reliably for actors nested inside a reactive button within the menu.
    actor.connect('enter-event', () => {
        hide();
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY_MS, show);
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('leave-event', () => {
        hide();
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('button-press-event', () => {
        hide();
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('notify::mapped', () => {
        if (!actor.mapped)
            hide();
    });
    actor.connect('destroy', hide);
    return actor;
}

function iconButton(iconName, accessibleName, onClick, extraClass = '') {
    const button = new St.Button({
        style_class: `cu-icon-button ${extraClass}`,
        child: icon(iconName, 'cu-icon-button-icon'),
        accessible_name: accessibleName,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', onClick);
    return addTooltip(button, accessibleName);
}

function chip(text, iconName, onClick, extraClass = '') {
    const box = new St.BoxLayout({style_class: 'cu-chip-box'});
    if (iconName)
        box.add_child(icon(iconName, 'cu-chip-icon'));
    if (text)
        box.add_child(label(text, 'cu-chip-label'));
    const button = new St.Button({style_class: `cu-chip ${extraClass}`, child: box, can_focus: true});
    button.connect('clicked', onClick);
    return button;
}

// St's CSS doesn't understand hsl().
function hslToHex(h, s, l) {
    const f = n => {
        const k = (n + h / 30) % 12;
        const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function avatar(account, styleClass = 'cu-avatar') {
    const letter = (displayName(account)[0] ?? '?').toUpperCase();
    const hue = [...(account.email || account.id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    const bin = new St.Bin({
        style_class: styleClass,
        child: label(letter, 'cu-avatar-letter', {x_align: Clutter.ActorAlign.CENTER}),
        y_align: Clutter.ActorAlign.CENTER,
    });
    bin.set_style(`background-color: ${hslToHex(hue, 0.42, 0.48)};`);
    return bin;
}

// Composition instead of subclassing PanelMenu.Button: without a GObject type
// of its own, the extension can be reloaded in the same session (dev-reload.sh)
// without hitting "Type name ... is already registered".
class Indicator {
    constructor(ext) {
        this.button = new PanelMenu.Button(0.5, 'Claude Usage');
        this.menu = this.button.menu;
        // Whoever destroys the button (us, the panel, a cleanup), the manager and
        // its timers must go with it; an orphaned manager keeps polling the API.
        this.button.connect('destroy', () => this.destroy());
        this._ext = ext;
        this._settings = ext.getSettings();
        this._manager = new UsageManager(this._settings);
        this._lastRecommendedId = null;
        // Detail view opened from the compact layout (transient; the account comes from selected-account).
        this._detailOpen = false;
        this._brandIcon = Gio.FileIcon.new(ext.dir.resolve_relative_path('icons/claude-usage.svg'));
        this.button.add_style_class_name('cu-panel-button');

        // Panel: ( ✱ name 62% │ 33% ) — each number with a thin progress line under it.
        const pill = new St.BoxLayout({style_class: 'cu-pill', y_align: Clutter.ActorAlign.CENTER});
        pill.add_child(new St.Icon({gicon: this._brandIcon, style_class: 'cu-pill-icon', y_align: Clutter.ActorAlign.CENTER}));
        this._panelName = label('', 'cu-pill-name');
        pill.add_child(this._panelName);
        this._segments = {};
        for (const key of ['session', 'weekly']) {
            if (key === 'weekly') {
                this._divider = new St.Widget({style_class: 'cu-pill-divider', y_align: Clutter.ActorAlign.CENTER});
                pill.add_child(this._divider);
            }
            const seg = {box: vbox('cu-pill-metric', {y_align: Clutter.ActorAlign.CENTER})};
            const line = new St.BoxLayout({style_class: 'cu-pill-line'});
            seg.pct = label('', 'cu-pill-pct');
            seg.reset = label('', 'cu-pill-reset');
            // Opacity instead of a color: the panel may be light or dark.
            seg.reset.opacity = 165;
            line.add_child(seg.pct);
            line.add_child(seg.reset);
            seg.box.add_child(line);
            seg.meterBin = new St.Bin({x_align: Clutter.ActorAlign.START});
            seg.box.add_child(seg.meterBin);
            pill.add_child(seg.box);
            this._segments[key] = seg;
        }
        this.button.add_child(pill);
        // Hovering the pill tells which account it shows, without opening the menu.
        addTooltip(this.button, () => this._panelTooltip());

        // All content lives in a non-reactive item with its own buttons, so
        // clicks (selecting an account, refreshing) don't close the menu.
        this._content = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'cu-menu'});
        this._box = vbox('cu-content', {x_expand: true});
        this._content.add_child(this._box);
        // The header is persistent: rebuilding it on every update would destroy
        // a button in the middle of a click (between press and release).
        this._header = this._buildHeader();
        this._body = vbox('cu-body', {x_expand: true});
        this._box.add_child(this._header);
        this._box.add_child(this._body);
        this.menu.addMenuItem(this._content);
        this.menu.box.add_style_class_name('cu-menu-box');

        this._changedCb = this._manager.connectChanged(() => this._update());
        this._settingsIds = [
            this._settings.connect('changed::panel-mode', () => this._update()),
            this._settings.connect('changed::panel-metrics', () => this._update()),
            this._settings.connect('changed::selected-account', () => this._update()),
            this._settings.connect('changed::popup-layout', () => this._update()),
            this._settings.connect('changed::language', () => {
                const header = this._buildHeader();
                this._box.replace_child(this._header, header);
                this._header = header;
                this._update();
            }),
        ];
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._render();
                this._manager.refreshForMenu();
                this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 30, () => {
                    this._render();
                    return GLib.SOURCE_CONTINUE;
                });
            } else {
                this._detailOpen = false;
                this._renaming = false;
                if (this._tickId)
                    GLib.source_remove(this._tickId);
                this._tickId = 0;
            }
        });
        this._update();
    }

    _copy(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        Main.notify('Claude Usage', _f('Copied: {text}', {text}));
    }

    _login(account) {
        this.menu.close();
        try {
            launchLogin(this._settings, account);
        } catch (e) {
            Main.notifyError('Claude Usage', e.message);
            return false;
        }
        return true;
    }

    _addAccount() {
        const account = this._manager.store.create();
        if (!this._login(account))
            this._manager.store.remove(account.id);
    }

    _update() {
        const rec = this._manager.recommendation();
        this._updatePanel(rec);
        this._maybeNotify(rec);
        if (this.menu.isOpen)
            this._render();
    }

    // Account the user pinned in the menu, if it still exists and is enabled.
    _pinnedAccount() {
        const id = this._settings.get_string('selected-account');
        const account = id ? this._manager.store.get(id) : null;
        return account && isEnabled(account) ? account : null;
    }

    _pin(id) {
        this._settings.set_string('selected-account', id ?? '');
    }

    _updatePanel(rec) {
        const mode = this._settings.get_string('panel-mode');
        const metrics = this._settings.get_string('panel-metrics');
        const account = this._pinnedAccount() ?? rec?.account;
        const usage = account ? this._manager.stateFor(account.id).usage : null;
        const show = mode !== 'icon' && !!usage;
        this._panelName.visible = show && mode === 'named';
        if (show)
            this._panelName.text = shortName(account);

        let visible = 0;
        for (const [key, seg] of Object.entries(this._segments)) {
            const win = usage?.[key];
            seg.box.visible = show && !!win && (metrics === 'both' || metrics === key);
            if (!seg.box.visible)
                continue;
            visible++;
            const pct = Math.round(win.used);
            const sev = severity(pct);
            seg.pct.text = `${pct}%`;
            seg.pct.style_class = `cu-pill-pct ${sev}`;
            seg.reset.visible = mode !== 'percent' && !!win.resetsAt;
            seg.reset.text = win.resetsAt ? formatDuration(win.resetsAt - Date.now()) : '';
            seg.meterBin.set_child(bar(pct, PILL_METER, 'cu-bar-pill'));
        }
        this._divider.visible = visible === 2;
    }

    _panelTooltip() {
        if (this.menu.isOpen)
            return null;
        const pinned = this._pinnedAccount();
        const rec = this._manager.recommendation();
        const account = pinned ?? rec?.account;
        if (!account)
            return 'Claude Usage';
        const tag = pinned ? _('Pinned to panel') : rec.blocked ? _('Next to free up') : _('Suggested');
        return `${displayName(account)} · ${tag}`;
    }

    _maybeNotify(rec) {
        const id = rec && !rec.blocked ? rec.account.id : null;
        if (id === this._lastRecommendedId)
            return;
        const previous = this._lastRecommendedId;
        this._lastRecommendedId = id;
        if (previous && id && this._settings.get_boolean('notify-recommendation'))
            Main.notify(_('Claude: switch accounts'), _f('Use {name} — {reason}', {name: displayName(rec.account), reason: rec.reason}));
    }

    _render() {
        if (this._renaming)
            return;
        this._body.destroy_all_children();
        const rec = this._manager.recommendation();
        const entries = this._manager.entries();
        const layout = this._settings.get_string('popup-layout');

        this._updateHeader(layout);

        if (!entries.length) {
            this._body.add_child(this._emptyState(this._manager.store.list().length > 0));
            this._body.add_child(this._footer());
            return;
        }

        const pinned = this._pinnedAccount();
        const compact = layout === 'compact' && !this._detailOpen;
        let others = entries;
        if (compact) {
            this._body.add_child(this._banner(rec, pinned));
        } else {
            const heroId = pinned?.id ?? rec?.account.id ?? entries[0].account.id;
            const hero = entries.find(e => e.account.id === heroId) ?? entries[0];
            this._body.add_child(this._heroCard(hero, rec));
            others = entries.filter(e => e !== hero);
        }

        if (others.length) {
            const head = new St.BoxLayout({style_class: 'cu-section-head'});
            head.add_child(label(compact ? _('ACCOUNTS') : _('OTHER ACCOUNTS'), 'cu-caption', {x_expand: true}));
            head.add_child(chip(_('Add'), 'list-add-symbolic', () => this._addAccount(), 'cu-chip-flat'));
            this._body.add_child(head);
            const list = vbox('cu-list');
            for (const entry of others)
                list.add_child(this._accountRow(entry, rec));
            this._body.add_child(list);
        }

        this._body.add_child(this._footer());
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'cu-header'});
        header.add_child(new St.Icon({gicon: this._brandIcon, style_class: 'cu-header-icon', y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(label('Claude Usage', 'cu-title', {x_expand: true}));

        const seg = new St.BoxLayout({style_class: 'cu-segmented', y_align: Clutter.ActorAlign.CENTER});
        this._layoutButtons = {};
        for (const [value, iconName, name] of [['detailed', 'view-paged-symbolic', _('Detailed')], ['compact', 'view-list-symbolic', _('Compact')]]) {
            const button = iconButton(iconName, name, () => {
                this._detailOpen = false;
                this._settings.set_string('popup-layout', value);
                this._render();
            }, 'cu-segment');
            this._layoutButtons[value] = button;
            seg.add_child(button);
        }
        header.add_child(seg);
        this._refreshButton = iconButton('view-refresh-symbolic', _('Refresh'),
            () => this._manager.refreshAll({reason: 'refresh button'}));
        header.add_child(this._refreshButton);
        // Quits: turns the extension off (like closing an app), stopping all polling.
        // Deferred so the extension isn't torn down inside this button's own handler.
        header.add_child(iconButton('window-close-symbolic', _('Quit — turn the extension off'), () => {
            // No close animation: the menu is destroyed right after.
            this.menu.close(false);
            const uuid = this._ext.uuid;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                Main.extensionManager.disableExtension(uuid);
                return GLib.SOURCE_REMOVE;
            });
        }));
        return header;
    }

    _updateHeader(layout) {
        for (const [value, button] of Object.entries(this._layoutButtons)) {
            if (value === layout)
                button.add_style_class_name('cu-segment-active');
            else
                button.remove_style_class_name('cu-segment-active');
        }
        this._refreshButton.child.icon_name = this._manager.loading ? 'content-loading-symbolic' : 'view-refresh-symbolic';
    }

    // Highlighted suggestion, used by the compact layout.
    _banner(rec, pinned) {
        const box = new St.BoxLayout({style_class: `cu-banner${rec?.blocked ? ' cu-banner-blocked' : ''}`});
        box.add_child(icon(rec?.blocked ? 'alarm-symbolic' : 'starred-symbolic', 'cu-banner-icon', {y_align: Clutter.ActorAlign.START}));
        const text = vbox('cu-banner-text', {x_expand: true});
        text.add_child(label(rec ? _f('Use {name}', {name: displayName(rec.account)}) : _('No usage data yet…'), 'cu-banner-title'));
        if (rec) {
            const reason = label(rec.reason, 'cu-banner-reason');
            reason.clutter_text.line_wrap = true;
            text.add_child(reason);
        }
        if (pinned && pinned.id !== rec?.account.id)
            text.add_child(chip(_f('Panel shows {name} · unpin', {name: shortName(pinned)}), 'view-pin-symbolic', () => this._pin(null), 'cu-chip-flat cu-chip-inline'));
        box.add_child(text);
        if (rec)
            box.add_child(iconButton('edit-copy-symbolic', _('Copy'), () => this._copy(shellCommandFor(rec.account))));
        return box;
    }

    // allDisabled: there are accounts, but all of them are disabled.
    _emptyState(allDisabled) {
        const box = vbox('cu-empty');
        box.add_child(new St.Icon({gicon: this._brandIcon, style_class: 'cu-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label(allDisabled ? _('All accounts are disabled') : _('No accounts yet'), 'cu-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        const sub = label(allDisabled
            ? _('Enable an account in the settings to see its usage here.')
            : _('Add your Claude accounts: a terminal opens to log in to each one.'), 'cu-empty-sub', {x_align: Clutter.ActorAlign.CENTER});
        sub.clutter_text.line_wrap = true;
        box.add_child(sub);
        const btn = new St.Button({
            label: allDisabled ? _('Settings') : _('Add account'),
            style_class: 'cu-primary',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        btn.connect('clicked', () => {
            if (!allDisabled) {
                this._addAccount();
                return;
            }
            this.menu.close();
            this._ext.openPreferences();
        });
        box.add_child(btn);
        return box;
    }

    _heroCard(entry, rec) {
        const {account, usage, error, needsLogin} = entry;
        const isRec = rec && rec.account.id === account.id;
        const isPinned = this._pinnedAccount()?.id === account.id;
        const card = vbox(`cu-hero${isRec && !rec.blocked ? ' cu-hero-suggested' : ''}`);

        const head = new St.BoxLayout({style_class: 'cu-hero-head'});
        head.add_child(avatar(account, 'cu-avatar cu-avatar-lg'));
        const titles = vbox('cu-hero-titles', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const nameLabel = label(displayName(account), 'cu-hero-name');
        titles.add_child(nameLabel);

        let sub;
        if (isRec)
            sub = `${rec.blocked ? _('Next to free up') : _('Suggested')} · ${rec.reason}`;
        else
            sub = [account.label ? account.email : '', account.orgName?.endsWith("'s Organization") ? '' : account.orgName]
                .filter(Boolean).join(' · ');
        if (isPinned)
            sub = sub ? `${_('Pinned to panel')} · ${sub}` : _('Pinned to panel');
        else if (!sub)
            sub = _('Click an account to pin it to the panel');
        const subLabel = label(sub, `cu-hero-sub${isRec && !rec.blocked ? ' cu-brand-text' : ''}`);
        subLabel.clutter_text.line_wrap = true;
        titles.add_child(subLabel);
        head.add_child(titles);
        if (account.plan)
            head.add_child(label(account.plan, 'cu-plan', {y_align: Clutter.ActorAlign.START}));
        card.add_child(head);

        if (needsLogin || !usage) {
            const msg = needsLogin || !account.email
                ? (account.email ? error ?? _('Login required') : _('Waiting for login in the terminal…'))
                : error ?? _('Loading…');
            const msgLabel = label(msg, needsLogin || error ? 'cu-error' : 'cu-hero-sub');
            msgLabel.clutter_text.line_wrap = true;
            card.add_child(msgLabel);
            if ((needsLogin || !account.email) && !account.readOnly) {
                const btn = new St.Button({label: _('Log in'), style_class: 'cu-primary', can_focus: true, x_align: Clutter.ActorAlign.START});
                btn.connect('clicked', () => this._login(account));
                card.add_child(btn);
            }
            return card;
        }

        const tiles = new St.BoxLayout({style_class: 'cu-tiles'});
        tiles.add_child(this._tile(_('SESSION'), usage.session));
        tiles.add_child(this._tile(_('WEEK'), usage.weekly));
        card.add_child(tiles);

        for (const extra of usage.extras)
            card.add_child(this._extraRow(extra));

        const hint = insight(usage);
        if (hint) {
            const line = new St.BoxLayout({style_class: `cu-insight ${hint.cls}`});
            line.add_child(icon(hint.icon, 'cu-insight-icon', {y_align: Clutter.ActorAlign.START}));
            const text = label(hint.text, 'cu-insight-text', {x_expand: true});
            text.clutter_text.line_wrap = true;
            line.add_child(text);
            card.add_child(line);
        }
        if (error)
            card.add_child(label(error, 'cu-error'));

        const actions = new St.BoxLayout({style_class: 'cu-actions'});
        if (this._detailOpen) {
            actions.add_child(chip(_('Back'), 'go-previous-symbolic', () => {
                this._detailOpen = false;
                this._render();
            }));
        }
        actions.add_child(chip(_('Rename'), 'document-edit-symbolic', () => this._startRename(account, titles, nameLabel)));
        actions.add_child(chip(_('Copy'), 'edit-copy-symbolic', () => this._copy(shellCommandFor(account))));
        if (isPinned) {
            actions.add_child(chip(_('Unpin'), 'view-pin-symbolic', () => {
                this._detailOpen = false;
                this._pin(null);
            }));
        }
        card.add_child(actions);
        return card;
    }

    // Tile "SESSION 62% / bar / 16:00 · in 2h 12m".
    _tile(caption, win) {
        const tile = vbox('cu-tile', {x_expand: true});
        tile.add_child(label(caption, 'cu-tile-caption'));
        const value = new St.BoxLayout({style_class: 'cu-tile-value'});
        const pct = win ? Math.round(win.used) : null;
        value.add_child(label(pct === null ? '—' : `${pct}`, `cu-tile-number ${pct === null ? '' : severity(pct)}`));
        if (pct !== null)
            value.add_child(label('%', 'cu-tile-unit', {y_align: Clutter.ActorAlign.END}));
        tile.add_child(value);
        tile.add_child(bar(win?.used, TILE_BAR, 'cu-bar-tile'));
        let when;
        if (!win)
            when = _('no data');
        else if (!win.resetsAt)
            when = _('starts on next use');
        else
            when = `${formatResetAt(win.resetsAt, {short: true})} · ${_f('in {time}', {time: formatDuration(win.resetsAt - Date.now())})}`;
        tile.add_child(label(when, 'cu-tile-reset'));
        return tile;
    }

    // Per-model limits (e.g. Fable): a discreet row below the tiles.
    _extraRow(extra) {
        const row = new St.BoxLayout({style_class: 'cu-extra'});
        row.add_child(label(_f('Week {model}', {model: extra.label}), 'cu-extra-name', {x_expand: true}));
        row.add_child(bar(extra.used, EXTRA_BAR, 'cu-bar-row'));
        row.add_child(label(`${Math.round(extra.used)}%`, 'cu-extra-pct'));
        return row;
    }

    _startRename(account, titles, nameLabel) {
        const entry = new St.Entry({
            text: account.label ?? '',
            hint_text: account.email || _('Nickname'),
            style_class: 'cu-rename-entry',
            can_focus: true,
            x_expand: true,
        });
        titles.replace_child(nameLabel, entry);
        const hint = titles.get_child_at_index(1);
        hint.text = _('Enter saves · Esc cancels · empty restores the email');
        hint.style_class = 'cu-hero-sub';
        this._renaming = true;

        const finish = save => {
            if (!this._renaming)
                return;
            this._renaming = false;
            if (save)
                this._manager.store.update(account.id, {label: entry.text.trim()});
            this._render();
        };
        entry.clutter_text.connect('activate', () => finish(true));
        entry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            finish(false);
            return Clutter.EVENT_STOP;
        });
        entry.clutter_text.set_selection(0, -1);
        entry.grab_key_focus();
    }

    _accountRow(entry, rec) {
        const {account, usage, needsLogin} = entry;
        const isPinned = this._pinnedAccount()?.id === account.id;
        const row = new St.BoxLayout({style_class: 'cu-row', x_expand: true, x_align: Clutter.ActorAlign.FILL});
        row.add_child(avatar(account));

        // Window that is blocking the account; its reset time, next to the mini bar, says when it frees up.
        let blockedBy = null;
        if (usage?.weekly?.used >= 99)
            blockedBy = 'weekly';
        else if (usage?.session?.used >= 97)
            blockedBy = 'session';

        const titles = vbox('cu-row-titles', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const nameLine = new St.BoxLayout({style_class: 'cu-row-name-line'});
        nameLine.add_child(label(displayName(account), 'cu-row-name'));
        if (blockedBy && !needsLogin) {
            const win = usage[blockedBy];
            const when = win.resetsAt ? formatResetAt(win.resetsAt) : '—';
            nameLine.add_child(addTooltip(icon('alarm-symbolic', 'cu-row-blocked'), blockedBy === 'weekly'
                ? _f('Weekly limit reached — frees up {when}', {when})
                : _f('Session limit reached — frees up {when}', {when})));
        }
        if (rec && !rec.blocked && rec.account.id === account.id)
            nameLine.add_child(addTooltip(icon('starred-symbolic', 'cu-star'), _('Suggested')));
        if (isPinned)
            nameLine.add_child(addTooltip(icon('view-pin-symbolic', 'cu-pin'), _('Pinned to panel')));
        titles.add_child(nameLine);

        let sub = account.plan || '';
        let subClass = 'cu-row-sub';
        if (account.include === false)
            sub += ` · ${_('excluded from suggestion')}`;
        if (needsLogin || !account.email) {
            sub = account.email ? _('login required') : _('waiting for login');
            subClass += ' cu-warn';
        } else if (!usage && entry.error) {
            sub = entry.error;
        }
        titles.add_child(label(sub, subClass));
        row.add_child(titles);

        if (usage && !needsLogin) {
            const meters = vbox('cu-row-meters', {y_align: Clutter.ActorAlign.CENTER});
            for (const [key, tag, win] of [['session', '5h', usage.session], ['weekly', '7d', usage.weekly]]) {
                const line = new St.BoxLayout({style_class: 'cu-row-meter'});
                line.add_child(label(tag, 'cu-row-tag'));
                line.add_child(bar(win?.used, ROW_BAR, 'cu-bar-row'));
                line.add_child(label(win ? `${Math.round(win.used)}%` : '—', `cu-row-pct ${win ? severity(win.used) : ''}`));
                line.add_child(label(win?.resetsAt ? formatResetAt(win.resetsAt, {short: true}) : '—',
                    `cu-row-reset${key === blockedBy ? ' cu-row-reset-blocked' : ''}`));
                meters.add_child(line);
            }
            row.add_child(meters);
        } else if (needsLogin || !account.email) {
            row.add_child(icon('dialog-warning-symbolic', 'cu-row-warning'));
        }

        const button = new St.Button({
            style_class: `cu-row-button${isPinned ? ' cu-row-pinned' : ''}`,
            child: row,
            x_expand: true,
            can_focus: true,
        });
        button.connect('clicked', () => {
            if (this._settings.get_string('popup-layout') === 'compact')
                this._detailOpen = true;
            this._pin(account.id);
        });
        return button;
    }

    _footer() {
        const footer = new St.BoxLayout({style_class: 'cu-footer'});
        let status = '';
        const hhmm = ts => GLib.DateTime.new_from_unix_local(Math.floor(ts / 1000)).format('%H:%M');
        if (this._manager.loading)
            status = _('Refreshing…');
        else if (this._manager.lastRefresh)
            status = _f('Updated {time}', {time: hhmm(this._manager.lastRefresh)});
        const limitedUntil = this._manager.rateLimitedUntil();
        if (limitedUntil)
            status += `${status ? ' · ' : ''}${_f('API frees up at {time}', {time: hhmm(limitedUntil)})}`;
        footer.add_child(label(status, 'cu-footer-status', {x_expand: true}));
        footer.add_child(chip(_('Usage page'), 'adw-external-link-symbolic', () => {
            this.menu.close();
            Gio.AppInfo.launch_default_for_uri(USAGE_PAGE, null);
        }, 'cu-chip-flat'));
        footer.add_child(iconButton('emblem-system-symbolic', _('Settings'), () => {
            this.menu.close();
            this._ext.openPreferences();
        }));
        return footer;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._manager.disconnectChanged(this._changedCb);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._manager.destroy();
        this.button.destroy();
    }
}

export default class ClaudeUsageExtension extends Extension {
    enable() {
        initI18n(this);
        // A button left behind by an instance that never got disabled (e.g. one
        // whose enable() failed) would make addToStatusArea throw.
        Main.panel.statusArea[this.uuid]?.destroy();
        this._indicator = new Indicator(this);
        try {
            Main.panel.addToStatusArea(this.uuid, this._indicator.button);
        } catch (e) {
            // The Shell won't call disable() for an extension whose enable()
            // failed: undo everything here so no timer survives.
            this._indicator.destroy();
            this._indicator = null;
            destroyI18n();
            throw e;
        }
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        destroyI18n();
    }
}

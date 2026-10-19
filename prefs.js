import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {AccountStore, displayName, effectiveWeight, hasCredentials, isEnabled} from './lib/accounts.js';
import {LANGUAGES, _, _f, initI18n} from './lib/i18n.js';
import {findClaude, launchLogin} from './lib/launcher.js';

// Shows paths under the home folder as ~/…
function tildify(path) {
    const home = GLib.get_home_dir();
    return path?.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        await initI18n(this);
        window.set_default_size(640, 720);
        window.add(this._accountsPage(window, settings));
        window.add(this._generalPage(settings));
    }

    _accountsPage(window, settings) {
        const store = new AccountStore(settings);
        const page = new Adw.PreferencesPage({title: _('Accounts'), icon_name: 'system-users-symbolic'});

        const group = new Adw.PreferencesGroup({
            title: _('Claude accounts'),
            description: _('Each account has its own session folder (CLAUDE_CONFIG_DIR). Logging in opens a terminal running "claude auth login".'),
        });
        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: _('Add account')}),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => {
            const account = store.create();
            if (!this._login(window, settings, account))
                store.remove(account.id);
        });
        group.set_header_suffix(addButton);
        page.add(group);

        const linkGroup = new Adw.PreferencesGroup({
            title: _('Link an existing folder'),
            description: _('Track an account already logged in elsewhere (e.g. the default ~/.claude used by Claude Code). It stays read-only: the token is renewed by whoever uses the folder, not by the extension.'),
        });
        const defaultDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const linkRow = new Adw.ActionRow({title: _('Claude Code folder'), subtitle: _('Must contain .credentials.json')});
        const linkDefault = new Gtk.Button({label: _('Link ~/.claude'), valign: Gtk.Align.CENTER});
        linkDefault.connect('clicked', () => this._link(window, store, defaultDir));
        const linkOther = new Gtk.Button({label: _('Choose folder…'), valign: Gtk.Align.CENTER});
        linkOther.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Claude folder (CLAUDE_CONFIG_DIR)'), initial_folder: Gio.File.new_for_path(GLib.get_home_dir())});
            dialog.select_folder(window, null, (d, res) => {
                try {
                    this._link(window, store, d.select_folder_finish(res).get_path());
                } catch {
                    // cancelled
                }
            });
        });
        linkRow.add_suffix(linkDefault);
        linkRow.add_suffix(linkOther);
        linkGroup.add(linkRow);
        page.add(linkGroup);

        const helpGroup = new Adw.PreferencesGroup({
            title: _('Using an account in the terminal'),
            description: _('Run Claude Code pointing at the account folder, for example:\nCLAUDE_CONFIG_DIR=&lt;folder&gt; claude\n“Copy” in the panel menu copies this command.'),
        });
        page.add(helpGroup);

        let rows = [];
        const rebuild = () => {
            // Don't rebuild while the user is typing a nickname.
            if (rows.some(r => r._editing))
                return;
            rows.forEach(r => group.remove(r));
            rows = [];
            const accounts = store.list();
            if (!accounts.length) {
                const empty = new Adw.ActionRow({
                    title: _('No accounts yet'),
                    subtitle: _('Click “Add account” and log in in the terminal that opens.'),
                });
                group.add(empty);
                rows.push(empty);
            }
            accounts.forEach((account, i) => {
                const row = this._accountRow(window, settings, store, account, i, accounts.length);
                group.add(row);
                rows.push(row);
            });
        };
        const id = settings.connect('changed::accounts', rebuild);
        window.connect('close-request', () => {
            settings.disconnect(id);
            return false;
        });
        rebuild();
        return page;
    }

    _accountRow(window, settings, store, account, index, total) {
        const logged = hasCredentials(account);
        const enabled = isEnabled(account);
        const subtitleParts = [];
        if (!enabled)
            subtitleParts.push(_('disabled'));
        if (account.label && account.email)
            subtitleParts.push(account.email);
        if (account.plan)
            subtitleParts.push(account.plan);
        if (account.orgName && !account.orgName.endsWith("'s Organization"))
            subtitleParts.push(account.orgName);
        if (!logged)
            subtitleParts.push(_('login pending'));
        if (account.readOnly)
            subtitleParts.push(_('linked (read-only)'));

        const row = new Adw.ExpanderRow({
            title: GLib.markup_escape_text(displayName(account), -1),
            subtitle: GLib.markup_escape_text(subtitleParts.join(' · '), -1),
        });
        if (!logged && enabled)
            row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic', css_classes: ['warning']}));

        // Disabling keeps the login and settings, but removes the account from the menu and from fetching.
        const enabledSwitch = new Gtk.Switch({
            active: enabled,
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Disabled accounts are not refreshed or shown, but keep their login and settings'),
        });
        enabledSwitch.connect('notify::active', () => store.update(account.id, {enabled: enabledSwitch.active}));
        row.add_suffix(enabledSwitch);

        const labelRow = new Adw.EntryRow({title: _('Nickname (optional)'), text: account.label ?? '', show_apply_button: true});
        labelRow.connect('changed', () => {
            row._editing = true;
        });
        labelRow.connect('apply', () => {
            row._editing = false;
            store.update(account.id, {label: labelRow.text.trim()});
        });
        row.add_row(labelRow);

        const includeRow = new Adw.SwitchRow({
            title: _('Include in suggestion'),
            subtitle: _('Turn off for accounts you only want to monitor'),
            active: account.include !== false,
        });
        includeRow.connect('notify::active', () => store.update(account.id, {include: includeRow.active}));
        row.add_row(includeRow);

        const weightRow = new Adw.SpinRow({
            title: _('Capacity weight'),
            subtitle: _f('How much this account is worth compared to a Pro (0 = automatic: {weight})', {weight: effectiveWeight({...account, weight: 0})}),
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 0.25, page_increment: 1, value: account.weight ?? 0}),
        });
        weightRow.connect('notify::value', () => store.update(account.id, {weight: weightRow.value}));
        row.add_row(weightRow);

        const dirRow = new Adw.ActionRow({
            title: _('Session folder'),
            subtitle: GLib.markup_escape_text(tildify(account.configDir), -1),
            subtitle_selectable: true,
        });
        const openDir = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: _('Open folder')});
        openDir.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(account.configDir, null), null));
        dirRow.add_suffix(openDir);
        row.add_row(dirRow);

        const actions = new Adw.ActionRow({title: _('Actions')});
        const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        const up = new Gtk.Button({icon_name: 'go-up-symbolic', sensitive: index > 0, tooltip_text: _('Move up'), css_classes: ['flat']});
        up.connect('clicked', () => store.move(account.id, -1));
        const down = new Gtk.Button({icon_name: 'go-down-symbolic', sensitive: index < total - 1, tooltip_text: _('Move down'), css_classes: ['flat']});
        down.connect('clicked', () => store.move(account.id, 1));
        const login = new Gtk.Button({label: logged ? _('Log in again') : _('Log in')});
        login.connect('clicked', () => this._login(window, settings, account));
        const remove = new Gtk.Button({label: _('Remove'), css_classes: ['destructive-action']});
        remove.connect('clicked', () => this._confirmRemove(window, store, account));
        login.visible = !account.readOnly;
        [up, down, login, remove].forEach(b => box.append(b));
        actions.add_suffix(box);
        row.add_row(actions);

        return row;
    }

    _login(window, settings, account) {
        try {
            launchLogin(settings, account);
            return true;
        } catch (e) {
            window.add_toast(new Adw.Toast({title: e.message, timeout: 6}));
            return false;
        }
    }

    _link(window, store, dir) {
        if (store.list().some(a => a.configDir === dir)) {
            window.add_toast(new Adw.Toast({title: _('This folder is already registered')}));
            return;
        }
        if (!GLib.file_test(GLib.build_filenamev([dir, '.credentials.json']), GLib.FileTest.EXISTS)) {
            window.add_toast(new Adw.Toast({title: _('No .credentials.json in this folder — log in there first'), timeout: 6}));
            return;
        }
        store.create(dir);
    }

    _confirmRemove(window, store, account) {
        const dialog = new Adw.AlertDialog({
            heading: _f('Remove {name}?', {name: displayName(account)}),
            body: account.readOnly
                ? _('The account will no longer be tracked. The linked folder is not changed.')
                : _('The saved session for this account (folder and credentials) will be deleted. This does not log out other places where the account is in use.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('remove', _('Remove'));
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response === 'remove')
                store.remove(account.id);
        });
        dialog.present(window);
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});

        const panel = new Adw.PreferencesGroup({title: _('Panel')});
        const modes = [
            ['full', _('Percent + reset time')],
            ['named', _('Name + percent + reset')],
            ['percent', _('Percent only')],
            ['icon', _('Icon only')],
        ];
        const modeRow = new Adw.ComboRow({
            title: _('Show in panel'),
            subtitle: _('Pinned account, or the suggested one'),
            model: Gtk.StringList.new(modes.map(m => m[1])),
            selected: Math.max(0, modes.findIndex(m => m[0] === settings.get_string('panel-mode'))),
        });
        modeRow.connect('notify::selected', () => settings.set_string('panel-mode', modes[modeRow.selected][0]));
        panel.add(modeRow);

        const languageRow = new Adw.ComboRow({
            title: _('Language'),
            subtitle: _('Reopen the preferences to apply it here; the panel menu updates right away'),
            model: Gtk.StringList.new(LANGUAGES.map(([, name]) => name ?? _('Automatic (system)'))),
            selected: Math.max(0, LANGUAGES.findIndex(([code]) => code === settings.get_string('language'))),
        });
        languageRow.connect('notify::selected', () => settings.set_string('language', LANGUAGES[languageRow.selected][0]));
        panel.add(languageRow);

        const metrics = [['session', _('Session (5h)')], ['weekly', _('Week (7d)')], ['both', _('Both')]];
        const metricsRow = new Adw.ComboRow({
            title: _('Percentages in panel'),
            model: Gtk.StringList.new(metrics.map(m => m[1])),
            selected: Math.max(0, metrics.findIndex(m => m[0] === settings.get_string('panel-metrics'))),
        });
        metricsRow.connect('notify::selected', () => settings.set_string('panel-metrics', metrics[metricsRow.selected][0]));
        panel.add(metricsRow);

        const layouts = [['detailed', _('Detailed')], ['compact', _('Compact')]];
        const layoutRow = new Adw.ComboRow({
            title: _('Menu layout'),
            subtitle: _('You can also switch it right in the menu'),
            model: Gtk.StringList.new(layouts.map(m => m[1])),
            selected: Math.max(0, layouts.findIndex(m => m[0] === settings.get_string('popup-layout'))),
        });
        layoutRow.connect('notify::selected', () => settings.set_string('popup-layout', layouts[layoutRow.selected][0]));
        panel.add(layoutRow);

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh every (minutes)'),
            subtitle: _('Short intervals may hit the API rate limit'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 120, step_increment: 1, page_increment: 5}),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        panel.add(intervalRow);

        const notifyRow = new Adw.SwitchRow({
            title: _('Notify when the suggestion changes'),
        });
        settings.bind('notify-recommendation', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panel.add(notifyRow);
        page.add(panel);

        const advanced = new Adw.PreferencesGroup({title: _('Advanced')});
        const claudeRow = new Adw.EntryRow({
            title: _f('claude executable (detected: {path})', {path: tildify(findClaude({get_string: () => ''})) ?? _('not found')}),
            show_apply_button: true,
        });
        settings.bind('claude-path', claudeRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        advanced.add(claudeRow);

        const termRow = new Adw.EntryRow({
            title: _('Terminal command (e.g. ptyxis --new-window --)'),
            show_apply_button: true,
        });
        settings.bind('terminal-command', termRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        advanced.add(termRow);
        page.add(advanced);

        return page;
    }
}

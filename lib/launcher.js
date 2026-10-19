// Opens a terminal running `claude auth login` with CLAUDE_CONFIG_DIR pointing
// at the account folder. The CLI itself runs the OAuth flow and writes
// .credentials.json; the extension notices the file and fetches the profile.

import GLib from 'gi://GLib';

import {_} from './i18n.js';

const TERMINALS = [
    ['xdg-terminal-exec'],
    ['ptyxis', '--new-window', '--'],
    ['gnome-terminal', '--'],
    ['kgx', '--'],
    ['konsole', '-e'],
    ['x-terminal-emulator', '-e'],
];

export function findClaude(settings) {
    const custom = settings.get_string('claude-path');
    if (custom)
        return custom;
    const candidates = [
        GLib.find_program_in_path('claude'),
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']),
        GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'local', 'claude']),
    ];
    return candidates.find(p => p && GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

function terminalArgv(settings) {
    const custom = settings.get_string('terminal-command');
    if (custom) {
        const [, argv] = GLib.shell_parse_argv(custom);
        return argv;
    }
    for (const [bin, ...args] of TERMINALS) {
        const path = GLib.find_program_in_path(bin);
        if (path)
            return [path, ...args];
    }
    return null;
}

export function shellCommandFor(account) {
    return `CLAUDE_CONFIG_DIR=${GLib.shell_quote(account.configDir)} claude`;
}

export function launchLogin(settings, account) {
    const claude = findClaude(settings);
    if (!claude)
        throw new Error(_('The "claude" executable was not found. Set its path in the preferences.'));
    const terminal = terminalArgv(settings);
    if (!terminal)
        throw new Error(_('No terminal found. Set the terminal command in the preferences.'));

    // Terminals like ptyxis/gnome-terminal reuse an already running instance and
    // don't inherit our environment, so the folder (and the translated messages)
    // are passed as script arguments.
    const script = [
        'export CLAUDE_CONFIG_DIR="$3"',
        'printf "\\033]0;Claude login\\007"',
        'echo "$4 $CLAUDE_CONFIG_DIR"',
        'echo',
        'if [ -n "$2" ]; then "$1" auth login --email "$2"; else "$1" auth login; fi',
        'status=$?',
        'echo',
        '[ $status -eq 0 ] && echo "$5" || echo "$6 ($status)"',
        'echo "$7"',
        'read _',
    ].join('\n');

    GLib.spawn_async(
        GLib.get_home_dir(),
        [...terminal, 'sh', '-c', script, 'claude-login', claude, account.email ?? '', account.configDir,
            _('Claude account login — folder:'),
            _('Done! The extension will detect the account in a moment.'),
            _('Login failed'),
            _('Press Enter to close.')],
        null,
        GLib.SpawnFlags.SEARCH_PATH,
        null);
}

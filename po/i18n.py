#!/usr/bin/env python3
"""Minimal translation tool that doesn't need the system gettext package.

    python3 po/i18n.py extract   # updates po/claude-juggler.pot and merges it into the .po files
    python3 po/i18n.py compile   # builds locale/<lang>/LC_MESSAGES/claude-juggler.mo

Extracts _('...') and _f('...', ...) calls with single-quoted strings.
"""

import re
import struct
import sys
from pathlib import Path

DOMAIN = 'claude-juggler'
ROOT = Path(__file__).resolve().parent.parent
PO_DIR = ROOT / 'po'
SOURCES = ['extension.js', 'prefs.js', 'lib/*.js']
CALL = re.compile(r"\b_f?\(\s*'((?:[^'\\]|\\.)*)'")
HEADER = ('Content-Type: text/plain; charset=UTF-8\n'
          'Content-Transfer-Encoding: 8bit\n')


def js_unescape(s):
    return re.sub(r"\\(.)", lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), s)


def po_escape(s):
    return s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\t', '\\t')


def po_unescape(s):
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), s)


def extract():
    found = {}
    for pattern in SOURCES:
        for path in sorted(ROOT.glob(pattern)):
            text = path.read_text(encoding='utf-8')
            for m in CALL.finditer(text):
                line = text.count('\n', 0, m.start()) + 1
                found.setdefault(js_unescape(m.group(1)), []).append(f'{path.relative_to(ROOT)}:{line}')
    return found


def read_po(path):
    entries, key, cur = {}, None, {}
    for raw in path.read_text(encoding='utf-8').splitlines() + ['']:
        line = raw.strip()
        if line.startswith('msgid '):
            cur, key = {'msgid': po_unescape(line[7:-1])}, 'msgid'
        elif line.startswith('msgstr '):
            cur['msgstr'], key = po_unescape(line[8:-1]), 'msgstr'
        elif line.startswith('"') and key:
            cur[key] += po_unescape(line[1:-1])
        elif not line and 'msgstr' in cur:
            entries[cur['msgid']] = cur['msgstr']
            cur, key = {}, None
    return entries


def write_po(path, messages, translations, lang):
    out = ['# Claude Juggler — GNOME Shell extension', '#', 'msgid ""', 'msgstr ""']
    header = translations.get('', HEADER)
    if lang and 'Language:' not in header:
        header += f'Language: {lang}\n'
    out += [f'"{po_escape(line)}\\n"' for line in header.splitlines()]
    for msgid, refs in messages.items():
        out += ['', f'#: {" ".join(refs)}', f'msgid "{po_escape(msgid)}"',
                f'msgstr "{po_escape(translations.get(msgid, ""))}"']
    path.write_text('\n'.join(out) + '\n', encoding='utf-8')


def cmd_extract():
    messages = extract()
    write_po(PO_DIR / f'{DOMAIN}.pot', messages, {}, None)
    for po in sorted(PO_DIR.glob('*.po')):
        old = read_po(po)
        write_po(po, messages, old, po.stem)
        missing = [m for m in messages if not old.get(m)]
        print(f'{po.name}: {len(messages) - len(missing)}/{len(messages)} translated')
        for m in missing:
            print(f'   missing: {m!r}')
    print(f'{len(messages)} messages in {DOMAIN}.pot')


def write_mo(path, catalog):
    keys = sorted(catalog)
    ids = [k.encode('utf-8') for k in keys]
    strs = [catalog[k].encode('utf-8') for k in keys]
    n = len(keys)
    orig_tab, trans_tab = 28, 28 + n * 8
    data_start = 28 + n * 16
    blob, orig, trans = b'', [], []
    for s in ids:
        orig.append((len(s), data_start + len(blob)))
        blob += s + b'\0'
    for s in strs:
        trans.append((len(s), data_start + len(blob)))
        blob += s + b'\0'
    head = struct.pack('<7I', 0x950412de, 0, n, orig_tab, trans_tab, 0, data_start)
    tables = b''.join(struct.pack('<2I', *e) for e in orig + trans)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(head + tables + blob)


def cmd_compile():
    for po in sorted(PO_DIR.glob('*.po')):
        catalog = {k: v for k, v in read_po(po).items() if v}
        catalog.setdefault('', HEADER)
        write_mo(ROOT / 'locale' / po.stem / 'LC_MESSAGES' / f'{DOMAIN}.mo', catalog)
        print(f'{po.stem}: {len(catalog) - 1} messages')


if __name__ == '__main__':
    {'extract': cmd_extract, 'compile': cmd_compile}[sys.argv[1] if len(sys.argv) > 1 else 'extract']()

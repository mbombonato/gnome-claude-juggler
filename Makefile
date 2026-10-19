UUID = claude-juggler@mbombonato.github.io

.PHONY: install pack schemas translations pot reload

schemas:
	glib-compile-schemas schemas

# Updates po/claude-juggler.pot and merges it into the .po files (lists what's missing)
pot:
	python3 po/i18n.py extract

translations:
	python3 po/i18n.py compile

install:
	./install.sh

# Reloads in the current session without logging out (needs unsafe mode; see dev-reload.sh)
reload:
	./dev-reload.sh

# Builds the .zip to install with `gnome-extensions install` or upload to extensions.gnome.org.
# `pack` tries to compile po/ with the system msgfmt and owns the locale/ folder,
# so it gets an empty po dir and the compiled .mo files are added to the zip afterwards.
pack: translations
	mkdir -p dist build/no-po
	gnome-extensions pack --force --podir=build/no-po --extra-source=lib --extra-source=icons --extra-source=base.css --extra-source=stylesheet-dark.css --extra-source=stylesheet-light.css --out-dir=dist .
	python3 -c "import zipfile,pathlib; z=zipfile.ZipFile('dist/$(UUID).shell-extension.zip','a'); [z.write(p) for p in sorted(pathlib.Path('locale').rglob('*.mo'))]"

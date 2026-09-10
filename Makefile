UUID := exchangebar@oflifurkan
SCHEMA := schemas/org.gnome.shell.extensions.exchangebar.gschema.xml
DIST := dist

.PHONY: all schemas test test-dolartoday test-xaus check pack install clean

all: check

schemas:
	glib-compile-schemas schemas

test:
	gjs -m tests/run.js

test-dolartoday:
	gjs -m tests/dolarToday.live.js

test-xaus:
	gjs -m tests/xaus.live.js

check: test
	jq empty metadata.json
	xmllint --noout $(SCHEMA)
	glib-compile-schemas --strict --dry-run schemas

pack: check schemas
	mkdir -p $(DIST)
	gnome-extensions pack --force --out-dir=$(DIST) \
		--schema=$(SCHEMA) \
		--extra-source=src --extra-source=prefs .

install: pack
	gnome-extensions install --force $(DIST)/$(UUID).shell-extension.zip

clean:
	rm -f schemas/gschemas.compiled
	rm -rf $(DIST)

UUID := exchangebar@oflifurkan
SCHEMA := schemas/org.gnome.shell.extensions.exchangebar.gschema.xml
DIST := dist
PACKAGE := $(DIST)/$(UUID).shell-extension.zip

.PHONY: all schemas lint test test-prefs test-release test-dolartoday \
	test-xaus check pack verify-package install clean

all: check

schemas:
	glib-compile-schemas schemas

lint:
	./node_modules/.bin/eslint . --max-warnings=0

test:
	gjs -m tests/run.js

test-prefs: schemas
	GSETTINGS_BACKEND=memory xvfb-run -a gjs -m tests/preferences.smoke.js

test-release:
	bash tests/release.test.sh

test-dolartoday:
	gjs -m tests/dolarToday.live.js

test-xaus:
	gjs -m tests/xaus.live.js

check: lint test test-prefs test-release
	jq -e 'type == "object" and (.uuid == "$(UUID)") and (."version-name" | type == "string") and (."shell-version" | index("50") != null)' metadata.json >/dev/null
	xmllint --noout $(SCHEMA)
	glib-compile-schemas --strict --dry-run schemas

pack: check schemas
	mkdir -p $(DIST)
	gnome-extensions pack --force --out-dir=$(DIST) \
		--schema=$(SCHEMA) \
		--extra-source=src --extra-source=prefs .
	zip -q $(PACKAGE) schemas/gschemas.compiled
	$(MAKE) verify-package

verify-package:
	bash scripts/verify-package.sh $(PACKAGE)

install: pack
	gnome-extensions install --force $(PACKAGE)

clean:
	rm -f schemas/gschemas.compiled
	rm -rf $(DIST)

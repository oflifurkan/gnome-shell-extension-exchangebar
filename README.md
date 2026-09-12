# ExchangeBar

ExchangeBar is a GNOME Shell 50 extension that displays USD/TRY, EUR/TRY, and
gram-gold/TRY prices in the top panel.

Version 0.1 is being built incrementally. The current implementation contains
the extension shell, a provider-independent market pipeline, and an offline
converter for TRY, USD, EUR, and gold grams. Live free-market USD/TRY and
EUR/TRY values come from the keyless DolarToday API; gram gold comes from the
keyless XAUS spot API.

## Requirements

- GNOME Shell 50
- GJS with modern ES-module support
- GTK 4 and Libadwaita (preferences)
- `glib-compile-schemas`, `jq`, `xmllint`, `zip`, and `unzip` for development
  checks and packaging
- Node.js and npm for ESLint
- Xvfb for the headless preferences smoke test

## Develop

Run all tests and validation:

```sh
npm ci
make check
```

Build an installable extension archive:

```sh
make pack
```

Install the archive for the current user:

```sh
make install
```

Log out and back in if GNOME Shell does not discover a newly installed
extension, then enable `exchangebar@oflifurkan` with Extensions or the
`gnome-extensions` command.

## Architecture

Providers return only normalized ExchangeBar quotes. `MarketService` owns
provider instances and market state; the panel and popup consume that service
and never access provider payloads. Currency and gold provider IDs are stored
independently so later releases can mix data sources. Converter mathematics
also consume only normalized quotes and have no dependency on Shell UI code.
Market data refreshes ten minutes after each completed update attempt, and the
popup provides a manual refresh action that resets that countdown. Successful
snapshots are cached under the user's XDG cache directory. A compatible cached
snapshot is shown immediately after startup; stale values remain available and
are visually distinguished while ExchangeBar retries in the background.

## Test live providers

DolarToday and XAUS are free and keyless. Optional live provider checks are
available:

```sh
make test-dolartoday
make test-xaus
```

DolarToday is the default FX provider and XAUS is the default gold provider.
To switch between live and deterministic data during development:

```sh
dconf write /org/gnome/shell/extensions/exchangebar/fx-provider "'dolar-today'"
dconf write /org/gnome/shell/extensions/exchangebar/fx-provider "'fake'"
dconf write /org/gnome/shell/extensions/exchangebar/gold-provider "'xaus'"
dconf write /org/gnome/shell/extensions/exchangebar/gold-provider "'fake'"
```

The preferences window provides the same FX and gold provider selectors,
10/15/30/60-minute refresh intervals, instrument visibility, decimal precision,
panel placement on the right or in the center beside the clock, and a
DolarToday source selector for Free Market or TCMB rates. Changes take effect
while the extension is running; restarting GNOME Shell is not required.

## Continuous integration

GitHub Actions runs ESLint, the GJS unit tests, strict metadata and schema
validation, a headless GTK/Libadwaita preferences smoke test, and extension
packaging for pull requests and pushes to `main`. Successful builds are kept as
downloadable workflow artifacts for 14 days. Live provider checks remain
manual so an external service outage cannot block a build.

## Release

Releases use stable semantic tags and must come from `main`. To publish a
release:

1. Update `version-name` in `metadata.json`, for example to `0.2.0`.
2. Merge and push that change to `main`, then wait for CI to pass.
3. Create and push the matching tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The tag workflow rejects malformed tags, version mismatches, and commits that
are not part of `main`. A valid tag publishes a GitHub Release with generated
notes, a versioned `.shell-extension.zip`, and its SHA-256 checksum. It does not
publish to extensions.gnome.org.

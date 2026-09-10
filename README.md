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
- `glib-compile-schemas`, `jq`, and `xmllint` for development checks

## Develop

Run all tests and validation:

```sh
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

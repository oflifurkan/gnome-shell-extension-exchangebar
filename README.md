# ExchangeBar

ExchangeBar is a GNOME Shell 50 extension that displays USD/TRY, EUR/TRY, and
gram-gold/TRY prices in the top panel.

Version 0.1 is being built incrementally. The current implementation contains
the extension shell and a provider-independent market pipeline backed by a
deterministic fake provider. It does not make network requests yet.

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
independently so later releases can mix data sources.

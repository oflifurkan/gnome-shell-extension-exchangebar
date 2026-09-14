# ExchangeBar

**Exchange rates and gram-gold prices, right in the GNOME Shell panel.**

ExchangeBar is a GNOME Shell 50 extension for keeping an eye on USD/TRY,
EUR/TRY, and gram-gold/TRY without leaving the desktop. Open the panel menu for
a fuller view, a quick currency/gold converter, and a one-click refresh.

[View the project on GitHub](https://github.com/oflifurkan/gnome-shell-extension-exchangebar)

## Highlights

- Shows USD/TRY, EUR/TRY, and gram gold in the top panel.
- Places the indicator on the right or beside the clock.
- Lets you show or hide each instrument and choose its decimal precision.
- Includes a compact converter for TRY, USD, EUR, and gold grams.
- Uses free, keyless providers: DolarToday for FX and XAUS for gold.
- Supports DolarToday Free Market and TCMB rate sources.
- Keeps the last compatible snapshot available when starting up or when a
  provider is temporarily unavailable, clearly marking stale values.
- Refreshes automatically every 10, 15, 30, or 60 minutes, with manual refresh
  available from the popup.

## Requirements

- GNOME Shell 50
- GTK 4 and Libadwaita (for Preferences)

For local development, you will also need GJS with ES-module support,
`glib-compile-schemas`, `jq`, `xmllint`, `zip`, `unzip`, Node.js/npm, and Xvfb.

## Install from source

Clone the repository, install the JavaScript development dependencies, then
build and install the extension for your user account:

```sh
git clone https://github.com/oflifurkan/gnome-shell-extension-exchangebar.git
cd gnome-shell-extension-exchangebar
npm ci
make install
```

Enable **ExchangeBar** in the Extensions app, or run:

```sh
gnome-extensions enable exchangebar@oflifurkan
```

If the extension does not appear immediately after installation, log out and
back in, then enable it again.

## Install a release

Ready-to-use extension archives are attached to
[GitHub Releases](https://github.com/oflifurkan/gnome-shell-extension-exchangebar/releases).
Download the `.shell-extension.zip` asset from the latest release and install
it with the Extensions app, or from a terminal:

```sh
gnome-extensions install --force ~/Downloads/exchangebar-*.shell-extension.zip
gnome-extensions enable exchangebar@oflifurkan
```

With the [GitHub CLI](https://cli.github.com/), the latest archive can be
downloaded and enabled entirely from the terminal:

```sh
mkdir exchangebar-release && cd exchangebar-release
gh release download --repo oflifurkan/gnome-shell-extension-exchangebar \
  --pattern '*.shell-extension.zip'
gnome-extensions install --force ./*.shell-extension.zip
gnome-extensions enable exchangebar@oflifurkan
```

Log out and back in if GNOME Shell does not discover the newly installed
extension straight away.

## Use

Click an ExchangeBar value in the top panel to open its menu. The menu shows
the latest quotes, their source and update status, a refresh button, and the
converter. Open the extension's Preferences from the Extensions app to adjust
panel placement, visible instruments, formatting, refresh frequency, and data
sources. Changes take effect while the extension is running.

> Market prices are informational and may be delayed or unavailable. They are
> not financial advice.

## Data sources

ExchangeBar does not require an API key. By default it obtains USD/TRY and
EUR/TRY from [DolarToday](https://dolartoday.org/) and gram-gold/TRY from
[XAUS](https://xaus.com/). Provider selections are independent, and the
preferences window also offers deterministic fake providers for development.

## Develop

Run the full local validation suite:

```sh
npm ci
make check
```

Build an installable archive without installing it:

```sh
make pack
```

Optional live checks exercise the public providers:

```sh
make test-dolartoday
make test-xaus
```

## License

This project is licensed under the terms in [LICENSE](LICENSE).

#!/usr/bin/env bash

set -euo pipefail

archive=${1:?Usage: verify-package.sh ARCHIVE}

if [[ ! -f ${archive} ]]; then
    echo "Package does not exist: ${archive}" >&2
    exit 1
fi

unzip -tqq "${archive}"
mapfile -t entries < <(unzip -Z1 "${archive}")

required_entries=(
    extension.js
    metadata.json
    prefs.js
    stylesheet.css
    schemas/gschemas.compiled
    schemas/org.gnome.shell.extensions.exchangebar.gschema.xml
    src/core/marketService.js
    src/providers/dolarToday.js
    src/providers/xaus.js
    src/ui/indicator.js
)

for required in "${required_entries[@]}"; do
    found=false
    for entry in "${entries[@]}"; do
        if [[ ${entry} == "${required}" ]]; then
            found=true
            break
        fi
    done
    if [[ ${found} == false ]]; then
        echo "Package is missing required entry: ${required}" >&2
        exit 1
    fi
done

for entry in "${entries[@]}"; do
    case ${entry} in
        dist/*|node_modules/*|tests/*|.github/*)
            echo "Package contains development-only entry: ${entry}" >&2
            exit 1
            ;;
    esac
done

echo "package verification passed: ${archive}"

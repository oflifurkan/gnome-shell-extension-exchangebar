#!/usr/bin/env bash

set -euo pipefail

version=$(jq -r '."version-name"' metadata.json)
tag="v${version}"

bash scripts/validate-release.sh "${tag}" HEAD HEAD

if bash scripts/validate-release.sh release-1 HEAD HEAD >/dev/null 2>&1; then
    echo 'Malformed release tag was accepted' >&2
    exit 1
fi

if bash scripts/validate-release.sh v999.0.0 HEAD HEAD >/dev/null 2>&1; then
    echo 'Mismatched release tag was accepted' >&2
    exit 1
fi

root_commit=$(git rev-list --max-parents=0 HEAD)
if [[ ${root_commit} != "$(git rev-parse HEAD)" ]] &&
    bash scripts/validate-release.sh "${tag}" "${root_commit}" HEAD \
        >/dev/null 2>&1; then
    echo 'Release commit outside the selected main ref was accepted' >&2
    exit 1
fi

if output=$(bash scripts/validate-release.sh \
    "${tag}" refs/remotes/origin/missing HEAD 2>&1); then
    echo 'Missing main ref was accepted' >&2
    exit 1
fi
if [[ ${output} != *"Unable to compare release commit"* ]]; then
    echo 'Git comparison failure was reported as an ancestry mismatch' >&2
    exit 1
fi

echo 'release validation tests passed'

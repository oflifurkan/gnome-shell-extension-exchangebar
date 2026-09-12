#!/usr/bin/env bash

set -euo pipefail

tag=${1:?Usage: validate-release.sh TAG [MAIN_REF] [RELEASE_COMMIT]}
main_ref=${2:-origin/main}
release_commit=${3:-HEAD}

if [[ ! ${tag} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Release tags must use stable SemVer, for example v0.2.0" >&2
    exit 1
fi

tag_version=${tag#v}
metadata_version=$(jq -r '."version-name"' metadata.json)
if [[ ${tag_version} != "${metadata_version}" ]]; then
    echo "Tag ${tag} does not match metadata version ${metadata_version}" >&2
    exit 1
fi

if ! jq -e '
    (.version | type == "number") and
    (.version == (.version | floor)) and
    (.version > 0)
' metadata.json >/dev/null; then
    echo 'metadata.json version must be a positive integer' >&2
    exit 1
fi

if ! git merge-base --is-ancestor "${release_commit}" "${main_ref}"; then
    echo "Release commit ${release_commit} is not contained in ${main_ref}" >&2
    exit 1
fi

echo "release validation passed: ${tag}"

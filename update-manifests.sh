#!/bin/sh
# Write updates.json for build/agent-parser-<version>.xpi, pointing at the GitHub release for the
# current version
#
# Run after ./build.sh, then upload exactly that .xpi file to the release, since the manifest
# records its hash.
#
# Versions up to 0.1.7 also had a Lite edition, which checks updates-lite.json. That manifest now
# points at the same .xpi, which moves those installs over to updates.json.
set -e
cd "$(dirname "$0")"
REPO=pymaster17/zotero-agent-parser
ID=$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
MIN_VERSION=$(sed -n 's/.*"strict_min_version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)

write_manifest() {
	xpi="build/$1-$VERSION.xpi"
	if [ ! -f "$xpi" ]; then
		echo "$xpi not found -- run ./build.sh first" >&2
		exit 1
	fi
	hash=$(shasum -a 256 "$xpi" | cut -d' ' -f1)
	cat > "$2" <<EOF
{
	"addons": {
		"$ID": {
			"updates": [
				{
					"version": "$VERSION",
					"update_link": "https://github.com/$REPO/releases/download/v$VERSION/$1-$VERSION.xpi",
					"update_hash": "sha256:$hash",
					"applications": {
						"zotero": {
							"strict_min_version": "$MIN_VERSION"
						}
					}
				}
			]
		}
	}
}
EOF
	echo "$2 -> $xpi ($hash)"
}

write_manifest agent-parser updates.json
write_manifest agent-parser updates-lite.json

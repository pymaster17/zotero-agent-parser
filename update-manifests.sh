#!/bin/sh
# Write updates.json (full edition) and updates-lite.json (lite edition) for the .xpi files in
# build/, pointing at the GitHub release for the current version
#
# Run after ./build.sh, then upload exactly those .xpi files to the release, since the manifests
# record their hashes.
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
write_manifest agent-parser-lite updates-lite.json

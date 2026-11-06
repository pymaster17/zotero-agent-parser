#!/bin/sh
# Package the plugin as .xpi files
#
#   ./build.sh          both editions
#   ./build.sh full     cloud + local MinerU
#   ./build.sh lite     cloud only: without the local MinerU provider (installer and server manager)
#
# Both editions use the same add-on ID and prefs, so installing one replaces the other and keeps
# the settings. They have separate update manifests so that each one stays on its own edition.
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
FILES="manifest.json bootstrap.js prefs.js content locale"
mkdir -p build

build_full() {
	out="build/agent-parser-$VERSION.xpi"
	rm -f "$out"
	zip -qr "$out" $FILES
	echo "$out"
}

build_lite() {
	out="build/agent-parser-lite-$VERSION.xpi"
	stage=$(mktemp -d)
	trap 'rm -rf "$stage"' EXIT
	cp -R $FILES "$stage/"
	# Leave out local MinerU: its provider, and its strings
	rm -r "$stage/content/providers/mineru-local"
	rm "$stage"/locale/*/agent-parser-mineru-local.ftl
	sed -i.bak "/dir: 'mineru-local'/d" "$stage/content/providers/index.js"
	sed -i.bak \
		-e 's/"name": "Agent Parser"/"name": "Agent Parser Lite"/' \
		-e 's/(cloud or local)/(cloud API)/' \
		-e 's#/updates.json"#/updates-lite.json"#' \
		"$stage/manifest.json"
	find "$stage" -name '*.bak' -delete
	! grep -q "mineru-local" "$stage/content/providers/index.js"
	grep -q "mineru-cloud" "$stage/content/providers/index.js"
	grep -q '"Agent Parser Lite"' "$stage/manifest.json"
	rm -f "$out"
	(cd "$stage" && zip -qr - $FILES) > "$out"
	echo "$out"
}

case "${1:-all}" in
	full) build_full ;;
	lite) build_lite ;;
	all) build_full; build_lite ;;
	*) echo "Usage: $0 [full|lite|all]" >&2; exit 1 ;;
esac

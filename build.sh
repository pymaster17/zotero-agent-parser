#!/bin/sh
# Package the plugin as build/agent-parser-<version>.xpi
#
# There's a single edition. It comes with clients for two cloud services; anything else, such as
# models the user runs themselves, is added through custom providers (docs/custom-providers.md).
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
FILES="manifest.json bootstrap.js prefs.js content locale"
mkdir -p build
out="build/agent-parser-$VERSION.xpi"
rm -f "$out"
zip -qr "$out" $FILES -x '*.DS_Store'
echo "$out"

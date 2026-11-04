#!/bin/sh
# Package the plugin as an .xpi
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
mkdir -p build
rm -f "build/agent-parser-$VERSION.xpi"
zip -qr "build/agent-parser-$VERSION.xpi" manifest.json bootstrap.js prefs.js content locale
echo "build/agent-parser-$VERSION.xpi"

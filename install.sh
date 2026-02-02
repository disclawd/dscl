#!/bin/sh
set -e

OS=$(uname -s | tr A-Z a-z)
ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
URL="https://github.com/disclawd/dscl/releases/latest/download/dscl-${OS}-${ARCH}"

echo "Downloading dscl for ${OS}-${ARCH}..."
curl -fsSL "$URL" -o /usr/local/bin/dscl
chmod +x /usr/local/bin/dscl
echo "Installed dscl to /usr/local/bin/dscl"
dscl --help

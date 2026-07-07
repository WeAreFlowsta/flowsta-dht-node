#!/bin/sh
set -e

# Flowsta DHT Node — Pre-compiled Entrypoint
#
# On first boot (empty /data), unpacks the pre-compiled WASM cache
# from the build. This avoids WASM compilation on low-spec hardware.
# The conductor still needs to install apps (register them with the
# node's own agent key), but the WASM is already in the cache so
# installApp is fast — just database writes, no compilation.
#
# What's pre-compiled: /data/holochain/databases/wasm/ (WASM cache)
# What's NOT pre-compiled: app registrations, lair keystore, source chains
# These are created fresh by the sidecar's install-bundled-dnas.mjs.

DATA_DIR="/data/holochain"
PRECOMPILED="/opt/flowsta/precompiled-data.tar.gz"

if [ ! -d "$DATA_DIR/databases/wasm" ] && [ -f "$PRECOMPILED" ]; then
  echo "First boot — unpacking pre-compiled WASM cache..."
  mkdir -p "$DATA_DIR/databases"

  # Extract only the WASM cache directory from the tarball
  tar xzf "$PRECOMPILED" -C /data "holochain/databases/wasm" 2>/dev/null || \
  tar xzf "$PRECOMPILED" -C /data "databases/wasm" 2>/dev/null || \
  echo "WARNING: Could not extract WASM cache from tarball"

  echo "WASM cache unpacked."
else
  if [ -d "$DATA_DIR/databases/wasm" ]; then
    echo "WASM cache exists, skipping unpack."
  else
    echo "No pre-compiled data available."
  fi
fi

# Hand off to the upstream conductor entrypoint
exec /usr/local/bin/entrypoint.sh

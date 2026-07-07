#!/bin/bash
set -e

# Build a pre-compiled Flowsta DHT Node image.
#
# This script:
# 1. Starts a conductor container
# 2. Runs the DNA installer to install all bundled hApp files
# 3. Stops the conductor and copies the populated data directory
# 4. Builds a final image with the pre-compiled data baked in
#
# Run this on a machine with at least 4GB RAM (e.g. Cloud Build).
# The resulting image can run on low-spec hardware (1GB RAM) because
# no WASM compilation is needed — everything is pre-compiled.

IMAGE_TAG="${IMAGE_TAG:-flowsta-dht-node:latest}"
CONDUCTOR_IMAGE="ghcr.io/holo-host/edgenode:v0.0.7ga.5-hc0.6.0-go-pion-dev"
BUILD_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Building pre-compiled Flowsta DHT Node ==="
echo "Image tag: $IMAGE_TAG"
echo "Build dir: $BUILD_DIR"

# Clean up any previous build containers
docker rm -f build-conductor build-sidecar 2>/dev/null || true
docker volume rm build-conductor-data 2>/dev/null || true

# Create a temporary conductor config for the build
# (minimal config, no real bootstrap needed — just installing DNAs)
cat > /tmp/build-conductor-config.yaml << 'EOF'
admin_interfaces:
- driver:
    type: websocket
    port: 4444
    allowed_origins: '*'
network:
  bootstrap_url: "https://bootstrap.flowsta.com"
  signal_url: "wss://bootstrap.flowsta.com"
  enable_mdns: false
data_root_path: "/data/holochain"
keystore:
  type: lair_server_in_proc
  lair_root: "/data/holochain/ks"
tracing_override: "error"
EOF

# Step 1: Start conductor with a named volume
echo ""
echo "=== Step 1: Starting conductor ==="
docker volume create build-conductor-data
docker run -d \
  --name build-conductor \
  --network host \
  -v build-conductor-data:/data \
  -v /tmp/build-conductor-config.yaml:/usr/local/share/holochain/conductor-config.template.yaml:ro \
  "$CONDUCTOR_IMAGE"

# Wait for conductor to be ready
echo "Waiting for conductor..."
ATTEMPTS=0
while [ $ATTEMPTS -lt 60 ]; do
  if docker run --rm --network host node:20-slim node -e "
    import('@holochain/client').then(async ({AdminWebsocket}) => {
      try {
        const a = await AdminWebsocket.connect({url: new URL('ws://localhost:4444'), wsClientOptions: {origin: 'build'}});
        await a.listApps({});
        await a.client.close();
        process.exit(0);
      } catch { process.exit(1); }
    });
  " 2>/dev/null; then
    echo "Conductor ready"
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 2
done

if [ $ATTEMPTS -ge 60 ]; then
  echo "ERROR: Conductor not ready after 120s"
  docker logs build-conductor --tail 20
  exit 1
fi

# Step 2: Build the sidecar image (for the installer script)
echo ""
echo "=== Step 2: Building sidecar ==="
docker build -t build-sidecar "$BUILD_DIR"

# Step 3: Run the installer
echo ""
echo "=== Step 3: Installing DNAs ==="
docker run --rm \
  --name build-sidecar \
  --network host \
  -e CONDUCTOR_URL=ws://localhost:4444 \
  build-sidecar \
  node /app/install-bundled-dnas.mjs

# Step 4: Stop the conductor cleanly
echo ""
echo "=== Step 4: Stopping conductor ==="
docker stop build-conductor
docker rm build-conductor

# Step 5: Extract just the WASM cache from the conductor data
# This is the expensive part (compiled WASM modules). Everything else
# (app registrations, keystore, source chains) is created fresh per node.
echo ""
echo "=== Step 5: Extracting pre-compiled WASM cache ==="
docker run --rm \
  -v build-conductor-data:/data \
  -v "$BUILD_DIR":/output \
  alpine sh -c "
    if [ -d /data/holochain/databases/wasm ]; then
      tar czf /output/precompiled-data.tar.gz -C /data holochain/databases/wasm
      echo 'WASM cache extracted'
    else
      echo 'ERROR: No WASM cache found in conductor data'
      ls -la /data/ /data/holochain/ /data/holochain/databases/ 2>/dev/null
      exit 1
    fi
  "

echo "Pre-compiled WASM cache: $(du -sh "$BUILD_DIR/precompiled-data.tar.gz" | cut -f1)"

# Step 6: Build the final image with pre-compiled data
echo ""
echo "=== Step 6: Building final image ==="
docker build -f "$BUILD_DIR/Dockerfile.precompiled" -t "$IMAGE_TAG" "$BUILD_DIR"

# Clean up
echo ""
echo "=== Cleanup ==="
docker volume rm build-conductor-data 2>/dev/null || true
rm -f "$BUILD_DIR/precompiled-data.tar.gz"
rm -f /tmp/build-conductor-config.yaml

echo ""
echo "=== Done ==="
echo "Image: $IMAGE_TAG"
echo "Run with: docker compose up -d"

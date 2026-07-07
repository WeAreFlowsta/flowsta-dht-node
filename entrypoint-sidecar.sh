#!/bin/bash
set -e

# Flowsta DHT Node Sidecar Entrypoint
#
# 1. Wait for conductor admin WebSocket to be ready
# 2. Install bundled DNAs (first boot)
# 3. Run auto-updater loop

echo "Flowsta DHT Node sidecar starting..."

CONDUCTOR_URL="${CONDUCTOR_URL:-ws://localhost:4444}"
CONDUCTOR_HOST=$(echo "$CONDUCTOR_URL" | sed 's|ws://||' | sed 's|/.*||')

# Wait for conductor admin WebSocket
echo "Waiting for conductor at $CONDUCTOR_URL..."
ATTEMPTS=0
MAX_ATTEMPTS=60
while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  if node -e "
    import { AdminWebsocket } from '@holochain/client';
    try {
      const a = await AdminWebsocket.connect({ url: new URL('$CONDUCTOR_URL'), wsClientOptions: { origin: 'flowsta-dht-node' } });
      await a.listApps({});
      await a.client.close();
      process.exit(0);
    } catch { process.exit(1); }
  " 2>/dev/null; then
    echo "Conductor ready"
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 3
done

if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
  echo "WARNING: Conductor not ready after ${MAX_ATTEMPTS} attempts, proceeding anyway"
fi

# Install bundled DNAs
echo "Installing bundled DNAs..."
node /app/install-bundled-dnas.mjs || echo "WARNING: DNA install had errors (updater will retry)"

# Auto-updater loop
if [ -n "$API_URL" ]; then
  echo "Starting auto-updater (interval: ${UPDATE_INTERVAL:-21600}s)..."
  while true; do
    sleep "${UPDATE_INTERVAL:-21600}"
    echo "Running DNA update check..."
    node /app/updater/dht-update.mjs 2>&1 || echo "WARNING: Update check failed (will retry)"
  done
else
  echo "API_URL not set — auto-updater disabled"
  echo "Sidecar will stay running to allow manual updates"
  # Keep container alive
  tail -f /dev/null
fi

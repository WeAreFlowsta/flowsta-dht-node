# Flowsta DHT Node — Installer/Updater Sidecar
#
# This image contains the DNA installer and auto-updater scripts.
# It runs alongside the Holochain conductor container using --network host
# to access the conductor's admin WebSocket.
#
# The conductor itself uses the upstream edge node image unchanged.
# This sidecar handles DNA installation on first boot and auto-updates.
#
# See docker-compose.yml or README.md for full setup.

FROM node:20-slim

WORKDIR /app

# Copy updater dependencies and install
COPY updater/package.json updater/package-lock.json* ./
RUN npm install --production

# Copy scripts
COPY install-bundled-dnas.mjs ./
COPY updater/dht-update.mjs updater/network-probe.mjs updater/network-report.mjs ./updater/

# Copy bundled hApp files
COPY happs/ ./happs/

# Copy entrypoint
COPY entrypoint-sidecar.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]

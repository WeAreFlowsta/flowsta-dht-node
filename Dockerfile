# Flowsta node agent image.
#
# Runs beside Docker on the node and manages the conductor containers from
# the signed node manifest (see agent/agent.mjs). Carries the public hApp
# bundles so a fresh node installs them without a download.
#
# Published as us-docker.pkg.dev/flowsta-475001/public/flowsta-dht-node:<version>;
# the manifest pins it by digest.

FROM node:22-slim

ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION} \
    NODE_ENV=production

WORKDIR /app

COPY updater/package.json updater/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY updater/network-probe.mjs ./updater/network-probe.mjs
COPY agent/ ./agent/
COPY happs/ ./happs/

LABEL org.flowsta.component="node-agent" \
      org.flowsta.version="${AGENT_VERSION}"

ENTRYPOINT ["node", "/app/agent/agent.mjs"]

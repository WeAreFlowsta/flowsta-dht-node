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

# The ProofPoll carrier (agent/lib/carrier.mjs), built by ProofPoll's CI for
# linux-x64 on Debian bookworm (this image's glibc 2.36). Only the ProofPoll
# node runs it, and only while its manifest has a `carrier` block; an image
# built without these two arguments carries none. The download is refused
# unless its SHA-256 matches.
ARG CARRIER_URL=
ARG CARRIER_SHA256=
RUN if [ -n "$CARRIER_URL" ]; then \
      node -e "const [u, h] = process.argv.slice(1); (async () => { const r = await fetch(u, { redirect: 'follow' }); if (!r.ok) throw new Error('carrier download: HTTP ' + r.status); const b = Buffer.from(await r.arrayBuffer()); const d = require('node:crypto').createHash('sha256').update(b).digest('hex'); if (d !== h) throw new Error('carrier sha256 ' + d + ' is not ' + h); require('node:fs').mkdirSync('/app/bin', { recursive: true }); require('node:fs').writeFileSync('/app/bin/proofpoll-carrier', b, { mode: 0o755 }); console.log('carrier ' + d + ', ' + b.length + ' bytes'); })().catch((e) => { console.error(e.message); process.exit(1); });" "$CARRIER_URL" "$CARRIER_SHA256"; \
    fi

COPY updater/network-probe.mjs ./updater/network-probe.mjs
COPY agent/ ./agent/
COPY happs/ ./happs/

LABEL org.flowsta.component="node-agent" \
      org.flowsta.version="${AGENT_VERSION}"

ENTRYPOINT ["node", "/app/agent/agent.mjs"]

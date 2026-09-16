/**
 * Flowsta DHT Node - network health report
 *
 * Reads this node's conductor (see network-probe.mjs: gossip freshness per
 * peer, DHT summary hash per DNA, direct vs relayed connections, live
 * endpoints) and posts the result to the Flowsta API so the network can be
 * seen as a whole. Endpoint ids only - never agent keys, never private data.
 *
 * Environment variables:
 *   API_URL          - Flowsta API base URL (required)
 *   CONDUCTOR_URL    - Conductor admin WS URL (default: ws://localhost:4444)
 *   NODE_LABEL       - Name this node reports under (default: hostname);
 *                      lowercase letters, digits and dashes
 *   NODE_SECRET      - Optional: fleet nodes send it so the report is trusted
 *                      outright. Without it the API trusts the report when it
 *                      can see this node as a live peer itself.
 *   REPORT_DISABLED  - Set to 1 to opt out of reporting (the node still works)
 */
import os from 'os';
import { AdminWebsocket } from '@holochain/client';
import { probeConductor } from './network-probe.mjs';

const API_URL = process.env.API_URL;
const CONDUCTOR_URL = process.env.CONDUCTOR_URL || 'ws://localhost:4444';
const NODE_SECRET = process.env.NODE_SECRET || null;
const LABEL = (process.env.NODE_LABEL || os.hostname()).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'community-node';

if (process.env.REPORT_DISABLED === '1') {
  console.log('Network reporting disabled (REPORT_DISABLED=1)');
  process.exit(0);
}
if (!API_URL) {
  console.error('API_URL environment variable is required');
  process.exit(1);
}

const admin = await AdminWebsocket.connect({ url: new URL(CONDUCTOR_URL), wsClientOptions: { origin: 'flowsta-dht-node' } });
let report;
try {
  report = await probeConductor(admin, { label: LABEL, software: { agent: 'sidecar', version: process.env.SIDECAR_VERSION || 'dev' } });
} finally {
  await admin.client.close().catch(() => {});
}

const headers = { 'Content-Type': 'application/json' };
if (NODE_SECRET) headers['X-Node-Secret'] = NODE_SECRET;
const res = await fetch(`${API_URL.replace(/\/$/, '')}/api/v1/vault/node/report`, { method: 'POST', headers, body: JSON.stringify(report) });
const body = await res.text();
if (!res.ok) {
  console.error(`Report rejected (${res.status}): ${body.slice(0, 300)}`);
  process.exit(1);
}
const issues = report.dnas.filter((d) => d.peers.length === 0 || d.peers.some((p) => p.errors)).map((d) => d.role);
console.log(`Report sent as "${LABEL}": ${report.dnas.length} DNAs, ${report.live_endpoints.length} live endpoints, ${report.direct}/${report.connections} direct connections${issues.length ? `, issues on ${issues.join(', ')}` : ''} -> ${body.slice(0, 120)}`);

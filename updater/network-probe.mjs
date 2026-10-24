/**
 * Network probe - one read-only pass over a conductor's admin websocket that
 * says how well this node is gossiping.
 *
 * Per shared DNA (identity + signing; private DNAs are skipped - a node's
 * private cells are nobody's business): cell count, local op count, the DHT
 * disc top hash (identical across healthy nodes), pending fetch requests,
 * agent-info count, live/known iroh endpoints network-wide (= conductors
 * online, Vaults included, as anonymous endpoint ids), and per peer the age
 * of the last gossip round, completed rounds, timeouts, terminations,
 * whether behaviour/local errors are recorded, and the peer's op count.
 * Plus the transport view: our own endpoint id and direct vs relayed
 * connections. Never a zome call, never a write, never an agent key in the
 * output - endpoint ids only.
 *
 * The same file, byte for byte, lives in the public node repo as
 * flowsta-dht-node/updater/network-probe.mjs and api/src/services/networkProbe.js. Change both.
 */
import { createHash } from 'crypto';
import { encodeHashToBase64 } from '@holochain/client';

export const PROBE_VERSION = 1;

// Public DNAs a node mirrors: Flowsta identity and signing, and ProofPoll on its node.
const SHARED_ROLE = /identity|signing|proofpoll/;
const USER_APP_SUFFIX = /_[A-Za-z0-9+/]{20}$/;

function toB64(x) {
  if (!x) return null;
  const bytes = x instanceof Uint8Array ? x : Array.isArray(x?.data) ? Uint8Array.from(x.data) : Array.isArray(x) ? Uint8Array.from(x) : null;
  return bytes ? Buffer.from(bytes).toString('base64') : null;
}

function parseAgentInfo(x) {
  try {
    const o = typeof x === 'string' ? JSON.parse(x) : x;
    return typeof o.agentInfo === 'string' ? JSON.parse(o.agentInfo) : o.agentInfo;
  } catch {
    return null;
  }
}

const endpointOf = (url) => (url || '').split('/').pop() || '';

/**
 * @param {import('@holochain/client').AdminWebsocket} admin - connected admin client
 * @param {{ label: string, software: { agent: string, version: string } }} meta
 * @returns {Promise<object>} the report
 */
export async function probeConductor(admin, meta) {
  const nowUs = Date.now() * 1000;
  const apps = await admin.listApps({});

  // Custodial (per-user, legacy) apps carry an agent-key suffix in their id;
  // the API's own system apps do not. Split so an API node's tail is visible.
  const isUserApp = (app) => USER_APP_SUFFIX.test(app.installed_app_id || '');
  const custodial = apps.filter(isUserApp);
  const system = apps.filter((a) => !isUserApp(a));

  // One entry per DNA hash (many apps share a DNA on an API node).
  const byDna = new Map();
  for (const app of apps) {
    if (app.status?.type !== 'enabled') continue;
    const user = isUserApp(app);
    for (const [role, cells] of Object.entries(app.cell_info || {})) {
      const cell = (cells || []).find((c) => c.type === 'provisioned' && c.value?.cell_id);
      if (!cell) continue;
      const dnaB64 = encodeHashToBase64(cell.value.cell_id[0]);
      if (!byDna.has(dnaB64)) byDna.set(dnaB64, { role: role.replace(USER_APP_SUFFIX, ''), cellId: cell.value.cell_id, cells: 0, cells_user: 0, cells_system: 0 });
      const e = byDna.get(dnaB64);
      e.cells++;
      if (user) e.cells_user++; else e.cells_system++;
    }
  }

  const dnas = [];
  const liveEndpoints = new Set();
  for (const [dnaB64, info] of byDna) {
    if (!SHARED_ROLE.test(info.role)) continue;
    const metrics = await admin.dumpNetworkMetrics({ dna_hash: info.cellId[0], include_dht_summary: true });
    const nm = metrics[dnaB64] || Object.values(metrics)[0] || {};
    const gossip = nm.gossip_state_summary || {};
    const peers = Object.entries(gossip.peer_meta || {}).map(([url, p]) => ({
      ep: endpointOf(url).slice(0, 8),
      age_s: p.last_gossip_timestamp ? Math.max(0, Math.round((nowUs - p.last_gossip_timestamp) / 1e6)) : null,
      rounds: p.completed_rounds ?? 0,
      timeouts: p.peer_timeouts ?? 0,
      terminated: p.peer_terminated ?? 0,
      errors: Boolean(p.peer_behavior_errors || p.local_errors),
      ops: p.dht_op_count ?? null,
      tombstone: Boolean(p.is_tombstone),
    }));
    const agentInfos = await admin.agentInfo({ cell_id: info.cellId });
    const known = new Set();
    const live = new Set();
    for (const raw of agentInfos) {
      const ai = parseAgentInfo(raw);
      if (!ai || ai.isTombstone) continue;
      const ep = endpointOf(ai.url);
      if (!ep) continue;
      known.add(ep);
      if (Number(ai.expiresAt) > nowUs) { live.add(ep); liveEndpoints.add(ep); }
    }
    const summary = gossip.dht_summary ? Object.values(gossip.dht_summary)[0] : null;
    // The settled past is one hash (disc_top_hash); the recent window is a
    // ring of per-slice hashes. Fold the ring into one digest so nodes can
    // be compared on the recent window too. Empty slices are skipped.
    let ringHash = null;
    if (summary && Array.isArray(summary.ring_top_hashes)) {
      const h = createHash('sha256');
      for (const x of summary.ring_top_hashes) { const b = toB64(x); if (b) h.update(b); }
      ringHash = h.digest('base64').slice(0, 16);
    }
    dnas.push({
      role: info.role,
      dna: dnaB64.slice(0, 12),
      cells: info.cells,
      cells_user: info.cells_user,
      cells_system: info.cells_system,
      local_ops: gossip.local_op_count ?? null,
      top_hash: summary ? (toB64(summary.disc_top_hash) || '').slice(0, 16) : null,
      disc_boundary: summary?.disc_boundary ?? null,
      ring_hash: ringHash,
      pending_fetch: Object.keys(nm.fetch_state_summary?.pending_requests || {}).length,
      agents: agentInfos.length,
      endpoints_known: known.size,
      endpoints_live: live.size,
      peers,
    });
  }

  const stats = await admin.dumpNetworkStats();
  const conns = stats?.transport_stats?.connections || [];
  return {
    v: PROBE_VERSION,
    label: meta.label,
    at: new Date().toISOString(),
    endpoint: endpointOf((stats?.transport_stats?.peer_urls || [])[0]),
    apps: apps.length,
    apps_enabled: apps.filter((a) => a.status?.type === 'enabled').length,
    apps_custodial: custodial.length,
    apps_custodial_enabled: custodial.filter((a) => a.status?.type === 'enabled').length,
    apps_system: system.length,
    apps_system_enabled: system.filter((a) => a.status?.type === 'enabled').length,
    connections: conns.length,
    direct: conns.filter((c) => c.is_direct).length,
    software: meta.software,
    dnas,
    live_endpoints: [...liveEndpoints],
  };
}

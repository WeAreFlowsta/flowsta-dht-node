/**
 * Is this conductor healthy after a change? Four checks, each with a reason:
 *   1. the admin websocket answers (within `adminWaitMs`)
 *   2. every app the manifest lists is installed and enabled
 *   3. no panic in the container log since the change
 *   4. a gossip round completed in the last 10 minutes on some DNA that has
 *      peers (skipped, with a note, when no DNA has any peer yet)
 */
import { clientFor } from './hc-client.mjs';
import { probeConductor } from '../../updater/network-probe.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connectAdmin(url, { waitMs = 5 * 60 * 1000, holochain } = {}) {
  const { AdminWebsocket } = await clientFor(holochain);
  const until = Date.now() + waitMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const admin = await AdminWebsocket.connect({ url: new URL(url), wsClientOptions: { origin: 'flowsta-agent' }, defaultTimeout: 120000 });
      await admin.listApps({});
      return admin;
    } catch (e) { lastError = e; await sleep(5000); }
  }
  throw new Error(`admin websocket ${url} did not answer: ${lastError?.message || lastError}`);
}

export async function verifyConductor({ adminUrl, holochain, expectedAppIds = [], docker, containerId, sinceUnix, gossipWaitMs = 10 * 60 * 1000, adminWaitMs, log = console.log }) {
  const checks = [];
  let admin;
  try { admin = await connectAdmin(adminUrl, { waitMs: adminWaitMs, holochain }); checks.push({ check: 'admin', ok: true }); }
  catch (e) { checks.push({ check: 'admin', ok: false, reason: e.message }); return { ok: false, checks }; }
  try {
    const apps = await admin.listApps({});
    const byId = new Map(apps.map((a) => [a.installed_app_id, a]));
    const missing = expectedAppIds.filter((id) => !byId.has(id));
    const disabled = expectedAppIds.filter((id) => byId.has(id) && !isRunning(byId.get(id).status));
    checks.push({ check: 'apps', ok: missing.length === 0 && disabled.length === 0, reason: [missing.length ? `missing ${missing.join(', ')}` : '', disabled.length ? `not running ${disabled.join(', ')}` : ''].filter(Boolean).join('; ') || undefined });

    if (docker && containerId) {
      const text = await docker.logs(containerId, { since: sinceUnix, tail: 2000 }).catch(() => '');
      const panicked = /panicked at|thread '.*' panicked/.test(text);
      checks.push({ check: 'logs', ok: !panicked, reason: panicked ? 'panic in the conductor log' : undefined });
    }

    const until = Date.now() + gossipWaitMs;
    let gossip = { ok: false, reason: 'no gossip round completed in time' };
    while (Date.now() < until) {
      const report = await probeConductor(admin, { label: 'verify', software: { agent: 'flowsta-agent', version: 'verify' } }).catch(() => null);
      const dnasWithPeers = (report?.dnas || []).filter((d) => d.peers.length > 0);
      if (dnasWithPeers.length === 0) { gossip = { ok: true, reason: 'no peers seen yet on any DNA; gossip check skipped' }; if (Date.now() + 60000 > until) break; await sleep(30000); continue; }
      if (dnasWithPeers.some((d) => d.peers.some((p) => p.age_s !== null && p.age_s < 600 && p.rounds > 0))) { gossip = { ok: true }; break; }
      await sleep(30000);
    }
    checks.push({ check: 'gossip', ...gossip });
  } finally {
    await admin.client.close().catch(() => {});
  }
  const ok = checks.every((c) => c.ok);
  log(`  verify: ${checks.map((c) => `${c.check}=${c.ok ? 'ok' : 'FAIL'}${c.reason ? ` (${c.reason})` : ''}`).join(' ')}`);
  return { ok, checks };
}

function isRunning(status) {
  if (!status) return false;
  if (typeof status === 'string') return status === 'running' || status === 'enabled';
  return status.type === 'running' || status.type === 'enabled' || 'running' in status || 'enabled' in status;
}

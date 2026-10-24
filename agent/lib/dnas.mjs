/**
 * Keep a conductor's installed apps in step with a generation's DNA list:
 * install what is missing (bundled file when its sha256 matches, else the
 * manifest's URL), verify every bundle against the manifest's sha256 before
 * install, never uninstall. The agent key is the conductor's existing one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function reconcileDnas(admin, dnas, { happsDir = '/app/happs', downloadDir = '/tmp/flowsta-agent-dnas', log = console.log } = {}) {
  const apps = await admin.listApps({});
  const byId = new Map(apps.map((a) => [a.installed_app_id, a]));
  const result = { installed: [], enabled: [], failed: [] };
  // An app that is installed but not running (a first enable that was cut
  // short, a conductor restart mid-compile) is enabled again. The call can
  // take minutes on a small box while the wasm compiles; the admin client's
  // timeout is the caller's to set.
  for (const d of dnas) {
    const app = byId.get(d.app_id);
    if (app && !isRunning(app.status)) {
      try {
        await admin.enableApp({ installed_app_id: d.app_id });
        result.enabled.push(d.app_id);
        log(`  enabled ${d.app_id}`);
      } catch (e) {
        result.failed.push({ app_id: d.app_id, reason: `enable: ${e.message || e}` });
      }
    }
  }
  const missing = dnas.filter((d) => !byId.has(d.app_id));
  if (missing.length === 0) return result;
  const agentKey = apps.length > 0 ? apps[0].agent_pub_key : await admin.generateAgentPubKey();
  fs.mkdirSync(downloadDir, { recursive: true });
  for (const dna of missing) {
    const bundled = path.join(happsDir, `${dna.app_id}_happ.happ`);
    let bytes = null;
    if (fs.existsSync(bundled)) bytes = fs.readFileSync(bundled);
    if (!bytes || sha256(bytes) !== dna.sha256) {
      const dest = path.join(downloadDir, `${dna.app_id}_happ.happ`);
      try { await download(dna.url, dest); bytes = fs.readFileSync(dest); } catch (e) { result.failed.push({ app_id: dna.app_id, reason: `download: ${e.message}` }); continue; }
    }
    const actual = sha256(bytes);
    if (actual !== dna.sha256) { result.failed.push({ app_id: dna.app_id, reason: `sha256 ${actual} does not match the manifest` }); continue; }
    try {
      await admin.installApp({ agent_key: agentKey, installed_app_id: dna.app_id, source: { type: 'bytes', value: bytes } });
      await admin.enableApp({ installed_app_id: dna.app_id });
      result.installed.push(dna.app_id);
      log(`  installed ${dna.app_id} (${(bytes.length / 1048576).toFixed(1)} MB)`);
    } catch (e) {
      const msg = e.message || String(e);
      if (/AppAlreadyInstalled|CellAlreadyExists/.test(msg)) { await admin.enableApp({ installed_app_id: dna.app_id }).catch(() => {}); result.installed.push(dna.app_id); }
      else result.failed.push({ app_id: dna.app_id, reason: msg });
    }
  }
  try { fs.rmSync(downloadDir, { recursive: true }); } catch {}
  return result;
}

export function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function isRunning(status) {
  if (!status) return false;
  if (typeof status === 'string') return status === 'running' || status === 'enabled';
  return status.type === 'running' || status.type === 'enabled' || 'running' in status || 'enabled' in status;
}

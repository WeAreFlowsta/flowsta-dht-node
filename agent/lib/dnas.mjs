/**
 * Keep a conductor's installed apps in step with a generation's DNA list:
 * install what is missing (bundled file when its sha256 matches, else the
 * manifest's URL), verify every bundle against the manifest's sha256 before
 * install, never uninstall. The agent key is the conductor's existing one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BUNDLE_BYTES = 64 * 1048576;

/** Why a bundle URL may not be fetched, or null when it may: https, the API's own host, nothing else. */
export function downloadRefusal(url, allowedHost) {
  let u;
  try { u = new URL(url); } catch { return 'not a URL'; }
  if (u.protocol !== 'https:') return 'not https';
  if (allowedHost && u.host !== allowedHost) return `host ${u.host} is not the API host ${allowedHost}`;
  return null;
}

/**
 * A bundle is fetched from the API host only, without following redirects,
 * within a time limit and a size cap: whoever controls the host named in a
 * signed URL could otherwise stream without end and freeze the agent
 * (found 2026-10-25). The sha256 check after the download is what proves
 * the bytes; this only bounds the attempt.
 */
async function download(url, dest, { allowedHost, maxBytes = MAX_BUNDLE_BYTES, timeoutMs = 10 * 60 * 1000 } = {}) {
  const refusal = downloadRefusal(url, allowedHost);
  if (refusal) throw new Error(refusal);
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`${declared} bytes is over the ${maxBytes}-byte limit`);
  const chunks = []; let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`more than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

export async function reconcileDnas(admin, dnas, { happsDir = '/app/happs', downloadDir = '/tmp/flowsta-agent-dnas', log = console.log, allowedHost } = {}) {
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
      try { await download(dna.url, dest, { allowedHost }); bytes = fs.readFileSync(dest); } catch (e) { result.failed.push({ app_id: dna.app_id, reason: `download: ${e.message}` }); continue; }
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

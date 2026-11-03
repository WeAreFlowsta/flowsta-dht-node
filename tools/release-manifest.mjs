#!/usr/bin/env node
// Build, sign and publish an app's release manifest for a finished release.
//
// Reads the release from GitHub: its installers and updater files with
// GitHub's own SHA-256 digests, and the sidecar hashes the release workflow
// published (kit-hashes-<target>.json). Builds the manifest
// (flowsta-release-manifest v1; checked in the apps by flowsta-update-check),
// asks the running Flowsta Vault to sign it (POST /sign-release-manifest: the
// Vault shows the app, version, channel and every file, and signs only on
// approval), checks the signature here, and uploads release-manifest.json to
// the release. A beta also replaces the two files of the app's fixed beta
// pre-release, which beta installs read.
//
// Usage:
//   node tools/release-manifest.mjs <app> <tag> [--rollout 100] [--from <version>]
//        [--changes-line] [--sequence N] [--dry-run] [--no-upload] [--vault URL]
//   <app>: vault or proofpoll (more as they adopt the updater).
//   --dry-run: print the manifest and its statement, sign nothing.
//
// The Vault signs for linked origins only: this tool uses the node manifest
// tool's key and origin (~/.config/flowsta/release-tool.key,
// http://localhost:7331), so one link serves both.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(root, 'updater', 'package.json'));
const { hashFrom32AndType, encodeHashToBase64, HoloHashType } = require('holochain-client-07');
const { canonicalJson } = await import('../agent/lib/canonical.mjs');

const APPS = {
  vault: {
    name: 'Flowsta Vault',
    app: 'com.flowsta.vault',
    repo: 'WeAreFlowsta/flowsta-vault-app',
    tagPrefix: 'vault-v',
    betaTag: 'vault-beta',
    lines: ['holochain-0.6', 'holochain-0.7'],
  },
  proofpoll: {
    name: 'ProofPoll',
    app: 'com.proofpoll.app',
    repo: 'WeAreFlowsta/ProofPoll',
    tagPrefix: 'proofpoll-v',
    betaTag: 'proofpoll-beta',
    lines: ['holochain-0.6', 'holochain-0.7'],
  },
};
const SIGNER_DID = process.env.RELEASE_MANIFEST_SIGNER_DID || 'did:flowsta:uhCAkWuA-Ehm9EVzcsPE2Wo_vpc9ImljHN8NMMEXpbtG5BdooOV9a';
const ORIGIN = 'http://localhost:7331';
const MAX_SEQUENCE_JUMP = 100;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const [appName, tag] = args;
const cfg = APPS[appName];
if (!cfg || !tag || tag.startsWith('--')) {
  console.error(`usage: release-manifest.mjs <${Object.keys(APPS).join('|')}> <tag> [--rollout 100] [--from <version>] [--changes-line] [--sequence N] [--dry-run] [--no-upload] [--vault URL]`);
  process.exit(2);
}
if (!tag.startsWith(cfg.tagPrefix)) throw new Error(`${appName} tags start with ${cfg.tagPrefix}`);
const { name: NAME, app: APP, repo: REPO, betaTag: BETA_TAG, lines: LINES } = cfg;
const dryRun = flag('dry-run');
const upload = !flag('no-upload') && !dryRun;
const VAULT = opt('vault', 'http://localhost:27777').replace(/\/$/, '');
const configDir = path.join(os.homedir(), '.config', 'flowsta');

// ---- GitHub ---------------------------------------------------------------
let token = process.env.GITHUB_TOKEN;
const authToken = () => (token ||= execFileSync('gh', ['auth', 'token']).toString().trim());
const gh = async (url, init = {}) => {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'flowsta-release-tool', ...(init.headers || {}) };
  if (init.auth !== false) headers.Authorization = `Bearer ${authToken()}`;
  const r = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, { ...init, headers });
  if (!r.ok && r.status !== 404) throw new Error(`${init.method || 'GET'} ${url}: ${r.status} ${await r.text()}`);
  return r;
};

const release = await (await gh(`/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`)).json();
if (!release.id) throw new Error(`no release ${tag} in ${REPO}`);
const version = tag.slice(cfg.tagPrefix.length);
const channel = release.prerelease ? 'beta' : 'stable';

// The installers and updater files, by what their names say. An updater file's
// .sig and the build's own records are not listed.
const ARM = /aarch64|arm64|apple-silicon/i;
const fileKind = (name) => {
  if (name.endsWith('.sig')) return null;
  const arch = ARM.test(name) ? 'aarch64' : 'x86_64';
  if (name.endsWith('.app.tar.gz')) return [`darwin-${arch}`, 'app-tarball'];
  if (name.endsWith('.dmg')) return [`darwin-${arch}`, 'dmg'];
  if (/setup\.exe$/i.test(name)) return ['windows-x86_64', 'nsis'];
  if (name.endsWith('.msi')) return ['windows-x86_64', 'msi'];
  if (name.endsWith('.deb')) return ['linux-x86_64', 'deb'];
  if (name.endsWith('.rpm')) return ['linux-x86_64', 'rpm'];
  return null;
};
const sha256Of = async (asset) => {
  if (asset.digest?.startsWith('sha256:')) return asset.digest.slice(7);
  // No digest from GitHub: hash the download.
  const r = await fetch(asset.browser_download_url);
  if (!r.ok) throw new Error(`download ${asset.name}: ${r.status}`);
  return createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
};
const files = [];
for (const asset of release.assets) {
  const pk = fileKind(asset.name);
  if (!pk) continue;
  files.push({ platform: pk[0], kind: pk[1], name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: await sha256Of(asset) });
}
files.sort((a, b) => `${a.platform} ${a.kind}`.localeCompare(`${b.platform} ${b.kind}`));
if (files.length === 0) throw new Error(`${tag} has no installers or updater files`);

const kit = [];
for (const asset of release.assets.filter((a) => /^kit-hashes-.+\.json$/.test(a.name))) {
  const r = await fetch(asset.browser_download_url);
  if (!r.ok) throw new Error(`download ${asset.name}: ${r.status}`);
  for (const k of await r.json()) kit.push({ line: k.line, target: k.target, sidecar: k.sidecar, sha256: k.sha256 });
}
kit.sort((a, b) => `${a.target} ${a.sidecar}`.localeCompare(`${b.target} ${b.sidecar}`));

// ---- The sequence: one above the last this channel published or this machine signed.
const lastSignedPath = path.join(configDir, 'release-manifests', `${APP}-${channel}.json`);
const lastSigned = fs.existsSync(lastSignedPath) ? JSON.parse(fs.readFileSync(lastSignedPath, 'utf8')).sequence : 0;
const channelManifestUrl = channel === 'beta'
  ? `https://github.com/${REPO}/releases/download/${BETA_TAG}/release-manifest.json`
  : `https://github.com/${REPO}/releases/latest/download/release-manifest.json`;
const published = await fetch(channelManifestUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
let sequence = Number(opt('sequence', 0));
if (!sequence) {
  sequence = Math.max(lastSigned, published?.app === APP && published?.channel === channel ? published.sequence : 0) + 1;
  if (sequence > lastSigned + MAX_SEQUENCE_JUMP) throw new Error(`the published manifest says the next sequence is ${sequence} but the last one signed here was ${lastSigned}; pass --sequence to confirm`);
}
if (!Number.isInteger(sequence) || sequence < 1 || sequence > 2 ** 31 - 1) throw new Error(`sequence ${sequence} is out of range`);

const percent = Number(opt('rollout', 100));
if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error('--rollout must be a whole number from 0 to 100');
const manifest = {
  v: 1,
  app: APP,
  channel,
  sequence,
  issued_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  version,
  notes_url: release.html_url,
  holochain: { lines: LINES, changes_line: flag('changes-line') },
  rollout: { percent },
  files,
  kit,
};
if (opt('from')) manifest.from_version = opt('from');

// ---- The statement: the node manifests' canonical JSON (sorted keys, no
// whitespace), the same bytes as the Vault and flowsta-update-check. Integers only.
const nonInteger = (v) => (Array.isArray(v) ? v.some(nonInteger) : v && typeof v === 'object' ? Object.values(v).some(nonInteger) : typeof v === 'number' && !Number.isInteger(v));
if (nonInteger(manifest)) throw new Error('a release manifest carries whole numbers only');
const canonical = canonicalJson;
const statement = `flowsta-release-manifest:v1:${APP}:${channel}:${sequence}:${createHash('sha256').update(canonical(manifest), 'utf8').digest('hex')}`;

console.log(`${APP} ${version} on ${channel}, sequence ${sequence}, rollout ${percent} %`);
for (const f of files) console.log(`  ${f.platform.padEnd(15)} ${f.kind.padEnd(12)} ${String(f.size).padStart(10)}  ${f.sha256}  ${f.name}`);
for (const k of kit) console.log(`  kit ${k.target.padEnd(28)} ${k.sidecar.padEnd(24)} ${k.sha256}`);
console.log(`statement ${statement}`);
if (dryRun) {
  console.log('\n--dry-run: nothing signed or uploaded');
  process.exit(0);
}

// ---- The Vault signs (linked origins only; the same tool key as the node manifests).
const status = await fetch(`${VAULT}/status`).then((r) => r.json()).catch(() => null);
if (!status) throw new Error(`no Vault at ${VAULT}; open Flowsta Vault and unlock it`);
if (!status.unlocked) throw new Error('the Vault is locked; unlock it first');
const toolKeyFile = process.env.FLOWSTA_RELEASE_TOOL_KEY || path.join(configDir, 'release-tool.key');
const toolDid = (() => {
  if (!fs.existsSync(toolKeyFile)) {
    fs.mkdirSync(path.dirname(toolKeyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(toolKeyFile, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  const raw = createPublicKey(createPrivateKey(fs.readFileSync(toolKeyFile, 'utf8'))).export({ format: 'der', type: 'spki' }).subarray(-32);
  return `did:flowsta:${encodeHashToBase64(hashFrom32AndType(raw, HoloHashType.Agent))}`;
})();
const appKey = toolDid.replace(/^did:flowsta:/, '');
const linked = await fetch(`${VAULT}/link-status?app_agent_pub_key=${encodeURIComponent(appKey)}`, { headers: { Origin: ORIGIN } }).then((r) => r.json()).catch(() => ({ linked: false }));
if (!linked.linked) {
  const clientId = process.env.FLOWSTA_RELEASE_CLIENT_ID;
  if (!clientId) throw new Error('first run: set FLOWSTA_RELEASE_CLIENT_ID (the "Flowsta Release Tool" app at dev.flowsta.com)');
  console.log('linking the release tool with the Vault (approve it there)...');
  const r = await fetch(`${VAULT}/link-identity`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ app_name: 'Flowsta Release Tool', client_id: clientId, app_agent_pub_key: appKey }) });
  if (!r.ok) throw new Error(`link-identity refused: ${r.status} ${await r.text()}`);
}
console.log('asking the Vault to sign (approve it there within ten minutes; check the version, channel and hashes against the lines above)...');
const signRes = await fetch(`${VAULT}/sign-release-manifest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ manifest }) });
if (!signRes.ok) throw new Error(`sign refused: ${signRes.status} ${await signRes.text()}`);
const signed = await signRes.json();
if (signed.statement !== statement) throw new Error(`the Vault signed a different statement:\n  vault ${signed.statement}\n  here  ${statement}`);
const sig = Buffer.from(signed.signature, 'base64');
const raw = Buffer.from(SIGNER_DID.replace(/^did:flowsta:u/, ''), 'base64url').subarray(3, 35);
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
if (sig.length !== 64 || !cryptoVerify(null, Buffer.from(statement, 'utf8'), key, sig)) {
  throw new Error(`the signature does not verify as ${SIGNER_DID}: is the Vault signed in as @weareflowsta? (it signed as ${signed.signer_did})`);
}
manifest.signature = { signer: SIGNER_DID, sig: sig.toString('base64'), statement };
const body = JSON.stringify(manifest, null, 2) + '\n';
fs.mkdirSync(path.dirname(lastSignedPath), { recursive: true });
fs.writeFileSync(lastSignedPath, body);
console.log(`verified as Team Flowsta; written ${lastSignedPath}`);
if (!upload) process.exit(0);

// ---- Upload: the release itself (stable installs read the latest release's file), and for a beta the app's beta pre-release too.
const replaceAsset = async (rel, name, data, type) => {
  for (const a of rel.assets.filter((x) => x.name === name)) await gh(`/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
  await gh(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body: data });
};
await replaceAsset(release, 'release-manifest.json', body, 'application/json');
console.log(`uploaded release-manifest.json to ${tag}`);
if (channel === 'beta') {
  const latest = release.assets.find((a) => a.name === 'latest.json');
  if (!latest) throw new Error(`${tag} has no latest.json (the release workflow writes it)`);
  const latestBody = await (await fetch(latest.browser_download_url)).text();
  let beta = await (await gh(`/repos/${REPO}/releases/tags/${BETA_TAG}`)).json();
  if (!beta.id) {
    beta = await (await gh(`/repos/${REPO}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: BETA_TAG, name: `Beta channel (for the ${NAME} updater)`, body: 'Holds the beta channel\'s two updater files. The installers are on each beta\'s own release.', prerelease: true }),
    })).json();
  }
  await replaceAsset(beta, 'latest.json', latestBody, 'application/json');
  await replaceAsset(beta, 'release-manifest.json', body, 'application/json');
  console.log(`beta channel (${BETA_TAG}) now points at ${version}`);
}

#!/usr/bin/env node
/**
 * Sign and publish a node manifest.
 *
 *   node tools/sign-manifest.mjs <channel> [--sequence N] [--no-upload] [--api URL] [--vault URL]
 *
 * Reads manifest/<channel>.json (the body: no signature member), stamps
 * issued_at and the next sequence, builds the statement
 *   flowsta-node-manifest:v1:<channel>:<sequence>:<sha256 of the canonical body>
 * and asks the running Flowsta Vault (localhost:27777) to sign it with the
 * identity it holds. The Vault shows the request and the person approves it
 * there; this tool never sees a key. The signed manifest is verified with
 * the same code every node runs (agent/lib/manifest.mjs), written to
 * manifest/<channel>.signed.json and, unless --no-upload, published through
 * POST /api/v1/vault/node/manifest. The signature is the authorization: the
 * API verifies it again before storing, so no session or token is needed.
 *
 * One-time setup: the Vault signs only for linked apps. Register "Flowsta
 * Release Tool" at dev.flowsta.com, put its client id in
 * FLOWSTA_RELEASE_CLIENT_ID, and the first run links it (one approval in the
 * Vault). The tool's origin is http://localhost:7331.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { statementFor, verifyManifest, didToVerifyKey, DEFAULT_SIGNER_DID } from '../agent/lib/manifest.mjs';

const args = process.argv.slice(2);
const channel = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
if (!channel) { console.error('usage: sign-manifest.mjs <channel> [--sequence N] [--no-upload] [--api URL] [--vault URL]'); process.exit(2); }
const API = (opt('api', process.env.FLOWSTA_API_URL || 'https://auth-api.flowsta.com')).replace(/\/$/, '');
const VAULT = (opt('vault', 'http://localhost:27777')).replace(/\/$/, '');
const ORIGIN = 'http://localhost:7331';
const SIGNER_DID = process.env.MANIFEST_SIGNER_DID || DEFAULT_SIGNER_DID;
const upload = !args.includes('--no-upload');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bodyPath = path.join(root, 'manifest', `${channel}.json`);
const body = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
if (body.signature) throw new Error(`${bodyPath} must not carry a signature; it is the body`);
if (body.channel !== channel) throw new Error(`${bodyPath} says channel "${body.channel}"`);

// Next sequence: one above what the API serves, unless given.
let sequence = Number(opt('sequence', 0));
if (!sequence) {
  const res = await fetch(`${API}/api/v1/vault/node/manifest?channel=${encodeURIComponent(channel)}`);
  if (res.ok) sequence = (await res.json()).sequence + 1;
  else if (res.status === 404) sequence = 1;
  else throw new Error(`could not read the current manifest: HTTP ${res.status}`);
}
const manifest = { ...body, sequence, issued_at: new Date().toISOString() };
const statement = statementFor(manifest);
console.log(`channel ${channel} sequence ${sequence}\nstatement ${statement}`);

// The Vault signs for linked origins only.
const status = await fetch(`${VAULT}/status`).then((r) => r.json()).catch(() => null);
if (!status) throw new Error(`no Vault at ${VAULT}; open Flowsta Vault and unlock it`);
if (!status.unlocked) throw new Error('the Vault is locked; unlock it first');
const linked = await fetch(`${VAULT}/link-status`, { headers: { Origin: ORIGIN } }).then((r) => r.json()).catch(() => ({ linked: false }));
if (!linked.linked) {
  const clientId = process.env.FLOWSTA_RELEASE_CLIENT_ID;
  if (!clientId) throw new Error('first run: set FLOWSTA_RELEASE_CLIENT_ID (register "Flowsta Release Tool" at dev.flowsta.com)');
  const require = createRequire(path.join(root, 'updater', 'package.json'));
  const { hashFrom32AndType, encodeHashToBase64, HoloHashType } = require('holochain-client-07');
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const appKey = encodeHashToBase64(hashFrom32AndType(raw, HoloHashType.Agent));
  console.log('linking the release tool with the Vault (approve it there)...');
  const r = await fetch(`${VAULT}/link-identity`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ app_name: 'Flowsta Release Tool', client_id: clientId, app_agent_pub_key: appKey }) });
  if (!r.ok) throw new Error(`link-identity refused: ${r.status} ${await r.text()}`);
}

console.log('asking the Vault to sign (approve it there)...');
const signRes = await fetch(`${VAULT}/sign`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ type: 'bytes', bytes: Buffer.from(statement, 'utf8').toString('base64'), reason: `Sign node manifest ${channel} #${sequence}` }),
});
if (!signRes.ok) throw new Error(`sign refused: ${signRes.status} ${await signRes.text()}`);
const signed = await signRes.json();
const sigBytes = /^[0-9a-f]{128}$/i.test(signed.signature) ? Buffer.from(signed.signature, 'hex') : Buffer.from(signed.signature, 'base64');
if (sigBytes.length !== 64) throw new Error(`unexpected signature length ${sigBytes.length}`);
manifest.signature = { signer: SIGNER_DID, sig: sigBytes.toString('base64'), statement };

const expectedKey = didToVerifyKey(SIGNER_DID);
const verdict = verifyManifest(manifest, { signerDid: SIGNER_DID, previousSequence: sequence - 1 });
if (!verdict.ok) throw new Error(`the signed manifest does not verify as ${SIGNER_DID}: ${verdict.reason}. Is the Vault signed in as @weareflowsta? (key ${expectedKey?.toString('base64url')})`);
const outPath = path.join(root, 'manifest', `${channel}.signed.json`);
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`verified; written ${path.relative(process.cwd(), outPath)}`);

if (upload) {
  const r = await fetch(`${API}/api/v1/vault/node/manifest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest) });
  const text = await r.text();
  if (!r.ok) throw new Error(`upload refused: ${r.status} ${text}`);
  console.log(`published: ${text}`);
}

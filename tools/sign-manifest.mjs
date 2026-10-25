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
 *
 * The Vault signs through POST /sign-node-manifest (Vault 1.7.0+): it derives
 * the statement from the manifest itself and shows the channel, sequence,
 * generations, digests and advisories before signing. (Its generic /sign
 * refuses `flowsta-` statements by design.) Two more modes:
 *   - --local-key <file>   an Ed25519 key kept in that file (created on first
 *                          use, mode 600). For the STAGING channel only: the
 *                          staging API and the staging node are told to trust
 *                          its DID (NODE_MANIFEST_SIGNER_DID / MANIFEST_SIGNER_DID).
 *                          Refused for the stable channel: production manifests
 *                          are signed by @weareflowsta in the Vault, nothing else.
 *   --print-did <file>     print the DID of a local key and exit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { statementFor, verifyManifest, didToVerifyKey, DEFAULT_SIGNER_DID } from '../agent/lib/manifest.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(root, 'updater', 'package.json'));
const { hashFrom32AndType, encodeHashToBase64, HoloHashType } = require('holochain-client-07');

/** A 39-byte Holochain agent key, spelled `u` + base64url, from a raw Ed25519 verify key. */
function agentKeyOf(raw32) { return encodeHashToBase64(hashFrom32AndType(raw32, HoloHashType.Agent)); }

/** Load or create the local signing key (PKCS8 PEM, mode 600). */
function localKey(file) {
  let pem;
  if (fs.existsSync(file)) pem = fs.readFileSync(file, 'utf8');
  else {
    pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, pem, { mode: 0o600 });
    console.log(`created local signing key ${file}`);
  }
  const privateKey = createPrivateKey(pem);
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, did: `did:flowsta:${agentKeyOf(raw)}` };
}

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const optionValues = new Set(['--sequence', '--api', '--vault', '--local-key', '--print-did', '--publish-file'].map((f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; }));
const channel = args.find((a) => !a.startsWith('--') && !optionValues.has(a));
if (opt('print-did')) { console.log(localKey(opt('print-did')).did); process.exit(0); }
// --publish-file <signed.json>: upload a manifest signed earlier (e.g. signed
// before the API that serves the channel was deployed). Verified first.
if (opt('publish-file')) {
  const file = opt('publish-file');
  const signed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const api = (opt('api', process.env.FLOWSTA_API_URL || 'https://auth-api.flowsta.com')).replace(/\/$/, '');
  // Verified against the signer this machine trusts (the Vault key, or
  // MANIFEST_SIGNER_DID for staging) - never against whatever the file claims.
  const signer = process.env.MANIFEST_SIGNER_DID || DEFAULT_SIGNER_DID;
  const verdict = verifyManifest(signed, { signerDid: signer, previousSequence: 0, channel: signed.channel });
  if (!verdict.ok) throw new Error(`${file} does not verify as ${signer}: ${verdict.reason}`);
  const r = await fetch(`${api}/api/v1/vault/node/manifest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
  const text = await r.text();
  if (!r.ok) throw new Error(`upload refused: ${r.status} ${text}`);
  console.log(`published ${signed.channel} #${signed.sequence}: ${text}`);
  process.exit(0);
}
if (!channel) { console.error('usage: sign-manifest.mjs <channel> [--sequence N] [--no-upload] [--api URL] [--vault URL] [--local-key FILE]\n       sign-manifest.mjs --print-did FILE'); process.exit(2); }
const localKeyFile = opt('local-key');
if (localKeyFile && channel === 'stable') { console.error('the stable channel is signed by @weareflowsta in the Vault only; --local-key is refused'); process.exit(2); }
const API = (opt('api', process.env.FLOWSTA_API_URL || 'https://auth-api.flowsta.com')).replace(/\/$/, '');
const VAULT = (opt('vault', 'http://localhost:27777')).replace(/\/$/, '');
const ORIGIN = 'http://localhost:7331';
const local = localKeyFile ? localKey(localKeyFile) : null;
const SIGNER_DID = local ? local.did : (process.env.MANIFEST_SIGNER_DID || DEFAULT_SIGNER_DID);
const upload = !args.includes('--no-upload');
const bodyPath = path.join(root, 'manifest', `${channel}.json`);
const body = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
if (body.signature) throw new Error(`${bodyPath} must not carry a signature; it is the body`);
if (body.channel !== channel) throw new Error(`${bodyPath} says channel "${body.channel}"`);

// Next sequence: one above what the API serves, unless given.
// The API's answer is unauthenticated: a jump far beyond the last sequence this
// machine signed is refused without --sequence, so a hostile API cannot have
// the signer burn the channel's sequence space (found 2026-10-25).
const MAX_SEQUENCE_JUMP = 100;
let sequence = Number(opt('sequence', 0));
if (!sequence) {
  const res = await fetch(`${API}/api/v1/vault/node/manifest?channel=${encodeURIComponent(channel)}`);
  if (res.ok) sequence = (await res.json()).sequence + 1;
  else if (res.status === 404) sequence = 1;
  else throw new Error(`could not read the current manifest: HTTP ${res.status}`);
  const lastSignedPath = path.join(root, 'manifest', `${channel}.signed.json`);
  const lastSigned = fs.existsSync(lastSignedPath) ? JSON.parse(fs.readFileSync(lastSignedPath, 'utf8')).sequence : 0;
  if (sequence > lastSigned + MAX_SEQUENCE_JUMP) throw new Error(`the API says the next sequence is ${sequence} but the last one signed here was ${lastSigned}; pass --sequence to confirm`);
}
if (!Number.isInteger(sequence) || sequence < 1 || sequence > 2 ** 31 - 1) throw new Error(`sequence ${sequence} is out of range`);
const manifest = { ...body, sequence, issued_at: new Date().toISOString() };
const statement = statementFor(manifest);
console.log(`channel ${channel} sequence ${sequence}\nstatement ${statement}`);

let sigBytes;
if (local) {
  console.log(`signing with the local key as ${SIGNER_DID} (${channel} channel)`);
  sigBytes = cryptoSign(null, Buffer.from(statement, 'utf8'), local.privateKey);
} else {
// The Vault signs for linked origins only.
const status = await fetch(`${VAULT}/status`).then((r) => r.json()).catch(() => null);
if (!status) throw new Error(`no Vault at ${VAULT}; open Flowsta Vault and unlock it`);
if (!status.unlocked) throw new Error('the Vault is locked; unlock it first');
const linked = await fetch(`${VAULT}/link-status`, { headers: { Origin: ORIGIN } }).then((r) => r.json()).catch(() => ({ linked: false }));
if (!linked.linked) {
  const clientId = process.env.FLOWSTA_RELEASE_CLIENT_ID;
  if (!clientId) throw new Error('first run: set FLOWSTA_RELEASE_CLIENT_ID (register "Flowsta Release Tool" at dev.flowsta.com)');
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const appKey = agentKeyOf(raw);
  console.log('linking the release tool with the Vault (approve it there)...');
  const r = await fetch(`${VAULT}/link-identity`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ app_name: 'Flowsta Release Tool', client_id: clientId, app_agent_pub_key: appKey }) });
  if (!r.ok) throw new Error(`link-identity refused: ${r.status} ${await r.text()}`);
}

console.log('asking the Vault to sign (approve it there; check the channel, sequence and digests against the lines above)...');
const signRes = await fetch(`${VAULT}/sign-node-manifest`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ manifest }),
});
if (!signRes.ok) throw new Error(`sign refused: ${signRes.status} ${await signRes.text()}`);
const signed = await signRes.json();
// The Vault derived the statement itself; it must be the one computed here.
if (signed.statement !== statement) throw new Error(`the Vault signed a different statement:\n  vault ${signed.statement}\n  here  ${statement}`);
if (signed.signer_did && signed.signer_did !== SIGNER_DID) console.warn(`note: the Vault's identity is ${signed.signer_did}, expected ${SIGNER_DID}`);
sigBytes = /^[0-9a-f]{128}$/i.test(signed.signature) ? Buffer.from(signed.signature, 'hex') : Buffer.from(signed.signature, 'base64');
}
if (sigBytes.length !== 64) throw new Error(`unexpected signature length ${sigBytes.length}`);
manifest.signature = { signer: SIGNER_DID, sig: sigBytes.toString('base64'), statement };

const expectedKey = didToVerifyKey(SIGNER_DID);
const verdict = verifyManifest(manifest, { signerDid: SIGNER_DID, previousSequence: sequence - 1, channel });
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

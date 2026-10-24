/**
 * The node manifest: what every node should be running, signed offline by
 * Flowsta's identity. The agent accepts a manifest only when
 *   - its signature verifies against the signer DID baked into the image,
 *   - its sequence is higher than the one already applied (no replay),
 *   - it has the shape below.
 *
 * Statement signed (UTF-8, Ed25519 detached):
 *   flowsta-node-manifest:v1:<channel>:<sequence>:<sha256 hex of canonical JSON of the manifest without "signature">
 * The agent key inside the DID is a 39-byte Holochain AgentPubKey
 * (0x84 0x20 0x24 + 32-byte Ed25519 verify key + 4 location bytes), spelled
 * `u` + base64url. The API never holds this key; the Vault signs.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { canonicalJson } from './canonical.mjs';

export const STATEMENT_PREFIX = 'flowsta-node-manifest:v1:';

// Team Flowsta's identity (@weareflowsta). Changing it takes a new agent
// image, which itself only arrives through a manifest this key signed.
export const DEFAULT_SIGNER_DID = 'did:flowsta:uhCAkWuA-Ehm9EVzcsPE2Wo_vpc9ImljHN8NMMEXpbtG5BdooOV9a';
export const GENERATION_STATES = new Set(['serving', 'retiring', 'retired']);
const GEN_ID = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const DIGEST_IMAGE = /^[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** `did:flowsta:u<base64url 39 bytes>` → 32-byte verify key, or null. */
export function didToVerifyKey(did) {
  if (typeof did !== 'string' || !did.startsWith('did:flowsta:u')) return null;
  let raw;
  try { raw = Buffer.from(did.slice('did:flowsta:u'.length), 'base64url'); } catch { return null; }
  if (raw.length !== 39 || raw[0] !== 0x84 || raw[1] !== 0x20 || raw[2] !== 0x24) return null;
  return raw.subarray(3, 35);
}

export function bodyOf(manifest) {
  const { signature, ...body } = manifest;
  return body;
}

export function bodyHash(manifest) {
  return createHash('sha256').update(canonicalJson(bodyOf(manifest))).digest('hex');
}

export function statementFor(manifest) {
  return `${STATEMENT_PREFIX}${manifest.channel}:${manifest.sequence}:${bodyHash(manifest)}`;
}

export function verifyEd25519(message, signature, verifyKey) {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, verifyKey]), format: 'der', type: 'spki' });
  try { return cryptoVerify(null, Buffer.from(message, 'utf8'), key, signature); } catch { return false; }
}

/** Shape check. Returns a reason string, or null when the manifest is well formed. */
export function validateShape(m) {
  if (!m || typeof m !== 'object') return 'not an object';
  if (m.v !== 1) return 'unsupported manifest version';
  if (typeof m.channel !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(m.channel)) return 'bad channel';
  if (!Number.isInteger(m.sequence) || m.sequence < 1) return 'bad sequence';
  if (typeof m.issued_at !== 'string' || Number.isNaN(Date.parse(m.issued_at))) return 'bad issued_at';
  if (!Array.isArray(m.generations) || m.generations.length === 0 || m.generations.length > 4) return 'bad generations';
  const ids = new Set(); const ports = new Set();
  for (const g of m.generations) {
    if (!g || typeof g !== 'object') return 'bad generation';
    if (typeof g.id !== 'string' || !GEN_ID.test(g.id) || ids.has(g.id)) return `bad generation id ${g.id}`;
    ids.add(g.id);
    if (!GENERATION_STATES.has(g.state)) return `bad state on ${g.id}`;
    if (typeof g.holochain !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(g.holochain)) return `bad holochain version on ${g.id}`;
    if (!g.conductor || typeof g.conductor !== 'object') return `bad conductor on ${g.id}`;
    if (typeof g.conductor.image !== 'string' || !DIGEST_IMAGE.test(g.conductor.image)) return `conductor image on ${g.id} must be pinned by digest`;
    if (!Number.isInteger(g.conductor.admin_port) || g.conductor.admin_port < 1024 || g.conductor.admin_port > 65535 || ports.has(g.conductor.admin_port)) return `bad admin_port on ${g.id}`;
    ports.add(g.conductor.admin_port);
    if (!g.bootstrap || typeof g.bootstrap.url !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(g.bootstrap.url)) return `bad bootstrap url on ${g.id}`;
    if (g.bootstrap.server_image !== undefined && !DIGEST_IMAGE.test(g.bootstrap.server_image)) return `bootstrap server image on ${g.id} must be pinned by digest`;
    if (g.adopts_legacy_conductor !== undefined && typeof g.adopts_legacy_conductor !== 'boolean') return `bad adopts_legacy_conductor on ${g.id}`;
    if (!Array.isArray(g.dnas) || g.dnas.length > 40) return `bad dnas on ${g.id}`;
    for (const d of g.dnas) {
      if (!d || typeof d.app_id !== 'string' || !/^[a-z0-9_]{1,64}$/.test(d.app_id)) return `bad dna app_id on ${g.id}`;
      if (typeof d.sha256 !== 'string' || !SHA256.test(d.sha256)) return `bad dna sha256 for ${d.app_id}`;
      if (typeof d.url !== 'string' || !/^https:\/\//.test(d.url)) return `bad dna url for ${d.app_id}`;
    }
  }
  if (!m.agent || typeof m.agent.image !== 'string' || !DIGEST_IMAGE.test(m.agent.image)) return 'agent image must be pinned by digest';
  if (m.advisories !== undefined) {
    if (!Array.isArray(m.advisories) || m.advisories.length > 20) return 'bad advisories';
    for (const a of m.advisories) {
      if (!a || typeof a.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(a.id)) return 'bad advisory id';
      if (!['security', 'routine'].includes(a.severity)) return `bad severity on advisory ${a.id}`;
      if (!['update', 'restart-conductor', 'notice'].includes(a.action)) return `bad action on advisory ${a.id}`;
      if (a.generation !== undefined && !ids.has(a.generation)) return `advisory ${a.id} names an unknown generation`;
      if (typeof a.text !== 'string' || a.text.length > 500) return `bad text on advisory ${a.id}`;
    }
  }
  if (!m.signature || typeof m.signature !== 'object') return 'missing signature';
  if (typeof m.signature.signer !== 'string' || typeof m.signature.sig !== 'string') return 'bad signature fields';
  return null;
}

/**
 * Full acceptance check. `signerDid` is the DID baked into the image;
 * `previousSequence` the sequence already applied (0 when none).
 * Returns { ok: true, manifest } or { ok: false, reason }.
 */
export function verifyManifest(manifest, { signerDid, previousSequence = 0 }) {
  const shape = validateShape(manifest);
  if (shape) return { ok: false, reason: shape };
  if (manifest.signature.signer !== signerDid) return { ok: false, reason: 'signer is not the trusted Flowsta identity' };
  const key = didToVerifyKey(signerDid);
  if (!key) return { ok: false, reason: 'trusted signer DID is malformed' };
  let sig;
  try { sig = Buffer.from(manifest.signature.sig, 'base64'); } catch { return { ok: false, reason: 'signature is not base64' }; }
  if (sig.length !== 64) return { ok: false, reason: 'signature is not 64 bytes' };
  const statement = statementFor(manifest);
  if (manifest.signature.statement !== undefined && manifest.signature.statement !== statement) {
    return { ok: false, reason: 'statement does not match the body' };
  }
  if (!verifyEd25519(statement, sig, key)) return { ok: false, reason: 'signature does not verify' };
  if (manifest.sequence <= previousSequence) return { ok: false, reason: `sequence ${manifest.sequence} is not newer than ${previousSequence}` };
  return { ok: true, manifest };
}

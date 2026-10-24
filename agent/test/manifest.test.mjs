import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { canonicalJson } from '../lib/canonical.mjs';
import { verifyManifest, statementFor, didToVerifyKey, validateShape, bodyHash } from '../lib/manifest.mjs';

function blake2bLocation(core) {
  const h = createHash('blake2b512').update(core).digest(); // placeholder: location bytes are not checked by the verifier
  return h.subarray(0, 4);
}

/** A test signer: Ed25519 key pair, its DID in the Vault's spelling, and a sign() for statements. */
export function testSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const agentKey = Buffer.concat([Buffer.from([0x84, 0x20, 0x24]), raw, blake2bLocation(raw)]);
  const did = `did:flowsta:u${agentKey.toString('base64url')}`;
  return { did, raw, signStatement: (s) => sign(null, Buffer.from(s, 'utf8'), privateKey).toString('base64') };
}

export function sampleManifest(overrides = {}) {
  return {
    v: 1, channel: 'staging', issued_at: '2026-10-24T10:00:00Z', sequence: 3,
    generations: [
      { id: 'holochain-0.6', state: 'serving', holochain: '0.6.1', adopts_legacy_conductor: true,
        conductor: { image: 'us-docker.pkg.dev/flowsta-475001/public/flowsta-edgenode@sha256:' + '9'.repeat(64), admin_port: 4444 },
        bootstrap: { url: 'https://bootstrap.flowsta.com' },
        dnas: [{ app_id: 'flowsta_identity_v1_4', sha256: 'a'.repeat(64), url: 'https://auth-api.flowsta.com/api/v1/vault/node/dna-bundle/identity/1.4' }] },
      { id: 'holochain-0.7', state: 'serving', holochain: '0.7.1',
        conductor: { image: 'us-docker.pkg.dev/flowsta-475001/public/flowsta-edgenode@sha256:' + '7'.repeat(64), admin_port: 4445 },
        bootstrap: { url: 'https://bootstrap-7.flowsta.com' }, dnas: [] },
    ],
    agent: { image: 'us-docker.pkg.dev/flowsta-475001/public/flowsta-dht-node@sha256:' + '1'.repeat(64) },
    advisories: [{ id: 'oct-24-note', severity: 'routine', action: 'notice', text: 'Rehearsal manifest.' }],
    ...overrides,
  };
}

export function signed(manifest, signer) {
  const statement = statementFor(manifest);
  return { ...manifest, signature: { signer: signer.did, sig: signer.signStatement(statement), statement } };
}

test('canonical JSON sorts keys and drops whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, { z: 'x', y: 2 }] }), '{"a":[true,null,{"y":2,"z":"x"}],"b":1}');
});

test('a DID in the Vault spelling yields the 32-byte verify key', () => {
  const s = testSigner();
  assert.deepEqual(didToVerifyKey(s.did), s.raw);
  assert.equal(didToVerifyKey('did:flowsta:uhCAk' + 'notbase64url!'), null);
  assert.equal(didToVerifyKey('did:web:flowsta.com'), null);
});

test('a well-formed, correctly signed, newer manifest is accepted', () => {
  const s = testSigner();
  const m = signed(sampleManifest(), s);
  assert.equal(validateShape(m), null);
  const r = verifyManifest(m, { signerDid: s.did, previousSequence: 2 });
  assert.equal(r.ok, true, r.reason);
});

test('the signature covers the body: any change breaks it', () => {
  const s = testSigner();
  const m = signed(sampleManifest(), s);
  const tampered = structuredClone(m);
  tampered.generations[1].conductor.image = 'us-docker.pkg.dev/flowsta-475001/public/flowsta-edgenode@sha256:' + 'e'.repeat(64);
  const r = verifyManifest(tampered, { signerDid: s.did });
  assert.equal(r.ok, false);
  assert.match(r.reason, /statement does not match|does not verify/);
  assert.notEqual(bodyHash(m), bodyHash(tampered));
});

test('another key, even with a valid signature of its own, is refused', () => {
  const trusted = testSigner(); const other = testSigner();
  const m = signed(sampleManifest(), other);
  const r = verifyManifest(m, { signerDid: trusted.did });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signer is not the trusted Flowsta identity');
  // Claiming the trusted DID while signing with another key fails on the signature itself
  const forged = { ...m, signature: { ...m.signature, signer: trusted.did } };
  assert.equal(verifyManifest(forged, { signerDid: trusted.did }).reason, 'signature does not verify');
});

test('an older or equal sequence is a replay and is refused', () => {
  const s = testSigner();
  const m = signed(sampleManifest({ sequence: 3 }), s);
  assert.equal(verifyManifest(m, { signerDid: s.did, previousSequence: 3 }).ok, false);
  assert.equal(verifyManifest(m, { signerDid: s.did, previousSequence: 9 }).ok, false);
  assert.equal(verifyManifest(m, { signerDid: s.did, previousSequence: 0 }).ok, true);
});

test('shape: images must be digest-pinned, ports unique, states known', () => {
  const base = sampleManifest();
  const tagImage = structuredClone(base); tagImage.generations[0].conductor.image = 'us-docker.pkg.dev/flowsta-475001/public/flowsta-edgenode:hc0.6.1';
  assert.match(validateShape({ ...tagImage, signature: { signer: 'x', sig: 'y' } }), /pinned by digest/);
  const samePort = structuredClone(base); samePort.generations[1].conductor.admin_port = 4444;
  assert.match(validateShape({ ...samePort, signature: { signer: 'x', sig: 'y' } }), /admin_port/);
  const badState = structuredClone(base); badState.generations[1].state = 'paused';
  assert.match(validateShape({ ...badState, signature: { signer: 'x', sig: 'y' } }), /bad state/);
  const badAdvisory = structuredClone(base); badAdvisory.advisories = [{ id: 'x', severity: 'urgent', action: 'update', text: '' }];
  assert.match(validateShape({ ...badAdvisory, signature: { signer: 'x', sig: 'y' } }), /severity/);
});

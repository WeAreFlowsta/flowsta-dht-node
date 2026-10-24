import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planActions, legacyDataMount, actionableAdvisories, GENERATION_LABEL, CONFIG_LABEL } from '../lib/plan.mjs';
import { parseWindow, inWindow } from '../lib/window.mjs';
import { renderConductorConfig, carryOverFromConfig } from '../lib/conductor-config.mjs';
import { tarOfFile, filesOfTar } from '../lib/tar.mjs';

const IMG6 = 'repo/edgenode@sha256:' + '6'.repeat(64);
const IMG7 = 'repo/edgenode@sha256:' + '7'.repeat(64);
const AGENT = 'repo/agent@sha256:' + '1'.repeat(64);
const desired = {
  agentImage: AGENT,
  generations: [
    { id: 'holochain-0.6', state: 'serving', image: IMG6, configSha: 'c6', adopts: true },
    { id: 'holochain-0.7', state: 'serving', image: IMG7, configSha: 'c7', adopts: false },
  ],
};
const managed = (gen, image, configSha, running = true) => ({ name: `flowsta-conductor-${gen}`, id: gen, image, running, labels: { [GENERATION_LABEL]: gen, [CONFIG_LABEL]: configSha } });

test('first run on an existing node: adopt the legacy conductor, create the new generation', () => {
  const actions = planActions(desired, { managed: [], legacy: { name: 'flowsta-conductor', running: true }, agentImage: AGENT });
  assert.deepEqual(actions.map((a) => [a.type, a.generation, a.disruptive]), [['adopt', 'holochain-0.6', true], ['create', 'holochain-0.7', false]]);
});

test('first run on a fresh node: create both, nothing disruptive', () => {
  const actions = planActions(desired, { managed: [], legacy: null, agentImage: AGENT });
  assert.deepEqual(actions.map((a) => [a.type, a.disruptive]), [['create', false], ['create', false]]);
});

test('steady state: nothing to do', () => {
  const actions = planActions(desired, { managed: [managed('holochain-0.6', IMG6, 'c6'), managed('holochain-0.7', IMG7, 'c7')], legacy: null, agentImage: AGENT });
  assert.deepEqual(actions, []);
});

test('a new image digest or config means a disruptive replace; a stopped conductor is started', () => {
  const newImage = 'repo/edgenode@sha256:' + 'a'.repeat(64);
  const actions = planActions(
    { ...desired, generations: [{ ...desired.generations[0], image: newImage }, { ...desired.generations[1], configSha: 'c7-new' }] },
    { managed: [managed('holochain-0.6', IMG6, 'c6'), managed('holochain-0.7', IMG7, 'c7')], legacy: null, agentImage: AGENT },
  );
  assert.deepEqual(actions.map((a) => [a.type, a.generation, a.reason]), [
    ['replace', 'holochain-0.6', 'conductor image changed'],
    ['replace', 'holochain-0.7', 'conductor config changed'],
  ]);
  const stopped = planActions(desired, { managed: [managed('holochain-0.6', IMG6, 'c6', false), managed('holochain-0.7', IMG7, 'c7')], legacy: null, agentImage: AGENT });
  assert.deepEqual(stopped.map((a) => [a.type, a.disruptive]), [['start', false]]);
});

test('retired and vanished generations are stopped, never removed; the agent self-updates last', () => {
  const retired = { ...desired, agentImage: 'repo/agent@sha256:' + '2'.repeat(64), generations: [{ ...desired.generations[0], state: 'retired' }] };
  const actions = planActions(retired, { managed: [managed('holochain-0.6', IMG6, 'c6'), managed('holochain-0.7', IMG7, 'c7')], legacy: null, agentImage: AGENT });
  assert.deepEqual(actions.map((a) => [a.type, a.generation ?? a.image]), [
    ['stop', 'holochain-0.6'], ['stop', 'holochain-0.7'], ['self-update', retired.agentImage],
  ]);
  assert.ok(actions.every((a) => a.type !== 'remove'));
});

test('legacy data mount: named volume or bind path', () => {
  assert.deepEqual(legacyDataMount({ Mounts: [{ Type: 'volume', Name: 'flowsta-dht-node_conductor-data', Destination: '/data' }] }), { volume: 'flowsta-dht-node_conductor-data' });
  assert.deepEqual(legacyDataMount({ Mounts: [{ Type: 'bind', Source: '/srv/hc', Destination: '/data' }] }), { bind: '/srv/hc' });
  assert.equal(legacyDataMount({ Mounts: [] }), null);
});

test('window: inside, outside, across midnight', () => {
  const w = parseWindow('03:00-05:00');
  assert.equal(inWindow(new Date(2026, 9, 24, 3, 30), w), true);
  assert.equal(inWindow(new Date(2026, 9, 24, 5, 0), w), false);
  assert.equal(inWindow(new Date(2026, 9, 24, 12, 0), w), false);
  const night = parseWindow('23:00-01:00');
  assert.equal(inWindow(new Date(2026, 9, 24, 23, 30), night), true);
  assert.equal(inWindow(new Date(2026, 9, 24, 0, 30), night), true);
  assert.equal(inWindow(new Date(2026, 9, 24, 2, 0), night), false);
  assert.throws(() => parseWindow('3am-5am'));
});

test('advisories: security ones outside the window only when allowed; notices never act', () => {
  const manifest = { advisories: [
    { id: 'sec', severity: 'security', action: 'restart-conductor', generation: 'holochain-0.6' },
    { id: 'rout', severity: 'routine', action: 'restart-conductor', generation: 'holochain-0.6' },
    { id: 'note', severity: 'routine', action: 'notice' },
    { id: 'done', severity: 'security', action: 'restart-conductor' },
  ] };
  const applied = new Set(['done']);
  assert.deepEqual(actionableAdvisories(manifest, { applied, inWindow: false, securityAnytime: true }).map((a) => a.id), ['sec']);
  assert.deepEqual(actionableAdvisories(manifest, { applied, inWindow: false, securityAnytime: false }).map((a) => a.id), []);
  assert.deepEqual(actionableAdvisories(manifest, { applied, inWindow: true, securityAnytime: false }).map((a) => a.id), ['sec', 'rout']);
});

test('conductor config: 0.6 keeps signal_url, 0.7 has none and carries request_timeout_s + db_sync_level', () => {
  const gen6 = { id: 'holochain-0.6', holochain: '0.6.1', conductor: { admin_port: 4444 }, bootstrap: { url: 'https://bootstrap.flowsta.com' } };
  const gen7 = { id: 'holochain-0.7', holochain: '0.7.1', conductor: { admin_port: 4445 }, bootstrap: { url: 'https://bootstrap-7.flowsta.com' } };
  const c6 = renderConductorConfig(gen6, { authBootstrap: 'AAA', authRelay: 'BBB' });
  const c7 = renderConductorConfig(gen7, { authBootstrap: 'AAA', authRelay: 'BBB' });
  assert.match(c6, /signal_url: "wss:\/\/bootstrap\.flowsta\.com"/);
  assert.match(c6, /port: 4444/);
  assert.doesNotMatch(c7, /signal_url|webrtc/);
  assert.match(c7, /relay_url: "https:\/\/bootstrap-7\.flowsta\.com\.\/"/);
  assert.match(c7, /request_timeout_s: 60/);
  assert.match(c7, /db_sync_level: Normal/);
  assert.match(c7, /port: 4445/);
  for (const c of [c6, c7]) { assert.match(c, /lair_server_in_proc/); assert.match(c, /base64_auth_material_bootstrap: "AAA"/); }
});

test('carry-over reads auth material and tracing from a hand-written config', () => {
  const yaml = 'network:\n  bootstrap_url: "https://b"\n  base64_auth_material_bootstrap: "eyJjIn0="\n  base64_auth_material_relay: "eyJyIn0="\n\ntracing_override: "info,kitsune2=info"\n';
  assert.deepEqual(carryOverFromConfig(yaml), { authBootstrap: 'eyJjIn0=', authRelay: 'eyJyIn0=', tracing: 'info,kitsune2=info' });
});

test('tar round trip: one file in, the same file out', () => {
  const tar = tarOfFile('conductor-config.template.yaml', 'hello: world\n');
  assert.equal(tar.length % 512, 0);
  const files = filesOfTar(tar);
  assert.deepEqual(Object.keys(files), ['conductor-config.template.yaml']);
  assert.equal(files['conductor-config.template.yaml'].toString(), 'hello: world\n');
});

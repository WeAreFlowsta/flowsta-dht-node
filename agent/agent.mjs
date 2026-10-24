#!/usr/bin/env node
/**
 * Flowsta node agent.
 *
 * Pulls the signed node manifest, verifies it against the Flowsta identity
 * baked into this image, and brings the node to what the manifest says:
 * one conductor container per serving generation (its own data volume, admin
 * port and bootstrap), the DNAs each generation lists, the agent itself.
 * Disruptive changes (replacing a running conductor, adopting the old one,
 * stopping a retired generation, updating the agent) happen in the
 * maintenance window and are verified; a failed change is rolled back to the
 * previous container. Every generation reports its health to the API.
 *
 * What it never does: delete a data volume, uninstall an app, accept an
 * inbound connection, act on an unsigned or older manifest.
 *
 * Environment:
 *   API_URL                   Flowsta API (manifest, DNA bundles, reports)         required
 *   CHANNEL                   manifest channel: stable | staging | proofpoll         default stable
 *   MANIFEST_SIGNER_DID       the Flowsta identity allowed to sign manifests        baked default
 *   UPDATE_WINDOW             HH:MM-HH:MM, node-local (set TZ)                      default 03:00-05:00
 *   SECURITY_UPDATES_ANYTIME  1 = security advisories may act outside the window    default 1
 *   NODE_LABEL                name this node reports under                          default hostname
 *   NODE_SECRET               fleet nodes only; reports trusted outright
 *   BOOTSTRAP_AUTH_MATERIAL / RELAY_AUTH_MATERIAL   auth material for the conductor configs
 *                             (default: carried over from the adopted conductor, else the community client id)
 *   TRACING_OVERRIDE          conductor tracing (default info,kitsune2=info)
 *   CONDUCTOR_DATA_ROOT       data_root_path inside the conductor container; default: carried over from the
 *                             adopted conductor, else /data/holochain. Never change it for a running generation.
 *   CONDUCTOR_LAIR_ROOT       lair_root (default <CONDUCTOR_DATA_ROOT>/ks)
 *   LEGACY_CONDUCTOR_NAMES    containers the agent may adopt (default flowsta-conductor,holochain-conductor)
 *   LEGACY_DATA_VOLUMES       volumes of an already-removed conductor the agent may adopt
                             (default flowsta-dht-node_conductor-data,holochain-data,holochain-conductor-data)
 *   AGENT_CONTAINER_NAME      this container's name (default flowsta-agent)
 *   STATE_DIR                 default /state
 *   STATUS_PORT               local status page on 127.0.0.1 (default 8787; 0 = off)
 *   TICK_SECONDS / REPORT_INTERVAL    default 60 / 600
 *   DRY_RUN                   1 = plan and log, change nothing (no container, DNA or advisory action)
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Docker, conductorContainerSpec } from './lib/docker.mjs';
import { verifyManifest, DEFAULT_SIGNER_DID } from './lib/manifest.mjs';
import { planActions, legacyDataMount, actionableAdvisories, containerNameFor, dataVolumeFor, MANAGED_LABEL, GENERATION_LABEL, CONFIG_LABEL, IMAGE_LABEL, SEQUENCE_LABEL } from './lib/plan.mjs';
import { parseWindow, inWindow } from './lib/window.mjs';
import { renderConductorConfig, carryOverFromConfig } from './lib/conductor-config.mjs';
import { tarOfFile, filesOfTar } from './lib/tar.mjs';
import { loadState, saveState, remember } from './lib/state.mjs';
import { reconcileDnas } from './lib/dnas.mjs';
import { verifyConductor, connectAdmin, isRunning } from './lib/verify.mjs';
import { probeConductor } from '../updater/network-probe.mjs';

const COMMUNITY_AUTH_MATERIAL = 'eyJjbGllbnRfaWQiOiJmbG93c3RhX2FwcF83NTRhODlmMDg3MGE5ZGRhZjhhODhhNTFhYzcwYzAxMzQwMWJhNDhiN2QyMTk1MTdhZjlkNzZhYzBjNzU2N2ExIn0=';
const TEMPLATE_DIR = '/usr/local/share/holochain';
const TEMPLATE_FILE = 'conductor-config.template.yaml';

const env = process.env;
const cfg = {
  apiUrl: (env.API_URL || '').replace(/\/$/, ''),
  channel: env.CHANNEL || 'stable',
  signerDid: env.MANIFEST_SIGNER_DID || DEFAULT_SIGNER_DID,
  window: parseWindow(env.UPDATE_WINDOW || '03:00-05:00'),
  securityAnytime: (env.SECURITY_UPDATES_ANYTIME ?? '1') !== '0',
  label: (env.NODE_LABEL || os.hostname()).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'community-node',
  nodeSecret: env.NODE_SECRET || null,
  legacyNames: (env.LEGACY_CONDUCTOR_NAMES || 'flowsta-conductor,holochain-conductor').split(',').map((s) => s.trim()).filter(Boolean),
  legacyVolumes: (env.LEGACY_DATA_VOLUMES || 'flowsta-dht-node_conductor-data,holochain-data,holochain-conductor-data').split(',').map((s) => s.trim()).filter(Boolean),
  selfName: env.AGENT_CONTAINER_NAME || 'flowsta-agent',
  stateDir: env.STATE_DIR || '/state',
  statusPort: Number(env.STATUS_PORT ?? 8787),
  tickMs: Number(env.TICK_SECONDS || 60) * 1000,
  reportMs: Number(env.REPORT_INTERVAL || 600) * 1000,
  happsDir: env.HAPPS_DIR || '/app/happs',
  version: env.AGENT_VERSION || 'dev',
  dryRun: env.DRY_RUN === '1',
};
if (!cfg.apiUrl) { console.error('API_URL is required'); process.exit(1); }

const docker = new Docker();
const stateFile = path.join(cfg.stateDir, 'state.json');
const state = loadState(stateFile);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const persist = () => saveState(stateFile, state);
const nowUnix = () => Math.floor(Date.now() / 1000);
let manifestEtag = null;
let busy = false;
let lastReportAt = 0;
let current = { manifest: state.manifest, actions: [], waiting: [], lastTick: null, lastError: null };

// ── manifest ─────────────────────────────────────────────────────────────────

async function fetchManifest() {
  const headers = {};
  if (manifestEtag) headers['If-None-Match'] = manifestEtag;
  const res = await fetch(`${cfg.apiUrl}/api/v1/vault/node/manifest?channel=${encodeURIComponent(cfg.channel)}`, { headers });
  if (res.status === 304) return null;
  if (res.status === 404) { if (!state.manifest) log(`no manifest published yet on channel "${cfg.channel}"`); return null; }
  if (!res.ok) throw new Error(`manifest fetch: HTTP ${res.status}`);
  const text = await res.text();
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new Error('manifest is not JSON'); }
  const verdict = verifyManifest(manifest, { signerDid: cfg.signerDid, previousSequence: state.manifest_sequence });
  if (!verdict.ok) {
    if (manifest?.sequence === state.manifest_sequence && state.manifest) { manifestEtag = res.headers.get('etag'); return null; }
    log(`manifest REFUSED: ${verdict.reason}`);
    remember(state, { event: 'manifest_refused', reason: verdict.reason, sequence: manifest?.sequence });
    persist();
    return null;
  }
  manifestEtag = res.headers.get('etag');
  state.manifest = manifest;
  state.manifest_sequence = manifest.sequence;
  remember(state, { event: 'manifest_accepted', sequence: manifest.sequence, channel: manifest.channel });
  persist();
  log(`manifest ${manifest.channel} #${manifest.sequence} accepted (${manifest.generations.map((g) => `${g.id}:${g.state}`).join(', ')})`);
  for (const a of manifest.advisories || []) if (!state.advisories_applied.includes(a.id)) log(`advisory [${a.severity}] ${a.id}: ${a.text}`);
  return manifest;
}

// ── observation ──────────────────────────────────────────────────────────────

async function observe() {
  const list = await docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=agent`] } });
  const managed = list.map((c) => ({
    id: c.Id, name: (c.Names?.[0] || '').replace(/^\//, ''), image: c.Image, labels: c.Labels || {}, running: c.State === 'running', mounts: c.Mounts || [],
  }));
  // A conductor left as <name>-previous by an interrupted rollback stands in
  // for its generation when nothing else holds the generation's name.
  const names = new Set(managed.map((c) => c.name));
  const managedView = managed.filter((c) => !c.name.endsWith('-previous') || !names.has(c.name.replace(/-previous$/, '')));
  managed.length = 0; managed.push(...managedView);
  let legacy = null;
  for (const name of cfg.legacyNames) {
    const info = await docker.inspectContainer(name);
    if (info && !(info.Config?.Labels || {})[MANAGED_LABEL]) { legacy = { name, id: info.Id, running: info.State?.Running === true, inspect: info }; break; }
  }
  if (!legacy) {
    // The old compose conductor may already be gone (docker compose up --remove-orphans)
    // while its data volume stayed: adopt the volume.
    const volumes = (await docker.listVolumes())?.Volumes || [];
    const known = volumes.find((v) => cfg.legacyVolumes.includes(v.Name) && !(v.Labels || {})[MANAGED_LABEL]);
    if (known) legacy = { name: `volume ${known.Name}`, id: null, running: false, inspect: { Mounts: [{ Type: 'volume', Name: known.Name, Destination: '/data' }] } };
  }
  const self = await docker.inspectContainer(cfg.selfName);
  return { managed, legacy, agentImage: self?.Config?.Image || null, self };
}

/** The operator's env wins over what was carried or remembered. */
function withEnvOverrides(auth) {
  if (!env.CONDUCTOR_DATA_ROOT) return auth;
  return { ...auth, dataRoot: env.CONDUCTOR_DATA_ROOT, lairRoot: env.CONDUCTOR_LAIR_ROOT || `${env.CONDUCTOR_DATA_ROOT}/ks` };
}

async function authMaterial(legacy) {
  if (state.auth) return withEnvOverrides(state.auth);
  let auth = { authBootstrap: env.BOOTSTRAP_AUTH_MATERIAL, authRelay: env.RELAY_AUTH_MATERIAL, tracing: env.TRACING_OVERRIDE };
  if ((!auth.authBootstrap || !auth.authRelay) && legacy) {
    try {
      const tar = await docker.getArchive(legacy.id, '/etc/holochain/conductor-config.yaml');
      const files = filesOfTar(tar);
      const text = Object.values(files)[0]?.toString('utf8') || '';
      const carried = carryOverFromConfig(text);
      auth = { authBootstrap: auth.authBootstrap || carried.authBootstrap, authRelay: auth.authRelay || carried.authRelay, tracing: auth.tracing || carried.tracing, dataRoot: carried.dataRoot, lairRoot: carried.lairRoot };
      log(`carried auth material, tracing and the data path (${carried.dataRoot || '/data/holochain'}) over from the existing conductor config`);
    } catch (e) { log(`could not read the existing conductor config (${e.message}); using the community client id`); }
  }
  auth.authBootstrap ||= COMMUNITY_AUTH_MATERIAL;
  auth.authRelay ||= auth.authBootstrap;
  auth.tracing ||= 'info,kitsune2=info';
  state.auth = auth;
  persist();
  return withEnvOverrides(auth);
}

function desiredFrom(manifest, auth) {
  return {
    agentImage: manifest.agent.image,
    generations: manifest.generations.map((g) => {
      const config = renderConductorConfig(g, auth);
      return { id: g.id, state: g.state, image: g.conductor.image, adminPort: g.conductor.admin_port, config, configSha: crypto.createHash('sha256').update(config).digest('hex'), adopts: g.adopts_legacy_conductor === true, dnas: g.dnas, holochain: g.holochain };
    }),
  };
}

// ── changes ──────────────────────────────────────────────────────────────────

async function createConductor(gen, { dataVolume, dataBind }, sequence) {
  const name = containerNameFor(gen.id);
  await docker.pullImage(gen.image);
  if (!dataBind) await docker.createVolume(dataVolume, { [MANAGED_LABEL]: 'agent', [GENERATION_LABEL]: gen.id }).catch((e) => { if (e.status !== 409) throw e; });
  const labels = { [MANAGED_LABEL]: 'agent', [GENERATION_LABEL]: gen.id, [CONFIG_LABEL]: gen.configSha, [IMAGE_LABEL]: gen.image, [SEQUENCE_LABEL]: String(sequence) };
  const created = await docker.createContainer(name, conductorContainerSpec({ image: gen.image, generation: gen.id, dataVolume, dataBind, labels }));
  try {
    await docker.putArchive(created.Id, TEMPLATE_DIR, tarOfFile(TEMPLATE_FILE, gen.config));
    await docker.startContainer(created.Id);
  } catch (e) {
    // A container that never started must not keep the generation's name.
    await docker.removeContainer(created.Id, { force: true }).catch(() => {});
    throw e;
  }
  return created.Id;
}

/** Give a container a name, evicting a stopped container that holds it. */
async function renameEvicting(id, name) {
  try { await docker.renameContainer(id, name); return; } catch (e) { if (e.status !== 409) throw e; }
  const holder = await docker.inspectContainer(name);
  if (holder && holder.Id !== id && !holder.State?.Running) await docker.removeContainer(holder.Id, { force: true });
  await docker.renameContainer(id, name);
}

async function verifyGeneration(gen, containerId, sinceUnix, { adminWaitMs, expectedApps = [] } = {}) {
  return verifyConductor({ adminUrl: `ws://localhost:${gen.adminPort}`, holochain: gen.holochain, expectedApps, docker, containerId, sinceUnix, adminWaitMs, log });
}

/** The apps a running conductor holds, so its replacement can be held to the same list. */
async function appsOf(adminPort, holochain) {
  let admin;
  try {
    admin = await connectAdmin(`ws://localhost:${adminPort}`, { waitMs: 20000, holochain });
    const apps = await admin.listApps({});
    return apps.map((a) => ({ id: a.installed_app_id, running: isRunning(a.status) }));
  } catch (e) {
    log(`could not list the running conductor's apps (${e.message}); the replacement is verified without them`);
    return [];
  } finally {
    await admin?.client.close().catch(() => {});
  }
}

/** Replace (or adopt) with rollback: the old container is kept as <name>-previous until the new one verifies. */
async function swapConductor(gen, oldContainer, { dataVolume, dataBind }, sequence, reason) {
  const name = containerNameFor(gen.id);
  const started = nowUnix();
  log(`${gen.id}: ${reason}; replacing ${oldContainer.name} on ${dataBind || dataVolume}`);
  // What the old conductor holds is what the new one must hold: a conductor
  // that comes up empty beside the real data (a changed data path) fails here.
  const expectedApps = oldContainer.running === false ? [] : await appsOf(gen.adminPort, gen.holochain);
  if (expectedApps.length) log(`${gen.id}: the replacement must carry ${expectedApps.length} apps (${expectedApps.filter((a) => a.running).length} running)`);
  try {
    await docker.pullImage(gen.image);
  } catch (e) {
    // Nothing was touched; remember the digest so a bad manifest is not retried every minute.
    const g = (state.generations[gen.id] ||= {});
    g.failed = { image: gen.image, configSha: gen.configSha, at: Date.now(), reason: `pull: ${e.message}` };
    remember(state, { event: 'pull_failed', generation: gen.id, image: gen.image, reason: e.message });
    persist();
    throw e;
  }
  await docker.updateContainer(oldContainer.id, { RestartPolicy: { Name: 'no' } }).catch(() => {});
  await docker.stopContainer(oldContainer.id, 90);
  await docker.renameContainer(oldContainer.id, `${name}-previous`);
  let newId;
  try {
    newId = await createConductor(gen, { dataVolume, dataBind }, sequence);
    const verdict = await verifyGeneration(gen, newId, started, { expectedApps });
    if (!verdict.ok) throw new Error(`verification failed: ${verdict.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.reason}`).join('; ')}`);
  } catch (e) {
    log(`${gen.id}: ROLLBACK (${e.message})`);
    if (newId) await docker.removeContainer(newId, { force: true }).catch(() => {});
    await renameEvicting(oldContainer.id, oldContainer.name).catch((err) => log(`${gen.id}: could not give ${oldContainer.name} its name back: ${err.message}`));
    await docker.updateContainer(oldContainer.id, { RestartPolicy: { Name: 'unless-stopped' } }).catch(() => {});
    await docker.startContainer(oldContainer.id);
    const g = (state.generations[gen.id] ||= {});
    g.lastRollback = { at: new Date().toISOString(), image: gen.image, reason: e.message };
    g.failed = { image: gen.image, configSha: gen.configSha, at: Date.now() };
    remember(state, { event: 'rollback', generation: gen.id, image: gen.image, reason: e.message });
    persist();
    return false;
  }
  await docker.removeContainer(oldContainer.id, { force: true }).catch(() => {});
  const g = (state.generations[gen.id] ||= {});
  g.previousImage = oldContainer.image;
  g.image = gen.image; g.configSha = gen.configSha; g.dataVolume = dataVolume || null; g.dataBind = dataBind || null;
  g.lastChange = { at: new Date().toISOString(), reason, from: oldContainer.image, to: gen.image };
  delete g.failed;
  remember(state, { event: 'replaced', generation: gen.id, reason, image: gen.image });
  persist();
  log(`${gen.id}: now on ${gen.image.split('@')[1]}`);
  return true;
}

async function applyAction(action, desired, observed) {
  const gen = desired.generations.find((g) => g.id === action.generation);
  const sequence = state.manifest.sequence;
  const g = (state.generations[action.generation] ||= {});
  if (g.failed && gen && g.failed.image === gen.image && g.failed.configSha === gen.configSha && Date.now() - g.failed.at < 24 * 3600 * 1000) {
    return `${action.generation}: skipping ${action.type}; this exact image+config rolled back ${Math.round((Date.now() - g.failed.at) / 60000)} min ago (retry after 24 h or a new manifest)`;
  }
  switch (action.type) {
    case 'create': {
      const started = nowUnix();
      const volume = g.dataVolume || dataVolumeFor(gen.id);
      log(`${gen.id}: creating conductor on volume ${volume}`);
      const id = await createConductor(gen, { dataVolume: volume }, sequence);
      g.image = gen.image; g.configSha = gen.configSha; g.dataVolume = volume;
      g.lastChange = { at: new Date().toISOString(), reason: 'created', to: gen.image };
      persist();
      const verdict = await verifyGeneration(gen, id, started);
      remember(state, { event: 'created', generation: gen.id, image: gen.image, verified: verdict.ok });
      persist();
      return `${gen.id}: created${verdict.ok ? '' : ' (verification incomplete; will keep checking)'}`;
    }
    case 'adopt': {
      const mount = legacyDataMount(observed.legacy.inspect);
      if (!mount) throw new Error(`${observed.legacy.name} has no /data mount; refusing to adopt`);
      if (!observed.legacy.id) {
        const started = nowUnix();
        log(`${gen.id}: creating conductor on the existing ${observed.legacy.name}`);
        const id = await createConductor(gen, { dataVolume: mount.volume, dataBind: mount.bind }, sequence);
        Object.assign(g, { image: gen.image, configSha: gen.configSha, dataVolume: mount.volume || null, dataBind: mount.bind || null, adopted: { from: observed.legacy.name, at: new Date().toISOString() }, lastChange: { at: new Date().toISOString(), reason: 'adopted volume', to: gen.image } });
        persist();
        const verdict = await verifyGeneration(gen, id, started);
        remember(state, { event: 'adopted_volume', generation: gen.id, volume: mount.volume || mount.bind, verified: verdict.ok });
        persist();
        return `${gen.id}: adopted ${observed.legacy.name}`;
      }
      const ok = await swapConductor(gen, { id: observed.legacy.id, name: observed.legacy.name, image: observed.legacy.inspect.Config?.Image, running: observed.legacy.running }, { dataVolume: mount.volume, dataBind: mount.bind }, sequence, `adopting ${observed.legacy.name}`);
      if (ok) { g.adopted = { from: observed.legacy.name, at: new Date().toISOString() }; persist(); }
      return `${gen.id}: adopt ${ok ? 'done' : 'rolled back'}`;
    }
    case 'replace': {
      const c = observed.managed.find((x) => x.labels[GENERATION_LABEL] === gen.id);
      const mount = legacyDataMount({ Mounts: c.mounts }) || { volume: g.dataVolume || dataVolumeFor(gen.id) };
      const ok = await swapConductor(gen, c, { dataVolume: mount.volume, dataBind: mount.bind }, sequence, action.reason);
      return `${gen.id}: replace ${ok ? 'done' : 'rolled back'}`;
    }
    case 'start': {
      const c = observed.managed.find((x) => x.labels[GENERATION_LABEL] === gen.id);
      await docker.startContainer(c.id);
      return `${gen.id}: started`;
    }
    case 'stop': {
      const c = observed.managed.find((x) => x.labels[GENERATION_LABEL] === action.generation);
      await docker.updateContainer(c.id, { RestartPolicy: { Name: 'no' } }).catch(() => {});
      await docker.stopContainer(c.id, 90);
      remember(state, { event: 'stopped', generation: action.generation, reason: action.reason });
      persist();
      return `${action.generation}: stopped (${action.reason}); data volume kept`;
    }
    case 'self-update':
      return selfUpdate(action.image, observed.self);
    default:
      return `unknown action ${action.type}`;
  }
}

/** Start the new agent from the manifest's digest with this container's settings, then step aside. */
async function selfUpdate(image, self) {
  if (!self) return 'self-update skipped: cannot inspect own container (set AGENT_CONTAINER_NAME)';
  log(`agent: updating to ${image.split('@')[1]}`);
  await docker.pullImage(image);
  // Carry the operator's settings, not the old image's own ENV (AGENT_VERSION
  // and the like belong to the image that is being replaced).
  const imageEnv = new Set((await docker.inspectImage(self.Config.Image))?.Config?.Env || []);
  const spec = {
    Image: image,
    Env: (self.Config.Env || []).filter((e) => !imageEnv.has(e)),
    Labels: { ...(self.Config.Labels || {}), [IMAGE_LABEL]: image },
    HostConfig: { NetworkMode: self.HostConfig.NetworkMode, RestartPolicy: { Name: 'unless-stopped' }, Binds: self.HostConfig.Binds, Mounts: self.HostConfig.Mounts, LogConfig: self.HostConfig.LogConfig },
  };
  await docker.updateContainer(self.Id, { RestartPolicy: { Name: 'no' } });
  await docker.renameContainer(self.Id, `${cfg.selfName}-previous`);
  try {
    const created = await docker.createContainer(cfg.selfName, spec);
    await docker.startContainer(created.Id);
  } catch (e) {
    await docker.renameContainer(self.Id, cfg.selfName).catch(() => {});
    await docker.updateContainer(self.Id, { RestartPolicy: { Name: 'unless-stopped' } }).catch(() => {});
    throw e;
  }
  state.agent = { previousImage: self.Config.Image, image, lastChange: new Date().toISOString() };
  remember(state, { event: 'agent_replaced', from: self.Config.Image, to: image });
  persist();
  log('agent: handed over; exiting');
  setTimeout(() => process.exit(0), 500);
  return 'agent: replaced';
}

/** On start: if we are the new agent and the previous one is still around, retire it once we have verified a manifest. */
async function retirePreviousAgent() {
  const prev = await docker.inspectContainer(`${cfg.selfName}-previous`);
  if (!prev) return;
  if (prev.State?.Running) await docker.stopContainer(prev.Id, 30).catch(() => {});
  await docker.removeContainer(prev.Id, { force: true }).catch(() => {});
  log('agent: previous agent container removed');
}

// ── per-generation upkeep (any time) ────────────────────────────────────────

async function upkeep(desired, observed) {
  for (const gen of desired.generations) {
    if (gen.state === 'retired') continue;
    const c = observed.managed.find((x) => x.labels[GENERATION_LABEL] === gen.id && x.running);
    if (!c) continue;
    const dnas = gen.state === 'serving' ? gen.dnas : [];
    if (dnas.length === 0) continue;
    let admin;
    try {
      admin = await connectAdmin(`ws://localhost:${gen.adminPort}`, { waitMs: 15000, holochain: gen.holochain });
      const r = await reconcileDnas(admin, dnas, { happsDir: cfg.happsDir, downloadDir: `/tmp/flowsta-agent-${gen.id}`, log });
      if (r.installed.length) { remember(state, { event: 'dnas_installed', generation: gen.id, apps: r.installed }); persist(); }
      for (const f of r.failed) log(`${gen.id}: DNA ${f.app_id} not installed: ${f.reason}`);
    } catch (e) {
      log(`${gen.id}: upkeep skipped (${e.message})`);
    } finally {
      await admin?.client.close().catch(() => {});
    }
  }
}

async function applyAdvisories(manifest, desired, observed, isWindow) {
  for (const a of actionableAdvisories(manifest, { applied: new Set(state.advisories_applied), inWindow: isWindow, securityAnytime: cfg.securityAnytime })) {
    if (a.action === 'restart-conductor') {
      const targets = a.generation ? [a.generation] : desired.generations.filter((g) => g.state !== 'retired').map((g) => g.id);
      for (const id of targets) {
        const c = observed.managed.find((x) => x.labels[GENERATION_LABEL] === id);
        if (!c) continue;
        log(`advisory ${a.id}: restarting ${id}`);
        await docker.request('POST', `/containers/${c.id}/restart?t=90`, { timeoutMs: 150000 });
      }
    }
    // 'update' advisories carry no action of their own: the generation's new digest in the same manifest is the update.
    state.advisories_applied.push(a.id);
    remember(state, { event: 'advisory_applied', id: a.id, action: a.action, severity: a.severity });
    persist();
  }
}

// ── report ───────────────────────────────────────────────────────────────────

async function report(desired, observed) {
  if (env.REPORT_DISABLED === '1') return;
  for (const gen of desired.generations) {
    const c = observed.managed.find((x) => x.labels[GENERATION_LABEL] === gen.id && x.running);
    if (!c) continue;
    let admin;
    try {
      // A conductor with many cells answers dump_network_metrics slowly, and
      // slowest in the minutes after a start; the report is not worth failing over.
      admin = await connectAdmin(`ws://localhost:${gen.adminPort}`, { waitMs: 15000, holochain: gen.holochain, callTimeoutMs: 10 * 60 * 1000 });
      const base = await probeConductor(admin, { label: cfg.label, software: { agent: 'flowsta-agent', version: cfg.version } });
      const g = state.generations[gen.id] || {};
      const body = { ...base, generation: gen.id, holochain: gen.holochain, conductor_digest: (c.image.split('@')[1] || null), agent_digest: (observed.agentImage?.split('@')[1] || null), manifest_sequence: state.manifest_sequence, last_change: g.lastChange || null, last_rollback: g.lastRollback || null, advisories_applied: state.advisories_applied.slice(-20) };
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.nodeSecret) headers['X-Node-Secret'] = cfg.nodeSecret;
      const res = await fetch(`${cfg.apiUrl}/api/v1/vault/node/report`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) log(`${gen.id}: report rejected (${res.status}) ${(await res.text()).slice(0, 200)}`);
      else log(`${gen.id}: report sent (${base.dnas.length} DNAs, ${base.direct}/${base.connections} direct)`);
    } catch (e) {
      log(`${gen.id}: report failed (${e.message})`);
    } finally {
      await admin?.client.close().catch(() => {});
    }
  }
}

// ── the tick ─────────────────────────────────────────────────────────────────

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await fetchManifest();
    const manifest = state.manifest;
    if (!manifest) return;
    const observed = await observe();
    const auth = await authMaterial(observed.legacy);
    const desired = desiredFrom(manifest, auth);
    const actions = planActions(desired, observed);
    const isWindow = inWindow(new Date(), cfg.window);
    const securityNow = cfg.securityAnytime && (manifest.advisories || []).some((a) => a.severity === 'security' && a.action === 'update' && !state.advisories_applied.includes(a.id));
    const results = []; const waiting = [];
    if (cfg.dryRun) {
      log(`DRY RUN: ${actions.length ? actions.map((a) => `${a.type} ${a.generation || a.image || ''} [${a.disruptive ? 'window' : 'any time'}] (${a.reason})`).join('; ') : 'nothing to do'}`);
      if (observed.legacy) log(`DRY RUN: legacy conductor ${observed.legacy.name} (${observed.legacy.running ? 'running' : 'stopped'}) on ${JSON.stringify(legacyDataMount(observed.legacy.inspect))}`);
      current = { manifest, actions: [], waiting: actions, lastTick: new Date().toISOString(), lastError: null };
      if (Date.now() - lastReportAt >= cfg.reportMs) { await report(desired, observed); lastReportAt = Date.now(); }
      return;
    }
    for (const action of actions) {
      const allowed = !action.disruptive || isWindow || securityNow;
      if (!allowed) { waiting.push(action); continue; }
      try { results.push(await applyAction(action, desired, observed)); }
      catch (e) { log(`${action.type} ${action.generation || ''} failed: ${e.message}`); results.push(`${action.type}: ${e.message}`); }
    }
    if (waiting.length && (!current.waiting.length || current.lastTick === null)) log(`waiting for the window ${env.UPDATE_WINDOW || '03:00-05:00'}: ${waiting.map((a) => `${a.type} ${a.generation || ''} (${a.reason})`).join('; ')}`);
    const after = results.length ? await observe() : observed;
    await applyAdvisories(manifest, desired, after, isWindow);
    await upkeep(desired, after);
    if (Date.now() - lastReportAt >= cfg.reportMs) { await report(desired, after); lastReportAt = Date.now(); }
    current = { manifest, actions: results, waiting, lastTick: new Date().toISOString(), lastError: null };
  } catch (e) {
    current.lastError = `${new Date().toISOString()} ${e.message}`;
    log(`tick failed: ${e.message}`);
  } finally {
    busy = false;
  }
}

// ── status page (read-only, loopback) ───────────────────────────────────────

function statusServer() {
  if (!cfg.statusPort) return;
  http.createServer((req, res) => {
    if (req.url !== '/status.json' && req.url !== '/') { res.writeHead(404); return res.end(); }
    const body = {
      node: cfg.label, channel: cfg.channel, agent_version: cfg.version, signer: cfg.signerDid,
      window: env.UPDATE_WINDOW || '03:00-05:00', in_window: inWindow(new Date(), cfg.window),
      manifest: current.manifest ? { sequence: current.manifest.sequence, issued_at: current.manifest.issued_at, generations: current.manifest.generations.map((g) => ({ id: g.id, state: g.state, holochain: g.holochain, image: g.conductor.image })) } : null,
      generations: state.generations, agent: state.agent,
      advisories: (current.manifest?.advisories || []).map((a) => ({ ...a, applied: state.advisories_applied.includes(a.id) })),
      waiting_for_window: current.waiting, last_tick: current.lastTick, last_error: current.lastError,
      history: state.history.slice(0, 50),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }).listen(cfg.statusPort, '127.0.0.1', () => log(`status on http://127.0.0.1:${cfg.statusPort}/status.json`));
}

// ── main ─────────────────────────────────────────────────────────────────────

const v = await docker.version().catch((e) => { console.error(`cannot talk to Docker at ${docker.socketPath}: ${e.message}`); process.exit(1); });
log(`flowsta node agent ${cfg.version} on Docker ${v.Version}; channel ${cfg.channel}; label ${cfg.label}; trusting ${cfg.signerDid}${cfg.dryRun ? '; DRY RUN' : ''}`);
fs.mkdirSync(cfg.stateDir, { recursive: true });
statusServer();
await retirePreviousAgent();
await tick();
setInterval(tick, cfg.tickMs);

#!/usr/bin/env node
// A read-only census of ProofPoll's public records on a node: polls, votes,
// flags, migration mappings and agent links on v1.3 (Holochain 0.6) and v1.4
// (0.7). It prints counts only: no titles, no options, no keys but the
// node's own two.
//
// What it writes, and nothing else: on each conductor, one app interface
// (it lasts until that conductor restarts) and one signing-credential grant
// on the node's own cell (a private CapGrant record on the node's chain).
// One zome call at a time, with a pause between, and it stops when the
// machine runs low on memory.
//
// Usage (inside the agent container, where the clients are installed):
//   node tools/proofpoll-census.mjs [--admin-06 ws://localhost:4444]
//     [--admin-07 ws://localhost:4445] [--origin flowsta-agent]
//     [--pause-ms 200] [--min-free-mb 150] [--clients /app/node_modules/]
//   --shape prints the key structure of the first poll record on each line
//   (no values) and stops: the first run against a new conductor version.

import os from 'node:os';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const ORIGIN = arg('origin', 'flowsta-agent');
const PAUSE_MS = Number(arg('pause-ms', '200'));
const MIN_FREE_MB = Number(arg('min-free-mb', '150'));
const CLIENTS = arg('clients', new URL('../updater/node_modules/', import.meta.url).href);
const clientsUrl = CLIENTS.startsWith('file:') ? CLIENTS : new URL(CLIENTS.endsWith('/') ? CLIENTS : `${CLIENTS}/`, 'file:///').href;

const LINES = [
  { line: '0.6', dna: 'v1.3', adminUrl: arg('admin-06', 'ws://localhost:4444'), appId: 'proofpoll_v1_3', client: '@holochain/client' },
  { line: '0.7', dna: 'v1.4', adminUrl: arg('admin-07', 'ws://localhost:4445'), appId: 'proofpoll_v1_4', client: 'holochain-client-07' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function guard() {
  const freeMb = Math.round(os.freemem() / 1048576);
  if (freeMb < MIN_FREE_MB) throw new Error(`stopped: ${freeMb} MB free, under ${MIN_FREE_MB} MB`);
  await sleep(PAUSE_MS);
}

const b64 = (u8) => (u8 ? Buffer.from(u8).toString('base64') : '');
const shapeOf = (v, depth = 0) => {
  if (v instanceof Uint8Array) return `bytes(${v.length})`;
  if (Array.isArray(v)) return depth > 4 ? '[...]' : [v.length ? shapeOf(v[0], depth + 1) : 'empty'];
  if (v && typeof v === 'object') {
    if (depth > 5) return '{...}';
    return Object.fromEntries(Object.keys(v).map((k) => [k, shapeOf(v[k], depth + 1)]));
  }
  return typeof v;
};

// A record's action and app entry, on either line's record shape. The 0.6
// action is an enum tagged by `type`; the 0.7 one carries its own header.
function actionOf(rec) {
  const content = rec?.signed_action?.hashed?.content ?? rec?.signed_action?.hashed?.action ?? null;
  const header = content?.header ?? content;
  return {
    hash: b64(rec?.signed_action?.hashed?.hash),
    author: b64(header?.author),
    timestamp: Number(header?.timestamp ?? 0),
  };
}
function entryOf(rec, decode) {
  const e = rec?.entry?.Present ?? rec?.entry?.present ?? null;
  const bytes = e?.entry ?? null;
  if (!(bytes instanceof Uint8Array)) return null;
  try { return decode(bytes); } catch { return null; }
}

async function censusOf(spec) {
  const mod = await import(new URL(`${spec.client}/lib/index.js`, clientsUrl).href);
  const { decode } = await import(new URL('@msgpack/msgpack/dist.cjs/index.cjs', clientsUrl).href).catch(() => import(new URL('@msgpack/msgpack/dist.esm/index.mjs', clientsUrl).href));
  const { AdminWebsocket, AppWebsocket } = mod;
  const admin = await AdminWebsocket.connect({ url: new URL(spec.adminUrl), wsClientOptions: { origin: ORIGIN }, defaultTimeout: 120000 });
  const apps = await admin.listApps({});
  const app = apps.find((a) => a.installed_app_id === spec.appId);
  if (!app) return { line: spec.line, error: `${spec.appId} is not installed` };
  const cell = Object.values(app.cell_info).flat().find((c) => c.type === 'provisioned' || c.provisioned);
  const cellId = cell?.value?.cell_id ?? cell?.provisioned?.cell_id;
  if (!cellId) return { line: spec.line, error: 'no provisioned cell' };

  // The two writes.
  const { port } = await admin.attachAppInterface({ allowed_origins: ORIGIN });
  await admin.authorizeSigningCredentials(cellId);
  const { token } = await admin.issueAppAuthenticationToken({ installed_app_id: spec.appId, single_use: false, expiry_seconds: 3600 });
  const appWs = await AppWebsocket.connect({ url: new URL(`ws://localhost:${port}`), token, wsClientOptions: { origin: ORIGIN }, defaultTimeout: 120000 });
  const call = async (zome_name, fn_name, payload = null) => {
    await guard();
    return appWs.callZome({ role_name: 'proofpoll', zome_name, fn_name, payload });
  };

  const polls = await call('polls', 'get_all_polls');
  if (flag('shape')) {
    await appWs.client.close(); await admin.client.close();
    return { line: spec.line, dna: spec.dna, polls: polls.length, shape: polls.length ? shapeOf(polls[0]) : null };
  }
  const now = Date.now() / 1000;
  const out = {
    line: spec.line, dna: spec.dna, node_agent: `u${Buffer.from(cellId[1]).toString('base64url')}`,
    polls: polls.length, polls_closed: 0, polls_open: 0, polls_unreadable: 0,
    votes: 0, flags: 0, mappings: 0, mappings_carried: 0,
    authors: new Set(), voters: new Set(), pollHashes: [], votesByPoll: new Map(), oldHashes: new Set(),
  };
  for (const rec of polls) {
    const { hash, author } = actionOf(rec);
    const poll = entryOf(rec, decode);
    out.authors.add(author);
    out.pollHashes.push(rec.signed_action.hashed.hash);
    if (!poll) { out.polls_unreadable += 1; continue; }
    if (poll.closes_at != null && Number(poll.closes_at) < now) out.polls_closed += 1; else out.polls_open += 1;
    const votes = await call('polls', 'get_poll_votes', rec.signed_action.hashed.hash);
    out.votes += votes.length;
    const voters = new Set(votes.map((v) => actionOf(v).author));
    voters.forEach((v) => out.voters.add(v));
    out.votesByPoll.set(hash, voters);
    out.flags += (await call('polls', 'get_poll_flags', rec.signed_action.hashed.hash)).length;
  }
  const mappings = await call('polls', 'get_all_migration_mappings');
  out.mappings = mappings.length;
  for (const m of mappings) {
    const mp = entryOf(m, decode);
    if (mp?.carried_from) out.mappings_carried += 1;
    if (mp?.old_action_hash) out.oldHashes.add(b64(mp.old_action_hash));
  }
  // Agent links: who among this line's participants has one here.
  const participants = new Set([...out.authors, ...out.voters].filter(Boolean));
  out.participants = participants.size;
  out.participants_linked = 0;
  for (const p of participants) {
    const linked = await call('agent_linking', 'get_linked_agents', Buffer.from(p, 'base64')).catch(() => []);
    if (linked.length > 0) out.participants_linked += 1;
  }
  await appWs.client.close(); await admin.client.close();
  return out;
}

const results = [];
for (const spec of LINES) {
  try { results.push(await censusOf(spec)); } catch (e) { results.push({ line: spec.line, error: String(e?.message ?? e) }); break; }
}
const [v13, v14] = results;
const report = { at: new Date().toISOString(), lines: [] };
for (const r of results) {
  if (r.error || r.shape !== undefined) { report.lines.push(r); continue; }
  report.lines.push({
    line: r.line, dna: r.dna, node_agent: r.node_agent, polls: r.polls, polls_open: r.polls_open, polls_closed: r.polls_closed,
    polls_unreadable: r.polls_unreadable, votes: r.votes, voters: r.voters.size, authors: r.authors.size, flags: r.flags,
    mappings: r.mappings, mappings_carried: r.mappings_carried, participants: r.participants, participants_linked: r.participants_linked,
  });
}
if (v13?.pollHashes && v14?.oldHashes) {
  // A v1.3 poll whose hash a v1.4 mapping names has a copy on v1.4.
  const mapped = v13.pollHashes.filter((h) => v14.oldHashes.has(b64(h))).length;
  report.v13_polls_with_a_v14_copy = mapped;
  report.v13_polls_without = v13.pollHashes.length - mapped;
  report.v13_voters_on_polls_without_a_copy = [...v13.votesByPoll.entries()]
    .filter(([h]) => !v14.oldHashes.has(h)).reduce((n, [, voters]) => n + voters.size, 0);
}
console.log(JSON.stringify(report, null, 2));
process.exit(0);

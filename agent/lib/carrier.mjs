/**
 * Running the ProofPoll carrier on the ProofPoll node.
 *
 * `proofpoll-carrier` (built in ProofPoll, carried in this image at
 * CARRIER_BIN) makes one pass and exits: it reads ProofPoll's public records
 * on DNA v1.3 (the 0.6 conductor) and v1.4 (the 0.7 conductor) and writes
 * each one not yet on v1.5, with its proof, on the 0.7 conductor. The signed
 * manifest says whether and how often it runs:
 *
 *   "carrier": {
 *     "lines": { "v06": "holochain-0.6", "v07": "holochain-0.7" },
 *     "every_hours": 6,             at most this often (1 to 168)
 *     "dry_run": true,              optional: count only, write nothing (default false)
 *     "max_writes": 500,            optional: the pass stops after this many (1 to 5000)
 *     "pause_ms": 200,              optional: between calls (0 to 10000)
 *     "min_free_mb": 150,           optional: the pass stops under this much free memory (50 to 4096)
 *     "restart_after_write": true,  optional: restart the v07 conductor after a pass that wrote (default true)
 *     "until": "2027-06-30T00:00:00Z"  optional: no pass after this (the park date)
 *   }
 *
 * A manifest without the block runs nothing. A pass starts only when both
 * conductors have run for a while (a cold conductor's first network reads
 * time out), the VM has room for it, and nothing else changed the node in
 * the same tick. The restart after a pass that wrote gives back the memory
 * the zome calls left behind (the e2-micro grew ~300 MB in one short read,
 * 11-04): a clean stop, as the memory restart does.
 */

import { spawn } from 'node:child_process';

const MIN = 60_000;
const HOUR = 60 * MIN;
const GEN_ID = /^[a-z0-9][a-z0-9.-]{0,31}$/;
/** A conductor this new is still making its first network reads. */
export const SETTLE_MS = 15 * MIN;
/** A pass that skipped (memory, a conductor not up) tries again this soon. */
export const RETRY_MS = 10 * MIN;
/** A pass running longer than this is stopped. */
export const MAX_RUN_MS = 2 * HOUR;
/** Room the VM keeps beside the pass's own floor before a pass starts. */
export const HEADROOM_MB = 200;

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Shape check for the manifest's `carrier`; `ids` are the manifest's generation ids. Returns a reason string, or null. */
export function carrierPolicyProblem(p, ids) {
  if (p === undefined) return null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'bad carrier';
  const l = p.lines;
  if (!l || typeof l !== 'object' || typeof l.v06 !== 'string' || typeof l.v07 !== 'string' || !GEN_ID.test(l.v06) || !GEN_ID.test(l.v07) || l.v06 === l.v07) return 'bad carrier lines';
  if (!ids.has(l.v06) || !ids.has(l.v07)) return 'carrier lines name an unknown generation';
  if (!intIn(p.every_hours, 1, 168)) return 'carrier every_hours must be 1 to 168';
  if (p.dry_run !== undefined && typeof p.dry_run !== 'boolean') return 'bad carrier dry_run';
  if (p.max_writes !== undefined && !intIn(p.max_writes, 1, 5000)) return 'carrier max_writes must be 1 to 5000';
  if (p.pause_ms !== undefined && !intIn(p.pause_ms, 0, 10000)) return 'carrier pause_ms must be 0 to 10000';
  if (p.min_free_mb !== undefined && !intIn(p.min_free_mb, 50, 4096)) return 'carrier min_free_mb must be 50 to 4096';
  if (p.restart_after_write !== undefined && typeof p.restart_after_write !== 'boolean') return 'bad carrier restart_after_write';
  if (p.until !== undefined && (typeof p.until !== 'string' || Number.isNaN(Date.parse(p.until)))) return 'bad carrier until';
  return null;
}

/**
 * Is a pass due by the manifest's schedule? Cheap: the agent asks this every
 * tick and looks at the node only when it says yes.
 * @param {object} [policy]  the manifest's `carrier`
 * @param {{ now: number, lastRunAt: number | null, lastSkipAt: number | null, binary: boolean }} o
 *   lastRunAt: when the last pass started; lastSkipAt: when one was last held back by the node
 * @returns {string | null}  why not, or null when due
 */
export function carrierNotDue(policy, { now, lastRunAt, lastSkipAt, binary }) {
  if (!policy) return 'no carrier in the manifest';
  if (!binary) return 'the carrier binary is not in this image';
  if (policy.until && now >= Date.parse(policy.until)) return `past its end date ${policy.until}`;
  if (lastRunAt && now - lastRunAt < policy.every_hours * HOUR) return `ran less than ${policy.every_hours} hours ago`;
  if (lastSkipAt && now - lastSkipAt < RETRY_MS) return 'held back less than 10 minutes ago';
  return null;
}

/**
 * Does the node hold a due pass back? (Then it tries again in RETRY_MS.)
 * @param {object} policy  the manifest's `carrier`
 * @param {{ now: number, startedAt: { v06?: number | null, v07?: number | null }, memAvailable: number | null, changed: boolean }} o
 *   startedAt: each conductor's start (ms), null when not running; memAvailable: the VM's MemAvailable (bytes);
 *   changed: something changed the node this tick
 * @returns {string | null}  why, or null when the pass may start
 */
export function carrierHeldBack(policy, { now, startedAt, memAvailable, changed }) {
  if (changed) return 'the node changed this tick';
  for (const line of ['v06', 'v07']) {
    const s = startedAt[line];
    if (!s) return `the ${line} conductor is not running`;
    if (now - s < SETTLE_MS) return `the ${line} conductor started less than 15 minutes ago`;
  }
  const floorMb = (policy.min_free_mb ?? 150) + HEADROOM_MB;
  if (memAvailable === null || memAvailable === undefined) return 'free memory not measured';
  if (memAvailable < floorMb * 1048576) return `${Math.round(memAvailable / 1048576)} MB free, under ${floorMb} MB`;
  return null;
}

/** The command line for one pass. */
export function carrierArgs(policy, { port06, port07, origin, stateFile }) {
  const a = ['--admin-06', `localhost:${port06}`, '--admin-07', `localhost:${port07}`, '--origin', origin, '--state', stateFile];
  if (policy.dry_run) a.push('--dry-run');
  if (policy.max_writes !== undefined) a.push('--max-writes', String(policy.max_writes));
  if (policy.pause_ms !== undefined) a.push('--pause-ms', String(policy.pause_ms));
  if (policy.min_free_mb !== undefined) a.push('--min-free-mb', String(policy.min_free_mb));
  return a;
}

/** The pass's report: the last stdout line that is a JSON object; null when there is none. */
export function parseCarrierReport(stdout) {
  const lines = String(stdout || '').trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === 'object' && !Array.isArray(r)) return r;
    } catch {}
  }
  return null;
}

/** The report's `carried` counts, as the log names them: [one, more]. */
const LABELS = {
  links: ['agent link', 'agent links'],
  polls: ['poll', 'polls'],
  later: ['later copy mapped', 'later copies mapped'],
  votes: ['vote', 'votes'],
  flags: ['flag', 'flags'],
};
const counted = (n, [one, more]) => `${n} ${n === 1 ? one : more}`;

/** One line for the log: what the pass did. */
export function carrierSummary(report, code) {
  if (!report) return `exit ${code}, no report`;
  const c = report.carried || {};
  const parts = Object.entries(c)
    .filter(([k, n]) => k !== 'deleted' && typeof n === 'number' && n > 0)
    .map(([k, n]) => counted(n, LABELS[k] || [k.replace(/_/g, ' '), k.replace(/_/g, ' ')]));
  const dry = report.dry_run === true;
  const did = [];
  if (parts.length) did.push(`${dry ? 'would carry' : 'carried'} ${parts.join(', ')}`);
  if (c.deleted > 0) did.push(`${dry ? 'would remove' : 'removed'} ${counted(c.deleted, ['copy', 'copies'])}`);
  if (!did.length) did.push(dry ? 'would carry nothing' : 'carried nothing');
  const extra = [
    report.waiting ? `${report.waiting} waiting` : null,
    report.failed ? `${report.failed} failed` : null,
    report.grants ? `${counted(report.grants, ['grant', 'grants'])} added` : null,
    report.stopped ? `stopped: ${report.stopped}` : null,
  ].filter(Boolean);
  return `${did.join('; ')}${extra.length ? `; ${extra.join('; ')}` : ''} (exit ${code})`;
}

/** Restart the v07 conductor after this pass? Only after one that wrote. */
export function restartAfterPass(policy, report) {
  if (!policy || policy.restart_after_write === false) return false;
  return !!(report && report.wrote === true && report.dry_run !== true);
}

/** Keep only the tail of a stream the pass wrote, for the log. */
export function tail(text, max = 4000) {
  const s = String(text || '');
  return s.length <= max ? s : `…${s.slice(s.length - max)}`;
}

/**
 * Start a pass. Returns the run, which fills in as the process goes:
 * { child, policy, startedAt, endedAt, stdout, stderr, done, stopping },
 * `done` = { code, signal, error } once it has ended (or could not start).
 */
export function startPass(bin, args, policy, { now = Date.now() } = {}) {
  const run = { child: null, policy, startedAt: now, endedAt: null, stdout: '', stderr: '', done: null, stopping: false };
  const end = (d) => { run.endedAt ||= Date.now(); run.done ||= d; };
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  run.child = child;
  child.stdout.on('data', (d) => { run.stdout = tail(run.stdout + d, 64000); });
  child.stderr.on('data', (d) => { run.stderr = tail(run.stderr + d, 64000); });
  child.on('error', (e) => end({ code: null, signal: null, error: e.message }));
  child.on('close', (code, signal) => end({ code, signal, error: null }));
  return run;
}

/** Stop a pass that has run too long: SIGTERM, then SIGKILL after `graceMs`. */
export function stopPass(run, graceMs = 10_000) {
  if (run.done || run.stopping) return;
  run.stopping = true;
  run.child.kill('SIGTERM');
  setTimeout(() => { if (!run.done) run.child.kill('SIGKILL'); }, graceMs).unref();
}

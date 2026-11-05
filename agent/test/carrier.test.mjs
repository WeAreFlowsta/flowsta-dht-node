import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { carrierPolicyProblem, carrierNotDue, carrierHeldBack, carrierArgs, parseCarrierReport, carrierSummary, restartAfterPass, tail, startPass, stopPass, SETTLE_MS, RETRY_MS } from '../lib/carrier.mjs';

const HOUR = 3_600_000;
const MB = 1048576;
const IDS = new Set(['holochain-0.6', 'holochain-0.7']);
const POLICY = { lines: { v06: 'holochain-0.6', v07: 'holochain-0.7' }, every_hours: 6 };
const NOW = Date.parse('2026-11-07T10:00:00Z');
const up = { v06: NOW - 2 * HOUR, v07: NOW - 2 * HOUR };
/** A report as the carrier prints it (ProofPoll carrier/src/node.rs `Report`). */
const REPORT = { dry_run: false, v13_read: true, v14_read: true, seen: { polls_v13: 10, polls_v14: 3, later_copies: 1, votes: 36, flags: 0, links: 14, deletes: 0 }, carried: { links: 14, polls: 10, later: 0, votes: 36, flags: 0, deleted: 0 }, waiting: 1, failed: 0, grants: 3, wrote: true, stopped: null };

test('policy: the full block, each bound, and the lines checked against the generations', () => {
  assert.equal(carrierPolicyProblem(undefined, IDS), null);
  assert.equal(carrierPolicyProblem({ ...POLICY, dry_run: true, max_writes: 500, pause_ms: 200, min_free_mb: 150, restart_after_write: false, until: '2027-06-30T00:00:00Z' }, IDS), null);
  assert.match(carrierPolicyProblem({ ...POLICY, lines: { v06: 'holochain-0.6', v07: 'holochain-0.6' } }, IDS), /bad carrier lines/);
  assert.match(carrierPolicyProblem({ ...POLICY, lines: { v06: 'holochain-0.5', v07: 'holochain-0.7' } }, IDS), /unknown generation/);
  assert.match(carrierPolicyProblem({ ...POLICY, every_hours: 200 }, IDS), /every_hours/);
  assert.match(carrierPolicyProblem({ ...POLICY, max_writes: 0 }, IDS), /max_writes/);
  assert.match(carrierPolicyProblem({ ...POLICY, pause_ms: -1 }, IDS), /pause_ms/);
  assert.match(carrierPolicyProblem({ ...POLICY, min_free_mb: 10 }, IDS), /min_free_mb/);
  assert.match(carrierPolicyProblem({ ...POLICY, dry_run: 'yes' }, IDS), /dry_run/);
  assert.match(carrierPolicyProblem([], IDS), /bad carrier/);
});

test('schedule: the first pass is due; then not until every_hours has passed', () => {
  const o = { now: NOW, lastRunAt: null, lastSkipAt: null, binary: true };
  assert.equal(carrierNotDue(POLICY, o), null);
  assert.match(carrierNotDue(POLICY, { ...o, lastRunAt: NOW - 5 * HOUR }), /less than 6 hours/);
  assert.equal(carrierNotDue(POLICY, { ...o, lastRunAt: NOW - 6 * HOUR }), null);
});

test('schedule: no block, no binary, past the end date, or held back a moment ago: not due', () => {
  const o = { now: NOW, lastRunAt: null, lastSkipAt: null, binary: true };
  assert.match(carrierNotDue(undefined, o), /no carrier/);
  assert.match(carrierNotDue(POLICY, { ...o, binary: false }), /binary is not in this image/);
  assert.match(carrierNotDue({ ...POLICY, until: '2026-11-01T00:00:00Z' }, o), /past its end date/);
  assert.match(carrierNotDue(POLICY, { ...o, lastSkipAt: NOW - RETRY_MS + 1000 }), /held back less than/);
  assert.equal(carrierNotDue(POLICY, { ...o, lastSkipAt: NOW - RETRY_MS }), null);
});

test('the node: both conductors settled and room in the VM, or the pass waits', () => {
  const o = { now: NOW, startedAt: up, memAvailable: 600 * MB, changed: false };
  assert.equal(carrierHeldBack(POLICY, o), null);
  assert.match(carrierHeldBack(POLICY, { ...o, changed: true }), /changed this tick/);
  assert.match(carrierHeldBack(POLICY, { ...o, startedAt: { ...up, v07: null } }), /v07 conductor is not running/);
  assert.match(carrierHeldBack(POLICY, { ...o, startedAt: { ...up, v06: NOW - SETTLE_MS + 1000 } }), /v06 conductor started less than 15 minutes ago/);
  assert.match(carrierHeldBack(POLICY, { ...o, memAvailable: 300 * MB }), /^300 MB free, under 350 MB$/);
  assert.match(carrierHeldBack({ ...POLICY, min_free_mb: 100 }, { ...o, memAvailable: 299 * MB }), /under 300 MB/);
  assert.match(carrierHeldBack(POLICY, { ...o, memAvailable: null }), /not measured/);
});

test('the command line: the ports, the agent origin, the kept credentials, and only the options the block sets', () => {
  const ctx = { port06: 4444, port07: 4445, origin: 'flowsta-agent', stateFile: '/state/proofpoll-carrier.json' };
  assert.deepEqual(carrierArgs(POLICY, ctx), ['--admin-06', 'localhost:4444', '--admin-07', 'localhost:4445', '--origin', 'flowsta-agent', '--state', '/state/proofpoll-carrier.json']);
  assert.deepEqual(carrierArgs({ ...POLICY, dry_run: true, max_writes: 50, pause_ms: 500, min_free_mb: 200 }, ctx).slice(8), ['--dry-run', '--max-writes', '50', '--pause-ms', '500', '--min-free-mb', '200']);
});

test('the report: the last JSON line of stdout; none when there is no such line', () => {
  assert.deepEqual(parseCarrierReport(`noise\n${JSON.stringify(REPORT)}\n`), REPORT);
  assert.equal(parseCarrierReport('carrier: could not connect\n'), null);
  assert.equal(parseCarrierReport('{not json'), null);
  assert.equal(parseCarrierReport(''), null);
});

test('the log line names what was carried, what waits and why a pass stopped', () => {
  assert.equal(carrierSummary(REPORT, 0), 'carried 14 agent links, 10 polls, 36 votes; 1 waiting; 3 grant(s) added (exit 0)');
  const dry = { ...REPORT, dry_run: true, wrote: false, grants: 0, waiting: 0, carried: { links: 0, polls: 2, later: 1, votes: 0, flags: 0, deleted: 1 } };
  assert.equal(carrierSummary(dry, 0), 'would carry 2 polls, 1 later copies mapped, 1 copies removed (exit 0)');
  const stopped = { ...REPORT, carried: { links: 0, polls: 0, later: 0, votes: 0, flags: 0, deleted: 0 }, waiting: 0, grants: 0, failed: 2, stopped: 'free memory under 150 MB' };
  assert.equal(carrierSummary(stopped, 2), 'carried nothing; 2 failed; stopped: free memory under 150 MB (exit 2)');
  assert.equal(carrierSummary(null, 1), 'exit 1, no report');
});

test('the restart: after a pass that wrote, unless the block turns it off; never after a dry run', () => {
  assert.equal(restartAfterPass(POLICY, REPORT), true);
  assert.equal(restartAfterPass({ ...POLICY, restart_after_write: false }, REPORT), false);
  assert.equal(restartAfterPass(POLICY, { ...REPORT, wrote: false }), false);
  assert.equal(restartAfterPass(POLICY, { ...REPORT, dry_run: true }), false);
  assert.equal(restartAfterPass(POLICY, null), false);
  assert.equal(restartAfterPass(undefined, REPORT), false);
});

test('tail keeps the end of a long stream', () => {
  assert.equal(tail('abc', 5), 'abc');
  assert.equal(tail('abcdefgh', 3), '…fgh');
});

/** A stand-in for the carrier: a script that prints what the test asks, then exits. */
function fakeCarrier(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-test-'));
  const bin = path.join(dir, 'proofpoll-carrier');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}
const ended = (run) => new Promise((resolve) => { const t = setInterval(() => { if (run.done) { clearInterval(t); resolve(run); } }, 20); });

test('a pass: its arguments reach it, its report and stderr are kept, its exit code is read', async () => {
  const bin = fakeCarrier(`echo "args: $*" >&2; echo '${JSON.stringify(REPORT)}'; exit 2`);
  const run = await ended(startPass(bin, ['--admin-06', 'localhost:4444', '--dry-run'], POLICY));
  assert.deepEqual(run.done, { code: 2, signal: null, error: null });
  assert.deepEqual(parseCarrierReport(run.stdout), REPORT);
  assert.match(run.stderr, /args: --admin-06 localhost:4444 --dry-run/);
  assert.ok(run.endedAt >= run.startedAt);
  assert.equal(run.policy, POLICY);
});

test('a binary that cannot start ends the run with its error', async () => {
  const run = await ended(startPass('/nonexistent/proofpoll-carrier', [], POLICY));
  assert.ok(run.done.error || run.done.code !== 0);
});

test('a pass that runs too long is stopped', async () => {
  const bin = fakeCarrier('trap "exit 7" TERM; while true; do sleep 0.05; done');
  const run = startPass(bin, [], POLICY);
  await new Promise((r) => setTimeout(r, 200));
  stopPass(run, 2000);
  await ended(run);
  assert.equal(run.stopping, true);
  assert.equal(run.done.code, 7);
});

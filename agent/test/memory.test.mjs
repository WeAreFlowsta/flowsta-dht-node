import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryVerdict, memoryPolicyProblem, inSlot } from '../lib/memory.mjs';

const GB = 1024 ** 3;
const HOUR = 3_600_000;
const POLICY = { generations: ['holochain-0.7'], share: 0.45, slots: { 'europe-dht': '05:20', 'singapore-dht': '05:50' } };
/** Node-local time: the tests run in whatever TZ the machine has, so build dates from local parts. */
const at = (h, m) => new Date(2026, 10, 3, h, m, 0);
const big = { usedBytes: 1.9 * GB, totalBytes: 3.82 * GB }; // ~50 %
const base = { policy: POLICY, label: 'europe-dht', generation: 'holochain-0.7', startedAt: at(5, 0).getTime() - 48 * HOUR };

test('over the share, in its slot: restart', () => {
  const v = memoryVerdict(big, { ...base, now: at(5, 25) });
  assert.equal(v.restart, true);
  assert.match(v.reason, /^50 % of the VM's memory, over 45 %, in its slot at 05:20$/);
});

test('over the share, outside its slot: waits', () => {
  const v = memoryVerdict(big, { ...base, now: at(5, 45) });
  assert.equal(v.restart, false);
  assert.match(v.reason, /waits for its slot at 05:20/);
});

test('under the share: nothing', () => {
  assert.equal(memoryVerdict({ usedBytes: 0.2 * GB, totalBytes: 3.82 * GB }, { ...base, now: at(5, 25) }).restart, false);
});

test('a line the policy does not name, or no policy: nothing', () => {
  assert.equal(memoryVerdict(big, { ...base, generation: 'holochain-0.6', now: at(5, 25) }).restart, false);
  assert.equal(memoryVerdict(big, { ...base, policy: undefined, now: at(5, 25) }).restart, false);
});

test('a node without a slot never restarts, unless urgent', () => {
  const v = memoryVerdict(big, { ...base, label: 'node1', now: at(5, 25) });
  assert.equal(v.restart, false);
  assert.match(v.reason, /no restart slot/);
  const urgent = memoryVerdict({ usedBytes: 2.6 * GB, totalBytes: 3.82 * GB }, { ...base, label: 'node1', policy: { ...POLICY, urgent_share: 0.6 }, now: at(14, 0) });
  assert.equal(urgent.restart, true);
  assert.match(urgent.reason, /over the urgent 60 %/);
});

test('never within 6 hours of a start, never twice a day', () => {
  assert.equal(memoryVerdict(big, { ...base, startedAt: at(5, 25).getTime() - 2 * HOUR, now: at(5, 25) }).restart, false);
  const v = memoryVerdict(big, { ...base, lastRestartAt: at(5, 25).getTime() - 20 * HOUR, now: at(5, 25) });
  assert.equal(v.restart, false);
  assert.match(v.reason, /less than 24 hours ago/);
  assert.equal(memoryVerdict(big, { ...base, lastRestartAt: at(5, 25).getTime() - 25 * HOUR, now: at(5, 25) }).restart, true);
});

test('urgent still respects the once-a-day limit', () => {
  const v = memoryVerdict({ usedBytes: 3 * GB, totalBytes: 3.82 * GB }, { ...base, policy: { ...POLICY, urgent_share: 0.6 }, lastRestartAt: at(5, 25).getTime() - HOUR, now: at(5, 25) });
  assert.equal(v.restart, false);
});

test('slots last 20 minutes and may cross midnight', () => {
  assert.equal(inSlot(at(5, 20), '05:20'), true);
  assert.equal(inSlot(at(5, 39), '05:20'), true);
  assert.equal(inSlot(at(5, 40), '05:20'), false);
  assert.equal(inSlot(at(5, 19), '05:20'), false);
  assert.equal(inSlot(at(0, 5), '23:50'), true);
  assert.equal(inSlot(new Date(2026, 10, 3, 23, 55), '23:50'), true);
});

test('policy shape', () => {
  assert.equal(memoryPolicyProblem(undefined), null);
  assert.equal(memoryPolicyProblem(POLICY), null);
  assert.equal(memoryPolicyProblem({ ...POLICY, urgent_share: 0.6, every_hours: 24 }), null);
  assert.match(memoryPolicyProblem({ ...POLICY, share: 0.95 }), /share must be between/);
  assert.match(memoryPolicyProblem({ ...POLICY, urgent_share: 0.4 }), /urgent_share/);
  assert.match(memoryPolicyProblem({ ...POLICY, every_hours: 1 }), /every_hours/);
  assert.match(memoryPolicyProblem({ ...POLICY, slots: { 'Europe DHT': '05:20' } }), /slot label/);
  assert.match(memoryPolicyProblem({ ...POLICY, slots: { 'europe-dht': '5:20' } }), /slot time/);
  assert.match(memoryPolicyProblem({ ...POLICY, generations: [] }), /generations/);
});

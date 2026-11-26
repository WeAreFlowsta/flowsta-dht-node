import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryLimitsProblem, limitFor, limitVerdict } from '../lib/limits.mjs';
import { conductorContainerSpec } from '../lib/docker.mjs';

const MB = 1024 * 1024;
const IDS = new Set(['holochain-0.6', 'holochain-0.7']);
// Europe and Singapore production: a 4 GB VM (3913 MB seen by the kernel), the ceilings set by hand on 2026-11-15.
const VM = 3913 * MB;
const STABLE = { generations: ['holochain-0.7'], share: 0.45, urgent_share: 0.6, slots: { 'europe-dht-2': '04:50' } };
const LIMITS = { 'europe-dht-2': { 'holochain-0.7': { memory_mb: 2600, memory_swap_mb: 3000 }, 'holochain-0.6': { memory_mb: 1000, memory_swap_mb: 1400 } } };
const want07 = { memoryBytes: 2600 * MB, memorySwapBytes: 3000 * MB };
const none = { memoryBytes: 0, memorySwapBytes: 0 };

test('shape: the production block is accepted; a manifest without one is too', () => {
  assert.equal(memoryLimitsProblem(LIMITS, IDS), null);
  assert.equal(memoryLimitsProblem(undefined, IDS), null);
});

test('shape: what is refused', () => {
  const one = (l) => memoryLimitsProblem({ 'europe-dht-2': { 'holochain-0.7': l } }, IDS);
  assert.match(one({ memory_mb: 100, memory_swap_mb: 200 }), /memory_mb .* must be 256 to/); // a typing mistake would stop the conductor starting
  assert.match(one({ memory_mb: 2600 }), /memory_swap_mb/);
  assert.match(one({ memory_mb: 2600, memory_swap_mb: 2000 }), /at least memory_mb/);
  assert.match(one({ memory_mb: '2600m', memory_swap_mb: 3000 }), /memory_mb/);
  assert.match(memoryLimitsProblem({ 'europe-dht-2': { 'holochain-0.9': { memory_mb: 2600, memory_swap_mb: 3000 } } }, IDS), /unknown generation/);
  assert.match(memoryLimitsProblem({ 'Europe DHT': { 'holochain-0.7': { memory_mb: 2600, memory_swap_mb: 3000 } } }, IDS), /bad memory_limits label/);
  assert.match(memoryLimitsProblem({ 'europe-dht-2': {} }, IDS), /bad memory_limits for europe-dht-2/);
  assert.match(memoryLimitsProblem([], IDS), /bad memory_limits/);
});

test('limitFor: this node and line only, in bytes', () => {
  const m = { memory_limits: LIMITS };
  assert.deepEqual(limitFor(m, 'europe-dht-2', 'holochain-0.7'), want07);
  assert.deepEqual(limitFor(m, 'europe-dht-2', 'holochain-0.6'), { memoryBytes: 1000 * MB, memorySwapBytes: 1400 * MB });
  assert.equal(limitFor(m, 'singapore-dht', 'holochain-0.7'), null);
  assert.equal(limitFor({}, 'europe-dht-2', 'holochain-0.7'), null);
});

test('a running conductor with no ceiling and room below it: set, no restart needed', () => {
  const v = limitVerdict(want07, { have: none, running: true, residentBytes: 1500 * MB, swapBytes: 300 * MB, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(v.apply, true);
  assert.match(v.reason, /^ceiling 2600 MB, 3000 MB with swap$/);
});

test('the ceiling already in place: nothing', () => {
  const v = limitVerdict(want07, { have: want07, running: true, residentBytes: 1500 * MB, swapBytes: 0, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(v.apply, false);
  assert.equal(v.kind, 'in-place');
});

test('a ceiling set by hand that differs from the manifest: replaced by the manifest\'s', () => {
  const v = limitVerdict(want07, { have: { memoryBytes: 2000 * MB, memorySwapBytes: 2400 * MB }, running: true, residentBytes: 900 * MB, swapBytes: 0, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(v.apply, true);
});

test('a running conductor already near the new ceiling: waits for its next restart', () => {
  // 2400 MB resident is over nine tenths of 2600 MB: lowering the ceiling onto it could get it killed.
  const near = limitVerdict(want07, { have: none, running: true, residentBytes: 2400 * MB, swapBytes: 0, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(near.apply, false);
  assert.equal(near.kind, 'near');
  assert.match(near.reason, /holds 2400 MB .* waits for its next restart/);
  // Resident is fine, but with its swap it is near the memory-and-swap figure.
  const swapped = limitVerdict(want07, { have: none, running: true, residentBytes: 2000 * MB, swapBytes: 800 * MB, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(swapped.kind, 'near');
});

test('a running conductor whose memory cannot be measured: waits', () => {
  const v = limitVerdict(want07, { have: none, running: true, residentBytes: null, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(v.apply, false);
  assert.equal(v.kind, 'unmeasured');
});

test('a stopped conductor, or one about to be created: set whatever it held', () => {
  assert.equal(limitVerdict(want07, { have: none, running: false, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' }).apply, true);
  assert.equal(limitVerdict(want07, { have: null, running: false, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' }).apply, true);
});

test('a ceiling at or under the point where the size restart acts at once: never set', () => {
  // Urgent restart at 60 % of 3913 MB = 2348 MB. A ceiling of 2000 MB (2300 with swap) would kill the conductor before the clean restart.
  const low = { memoryBytes: 2000 * MB, memorySwapBytes: 2300 * MB };
  const v = limitVerdict(low, { have: none, running: false, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(v.apply, false);
  assert.equal(v.kind, 'below-restart');
  assert.match(v.reason, /2300 MB with swap is not above the size restart's 2348 MB/);
  // The same manifest on a smaller VM is fine: the check is against this VM.
  assert.equal(limitVerdict(low, { have: none, running: false, totalBytes: 1976 * MB, policy: STABLE, generation: 'holochain-0.7' }).apply, true);
  // Without an urgent share the slot's share is the point.
  const noUrgent = { ...STABLE, urgent_share: undefined };
  assert.equal(limitVerdict({ memoryBytes: 1500 * MB, memorySwapBytes: 1700 * MB }, { have: none, running: false, totalBytes: VM, policy: noUrgent, generation: 'holochain-0.7' }).kind, 'below-restart');
});

test('a line under a size restart, with the VM\'s memory unknown: not set', () => {
  const v = limitVerdict(want07, { have: none, running: false, totalBytes: null, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(v.apply, false);
  assert.equal(v.kind, 'unchecked');
});

test('a line the size restart does not cover: the ceiling stands alone', () => {
  const want06 = { memoryBytes: 1000 * MB, memorySwapBytes: 1400 * MB };
  assert.equal(limitVerdict(want06, { have: none, running: true, residentBytes: 617 * MB, swapBytes: 0, totalBytes: VM, policy: STABLE, generation: 'holochain-0.6' }).apply, true);
  assert.equal(limitVerdict(want06, { have: none, running: false, totalBytes: null, policy: undefined, generation: 'holochain-0.6' }).apply, true);
});

test('a line with its own restart thresholds: the ceiling is checked against those', () => {
  const policy = { generations: ['holochain-0.7', 'holochain-0.6'], share: 0.45, urgent_share: 0.6, slots: {}, lines: { 'holochain-0.6': { share: 0.2, urgent_share: 0.24 } } };
  // 24 % of 3913 MB = 939 MB: 1400 MB with swap is above it, 900 MB is not.
  assert.equal(limitVerdict({ memoryBytes: 1000 * MB, memorySwapBytes: 1400 * MB }, { have: none, running: false, totalBytes: VM, policy, generation: 'holochain-0.6' }).apply, true);
  assert.equal(limitVerdict({ memoryBytes: 800 * MB, memorySwapBytes: 900 * MB }, { have: none, running: false, totalBytes: VM, policy, generation: 'holochain-0.6' }).kind, 'below-restart');
});

test('no ceiling named for this node and line: nothing', () => {
  const v = limitVerdict(null, { have: none, running: true, residentBytes: 1, totalBytes: VM, policy: STABLE, generation: 'holochain-0.7' });
  assert.equal(v.apply, false);
  assert.equal(v.kind, 'none');
});

test('the container spec carries the ceiling the agent chose', () => {
  const spec = conductorContainerSpec({ image: 'i', generation: 'holochain-0.7', dataVolume: 'v', labels: {}, ...want07 });
  assert.equal(spec.HostConfig.Memory, 2600 * MB);
  assert.equal(spec.HostConfig.MemorySwap, 3000 * MB);
  const bare = conductorContainerSpec({ image: 'i', generation: 'holochain-0.7', dataVolume: 'v', labels: {} });
  assert.equal(bare.HostConfig.Memory, undefined);
});

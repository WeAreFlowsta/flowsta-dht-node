import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { parseMeminfo, containerMemory, readHost } from '../lib/host.mjs';

const MEMINFO = `MemTotal:        4007028 kB
MemFree:          120000 kB
MemAvailable:    1567744 kB
Buffers:           40000 kB
Cached:          1200000 kB
SwapTotal:       1048572 kB
SwapFree:         536572 kB
`;

test('meminfo: total, available and swap in bytes', () => {
  const m = parseMeminfo(MEMINFO);
  assert.equal(m.mem_total, 4007028 * 1024);
  assert.equal(m.mem_available, 1567744 * 1024);
  assert.equal(m.swap_total, 1048572 * 1024);
  assert.equal(m.swap_used, (1048572 - 536572) * 1024);
});

test('meminfo without swap lines: nulls, not zeros', () => {
  const m = parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 500 kB\n');
  assert.equal(m.swap_total, null);
  assert.equal(m.swap_used, null);
});

test('container memory leaves out the inactive file cache (cgroup v2 and v1)', () => {
  assert.equal(containerMemory({ memory_stats: { usage: 1_700_000_000, stats: { inactive_file: 100_000_000 } } }), 1_600_000_000);
  assert.equal(containerMemory({ memory_stats: { usage: 1_700_000_000, stats: { total_inactive_file: 200_000_000 } } }), 1_500_000_000);
  assert.equal(containerMemory({ memory_stats: { usage: 5, stats: {} } }), 5);
  assert.equal(containerMemory({}), null);
});

test('readHost reads this machine and never throws', () => {
  const h = readHost(os.tmpdir());
  assert.equal(typeof h.kernel, 'string');
  assert.ok(h.mem_total === null || h.mem_total > 0);
  assert.ok(h.disk_total === null || h.disk_used <= h.disk_total);
  const missing = readHost('/no/such/dir');
  assert.equal(missing.disk_total, null);
});

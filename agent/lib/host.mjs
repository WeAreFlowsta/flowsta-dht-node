/**
 * What the node itself looks like, for the health report.
 *
 * The agent runs in a container, but a container sees the host's
 * /proc/meminfo, load, uptime and kernel release; the state volume sits on
 * the host's disk, so its filesystem use is the host's. Each conductor's
 * memory comes from Docker's stats, page cache excluded (what `docker stats`
 * shows), so it is what the conductor holds, not what the kernel cached for it.
 */
import fs from 'node:fs';
import os from 'node:os';

/** /proc/meminfo text → bytes for the fields the report uses. */
export function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  const b = (k) => (kb[k] === undefined ? null : kb[k] * 1024);
  const swapUsed = kb.SwapTotal !== undefined && kb.SwapFree !== undefined ? (kb.SwapTotal - kb.SwapFree) * 1024 : null;
  return { mem_total: b('MemTotal'), mem_available: b('MemAvailable'), swap_total: b('SwapTotal'), swap_used: swapUsed };
}

/**
 * A container's memory from one Docker stats sample: usage minus the
 * inactive file cache (cgroup v2 `inactive_file`, v1 `total_inactive_file`).
 */
export function containerMemory(stats) {
  const m = stats?.memory_stats;
  if (!m || typeof m.usage !== 'number') return null;
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0;
  return Math.max(0, m.usage - cache);
}

/**
 * A container's swap in bytes from its cgroup v2 `memory.swap.current`,
 * read inside it; null when the text is not one number (cgroup v1, no swap
 * accounting, no `cat` in the image).
 */
export function parseSwapCurrent(text) {
  const t = String(text ?? '').trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** The host, as the report carries it. Every field may be null when unreadable. */
export function readHost(stateDir) {
  let mem = { mem_total: null, mem_available: null, swap_total: null, swap_used: null };
  try { mem = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch {}
  let disk = { disk_total: null, disk_used: null };
  try {
    const s = fs.statfsSync(stateDir);
    disk = { disk_total: s.blocks * s.bsize, disk_used: (s.blocks - s.bfree) * s.bsize };
  } catch {}
  return {
    ...mem,
    ...disk,
    load_1m: Math.round(os.loadavg()[0] * 100) / 100,
    cpus: os.cpus().length,
    uptime_s: Math.round(os.uptime()),
    kernel: os.release(),
  };
}

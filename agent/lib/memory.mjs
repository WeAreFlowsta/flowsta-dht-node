/**
 * Restarting a conductor that has grown too large.
 *
 * Holochain 0.7.1 conductors grow about 0.5 GB a day on the fleet's nodes
 * (production read 2026-11-02) until the VM swaps and the kernel kills one.
 * A clean restart brings one back to about 200 MB. The signed manifest says
 * when that is allowed:
 *
 *   "memory_restart": {
 *     "generations": ["holochain-0.7"],   which lines it applies to
 *     "share": 0.45,                      restart above this share of the VM's memory
 *     "slots": { "europe-dht": "05:20" }, each node's own time (node-local, like
 *                                         UPDATE_WINDOW), so nodes restart one at a time
 *     "urgent_share": 0.6,                optional: above this, restart at once
 *     "every_hours": 24                   optional: at most this often (default 24, min 6)
 *   }
 *
 * A node without a slot never restarts for memory (except above
 * urgent_share), so the fleet opts in node by node. Rather than a container
 * memory limit: an out-of-memory kill is a hard stop, and hard stops have
 * left an empty lair pid_file before.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A slot lasts this long: the check runs every 5 minutes, so it gets several chances. */
export const SLOT_MINUTES = 20;
const AFTER_START_MS = 6 * HOUR;
const GEN_ID = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Shape check for the manifest's `memory_restart`. Returns a reason string, or null. */
export function memoryPolicyProblem(p) {
  if (p === undefined) return null;
  if (!p || typeof p !== 'object') return 'bad memory_restart';
  if (!Array.isArray(p.generations) || p.generations.length === 0 || p.generations.length > 4 || !p.generations.every((g) => typeof g === 'string' && GEN_ID.test(g))) return 'bad memory_restart generations';
  if (typeof p.share !== 'number' || !(p.share >= 0.2 && p.share <= 0.9)) return 'memory_restart share must be between 0.2 and 0.9';
  if (p.urgent_share !== undefined && (typeof p.urgent_share !== 'number' || !(p.urgent_share > p.share && p.urgent_share <= 0.95))) return 'memory_restart urgent_share must be above share and at most 0.95';
  if (p.every_hours !== undefined && (!Number.isInteger(p.every_hours) || p.every_hours < 6 || p.every_hours > 168)) return 'memory_restart every_hours must be 6 to 168';
  if (!p.slots || typeof p.slots !== 'object' || Array.isArray(p.slots)) return 'bad memory_restart slots';
  const entries = Object.entries(p.slots);
  if (entries.length > 64) return 'too many memory_restart slots';
  for (const [label, at] of entries) {
    if (!LABEL.test(label)) return `bad memory_restart slot label ${label}`;
    if (typeof at !== 'string' || !HHMM.test(at)) return `bad memory_restart slot time for ${label}`;
  }
  return null;
}

/** "05:20" → minutes after midnight. */
function minutesOf(hhmm) {
  const m = HHMM.exec(hhmm);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Whether `date` (node-local) falls in the slot that starts at `hhmm`. */
export function inSlot(date, hhmm) {
  const start = minutesOf(hhmm);
  const minute = date.getHours() * 60 + date.getMinutes();
  const since = (minute - start + 1440) % 1440;
  return since < SLOT_MINUTES;
}

/**
 * Should this generation's conductor be restarted for its size?
 * @param {{ usedBytes: number, totalBytes: number }} mem  the conductor's memory (page cache excluded) and the VM's
 * @param {{ policy?: object, label: string, generation: string, now: Date, startedAt: number, lastRestartAt?: number | null }} o
 * @returns {{ restart: boolean, reason: string, share: number | null }}
 */
export function memoryVerdict({ usedBytes, totalBytes }, { policy, label, generation, now, startedAt, lastRestartAt = null }) {
  const share = usedBytes > 0 && totalBytes > 0 ? usedBytes / totalBytes : null;
  const no = (reason) => ({ restart: false, reason, share });
  if (!policy || !policy.generations.includes(generation)) return no('no memory policy for this line');
  if (share === null) return no('memory not measured');
  const pct = (x) => `${Math.round(x * 100)} %`;
  if (share < policy.share) return no(`${pct(share)} of the VM's memory, under ${pct(policy.share)}`);
  const t = now.getTime();
  if (t - startedAt < AFTER_START_MS) return no(`${pct(share)}, but started less than 6 hours ago`);
  const every = (policy.every_hours || 24) * HOUR;
  if (lastRestartAt && t - lastRestartAt < every) return no(`${pct(share)}, but restarted for its size less than ${policy.every_hours || 24} hours ago`);
  if (policy.urgent_share && share >= policy.urgent_share) return { restart: true, reason: `${pct(share)} of the VM's memory, over the urgent ${pct(policy.urgent_share)}`, share };
  const slot = policy.slots[label];
  if (!slot) return no(`${pct(share)}, over ${pct(policy.share)}, but this node has no restart slot`);
  if (!inSlot(now, slot)) return no(`${pct(share)}, over ${pct(policy.share)}; waits for its slot at ${slot}`);
  return { restart: true, reason: `${pct(share)} of the VM's memory, over ${pct(policy.share)}, in its slot at ${slot}`, share };
}

/**
 * A memory ceiling for each conductor container, carried by the signed manifest.
 *
 * A 0.7.1 conductor grows until something stops it. The clean stop is the
 * size restart (lib/memory.mjs). The ceiling is the backstop for when that
 * does not act in time: without one a grown conductor takes the whole VM
 * down with it.
 *
 *   "memory_limits": {
 *     "europe-dht-2": {                      per node label
 *       "holochain-0.7": { "memory_mb": 2600, "memory_swap_mb": 3000 },
 *       "holochain-0.6": { "memory_mb": 1000, "memory_swap_mb": 1400 }
 *     }
 *   }
 *
 * `memory_mb` is the container's memory, `memory_swap_mb` its memory and
 * swap together (Docker's two figures). The agent sets them when it creates
 * a conductor and on a conductor that already exists, running or not,
 * without restarting it. A node or line the block does not name keeps what
 * it has (CONDUCTOR_MEMORY at creation, or a ceiling set by hand): the agent
 * never removes a ceiling.
 *
 * Two things it will not do, because a conductor killed for memory is a hard
 * stop and hard stops have left an empty lair pid_file before:
 *   - set a ceiling that is not above the point where the size restart acts
 *     at once on this VM, so the clean restart always comes first;
 *   - lower a ceiling onto a running conductor that is already near it; it
 *     waits for the conductor's next restart.
 */
import { thresholdsFor } from './memory.mjs';

const MB = 1024 * 1024;
const GEN_ID = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Below this a typing mistake would stop a conductor from starting at all. */
export const MIN_MEMORY_MB = 256;
const MAX_MEMORY_MB = 1024 * 1024;
/** A running conductor may hold at most this share of a new ceiling when it is set. */
export const HEADROOM = 0.9;

/** Shape check for the manifest's `memory_limits`. Returns a reason string, or null. */
export function memoryLimitsProblem(p, generationIds) {
  if (p === undefined) return null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'bad memory_limits';
  const labels = Object.entries(p);
  if (labels.length > 64) return 'too many memory_limits labels';
  for (const [label, lines] of labels) {
    if (!LABEL.test(label)) return `bad memory_limits label ${label}`;
    if (!lines || typeof lines !== 'object' || Array.isArray(lines)) return `bad memory_limits for ${label}`;
    const entries = Object.entries(lines);
    if (entries.length === 0 || entries.length > 4) return `bad memory_limits for ${label}`;
    for (const [gen, l] of entries) {
      if (!GEN_ID.test(gen) || (generationIds && !generationIds.has(gen))) return `memory_limits for ${label} names an unknown generation ${gen}`;
      if (!l || typeof l !== 'object') return `bad memory_limits for ${label} ${gen}`;
      if (!Number.isInteger(l.memory_mb) || l.memory_mb < MIN_MEMORY_MB || l.memory_mb > MAX_MEMORY_MB) return `memory_limits memory_mb for ${label} ${gen} must be ${MIN_MEMORY_MB} to ${MAX_MEMORY_MB}`;
      if (!Number.isInteger(l.memory_swap_mb) || l.memory_swap_mb < l.memory_mb || l.memory_swap_mb > 2 * MAX_MEMORY_MB) return `memory_limits memory_swap_mb for ${label} ${gen} must be at least memory_mb`;
    }
  }
  return null;
}

/** The ceiling the manifest gives this node's line, in bytes; null when it names none. */
export function limitFor(manifest, label, generation) {
  const l = manifest?.memory_limits?.[label]?.[generation];
  if (!l) return null;
  return { memoryBytes: l.memory_mb * MB, memorySwapBytes: l.memory_swap_mb * MB };
}

const mb = (bytes) => `${Math.round(bytes / MB)} MB`;

/**
 * Should the ceiling `want` be set on this conductor's container now?
 *
 * @param {{ memoryBytes: number, memorySwapBytes: number } | null} want  the manifest's ceiling for this node and line
 * @param {object} o
 * @param {{ memoryBytes: number, memorySwapBytes: number } | null} [o.have]  what the container has now (0 or absent = none); null for a container not yet created
 * @param {boolean} [o.running]  whether the conductor is running
 * @param {number | null} [o.residentBytes]  its memory now (page cache excluded)
 * @param {number | null} [o.swapBytes]  its swap now
 * @param {number | null} [o.totalBytes]  the VM's memory
 * @param {object} [o.policy]  the manifest's memory_restart
 * @param {string} o.generation
 * @returns {{ apply: boolean, kind: string, reason: string }}  `kind` names the case, for logging once per change
 */
export function limitVerdict(want, { have = null, running = false, residentBytes = null, swapBytes = null, totalBytes = null, policy, generation }) {
  const no = (kind, reason) => ({ apply: false, kind, reason });
  if (!want) return no('none', 'the manifest names no ceiling for this node and line');
  if (have && (have.memoryBytes || 0) === want.memoryBytes && (have.memorySwapBytes || 0) === want.memorySwapBytes) return no('in-place', `ceiling in place (${mb(want.memoryBytes)}, ${mb(want.memorySwapBytes)} with swap)`);
  // The clean restart must come first: the ceiling has to sit above the
  // point where the size restart acts at once (or, without one, acts at all).
  const t = thresholdsFor(policy, generation);
  if (t) {
    if (!(totalBytes > 0)) return no('unchecked', 'the VM\'s memory is not known, so the ceiling cannot be checked against the size restart: not set');
    const point = (t.urgent ?? t.share) * totalBytes;
    if (want.memorySwapBytes <= point) return no('below-restart', `a ceiling of ${mb(want.memorySwapBytes)} with swap is not above the size restart's ${mb(point)} on this VM: not set`);
  }
  if (running) {
    if (residentBytes === null || residentBytes === undefined) return no('unmeasured', 'the conductor\'s memory is not measured: waits');
    const held = residentBytes + (swapBytes || 0);
    if (residentBytes > HEADROOM * want.memoryBytes || held > HEADROOM * want.memorySwapBytes) {
      return no('near', `the conductor holds ${mb(residentBytes)} (${mb(held)} with swap), too near a ceiling of ${mb(want.memoryBytes)} (${mb(want.memorySwapBytes)}): waits for its next restart`);
    }
  }
  return { apply: true, kind: 'set', reason: `ceiling ${mb(want.memoryBytes)}, ${mb(want.memorySwapBytes)} with swap` };
}

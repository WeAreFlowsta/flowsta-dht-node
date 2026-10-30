/**
 * Stuck bootstrap registrations.
 *
 * A conductor registers each of its networks with the bootstrap server and
 * signs a fresh registration every few minutes. If the server cannot be
 * reached while one is due, the conductor keeps retrying the same signed
 * registration; once it is more than a few minutes old the server refuses
 * it (HTTP 500), and the conductor never replaces it. Peers then stop
 * finding the node while everything else on it looks healthy. Only a
 * restart clears it: the restarted conductor's first registrations are
 * fresh and accepted.
 *
 * This module decides when the agent should do that. The agent reads the
 * conductor's logs, asks whether the bootstrap server answers at all (a
 * restart cannot help while it is down), and restarts.
 */

export const PUT_ERROR = 'Bootstrap PUT returned HTTP error';

const MIN = 60_000;
/** A refused registration is retried every 5 minutes: six in 30 minutes for one network. */
const MIN_ERRORS = 6;
const WINDOW_MS = 30 * MIN;
const STILL_FAILING_MS = 10 * MIN;
const AFTER_START_MS = 30 * MIN;
const BETWEEN_RESTARTS_MS = 6 * 60 * MIN;

/**
 * Failed registrations in a log read with Docker timestamps
 * (each line starts with an RFC 3339 time).
 * @param {string} text
 * @returns {{ at: number, url: string | null }[]}
 */
export function putErrors(text) {
  const out = [];
  // Conductor logs colour field names (url<dim>=</dim>"..."): drop the escapes first.
  // eslint-disable-next-line no-control-regex
  for (const line of String(text || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    if (!line.includes(PUT_ERROR)) continue;
    const at = Date.parse(line.slice(0, line.indexOf(' ')));
    const url = /url="([^"]+)"/.exec(line);
    out.push({ at, url: url ? url[1] : null });
  }
  return out.filter((e) => Number.isFinite(e.at));
}

/**
 * Should the conductor be restarted to clear stuck registrations?
 * Failing steadily for 30 minutes and still failing in the last 10; never
 * within 30 minutes of the conductor starting, never twice in 6 hours.
 * @param {{ at: number, url: string | null }[]} errors
 * @param {{ now: number, startedAt: number, lastRestartAt?: number | null }} o
 * @returns {{ restart: boolean, reason: string, bootstrap: string | null }}
 */
export function registrationVerdict(errors, { now, startedAt, lastRestartAt = null }) {
  if (now - startedAt < AFTER_START_MS) return { restart: false, reason: 'started less than 30 minutes ago', bootstrap: null };
  if (lastRestartAt && now - lastRestartAt < BETWEEN_RESTARTS_MS) return { restart: false, reason: 'restarted for this less than 6 hours ago', bootstrap: null };
  const recent = errors.filter((e) => now - e.at <= WINDOW_MS && e.at <= now);
  const latest = recent.reduce((m, e) => Math.max(m, e.at), 0);
  const earliest = recent.reduce((m, e) => Math.min(m, e.at), Infinity);
  const steady = recent.length >= MIN_ERRORS && now - latest <= STILL_FAILING_MS && now - earliest >= WINDOW_MS - STILL_FAILING_MS;
  if (!steady) return { restart: false, reason: `${recent.length} refused registrations in 30 minutes`, bootstrap: null };
  let bootstrap = null;
  const url = recent.find((e) => e.url)?.url;
  try { bootstrap = url ? new URL(url).origin : null; } catch { bootstrap = null; }
  return { restart: true, reason: `${recent.length} refused registrations in 30 minutes, the latest ${Math.round((now - latest) / 1000)} s ago`, bootstrap };
}

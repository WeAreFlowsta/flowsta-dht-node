/**
 * Environment for the conductor containers (CONDUCTOR_ENV): glibc's malloc
 * settings only, for the 0.7 memory test (production read 2026-11-02 § 1a:
 * does the growth flatten when glibc returns freed memory?). Entries are
 * separated by `;` because GLIBC_TUNABLES values hold `:` and `=`:
 *
 *   CONDUCTOR_ENV="GLIBC_TUNABLES=glibc.malloc.mmap_threshold=131072:glibc.malloc.trim_threshold=131072:glibc.malloc.arena_max=2"
 *
 * The entries count in the conductor's config hash, so changing them
 * replaces the conductor in the maintenance window like a config change.
 * With CONDUCTOR_ENV unset the hash is exactly the config's, as before 2.0.11:
 * no running conductor is replaced by the upgrade.
 */
import { createHash } from 'node:crypto';

const ALLOWED = /^(GLIBC_TUNABLES|MALLOC_ARENA_MAX|MALLOC_MMAP_THRESHOLD_|MALLOC_TRIM_THRESHOLD_|MALLOC_TOP_PAD_)$/;
const VALUE = /^[A-Za-z0-9._:=-]{1,512}$/;

/** "A=1;B=2" → ["A=1", "B=2"]; throws on a name outside the allowlist or an odd value. */
export function parseConductorEnv(spec) {
  if (!spec || !String(spec).trim()) return [];
  const out = [];
  for (const raw of String(spec).split(';')) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const name = eq > 0 ? entry.slice(0, eq) : '';
    const value = eq > 0 ? entry.slice(eq + 1) : '';
    if (!ALLOWED.test(name)) throw new Error(`CONDUCTOR_ENV: ${name || entry} is not allowed (glibc malloc settings only)`);
    if (!VALUE.test(value)) throw new Error(`CONDUCTOR_ENV: bad value for ${name}`);
    out.push(`${name}=${value}`);
  }
  return out;
}

/** The conductor's config hash: the config's alone when there is no extra environment. */
export function configShaOf(config, env = []) {
  const h = createHash('sha256').update(config);
  if (env.length) h.update(`\n# conductor environment\n${env.join('\n')}`);
  return h.digest('hex');
}

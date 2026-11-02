import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseConductorEnv, configShaOf } from '../lib/conductor-env.mjs';

const TUNABLES = 'GLIBC_TUNABLES=glibc.malloc.mmap_threshold=131072:glibc.malloc.trim_threshold=131072:glibc.malloc.arena_max=2';

test('parses the glibc settings, separated by semicolons', () => {
  assert.deepEqual(parseConductorEnv(`${TUNABLES}; MALLOC_ARENA_MAX=2`), [TUNABLES, 'MALLOC_ARENA_MAX=2']);
  assert.deepEqual(parseConductorEnv(''), []);
  assert.deepEqual(parseConductorEnv(undefined), []);
});

test('refuses anything but glibc malloc settings', () => {
  assert.throws(() => parseConductorEnv('RUST_LOG=debug'), /RUST_LOG is not allowed/);
  assert.throws(() => parseConductorEnv('LD_PRELOAD=/tmp/x.so'), /LD_PRELOAD is not allowed/);
  assert.throws(() => parseConductorEnv('MALLOC_ARENA_MAX=2 && rm'), /bad value/);
  assert.throws(() => parseConductorEnv('GLIBC_TUNABLES'), /is not allowed/);
});

test('no extra environment: the hash is the config hash as before 2.0.11', () => {
  const config = 'data_root_path: /data/holochain\n';
  assert.equal(configShaOf(config), createHash('sha256').update(config).digest('hex'));
  assert.equal(configShaOf(config, []), createHash('sha256').update(config).digest('hex'));
});

test('extra environment changes the hash, so the conductor is replaced', () => {
  const config = 'data_root_path: /data/holochain\n';
  assert.notEqual(configShaOf(config, [TUNABLES]), configShaOf(config));
  assert.notEqual(configShaOf(config, ['MALLOC_ARENA_MAX=2']), configShaOf(config, ['MALLOC_ARENA_MAX=4']));
});

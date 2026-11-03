import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prunableImages, repoOf } from '../lib/prune.mjs';

const R = 'us-docker.pkg.dev/flowsta-475001/public';
const d = (c) => c.repeat(64);
const AGENT_NOW = `${R}/flowsta-dht-node@sha256:${d('a')}`;
const AGENT_PREV = `${R}/flowsta-dht-node@sha256:${d('b')}`;
const AGENT_OLD = `${R}/flowsta-dht-node@sha256:${d('c')}`;
const COND_NOW = `${R}/flowsta-edgenode@sha256:${d('d')}`;
const COND_OLD = `${R}/flowsta-edgenode@sha256:${d('e')}`;
const manifest = { agent: { image: AGENT_NOW }, generations: [{ conductor: { image: COND_NOW } }] };
const img = (id, ...refs) => ({ Id: `sha256:${id.repeat(64)}`, RepoDigests: refs, RepoTags: [], Size: 100 });

const images = [
  img('1', AGENT_NOW),
  img('2', AGENT_PREV),
  img('3', AGENT_OLD),
  img('4', COND_NOW),
  img('5', COND_OLD),
  img('6', `${R}/flowsta-edgenode@sha256:${d('f')}`), // old, but a stopped container still uses it
  { Id: `sha256:${'7'.repeat(64)}`, RepoDigests: ['docker.io/library/postgres@sha256:' + d('9')], RepoTags: ['postgres:16'], Size: 100 }, // not ours
  { Id: `sha256:${'8'.repeat(64)}`, RepoDigests: [], RepoTags: ['<none>:<none>'], Size: 100 }, // origin unknown
];
const containers = [
  { ImageID: `sha256:${'1'.repeat(64)}`, Image: AGENT_NOW },
  { ImageID: `sha256:${'4'.repeat(64)}`, Image: COND_NOW },
  { ImageID: `sha256:${'6'.repeat(64)}`, Image: 'stopped-legacy' },
];

test('removes only old images of the repositories the manifest names', () => {
  const ids = prunableImages({ images, containers, manifest, keep: [AGENT_PREV] }).map((p) => p.id[7]);
  assert.deepEqual(ids.sort(), ['3', '5']);
});

test('keeps the previous agent image only when asked to', () => {
  const ids = prunableImages({ images, containers, manifest }).map((p) => p.id[7]);
  assert.deepEqual(ids.sort(), ['2', '3', '5']);
});

test('an image tagged with one of ours and one foreign repository is left alone', () => {
  const mixed = [{ Id: 'sha256:' + 'x'.repeat(64), RepoDigests: [COND_OLD], RepoTags: ['mine/edgenode:old'], Size: 1 }];
  assert.equal(prunableImages({ images: mixed, containers: [], manifest }).length, 0);
});

test('repository of a ref', () => {
  assert.equal(repoOf(`${R}/flowsta-edgenode@sha256:${d('d')}`), `${R}/flowsta-edgenode`);
  assert.equal(repoOf('localhost:5000/x/y:tag'), 'localhost:5000/x/y');
  assert.equal(repoOf('postgres:16'), 'postgres');
  assert.equal(repoOf('ghcr.io/holo-host/edgenode'), 'ghcr.io/holo-host/edgenode');
});

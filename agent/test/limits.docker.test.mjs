/**
 * The ceiling against a real Docker engine: set on a running container
 * without restarting it, raised, lowered, and the restart policy untouched.
 * Skipped unless DOCKER_IT=1 (it needs the Docker socket and the image named
 * by DOCKER_IT_IMAGE, default busybox:stable, already pulled).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Docker } from '../lib/docker.mjs';

const MB = 1024 * 1024;
const on = process.env.DOCKER_IT === '1';
const image = process.env.DOCKER_IT_IMAGE || 'busybox:stable';

test('a ceiling is set, raised and lowered on a running container with no restart', { skip: !on && 'set DOCKER_IT=1 to run against Docker' }, async () => {
  const docker = new Docker();
  const name = `flowsta-limits-test-${process.pid}`;
  const created = await docker.createContainer(name, { Image: image, Cmd: ['sleep', '600'], HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'none' } });
  try {
    await docker.startContainer(created.Id);
    const before = await docker.inspectContainer(created.Id);
    assert.equal(before.HostConfig.Memory, 0);

    const set = async (memoryMb, swapMb) => {
      await docker.updateContainer(created.Id, { Memory: memoryMb * MB, MemorySwap: swapMb * MB });
      const i = await docker.inspectContainer(created.Id);
      assert.equal(i.HostConfig.Memory, memoryMb * MB);
      assert.equal(i.HostConfig.MemorySwap, swapMb * MB);
      assert.equal(i.State.Running, true);
      assert.equal(i.State.StartedAt, before.State.StartedAt, 'the container was not restarted');
      assert.equal(i.RestartCount, 0);
      assert.equal(i.HostConfig.RestartPolicy.Name, 'unless-stopped', 'the restart policy is untouched');
      const max = await docker.exec(created.Id, ['cat', '/sys/fs/cgroup/memory.max']);
      assert.equal(max.output.trim(), String(memoryMb * MB), 'the kernel holds the new ceiling');
    };
    await set(300, 400); // from none
    await set(600, 800); // raised past the old memory-and-swap figure in one call
    await set(256, 256); // lowered, no swap allowed
  } finally {
    await docker.removeContainer(created.Id, { force: true });
  }
});

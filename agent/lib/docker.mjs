/**
 * The slice of the Docker Engine API the agent uses, over the unix socket.
 * No dependency: node:http speaks to the socket directly.
 */
import http from 'node:http';

const API = 'v1.44';

export class Docker {
  constructor({ socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock' } = {}) {
    this.socketPath = socketPath;
  }

  request(method, path, { body, headers = {}, raw = false, timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      const isBuffer = Buffer.isBuffer(body);
      const payload = body === undefined ? undefined : isBuffer ? body : Buffer.from(JSON.stringify(body));
      const req = http.request(
        { socketPath: this.socketPath, method, path: `/${API}${path}`, headers: { ...(payload ? { 'Content-Type': isBuffer ? 'application/x-tar' : 'application/json', 'Content-Length': payload.length } : {}), ...headers } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const data = Buffer.concat(chunks);
            if (res.statusCode >= 400) {
              let message = data.toString('utf8');
              try { message = JSON.parse(message).message || message; } catch {}
              const err = new Error(`docker ${method} ${path}: ${res.statusCode} ${message}`);
              err.status = res.statusCode;
              return reject(err);
            }
            if (raw) return resolve({ status: res.statusCode, data, headers: res.headers });
            const text = data.toString('utf8');
            if (!text) return resolve(null);
            try { resolve(JSON.parse(text)); } catch { resolve(text); }
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`docker ${method} ${path}: timeout`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  version() { return this.request('GET', '/version'); }

  listContainers({ all = true, filters } = {}) {
    const q = new URLSearchParams({ all: String(all) });
    if (filters) q.set('filters', JSON.stringify(filters));
    return this.request('GET', `/containers/json?${q}`);
  }

  async inspectContainer(nameOrId) {
    try { return await this.request('GET', `/containers/${encodeURIComponent(nameOrId)}/json`); } catch (e) { if (e.status === 404) return null; throw e; }
  }

  createContainer(name, config) { return this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: config }); }
  startContainer(id) { return this.request('POST', `/containers/${id}/start`).catch((e) => { if (e.status !== 304) throw e; }); }
  stopContainer(id, seconds = 60) { return this.request('POST', `/containers/${id}/stop?t=${seconds}`, { timeoutMs: (seconds + 30) * 1000 }).catch((e) => { if (e.status !== 304) throw e; }); }
  removeContainer(id, { force = false } = {}) { return this.request('DELETE', `/containers/${id}?force=${force}&v=false`).catch((e) => { if (e.status !== 404) throw e; }); }
  renameContainer(id, name) { return this.request('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`); }
  updateContainer(id, body) { return this.request('POST', `/containers/${id}/update`, { body }); }
  putArchive(id, path, tarBuffer) { return this.request('PUT', `/containers/${id}/archive?path=${encodeURIComponent(path)}`, { body: tarBuffer, raw: true }); }
  async getArchive(id, path) {
    const { data } = await this.request('GET', `/containers/${id}/archive?path=${encodeURIComponent(path)}`, { raw: true });
    return data;
  }

  /** Container logs as text (demultiplexed when the container has no TTY). */
  async logs(id, { since, tail = 200 } = {}) {
    const q = new URLSearchParams({ stdout: '1', stderr: '1', tail: String(tail) });
    if (since) q.set('since', String(since));
    const { data } = await this.request('GET', `/containers/${id}/logs?${q}`, { raw: true });
    const out = [];
    let off = 0;
    // Multiplexed frames: 1 byte stream, 3 zero bytes, 4-byte big-endian size.
    const looksFramed = data.length >= 8 && [0, 1, 2].includes(data[0]) && data[1] === 0 && data[2] === 0 && data[3] === 0;
    if (!looksFramed) return data.toString('utf8');
    while (off + 8 <= data.length) {
      const size = data.readUInt32BE(off + 4);
      out.push(data.subarray(off + 8, off + 8 + size).toString('utf8'));
      off += 8 + size;
    }
    return out.join('');
  }

  /** Pull an image reference (tag or @sha256 digest); resolves when the stream ends. */
  pullImage(ref, { timeoutMs = 20 * 60 * 1000 } = {}) {
    const at = ref.indexOf('@');
    const q = at > 0 ? `fromImage=${encodeURIComponent(ref.slice(0, at))}&tag=${encodeURIComponent(ref.slice(at + 1))}` : `fromImage=${encodeURIComponent(ref)}`;
    return this.request('POST', `/images/create?${q}`, { raw: true, timeoutMs }).then(({ data }) => {
      const lines = data.toString('utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try { const j = JSON.parse(line); if (j.error) throw new Error(`pull ${ref}: ${j.error}`); } catch (e) { if (e.message.startsWith('pull ')) throw e; }
      }
    });
  }

  async inspectImage(ref) {
    try { return await this.request('GET', `/images/${encodeURIComponent(ref)}/json`); } catch (e) { if (e.status === 404) return null; throw e; }
  }

  listVolumes() { return this.request('GET', '/volumes'); }
  createVolume(name, labels = {}) { return this.request('POST', '/volumes/create', { body: { Name: name, Labels: labels } }); }
}

/** The container spec for a generation's conductor. */
export function conductorContainerSpec({ image, generation, dataVolume, dataBind, labels, env = [] }) {
  const Binds = dataBind ? [`${dataBind}:/data`] : [`${dataVolume}:/data`];
  return {
    Image: image,
    Env: env,
    Labels: labels,
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      Binds,
      Ulimits: [
        { Name: 'nofile', Soft: 1048576, Hard: 1048576 },
        { Name: 'memlock', Soft: -1, Hard: -1 },
      ],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '100m', 'max-file': '3' } },
    },
  };
}

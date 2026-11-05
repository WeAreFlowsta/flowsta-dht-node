// A POST to the running Flowsta Vault that waits as long as its approval
// dialog does. fetch gives up when no response arrives within 300 s (Node's
// built-in headers timeout), and the Vault answers only once the person
// approves, within ten minutes. The Vault listens on http on this machine.
import http from 'node:http';

export function postToVault(url, origin, payload, waitMs = 11 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Origin: origin },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.setTimeout(waitMs, () => req.destroy(new Error(`no answer from the Vault in ${Math.round(waitMs / 60000)} minutes`)));
    req.on('error', reject);
    req.end(body);
  });
}

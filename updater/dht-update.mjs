/**
 * Flowsta DHT Node Auto-Updater
 *
 * Polls the Flowsta API for available DNA versions, compares against
 * locally installed apps, and installs any missing versions.
 *
 * Only installs identity and signing DNAs (never private).
 *
 * Environment variables:
 *   API_URL      - Flowsta API base URL (required)
 *   NODE_SECRET  - Optional legacy shared secret; public-DNA bundle
 *                  downloads are open (integrity via manifest sha256)
 *   CONDUCTOR_URL - Conductor admin WS URL (default: ws://localhost:4444)
 */
import { AdminWebsocket } from '@holochain/client';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const API_URL = process.env.API_URL;
const NODE_SECRET = process.env.NODE_SECRET || null;
const CONDUCTOR_URL = process.env.CONDUCTOR_URL || 'ws://localhost:4444';
const DOWNLOAD_DIR = '/tmp/flowsta-dht-updates';

if (!API_URL) {
  console.error('API_URL environment variable is required');
  process.exit(1);
}

/**
 * Fetch JSON from a URL.
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Download a file from a URL to disk.
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        fs.unlinkSync(destPath);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => {
      fs.unlinkSync(destPath);
      reject(e);
    });
  });
}

async function main() {
  console.log(`Checking for DNA updates from ${API_URL}...`);

  // 1. Fetch available versions from API
  const versions = await fetchJson(
    `${API_URL}/api/v1/vault/node/dna-versions`
  );

  console.log(`Available — identity: [${versions.identity_dna.all_versions.join(', ')}], signing: [${versions.signing_dna.all_versions.join(', ')}]`);

  // 2. Connect to local conductor
  const admin = await AdminWebsocket.connect({
    url: new URL(CONDUCTOR_URL),
    wsClientOptions: { origin: 'flowsta-dht-node' },
    defaultTimeout: 300000,
  });

  try {
    const apps = await admin.listApps({});
    const installedIds = new Set(apps.map(a => a.installed_app_id));

    // Get agent key
    let agentKey;
    if (apps.length > 0) {
      agentKey = apps[0].agent_pub_key;
    } else {
      agentKey = await admin.generateAgentPubKey();
      console.log('Generated new agent key');
    }

    // 3. Find missing versions
    const toInstall = [];

    for (const version of versions.identity_dna.all_versions) {
      const appId = `flowsta_identity_v${version.replace('.', '_')}`;
      if (!installedIds.has(appId)) {
        toInstall.push({ type: 'identity', version, appId });
      }
    }

    for (const version of versions.signing_dna.all_versions) {
      const appId = `flowsta_signing_v${version.replace('.', '_')}`;
      if (!installedIds.has(appId)) {
        toInstall.push({ type: 'signing', version, appId });
      }
    }

    if (toInstall.length === 0) {
      console.log('All DNAs up to date');
      return;
    }

    console.log(`Need to install ${toInstall.length} DNA(s): ${toInstall.map(t => t.appId).join(', ')}`);

    // 4. Download and install each missing version
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    for (const { type, version, appId } of toInstall) {
      const versionSlug = version.replace('.', '_');
      const filename = `flowsta_${type}_v${versionSlug}_happ.happ`;
      const destPath = path.join(DOWNLOAD_DIR, filename);

      // Check if we already have it bundled
      const bundledPath = `${process.env.HAPPS_DIR || '/app/happs'}/${filename}`;
      let happPath;

      if (fs.existsSync(bundledPath)) {
        console.log(`  Using bundled ${filename}`);
        happPath = bundledPath;
      } else {
        // Download from API
        const downloadUrl = NODE_SECRET
          ? `${API_URL}/api/v1/vault/node/dna-bundle/${type}/${version}?node_secret=${NODE_SECRET}`
          : `${API_URL}/api/v1/vault/node/dna-bundle/${type}/${version}`;
        console.log(`  Downloading ${filename}...`);
        try {
          await downloadFile(downloadUrl, destPath);
          happPath = destPath;
        } catch (e) {
          console.error(`  FAIL download ${filename}: ${e.message}`);
          continue;
        }
      }

      // Verify against the manifest checksum when the server provides one
      // — a drifted or corrupted bundle must fail loudly here, never join
      // the network as a different DNA.
      const happBytes = fs.readFileSync(happPath);
      const expected = versions[`${type}_dna`]?.checksums?.[version];
      if (expected) {
        const actual = crypto.createHash('sha256').update(happBytes).digest('hex');
        if (actual !== expected.toLowerCase()) {
          console.error(`  FAIL checksum ${filename}: manifest ${expected} vs file ${actual} — skipping install`);
          continue;
        }
        console.log(`  Checksum verified ${filename}`);
      }
      console.log(`  Installing ${appId} (${(happBytes.length / 1024 / 1024).toFixed(1)}MB)...`);

      try {
        await admin.installApp({
          agent_key: agentKey,
          installed_app_id: appId,
          source: { type: 'bytes', value: happBytes },
        });
        await admin.enableApp({ installed_app_id: appId });
        console.log(`  OK ${appId}`);
      } catch (e) {
        const msg = e.message || String(e);
        if (msg.includes('AppAlreadyInstalled') || msg.includes('CellAlreadyExists')) {
          console.log(`  OK ${appId} (already installed)`);
          await admin.enableApp({ installed_app_id: appId }).catch(() => {});
        } else {
          console.error(`  FAIL ${appId}: ${msg}`);
        }
      }
    }

    // 5. Clean up downloads
    try { fs.rmSync(DOWNLOAD_DIR, { recursive: true }); } catch {}

    // Final status
    const finalApps = await admin.listApps({});
    console.log(`\nUpdate complete: ${finalApps.length} apps installed`);
  } finally {
    await admin.client.close();
  }
}

main().catch(err => {
  console.error('Update error:', err.message || err);
  process.exit(1);
});

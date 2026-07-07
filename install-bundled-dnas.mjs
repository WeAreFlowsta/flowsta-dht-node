/**
 * Install bundled DNA hApp files on first boot.
 *
 * Reads all .happ files from /opt/flowsta/happs/, compares against
 * installed apps on the local conductor, and installs any missing ones.
 *
 * Uses the agent key from an existing app, or generates a new one
 * if this is a fresh conductor.
 */
import { AdminWebsocket } from '@holochain/client';
import fs from 'fs';
import path from 'path';

const HAPPS_DIR = process.env.HAPPS_DIR || '/app/happs';
const CONDUCTOR_URL = process.env.CONDUCTOR_URL || 'ws://localhost:4444';

async function main() {
  const admin = await AdminWebsocket.connect({
    url: new URL(CONDUCTOR_URL),
    wsClientOptions: { origin: 'flowsta-dht-node' },
    defaultTimeout: 300000, // 5 min — WASM compilation is slow
  });

  try {
    // Get existing apps
    const apps = await admin.listApps({});
    const installedIds = new Set(apps.map(a => a.installed_app_id));
    console.log(`Currently installed: ${apps.length} apps`);

    // Get or generate agent key
    let agentKey;
    if (apps.length > 0) {
      agentKey = apps[0].agent_pub_key;
      console.log(`Using existing agent key from ${apps[0].installed_app_id}`);
    } else {
      agentKey = await admin.generateAgentPubKey();
      console.log('Generated new agent key for this node');
    }

    // Scan happs directory for .happ files
    if (!fs.existsSync(HAPPS_DIR)) {
      console.log('No happs directory found, skipping');
      return;
    }

    const happFiles = fs.readdirSync(HAPPS_DIR)
      .filter(f => f.endsWith('.happ'))
      .sort();

    console.log(`Found ${happFiles.length} bundled hApp files`);

    for (const file of happFiles) {
      // Extract app ID from filename: flowsta_signing_v1_4_happ.happ -> flowsta_signing_v1_4
      const appId = file.replace('_happ.happ', '');

      if (installedIds.has(appId)) {
        console.log(`  SKIP ${appId} (already installed)`);
        continue;
      }

      const happPath = path.join(HAPPS_DIR, file);
      const happBytes = fs.readFileSync(happPath);
      console.log(`  INSTALLING ${appId} (${(happBytes.length / 1024 / 1024).toFixed(1)}MB)...`);

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
          console.log(`  OK ${appId} (already installed, enabling)`);
          await admin.enableApp({ installed_app_id: appId }).catch(() => {});
        } else {
          console.error(`  FAIL ${appId}: ${msg}`);
        }
      }
    }

    // Final status
    const finalApps = await admin.listApps({});
    console.log(`\nInstallation complete: ${finalApps.length} apps installed`);
    for (const app of finalApps) {
      console.log(`  ${app.installed_app_id} | ${JSON.stringify(app.status)}`);
    }
  } finally {
    await admin.client.close();
  }
}

main().catch(err => {
  console.error('DNA installation error:', err.message || err);
  process.exit(1);
});

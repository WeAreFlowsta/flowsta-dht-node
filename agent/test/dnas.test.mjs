import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appIdKey, reconcileDnas } from '../lib/dnas.mjs';

const ID = 'flowsta_identity_v1_3';

function fakeAdmin(apps, { installError } = {}) {
  const calls = { installed: [], enabled: [] };
  return {
    calls,
    listApps: async () => apps,
    enableApp: async ({ installed_app_id }) => { calls.enabled.push(installed_app_id); },
    installApp: async ({ installed_app_id }) => { if (installError) throw new Error(installError); calls.installed.push(installed_app_id); },
    generateAgentPubKey: async () => 'key',
  };
}

test('an app id matches its older spellings', () => {
  assert.equal(appIdKey('flowsta-identity-v1.3'), appIdKey(ID));
  assert.notEqual(appIdKey('flowsta_identity_v1_4'), appIdKey(ID));
});

test('an app running under an older spelling of its id is not installed again', async () => {
  const admin = fakeAdmin([{ installed_app_id: 'flowsta-identity-v1.3', status: { type: 'running' }, agent_pub_key: 'key' }]);
  const r = await reconcileDnas(admin, [{ app_id: ID, sha256: 'x', url: 'https://example.invalid/x' }], { log: () => {} });
  assert.deepEqual(r, { installed: [], enabled: [], failed: [], elsewhere: [] });
  assert.deepEqual(admin.calls, { installed: [], enabled: [] });
});

test('a stopped app under an older spelling is enabled by its own id', async () => {
  const admin = fakeAdmin([{ installed_app_id: 'flowsta-identity-v1.3', status: { type: 'disabled' }, agent_pub_key: 'key' }]);
  const r = await reconcileDnas(admin, [{ app_id: ID, sha256: 'x', url: 'https://example.invalid/x' }], { log: () => {} });
  assert.deepEqual(r.enabled, ['flowsta-identity-v1.3']);
  assert.deepEqual(admin.calls.enabled, ['flowsta-identity-v1.3']);
});

import fs from 'node:fs';
import path from 'node:path';

export function loadState(file) {
  try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return emptyState(); }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function emptyState() {
  return { manifest_sequence: 0, manifest: null, generations: {}, agent: {}, advisories_applied: [], history: [] };
}

export function remember(state, event) {
  state.history.unshift({ at: new Date().toISOString(), ...event });
  state.history = state.history.slice(0, 200);
}

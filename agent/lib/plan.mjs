/**
 * Pure planning: what the manifest wants, what Docker shows, the actions
 * between them. No I/O here, so it is tested on paper.
 */
export const MANAGED_LABEL = 'org.flowsta.managed';
export const GENERATION_LABEL = 'org.flowsta.generation';
export const CONFIG_LABEL = 'org.flowsta.config-sha256';
export const IMAGE_LABEL = 'org.flowsta.image';
export const SEQUENCE_LABEL = 'org.flowsta.manifest-sequence';

export function containerNameFor(generationId) { return `flowsta-conductor-${generationId}`; }
export function dataVolumeFor(generationId) { return `flowsta-conductor-data-${generationId}`; }

/**
 * observed: { managed: [{ name, id, image, labels, running, mounts }], legacy: { name, id, running, mounts } | null, agentImage }
 * desired:  { generations: [{ id, state, image, configSha, adopts, dataVolume }], agentImage }
 * Returns actions in the order to apply them. `disruptive` actions wait for the window.
 */
export function planActions(desired, observed) {
  const actions = [];
  const byGeneration = new Map(observed.managed.map((c) => [c.labels?.[GENERATION_LABEL], c]));
  for (const gen of desired.generations) {
    const current = byGeneration.get(gen.id);
    if (gen.state === 'retired') {
      if (current?.running) actions.push({ type: 'stop', generation: gen.id, disruptive: true, reason: 'generation retired' });
      continue;
    }
    if (!current) {
      if (gen.adopts && observed.legacy) {
        actions.push({ type: 'adopt', generation: gen.id, from: observed.legacy.name, disruptive: observed.legacy.running, reason: 'first run: taking over the existing conductor and its data' });
      } else {
        actions.push({ type: 'create', generation: gen.id, disruptive: false, reason: 'no conductor for this generation yet' });
      }
      continue;
    }
    const imageChanged = current.image !== gen.image;
    const configChanged = (current.labels?.[CONFIG_LABEL] || '') !== gen.configSha;
    if (imageChanged || configChanged) {
      actions.push({ type: 'replace', generation: gen.id, disruptive: true, fromImage: current.image, reason: imageChanged ? 'conductor image changed' : 'conductor config changed' });
      continue;
    }
    if (!current.running) actions.push({ type: 'start', generation: gen.id, disruptive: false, reason: 'conductor is not running' });
  }
  const wanted = new Set(desired.generations.map((g) => g.id));
  for (const c of observed.managed) {
    const id = c.labels?.[GENERATION_LABEL];
    if (!wanted.has(id) && c.running) actions.push({ type: 'stop', generation: id, disruptive: true, reason: 'generation no longer in the manifest' });
  }
  if (desired.agentImage && observed.agentImage && desired.agentImage !== observed.agentImage) {
    actions.push({ type: 'self-update', image: desired.agentImage, disruptive: true, reason: 'agent image changed' });
  }
  return actions;
}

/** The volume (or bind path) a legacy conductor keeps its data on. */
export function legacyDataMount(inspect) {
  const m = (inspect?.Mounts || []).find((x) => x.Destination === '/data');
  if (!m) return null;
  return m.Type === 'volume' ? { volume: m.Name } : { bind: m.Source };
}

/** Advisories the agent may act on now: security ones any time (when allowed), the rest in the window. */
export function actionableAdvisories(manifest, { applied, inWindow, securityAnytime }) {
  return (manifest.advisories || []).filter((a) => !applied.has(a.id) && a.action !== 'notice' && (inWindow || (a.severity === 'security' && securityAnytime)));
}

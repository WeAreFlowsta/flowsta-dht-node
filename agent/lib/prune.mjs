/**
 * Old images: each agent and conductor update pulls a new image and leaves
 * the old one behind (proofpoll-node's 10 GB disk reached 85 % on
 * 2026-11-02, 1.77 GB of it old images). This picks the images the agent
 * may remove, and only those:
 *   - an image of a repository the manifest itself names (the agent's and
 *     each generation's conductor and bootstrap images), so a community
 *     node's own images are never touched;
 *   - not used by any container, running or stopped;
 *   - not one the manifest names now, and not the previous agent image
 *     (kept so a rollback needs no download).
 * Untagged images with no digest are left alone: their origin is unknown.
 */

/** "registry/path/name@sha256:…" or "registry/path/name:tag" → "registry/path/name". */
export function repoOf(ref) {
  if (typeof ref !== 'string') return null;
  const at = ref.indexOf('@');
  const base = at >= 0 ? ref.slice(0, at) : ref;
  const slash = base.lastIndexOf('/');
  const colon = base.lastIndexOf(':');
  return colon > slash ? base.slice(0, colon) : base;
}

/** The image refs a manifest names: the agent and every generation's conductor and bootstrap server. */
export function manifestImages(manifest) {
  const refs = [manifest?.agent?.image];
  for (const g of manifest?.generations || []) refs.push(g?.conductor?.image, g?.bootstrap?.server_image);
  return refs.filter((r) => typeof r === 'string');
}

/**
 * @param {{ images: object[], containers: object[], manifest: object, keep?: string[] }} o
 *   images: Docker's /images/json; containers: /containers/json?all=1;
 *   keep: more refs to keep (the previous agent image)
 * @returns {{ id: string, refs: string[], size: number }[]}
 */
export function prunableImages({ images, containers, manifest, keep = [] }) {
  const named = [...manifestImages(manifest), ...keep.filter(Boolean)];
  const repos = new Set(named.map(repoOf).filter(Boolean));
  const keepRefs = new Set(named);
  const used = new Set((containers || []).flatMap((c) => [c.ImageID, c.Image]).filter(Boolean));
  const out = [];
  for (const img of images || []) {
    const refs = [...(img.RepoDigests || []), ...(img.RepoTags || [])].filter((r) => r && !r.startsWith('<none>'));
    if (refs.length === 0) continue;
    if (!refs.every((r) => repos.has(repoOf(r)))) continue;
    if (used.has(img.Id) || refs.some((r) => used.has(r))) continue;
    if (refs.some((r) => keepRefs.has(r))) continue;
    out.push({ id: img.Id, refs, size: img.Size || 0 });
  }
  return out;
}

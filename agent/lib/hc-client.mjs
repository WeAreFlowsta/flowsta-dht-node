/**
 * One Holochain client per conductor line. The 0.6 and 0.7 conductors speak
 * different admin wire formats, so the agent carries both clients and picks
 * by the generation's Holochain version.
 */
export async function clientFor(holochainVersion) {
  const line = /^0\.6(\.|$)/.test(holochainVersion || '') ? '0.6' : '0.7';
  return line === '0.6' ? import('@holochain/client') : import('holochain-client-07');
}

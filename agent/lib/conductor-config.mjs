/**
 * The conductor config a generation runs with. Rendered by the agent from
 * the manifest (bootstrap URL, admin port, Holochain line) and the node's
 * own settings (auth material, tracing); never hand-edited on the node.
 *
 * 0.6: bootstrap_url + signal_url + relay_url (the signal server is the
 *      bootstrap host; relay as the FQDN-with-dot form).
 * 0.7: no signal_url (the field is rejected), relay_url = the bootstrap host,
 *      request_timeout_s under network, db_sync_level.
 */
export function holochainLine(version) {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`bad holochain version "${version}"`);
  return `${m[1]}.${m[2]}`;
}

/**
 * `dataRoot` and `lairRoot` are where the conductor's data lives inside the
 * container. They are carried over from an adopted conductor's config and
 * must never change for a running generation: a different path is an empty
 * conductor beside the real data, and nothing but the path would tell.
 */
export const DEFAULT_ALLOWED_ORIGINS = 'flowsta-agent,flowsta-auth-api';

export function renderConductorConfig(generation, { authBootstrap, authRelay, tracing = 'info,kitsune2=info', dataRoot = '/data/holochain', lairRoot, allowedOrigins = DEFAULT_ALLOWED_ORIGINS }) {
  lairRoot ||= `${dataRoot}/ks`;
  if (!/^(\*|[a-zA-Z0-9._:\/-]+(,[a-zA-Z0-9._:\/-]+)*)$/.test(allowedOrigins)) throw new Error(`bad allowed origins "${allowedOrigins}"`);
  const line = holochainLine(generation.holochain);
  const host = generation.bootstrap.url.replace(/^https:\/\//, '').replace(/\/+$/, '');
  const yamlStr = (s) => JSON.stringify(String(s));
  const lines = [
    '# Rendered by the Flowsta node agent from the signed manifest. Edits here are overwritten.',
    `# generation: ${generation.id} (Holochain ${generation.holochain})`,
    'admin_interfaces:',
    '- driver:',
    '    type: websocket',
    `    port: ${generation.conductor.admin_port}`,
    '    danger_bind_addr: null',
    // The admin interface answers the agent and the API, not any local page
    // (`*` did, until 2026-10-25); operators list more with CONDUCTOR_ALLOWED_ORIGINS.
    `    allowed_origins: ${yamlStr(allowedOrigins)}`,
    '',
    'network:',
    `  bootstrap_url: ${yamlStr(`https://${host}`)}`,
  ];
  if (line === '0.6') {
    lines.push(`  signal_url: ${yamlStr(`wss://${host}`)}`);
    lines.push(`  relay_url: ${yamlStr(`https://${host}./`)}`);
  } else {
    lines.push(`  relay_url: ${yamlStr(`https://${host}./`)}`);
    lines.push('  request_timeout_s: 60');
  }
  if (authBootstrap) lines.push(`  base64_auth_material_bootstrap: ${yamlStr(authBootstrap)}`);
  if (authRelay) lines.push(`  base64_auth_material_relay: ${yamlStr(authRelay)}`);
  lines.push('  report: !json_lines', '    days_retained: 30', '    fetched_op_interval_s: 300', '');
  lines.push(`data_root_path: ${yamlStr(dataRoot)}`, '');
  lines.push('keystore:', '  type: lair_server_in_proc', `  lair_root: ${yamlStr(lairRoot)}`, '');
  if (line !== '0.6') lines.push('db_sync_level: Normal', '');
  lines.push(`tracing_override: ${yamlStr(tracing)}`, '');
  return lines.join('\n');
}

/** Pull what a node's existing hand-written config carried that the manifest does not know. */
export function carryOverFromConfig(yamlText) {
  const grab = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm').exec(yamlText || '');
    return m ? m[1].trim() : undefined;
  };
  return {
    authBootstrap: grab('base64_auth_material_bootstrap'),
    authRelay: grab('base64_auth_material_relay'),
    tracing: grab('tracing_override'),
    dataRoot: grab('data_root_path')?.replace(/^'|'$/g, ''),
    lairRoot: grab('lair_root')?.replace(/^'|'$/g, ''),
  };
}

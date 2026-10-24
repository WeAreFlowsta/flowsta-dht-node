/**
 * Canonical JSON: the one byte sequence a JSON value has, so a hash or a
 * signature over it means the same thing to the signer and every verifier.
 * Object keys sorted, no whitespace, numbers as JSON prints them; `undefined`
 * members dropped (as JSON.stringify does).
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

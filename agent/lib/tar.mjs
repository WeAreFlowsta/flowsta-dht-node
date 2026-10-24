/** A one-file ustar archive, for Docker's PUT /containers/{id}/archive. */
export function tarOfFile(name, content, { mode = 0o644, mtime = Math.floor(Date.now() / 1000) } = {}) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  const put = (str, offset, length) => header.write(str, offset, length, 'ascii');
  const oct = (n, length) => n.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);           // uid
  put(oct(0, 8), 116, 8);           // gid
  put(oct(data.length, 12), 124, 12);
  put(oct(mtime, 12), 136, 12);
  put('        ', 148, 8);          // checksum placeholder (spaces)
  put('0', 156, 1);                 // regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024, 0)]);
}

/** Read a ustar/pax archive (as Docker's GET archive returns) into { name: Buffer }. */
export function filesOfTar(buf) {
  const files = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.toString('ascii', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const prefix = header.toString('ascii', 345, 500).replace(/\0.*$/, '');
    off += 512;
    if (type === '0' || type === '\0') files[prefix ? `${prefix}/${name}` : name] = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

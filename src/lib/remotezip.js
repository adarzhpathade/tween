'use strict';
// Read single files out of a .zip that lives on a web server, using HTTP Range requests.
// This lets onboarding take the ~20 MB it needs (one exe, a dll, a few model folders)
// out of an 800 MB release archive instead of downloading the whole thing.
// Falls back to null when the server ignores Range; the caller then downloads in full.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

async function resolveUrl(url) {
  // GitHub release links redirect to short-lived signed URLs. Resolve once, reuse for ranges.
  const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
  try { await r.body?.cancel(); } catch { /* ignore */ }
  if (r.status !== 206) return { url: r.url, ranges: false, size: Number(r.headers.get('content-length')) || 0 };
  const total = Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
  return { url: r.url, ranges: total > 0, size: total };
}

async function range(src, start, end) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(src.url, { headers: { Range: `bytes=${start}-${end}` } });
    if (r.status === 206) return Buffer.from(await r.arrayBuffer());
    try { await r.body?.cancel(); } catch { /* ignore */ }
    if (r.status === 403 || r.status === 410) { Object.assign(src, await resolveUrl(src.orig)); continue; } // signed URL expired
    throw new Error(`Range request failed (HTTP ${r.status})`);
  }
  throw new Error('Range request failed after retries');
}

function zip64Extra(extra, e) {
  for (let p = 0; p + 4 <= extra.length;) {
    const id = extra.readUInt16LE(p), len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      if (e.size === 0xffffffff) { e.size = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (e.csize === 0xffffffff) { e.csize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (e.offset === 0xffffffff) { e.offset = Number(extra.readBigUInt64LE(q)); }
    }
    p += 4 + len;
  }
}

/** Open a remote zip. Returns null if the server does not support Range requests. */
async function open(url) {
  const src = { orig: url, ...(await resolveUrl(url)) };
  if (!src.ranges) return null;
  const tailLen = Math.min(src.size, 65557 + 20);
  const tail = await range(src, src.size - tailLen, src.size - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record)');
  let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
    if (loc < 0) throw new Error('Zip64 locator missing');
    const z64off = Number(tail.readBigUInt64LE(loc + 8));
    const z = await range(src, z64off, z64off + 55);
    count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
  }
  const cd = await range(src, cdOff, cdOff + cdSize - 1);
  const entries = [];
  for (let p = 0, i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt central directory');
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const e = {
      name: cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/'),
      method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
    };
    zip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), e);
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function extract(entry, dest) {
    if (entry.name.endsWith('/')) { fs.mkdirSync(dest, { recursive: true }); return; }
    const lh = await range(src, entry.offset, entry.offset + 29);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
    const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = entry.csize ? await range(src, start, start + entry.csize - 1) : Buffer.alloc(0);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
    if (data.length !== entry.size) throw new Error(`Size mismatch for ${entry.name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.part', data);
    fs.renameSync(dest + '.part', dest);
  }

  return { entries, size: src.size, extract };
}

module.exports = { open };

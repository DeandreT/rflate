import test from 'node:test';
import assert from 'node:assert/strict';
import { r, f, zlib, samples, same, concat, chunks, text, bytes, throwsCode } from './helpers.mjs';

const pairs = [
  ['Deflate', 'Inflate', zlib.inflateRawSync, 'inflateSync'],
  ['Gzip', 'Gunzip', zlib.gunzipSync, 'gunzipSync'],
  ['Zlib', 'Unzlib', zlib.inflateSync, 'unzlibSync'],
];

const runStream = (S, opts, parts, extra) => {
  const out = [];
  let finals = 0;
  const s = opts ? new S(opts, (d, fin) => { out.push(d); finals += fin; }) : new S((d, fin) => { out.push(d); finals += fin; });
  if (extra) extra(s);
  parts.forEach((p, i) => s.push(p, i == parts.length - 1));
  if (!parts.length) s.push(new Uint8Array(0), true);
  assert.equal(finals, 1, 'exactly one final callback');
  return concat(out);
};

test('compression streams with random chunking decode everywhere', () => {
  for (const [name, data] of Object.entries(samples())) {
    for (const [C, D, node, fd] of pairs) {
      for (const level of [0, 1, 6, 9]) {
        const c = runStream(r[C], { level, mtime: 0 }, chunks(data, 40000));
        const msg = `${name} ${C} level ${level}`;
        same(new Uint8Array(node(c)), data, msg);
        same(f[fd](c), data, msg + ' (fflate)');
        same(runStream(r[D], null, chunks(c, 3000)), data, msg + ' (rflate stream)');
        same(runStream(r.Decompress, null, chunks(c, 3000)), data, msg + ' (Decompress)');
      }
    }
  }
});

test('decompression streams accept fflate output byte by byte', () => {
  const data = text(5000);
  for (const [C, D] of pairs) {
    const c = f[C.toLowerCase() + 'Sync'](data);
    const parts = Array.from(c, b => new Uint8Array([b]));
    same(runStream(r[D], null, parts), data, D);
  }
});

test('flush makes pushed data decodable, sync flush aligns to bytes', () => {
  const data = text(30000);
  for (const [C, , , ] of pairs) {
    for (const sync of [false, true]) {
      const out = [];
      const s = new r[C]({ mtime: 0 }, d => out.push(d));
      s.push(data.subarray(0, 10000));
      s.flush(sync);
      const prefix = concat(out);
      if (sync) {
        // A sync flush ends with the empty stored block 00 00 ff ff.
        same(prefix.subarray(-4), new Uint8Array([0, 0, 0xff, 0xff]), C);
        const inf = C == 'Deflate' ? zlib.inflateRawSync : C == 'Gzip' ? zlib.gunzipSync : zlib.inflateSync;
        same(new Uint8Array(inf(prefix, { finishFlush: zlib.constants.Z_SYNC_FLUSH })), data.subarray(0, 10000), C + ' prefix');
      }
      s.push(data.subarray(10000), true);
      const all = concat(out);
      same(f.decompressSync(all), data, `${C} flush(${sync})`);
    }
  }
});

test('streaming dictionaries', () => {
  const dictionary = text(10000), data = text(20000);
  for (const [C, D] of [['Deflate', 'Inflate'], ['Zlib', 'Unzlib']]) {
    const c = runStream(r[C], { dictionary }, chunks(data));
    same(runStream(r[D], { dictionary }, chunks(c, 100)), data, C);
    same(f[D == 'Inflate' ? 'inflateSync' : 'unzlibSync'](c, { dictionary }), data, C + ' (fflate)');
  }
});

test('multi-member gzip streams and onmember offsets', () => {
  const a = text(3000), b = bytes(500), c = text(9000);
  const members = [zlib.gzipSync(a), r.gzipSync(b), f.gzipSync(c)];
  const all = concat(members);
  for (const max of [1, 7, 300, 100000]) {
    const offsets = [];
    const out = runStream(r.Gunzip, null, chunks(all, max), s => { s.onmember = o => offsets.push(o); });
    same(out, concat([a, b, c]), 'chunk ' + max);
    assert.deepEqual(offsets, [members[0].length, members[0].length + members[1].length]);
  }
});

test('stream errors match fflate', () => {
  for (const [C, D] of pairs) {
    throwsCode(() => new r[C]().push(new Uint8Array(1)), 5);
    throwsCode(() => new r[D]().push(new Uint8Array(1)), 5);
    const s = new r[C](() => {});
    s.push(new Uint8Array(10), true);
    throwsCode(() => s.push(new Uint8Array(1)), 4);
    const c = r[C.toLowerCase() + 'Sync'](text(20000));
    const d = new r[D](() => {});
    throwsCode(() => d.push(c.subarray(0, c.length >> 1), true), 0);
    const d2 = new r[D](() => {});
    d2.push(c, true);
    throwsCode(() => d2.push(c), 4);
  }
  throwsCode(() => new r.Gunzip(() => {}).push(new Uint8Array(20).fill(7)), 6);
  throwsCode(() => new r.Unzlib(() => {}).push(new Uint8Array(20).fill(7)), 6);
});

test('stream output never aliases WebAssembly memory or caller buffers', () => {
  const data = text(100000);
  const outs = [];
  const s = new r.Deflate(d => outs.push(d));
  const buf = new Uint8Array(1000);
  for (let i = 0; i < data.length; i += 1000) {
    buf.set(data.subarray(i, i + 1000));
    s.push(buf.subarray(0, Math.min(1000, data.length - i)), i + 1000 >= data.length);
  }
  for (const o of outs) assert.equal(o.byteOffset, 0), assert.equal(o.buffer.byteLength, o.length);
  same(zlib.inflateRawSync(concat(outs)), data);
  // The Inflate stream must copy pending input it keeps between pushes.
  const g = r.gzipSync(data), parts = [], scratch = new Uint8Array(10);
  const gs = new r.Gunzip(d => parts.push(d));
  for (let i = 0; i < g.length; i += 10) {
    scratch.set(g.subarray(i, i + 10));
    gs.push(scratch.subarray(0, Math.min(10, g.length - i)), i + 10 >= g.length);
    scratch.fill(0);
  }
  same(concat(parts), data);
});

test('many abandoned streams do not exhaust memory', () => {
  const data = text(50000);
  for (let i = 0; i < 3000; i++) {
    new r.Deflate(() => {}).push(data);
    new r.Inflate(() => {}).push(r.deflateSync(data).subarray(0, 1000));
    if (global.gc && i % 200 == 0) global.gc();
  }
});

test('Gunzip delivers each member before announcing the next, and data before errors', () => {
  const a = text(3000), b = text(4000);
  const all = concat([r.gzipSync(a), r.gzipSync(b)]);
  const events = [];
  const s = new r.Gunzip((d, fin) => events.push(['data', d.length, fin]));
  s.onmember = o => events.push(['member', o]);
  s.push(all, true);
  const mi = events.findIndex(e => e[0] == 'member');
  const before = events.slice(0, mi).reduce((n, e) => n + e[1], 0);
  assert.equal(before, a.length, 'all of member A precedes onmember(B)');
  assert.equal(events.filter(e => e[2]).length, 1);
  // trailing garbage after a member: the member's data arrives, then the error
  let got = 0;
  const g = new r.Gunzip(d => { got += d.length; });
  throwsCode(() => g.push(concat([r.gzipSync(a), new Uint8Array([1, 2, 3, 4, 5, 6])]), true), 6);
  assert.equal(got, a.length);
});

test('chunks larger than the 1 MiB slice size', () => {
  const data = text(3 << 20);
  for (const [C, D] of pairs) {
    const c = runStream(r[C], { mtime: 0 }, [data.subarray(0, 2500000), data.subarray(2500000)]);
    same(f.decompressSync(c), data, C);
    same(runStream(r[D], null, [c]), data, D);
  }
});

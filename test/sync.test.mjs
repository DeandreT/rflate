import test from 'node:test';
import assert from 'node:assert/strict';
import { r, f, zlib, samples, same, text, bytes, throwsCode } from './helpers.mjs';

const formats = [
  { c: 'deflateSync', d: 'inflateSync', node: zlib.inflateRawSync, fc: 'deflateSync' },
  { c: 'gzipSync', d: 'gunzipSync', node: zlib.gunzipSync, fc: 'gzipSync' },
  { c: 'zlibSync', d: 'unzlibSync', node: zlib.inflateSync, fc: 'zlibSync' },
];

test('exports match fflate', () => {
  assert.deepEqual(Object.keys(r).sort(), Object.keys(f).sort());
  for (const k of Object.keys(f)) {
    assert.equal(typeof r[k], typeof f[k], k);
    if (typeof f[k] == 'function' && f[k].prototype) {
      const own = o => Object.keys(o).filter(m => !/^[a-z]$/.test(m)).sort();
      assert.deepEqual(own(r[k].prototype), own(f[k].prototype), k + ' public methods');
    }
  }
  assert.deepEqual(r.FlateErrorCode, f.FlateErrorCode);
  assert.equal(r.compressSync, r.gzipSync);
  assert.equal(r.Compress, r.Gzip);
});

test('round trips with every level, cross-checked against fflate and node:zlib', () => {
  for (const [name, data] of Object.entries(samples())) {
    for (const fm of formats) {
      for (const level of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, undefined]) {
        const opts = level === undefined ? undefined : { level };
        const c = r[fm.c](data, opts);
        const msg = `${name} ${fm.c} level ${level}`;
        same(r[fm.d](c), data, msg);
        same(f[fm.d](c), data, msg + ' (fflate decode)');
        same(new Uint8Array(fm.node(c)), data, msg + ' (zlib decode)');
        same(r.decompressSync(c), data, msg + ' (auto)');
        same(r[fm.d](f[fm.fc](data, opts)), data, msg + ' (decode fflate output)');
      }
    }
  }
});

test('mem option at every value', () => {
  const data = text(100000);
  for (let mem = 0; mem <= 12; mem++) {
    for (const level of [1, 6, 9]) same(zlib.inflateRawSync(r.deflateSync(data, { level, mem })), data, `mem ${mem}`);
  }
});

test('compression ratio is in line with fflate', () => {
  const data = text(500000);
  for (const level of [1, 6, 9]) {
    const ours = r.deflateSync(data, { level }).length, theirs = f.deflateSync(data, { level }).length;
    assert.ok(ours < theirs * 1.1, `level ${level}: ${ours} vs fflate ${theirs}`);
  }
});

test('dictionaries interoperate with fflate and node:zlib', () => {
  const dictionary = text(20000), data = text(5000);
  for (const [c, d] of [['deflateSync', 'inflateSync'], ['zlibSync', 'unzlibSync']]) {
    const ours = r[c](data, { dictionary }), theirs = f[c](data, { dictionary });
    same(r[d](ours, { dictionary }), data);
    same(f[d](ours, { dictionary }), data);
    same(r[d](theirs, { dictionary }), data);
    assert.ok(ours.length < r[c](data).length, 'dictionary should help');
  }
  same(new Uint8Array(zlib.inflateSync(r.zlibSync(data, { dictionary }), { dictionary })), data);
  same(new Uint8Array(zlib.inflateRawSync(r.deflateSync(data, { dictionary }), { dictionary })), data);
  // zlib headers mark dictionary use
  throwsCode(() => r.unzlibSync(r.zlibSync(data, { dictionary })), 6);
  throwsCode(() => r.unzlibSync(r.zlibSync(data), { dictionary }), 6);
  const big = text(70000);
  same(r.inflateSync(r.deflateSync(data, { dictionary: big }), { dictionary: big }), data, '>32K dictionary uses its tail');
});

test('gzip header matches fflate byte for byte', () => {
  const data = text(1000);
  for (const opts of [{}, { filename: 'hello.txt', mtime: 1700000000000 }, { mtime: 0, level: 9 }, { level: 1, mtime: '2020-01-01' }, { level: 0, mtime: new Date(0) }]) {
    const o = { mtime: 1234567890000, ...opts };
    const ours = r.gzipSync(data, o), theirs = f.gzipSync(data, o);
    const hl = 10 + (o.filename ? o.filename.length + 1 : 0);
    same(ours.subarray(0, hl), theirs.subarray(0, hl), JSON.stringify(o));
    same(ours.subarray(-8), theirs.subarray(-8), 'trailer');
  }
});

test('zlib header and trailer match fflate', () => {
  const data = text(3000), dictionary = text(500);
  for (const o of [{}, { level: 0 }, { level: 1 }, { level: 9 }, { dictionary }]) {
    const ours = r.zlibSync(data, o), theirs = f.zlibSync(data, o);
    const hl = o.dictionary ? 6 : 2;
    same(ours.subarray(0, hl), theirs.subarray(0, hl));
    same(ours.subarray(-4), theirs.subarray(-4));
  }
});

test('out option fills or truncates like fflate', () => {
  const data = text(10000), c = r.deflateSync(data);
  const big = new Uint8Array(20000);
  const res = r.inflateSync(c, { out: big });
  assert.equal(res.buffer, big.buffer);
  same(res, data);
  const small = new Uint8Array(100);
  const t = r.inflateSync(c, { out: small });
  assert.equal(t.buffer, small.buffer);
  same(t, data.subarray(0, 100));
  same(r.gunzipSync(r.gzipSync(data), { out: new Uint8Array(10000) }), data);
  same(r.unzlibSync(r.zlibSync(data), { out: new Uint8Array(10000) }), data);
  same(r.decompressSync(r.zlibSync(data), { out: new Uint8Array(10000) }), data);
  assert.equal(r.inflateSync(new Uint8Array(0)).length, 0);
  assert.equal(r.inflateSync(c, { out: new Uint8Array(0) }).length, 0);
});

test('gunzipSync uses ISIZE like fflate (first member only)', () => {
  const a = text(1000), b = text(2000);
  const two = Buffer.concat([zlib.gzipSync(a), zlib.gzipSync(b)]);
  same(r.gunzipSync(two), f.gunzipSync(two));
});

test('errors match fflate codes', () => {
  const data = text(50000);
  for (const fm of formats) {
    const c = r[fm.c](data);
    throwsCode(() => r[fm.d](c.subarray(0, c.length >> 1)), 0);
    throwsCode(() => f[fm.d](c.subarray(0, c.length >> 1)), 0);
  }
  throwsCode(() => r.inflateSync(new Uint8Array([0xff, 0xff, 0xff])), 1);
  throwsCode(() => f.inflateSync(new Uint8Array([0xff, 0xff, 0xff])), 1);
  // a stored block whose length check fails, then a reserved block type
  throwsCode(() => r.inflateSync(new Uint8Array([0x07])), 1);
  throwsCode(() => r.gunzipSync(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), 6);
  throwsCode(() => r.unzlibSync(new Uint8Array([1, 2, 3, 4, 5, 6, 7])), 6);
  const e = throwsCode(() => r.gunzipSync(new Uint8Array(4)), 6);
  assert.equal(e.message, 'invalid gzip data');
  assert.ok(e instanceof Error);
});

test('corrupt input never crashes the engine', () => {
  const data = text(20000);
  const c = r.deflateSync(data);
  for (let i = 0; i < 400; i++) {
    const x = c.slice();
    for (let k = 0; k < 4; k++) x[(Math.random() * x.length) | 0] ^= 1 << (k & 7);
    try { r.inflateSync(x); } catch (e) { assert.ok(e.code >= 0 && e.code <= 3, e.message); }
    try { r.inflateSync(bytes(1 + (i * 37) % 300)); } catch (e) { assert.ok(e.code >= 0 && e.code <= 3, e.message); }
  }
  // the engine still works afterwards
  same(r.inflateSync(c), data);
});

test('large input (40 MiB) round trip', () => {
  const data = new Uint8Array(40 << 20);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 27;
  same(r.gunzipSync(r.gzipSync(data, { level: 1 })), data);
});

test('UTF-8 helpers match fflate', () => {
  const strs = ['', 'abc', 'héllo wörld', '日本語テキスト', '😀 emoji \u{1F680}', 'x'.repeat(100000) + '€'];
  for (const s of strs) {
    same(r.strToU8(s), f.strToU8(s));
    assert.equal(r.strFromU8(r.strToU8(s)), s);
    same(r.strToU8(s, true), f.strToU8(s, true));
    assert.equal(r.strFromU8(f.strToU8(s, true), true), f.strFromU8(f.strToU8(s, true), true));
  }
  const invalid = new Uint8Array([0xff, 0xfe, 0xfd, 0xc3]);
  assert.equal(r.strFromU8(invalid), f.strFromU8(invalid));
});

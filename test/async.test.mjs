import test from 'node:test';
import assert from 'node:assert/strict';
import { r, f, zlib, same, concat, chunks, text, bytes, cb } from './helpers.mjs';

const fns = [
  ['deflate', 'inflate', 'inflateSync'],
  ['gzip', 'gunzip', 'gunzipSync'],
  ['zlib', 'unzlib', 'unzlibSync'],
];

test('async one-shot functions run in workers and match sync results', async () => {
  const data = text(300000);
  for (const [c, d, fd] of fns) {
    const comp = await cb(k => r[c](data, { level: 9, mtime: 0 }, k));
    same(f[fd](comp), data, c);
    same(await cb(k => r[d](comp, k)), data, d);
    same(await cb(k => r[d](comp, { size: data.length }, k)), data, d + ' size');
    same(await cb(k => r.decompress(comp, k)), data, 'decompress ' + c);
    same(r.decompressSync(await cb(k => r[c](data, k))), data, c + ' default opts');
  }
  const dictionary = text(8000);
  const dc = await cb(k => r.deflate(data, { dictionary }, k));
  same(await cb(k => r.inflate(dc, { dictionary }, k)), data, 'dictionary');
});

test('async errors and terminate', async () => {
  const c = r.deflateSync(text(100000));
  await assert.rejects(cb(k => r.inflate(c.subarray(0, 100), k)), e => e.code === 0);
  await assert.rejects(cb(k => r.gunzip(new Uint8Array(30).fill(1), k)), e => e.code === 6);
  assert.throws(() => r.deflate(c), e => e.code === 7);
  let called = false;
  const term = r.deflate(bytes(5 << 20), () => { called = true; });
  term();
  await new Promise(res => setTimeout(res, 300));
  assert.equal(called, false);
});

test('consume transfers the input buffer', async () => {
  const data = text(100000), copy = data.slice();
  const out = await cb(k => r.gzip(data, { consume: true }, k));
  assert.equal(data.length, 0);
  same(zlib.gunzipSync(out), copy);
});

const asyncPairs = [
  ['AsyncDeflate', 'AsyncInflate', zlib.inflateRawSync],
  ['AsyncGzip', 'AsyncGunzip', zlib.gunzipSync],
  ['AsyncZlib', 'AsyncUnzlib', zlib.inflateSync],
];

const runAsync = (S, opts, parts, extra) => new Promise((resolve, reject) => {
  const out = [];
  const s = new S(opts || {}, (err, d, fin) => {
    if (err) return reject(err);
    out.push(d);
    if (fin) resolve({ out: concat(out), s });
  });
  if (extra) extra(s);
  parts.forEach((p, i) => s.push(p.slice(), i == parts.length - 1));
});

test('async streams round trip and report drain', async () => {
  const data = text(400000);
  for (const [C, D, node] of asyncPairs) {
    let drained = 0;
    const { out: c } = await runAsync(r[C], { level: 6 }, chunks(data, 50000), s => { s.ondrain = n => { drained += n; }; });
    same(new Uint8Array(node(c)), data, C);
    assert.equal(drained > 0, true, C + ' ondrain');
    const { out, s } = await runAsync(r[D], null, chunks(c, 7000));
    same(out, data, D);
    assert.ok(s.queuedSize >= 0);
    same((await runAsync(r.AsyncDecompress, null, chunks(c, 7000))).out, data, 'AsyncDecompress ' + C);
  }
});

test('async stream flush', async () => {
  const data = text(20000);
  const got = [];
  await new Promise((resolve, reject) => {
    const s = new r.AsyncGzip({ mtime: 0 }, (err, d, fin) => {
      if (err) return reject(err);
      got.push(d);
      if (got.length == 1) s.push(data.slice(10000), true);
      if (fin) resolve();
    });
    s.push(data.slice(0, 10000));
    s.flush(true);
  });
  same(zlib.gunzipSync(concat(got)), data);
});

test('AsyncGunzip onmember', async () => {
  const a = zlib.gzipSync(text(3000)), b = zlib.gzipSync(text(4000));
  const offsets = [];
  await runAsync(r.AsyncGunzip, null, chunks(concat([a, b]), 500), s => { s.onmember = o => offsets.push(o); });
  assert.deepEqual(offsets, [a.length]);
});

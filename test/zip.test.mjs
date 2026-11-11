import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { r, f, same, concat, chunks, text, bytes, cb } from './helpers.mjs';

const tree = () => ({
  'readme.md': text(5000),
  'random.bin': bytes(200000),
  'big.txt': [text(600000), { level: 9 }],
  'stored.txt': [text(3000), { level: 0 }],
  'empty': new Uint8Array(0),
  'ünïcødé ✓.txt': [text(100), { comment: 'naïve comment', mtime: new Date('2001-02-03T04:05:06') }],
  dir: { nested: { 'deep.json': text(20000) }, 'x.txt': [text(10), { extra: { 0xCAFE: new Uint8Array([1, 2, 3]) }, os: 3, attrs: 0o644 << 16 }] },
});
const mtime = new Date('2020-05-06T07:08:10');

const check = (unz, expect, msg) => {
  const flat = {};
  const walk = (o, p) => {
    for (const k in o) {
      const v = o[k];
      if (v instanceof Uint8Array) flat[p + k] = v;
      else if (Array.isArray(v)) {
        if (v[0] instanceof Uint8Array) flat[p + k] = v[0];
        else walk(v[0], p + k + '/');
      } else walk(v, p + k + '/');
    }
  };
  walk(expect, '');
  for (const k in flat) same(unz[k], flat[k], `${msg}: ${k}`);
};

test('zipSync output is readable by fflate, and fflate zips by rflate', () => {
  const t = tree();
  const z = r.zipSync(t, { mtime });
  check(f.unzipSync(z), t, 'fflate reads rflate');
  check(r.unzipSync(f.zipSync(t, { mtime })), t, 'rflate reads fflate');
  check(r.unzipSync(z), t, 'rflate reads rflate');
});

test('stored zips are byte-identical to fflate', () => {
  const t = { a: text(1000), b: { c: bytes(5000) }, 'd é.txt': [text(10), { comment: 'hi', os: 3 }] };
  same(r.zipSync(t, { level: 0, mtime }), f.zipSync(t, { level: 0, mtime }));
});

test('zip central directory metadata matches fflate', () => {
  const t = tree();
  const infos = z => {
    const out = [];
    r.unzipSync(z, { filter: i => { out.push(i); return false; } });
    return out.map(({ name, originalSize, compression }) => ({ name, originalSize, compression }));
  };
  assert.deepEqual(infos(r.zipSync(t, { mtime })), infos(f.zipSync(t, { mtime })));
  const z = r.zipSync(t, { mtime }), zf = f.zipSync(t, { mtime });
  // local header of the first file: everything but sizes matches
  same(z.subarray(0, 18), zf.subarray(0, 18));
});

test('system unzip accepts rflate archives', (t) => {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { return t.skip('unzip not installed'); }
  const dir = mkdtempSync(join(tmpdir(), 'rflate-zip-'));
  try {
    const file = join(dir, 'a.zip');
    writeFileSync(file, r.zipSync(tree(), { mtime }));
    execFileSync('unzip', ['-tq', file]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('async zip/unzip', async () => {
  const t = tree();
  const z = await cb(k => r.zip(t, { mtime }, k));
  check(f.unzipSync(z), t, 'async zip');
  check(await cb(k => r.unzip(z, k)), t, 'async unzip');
  const names = [];
  const filtered = await cb(k => r.unzip(z, { filter: i => (names.push(i.name), i.name.endsWith('.txt')) }, k));
  assert.ok(names.length > 5);
  assert.ok(Object.keys(filtered).every(n => n.endsWith('.txt')));
});

test('streaming Zip with every input type, read back with streaming Unzip', async () => {
  const files = { 'a.txt': text(300000), 'b.bin': bytes(70000), 'c.txt': text(500), 'd.txt': text(80000) };
  const parts = [];
  const archive = await new Promise((resolve, reject) => {
    const zip = new r.Zip((err, d, fin) => {
      if (err) return reject(err);
      parts.push(d);
      if (fin) resolve(concat(parts));
    });
    const a = new r.ZipDeflate('a.txt', { level: 9 });
    const b = new r.ZipPassThrough('b.bin');
    const c = new r.AsyncZipDeflate('c.txt');
    const d = new r.ZipDeflate('d.txt');
    for (const x of [a, b, c, d]) zip.add(x);
    for (const [s, n] of [[a, 'a.txt'], [b, 'b.bin'], [c, 'c.txt'], [d, 'd.txt']]) {
      const ch = chunks(files[n], 20000);
      ch.forEach((p, i) => s.push(p.slice(), i == ch.length - 1));
    }
    zip.end();
  });
  same(f.unzipSync(archive)['a.txt'], files['a.txt']);
  for (const Dec of ['UnzipInflate', 'AsyncUnzipInflate']) {
    const got = {};
    await new Promise((resolve, reject) => {
      let pending = 0, ended = false;
      const unz = new r.Unzip(file => {
        pending++;
        const out = [];
        file.ondata = (err, d, fin) => {
          if (err) return reject(err);
          out.push(d);
          if (fin) { got[file.name] = concat(out); if (!--pending && ended) resolve(); }
        };
        file.start();
      });
      unz.register(r[Dec]);
      for (const p of chunks(archive, 9000)) unz.push(p);
      unz.push(new Uint8Array(0), true);
      ended = true;
      if (!pending) resolve();
    });
    for (const n in files) same(got[n], files[n], `${Dec} ${n}`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const check = async L => {
  const data = new TextEncoder().encode('build check '.repeat(3000));
  assert.deepEqual(L.gunzipSync(L.gzipSync(data)), data);
  const out = await new Promise((res, rej) => L.zlib(data, (e, d) => (e ? rej(e) : res(d))));
  assert.deepEqual(L.unzlibSync(out), data);
};

test('esm/index.mjs', async () => check(await import('../esm/index.mjs')));
test('lib/index.cjs', async () => check(require('../lib/index.cjs')));
test('lib/node.cjs', async () => check(require('../lib/node.cjs')));
test('umd/index.js', async () => check(require('../umd/index.js')));
test('package exports resolve', async () => {
  const pkg = require('../package.json');
  for (const f of ['./esm/index.mjs', './esm/browser.js', './lib/node.cjs', './lib/browser.cjs', './lib/index.cjs', './umd/index.js', './lib/index.d.ts', './esm/index.d.mts', './lib/node.d.cts']) {
    assert.ok(require('node:fs').existsSync(new URL(f, new URL('../', import.meta.url))), f);
  }
});

test('minified UMD async streams (workers rebuild classes from minified source)', async () => {
  const L = require('../umd/index.js');
  const data = new TextEncoder().encode('stream check '.repeat(20000));
  for (const [C, D] of [['AsyncDeflate', 'AsyncInflate'], ['AsyncGzip', 'AsyncGunzip'], ['AsyncZlib', 'AsyncUnzlib']]) {
    const run = (S, input) => new Promise((res, rej) => {
      const out = [];
      const s = new L[S]((e, d, fin) => { if (e) return rej(e); out.push(d); if (fin) res(Buffer.concat(out)); });
      s.push(input.slice(0, 1000));
      s.push(input.slice(1000), true);
    });
    const c = await run(C, data);
    assert.deepEqual(new Uint8Array(await run(D, new Uint8Array(c))), data, C);
  }
  const z = await new Promise((res, rej) => L.zip({ a: data, b: [data, { level: 9 }] }, (e, d) => (e ? rej(e) : res(d))));
  const u = await new Promise((res, rej) => L.unzip(z, (e, d) => (e ? rej(e) : res(d))));
  assert.deepEqual(u.b, data);
});

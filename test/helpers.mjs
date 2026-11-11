import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
export const r = require('../lib/node.cjs');
export const f = require('fflate');
export const zlib = require('node:zlib');

let seed = 0x2545f491;
export function rand() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return seed >>> 0;
}
export function bytes(n, alphabet = 256) {
  const o = new Uint8Array(n);
  for (let i = 0; i < n; i++) o[i] = rand() % alphabet;
  return o;
}
export function text(n) {
  const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'rflate', 'zlib',
    'compression', '{"id":', '"name":', 'null', 'true', '\n', '  ', 'héllo', 'wörld', '日本'];
  let s = '';
  while (s.length < n) s += words[rand() % words.length] + (rand() & 1 ? ' ' : '');
  return new TextEncoder().encode(s).subarray(0, n);
}
export const samples = () => ({
  empty: new Uint8Array(0),
  one: new Uint8Array([42]),
  small: text(100),
  text: text(200000),
  random: bytes(70000),
  lowEntropy: bytes(150000, 4),
  zeros: new Uint8Array(300000),
  longRun: new TextEncoder().encode('hello world '.repeat(20000)),
});
export const same = (a, b, msg) => {
  assert.ok(a instanceof Uint8Array, 'not a Uint8Array');
  assert.equal(a.length, b.length, msg);
  assert.ok(Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length)), msg);
};
export const concat = chunks => {
  const n = chunks.reduce((a, c) => a + c.length, 0), o = new Uint8Array(n);
  let p = 0;
  for (const c of chunks) o.set(c, p), p += c.length;
  return o;
};
// split into random-size chunks (including empty ones)
export const chunks = (data, max = 5000) => {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const n = rand() % 7 == 0 ? 0 : 1 + rand() % max;
    out.push(data.subarray(i, i + n)), i += n;
  }
  return out;
};
export const throwsCode = (fn, code) => {
  let e;
  try { fn(); } catch (x) { e = x; }
  assert.ok(e, 'expected an error');
  assert.equal(e.code, code, `expected code ${code}, got ${e.code}: ${e.message}`);
  return e;
};
export const cb = fn => new Promise((resolve, reject) => fn((err, data) => err ? reject(err) : resolve(data)));

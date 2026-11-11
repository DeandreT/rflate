// Node benchmark: rflate versus fflate on every public operation.
// Usage: node --expose-gc bench/run.mjs [corpus-dir] [out.json]
// Without a corpus directory only synthetic inputs are used. bench/corpus.mjs
// downloads the pinned Canterbury and large corpora.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { cases, datasets, run } from './cases.mjs';

const require = createRequire(import.meta.url);
const [corpusDir, outFile = 'bench/results-node.json'] = process.argv.slice(2);
const rflate = require('../lib/node.cjs'), fflate = require('fflate');
const corpus = {};
if (corpusDir) for (const n of readdirSync(corpusDir).sort()) corpus[n] = new Uint8Array(readFileSync(join(corpusDir, n)));
const sets = datasets(corpus);

// Cold start: fresh processes that load the library and compress+decompress 1 KiB.
const cold = {};
for (const [name, path] of [['rflate', '../lib/node.cjs'], ['fflate', 'fflate']]) {
  const code = `const t0=performance.now();const L=require(${JSON.stringify(require.resolve(path))});const t1=performance.now();` +
    `const d=new TextEncoder().encode('x'.repeat(1024));L.gunzipSync(L.gzipSync(d));const t2=performance.now();` +
    `console.log(JSON.stringify([t1-t0,t2-t1]))`;
  const runs = [];
  for (let i = 0; i < 15; i++) runs.push(JSON.parse(execFileSync(process.execPath, ['-e', code]).toString()));
  const med = k => runs.map(r => r[k]).sort((a, b) => a - b)[7];
  cold[name] = { loadMs: med(0), firstCallMs: med(1) };
}
console.log('cold start', cold);

const list = cases(rflate, sets);
const res = run({ rflate, fflate }, list, { now: () => performance.now(), gc: global.gc, log: m => console.log(m, 'load', os.loadavg()[0].toFixed(1)) });
res.cold = cold;
res.environment = { runtime: `node ${process.version}`, cpu: os.cpus()[0].model, date: new Date().toISOString(), loadAvg: os.loadavg() };
writeFileSync(outFile, JSON.stringify(res));
console.log('wrote', outFile);

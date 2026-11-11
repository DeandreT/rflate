// Benchmark cases shared by the Node and browser runners. Each case runs the
// same public API call against rflate and fflate.
let seed = 0x19283746;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const enc = new TextEncoder();

export function json(target) {
  const records = [];
  let bytes = 2;
  for (let i = 0; bytes < target; i++) {
    const s = JSON.stringify({ id: i, account: `account-${random() % 1000}`, active: !!(random() & 1),
      status: ['pending', 'complete', 'cancelled', 'processing'][random() % 4], quantity: random() % 100,
      amount: (random() % 100000) / 100, description: `Item ${random() % 10000} in category ${random() % 25}` });
    if (bytes + s.length + 1 > target && records.length) break;
    records.push(s), bytes += s.length + 1;
  }
  return enc.encode(`[${records.join(',')}]`);
}

export function datasets(corpus) {
  seed = 0x19283746;
  const rnd = new Uint8Array(1 << 20);
  for (let i = 0; i < rnd.length; i++) rnd[i] = random() & 255;
  return [
    ['json-128B', json(128)], ['json-1KiB', json(1024)], ['json-16KiB', json(16384)], ['json-1MiB', json(1 << 20)],
    ['random-1MiB', rnd],
    ...Object.entries(corpus),
  ];
}

const chunked = (data, size) => {
  const out = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  if (!out.length) out.push(data);
  return out;
};
const streamAll = (S, opts, parts) => {
  let n = 0, last;
  const s = new S(opts, (d) => { n += d.length; last = d; });
  for (let i = 0; i < parts.length; i++) s.push(parts[i], i == parts.length - 1);
  return { length: n, 0: last ? last[0] : 0 };
};

// Returns [{ group, name, bytes, run(lib) }]
export function cases(lib, sets, { full = true } = {}) {
  const out = [];
  for (const [name, data] of sets) {
    const deflated = lib.deflateSync(data, { level: 6 }), gz = lib.gzipSync(data, { mtime: '2020-01-01' }), zl = lib.zlibSync(data);
    const add = (group, run) => out.push({ group, name, bytes: data.length, run });
    for (const level of [1, 6, 9]) add(`deflateSync L${level}`, L => L.deflateSync(data, { level }));
    add('inflateSync', L => L.inflateSync(deflated));
    add('gzipSync', L => L.gzipSync(data, { mtime: '2020-01-01' }));
    add('gunzipSync', L => L.gunzipSync(gz));
    if (!full) continue;
    add('zlibSync', L => L.zlibSync(data));
    add('unzlibSync', L => L.unzlibSync(zl));
    if (data.length >= 65536) {
      const small = chunked(data, 4096), large = chunked(data, 65536), defParts = chunked(deflated, 4096), tiny = chunked(gz, 512);
      add('Deflate stream 64K chunks', L => streamAll(L.Deflate, { level: 6 }, large));
      add('Deflate stream 4K chunks', L => streamAll(L.Deflate, { level: 6 }, small));
      add('Inflate stream 4K chunks', L => streamAll(L.Inflate, {}, defParts));
      add('Gunzip stream 512B chunks', L => streamAll(L.Gunzip, {}, tiny));
    }
  }
  if (full) {
    const files = {};
    for (const [name, data] of sets) files[name] = data;
    const total = Object.values(files).reduce((a, d) => a + d.length, 0);
    const zipped = lib.zipSync(files, { mtime: '2020-01-01' });
    out.push({ group: 'zipSync', name: 'all datasets', bytes: total, run: L => L.zipSync(files, { mtime: '2020-01-01' }) });
    out.push({ group: 'unzipSync', name: 'all datasets', bytes: total, run: L => L.unzipSync(zipped) });
  }
  return out;
}

const median = v => { const a = [...v].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

export function run(libs, list, { rounds = 5, minMs = 50, now, gc, log = () => {} }) {
  let sink = 0;
  const sample = (fn, ms) => {
    let n = 0;
    const t0 = now();
    do { const r = fn(); sink ^= r.length ^ (r[0] | 0); n++; } while (now() - t0 < ms);
    return (now() - t0) / n;
  };
  const jobs = [];
  for (const c of list) for (const [lib, L] of Object.entries(libs)) jobs.push({ ...c, lib, fn: () => c.run(L), samples: [] });
  for (const j of jobs) sample(j.fn, minMs / 2);
  for (let r = 0; r < rounds; r++) {
    for (let i = jobs.length - 1; i > 0; i--) { const k = random() % (i + 1); [jobs[i], jobs[k]] = [jobs[k], jobs[i]]; }
    for (const j of jobs) { if (gc) gc(); j.samples.push(sample(j.fn, minMs)); }
    log(`round ${r + 1}/${rounds}`);
  }
  return { sink, results: jobs.map(({ fn, run, ...j }) => ({ ...j, ms: median(j.samples) })) };
}

// Markdown table of rflate's speedup over fflate per operation and runtime.
// Usage: node bench/table.mjs Node=results-node.json Chromium=results-chromium.json ...
import { readFileSync } from 'node:fs';

const cols = process.argv.slice(2).map(a => {
  const [name, file] = a.split('=');
  const by = {};
  for (const r of JSON.parse(readFileSync(file, 'utf8')).results) ((by[r.group] ||= {})[r.name] ||= {})[r.lib] = r.ms;
  return { name, by };
});
const geo = v => Math.exp(v.reduce((a, x) => a + Math.log(x), 0) / v.length);
const groups = [...new Set(cols.flatMap(c => Object.keys(c.by)))];
const order = g => ['deflateSync', 'inflateSync', 'gzipSync', 'gunzipSync', 'zlibSync', 'unzlibSync', 'Deflate', 'Inflate', 'Gunzip', 'zipSync', 'unzipSync']
  .findIndex(p => g.startsWith(p));
groups.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
console.log(`| Operation | ${cols.map(c => c.name).join(' | ')} |`);
console.log(`|---|${cols.map(() => '---:').join('|')}|`);
for (const g of groups) {
  const cells = cols.map(c => {
    if (!c.by[g]) return '–';
    const r = Object.values(c.by[g]).map(v => v.fflate / v.rflate);
    const lo = Math.min(...r);
    return `${geo(r).toFixed(1)}×` + (r.length > 1 ? ` (min ${lo.toFixed(2)}×)` : '');
  });
  console.log(`| \`${g}\` | ${cells.join(' | ')} |`);
}

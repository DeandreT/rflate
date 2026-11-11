// Prints rflate's speedup over fflate per operation (geometric mean over inputs).
// Usage: node bench/summary.mjs results.json [--detail]
import { readFileSync } from 'node:fs';

const [file, detail] = process.argv.slice(2);
const data = JSON.parse(readFileSync(file, 'utf8'));
const by = {};
for (const r of data.results) ((by[r.group] ||= {})[r.name] ||= {})[r.lib] = r.ms;
const geo = v => Math.exp(v.reduce((a, x) => a + Math.log(x), 0) / v.length);
const rows = [];
for (const [group, names] of Object.entries(by)) {
  const ratios = Object.entries(names).map(([n, v]) => [n, v.fflate / v.rflate]);
  const worst = ratios.reduce((a, b) => (b[1] < a[1] ? b : a));
  rows.push({ group, speedup: geo(ratios.map(r => r[1])).toFixed(2), worst: `${worst[0]} ${worst[1].toFixed(2)}`, n: ratios.length });
  if (detail) for (const [n, x] of ratios) console.log(`  ${group.padEnd(28)} ${n.padEnd(28)} ${x.toFixed(2)}x`);
}
console.table(rows);
if (data.cold) console.log('cold start (ms):', JSON.stringify(data.cold));
if (data.environment) console.log(JSON.stringify(data.environment));

// Downloads the Canterbury and large corpora from a pinned public mirror and
// verifies them against the mirror's SHA1SUM files.
// Usage: node bench/corpus.mjs <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node bench/corpus.mjs <dir>');
const base = 'https://raw.githubusercontent.com/pfalcon/canterbury-corpus/c380ef9dc1dc62691757fdfeebdc2f85710e1e46';
mkdirSync(dir, { recursive: true });
for (const group of ['canterbury', 'large']) {
  const sums = await (await fetch(`${base}/${group}/SHA1SUM`)).text();
  for (const line of sums.split('\n').filter(Boolean)) {
    const [sha1, name] = line.trim().split(/\s+/);
    const data = new Uint8Array(await (await fetch(`${base}/${group}/${name}`)).arrayBuffer());
    if (createHash('sha1').update(data).digest('hex') != sha1) throw new Error('checksum mismatch: ' + name);
    writeFileSync(join(dir, `${group}__${name}`), data);
    console.log(group, name, data.length);
  }
}

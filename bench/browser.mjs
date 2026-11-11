// Runs bench/browser.html in headless Chromium and/or Firefox and saves results.
// Usage: node bench/browser.mjs <corpus-dir> <out-prefix> [chromium] [firefox]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [corpusDir, prefix, ...browsers] = process.argv.slice(2);
const names = readdirSync(corpusDir).sort();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

for (const browser of browsers.length ? browsers : ['chromium', 'firefox']) {
  let done;
  const finished = new Promise(r => (done = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method == 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => { res.end('ok'); done(JSON.parse(body)); });
      return;
    }
    if (url.pathname == '/corpus-list') return res.end(JSON.stringify(names));
    let file;
    if (url.pathname.startsWith('/corpus/')) file = join(corpusDir, normalize(url.pathname.slice(8)).replace(/^(\.\.[/\\])+/, ''));
    else if (url.pathname.startsWith('/bench/') || url.pathname.startsWith('/umd/') || url.pathname.startsWith('/node_modules/fflate/umd/'))
      file = join(root, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file || !existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/bench/browser.html`;
  const profile = mkdtempSync(join(tmpdir(), `rflate-${browser}-`));
  // Never attach to the desktop session.
  const env = { ...process.env };
  for (const k of ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY']) delete env[k];
  const args = browser == 'firefox'
    ? ['--headless', '--no-remote', '--profile', profile, url]
    : ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--user-data-dir=${profile}`, url];
  const proc = spawn(browser, args, { env, stdio: 'ignore' });
  const timer = setTimeout(() => done({ error: 'timeout' }), 30 * 60 * 1000);
  const result = await finished;
  clearTimeout(timer);
  proc.kill('SIGTERM');
  server.close();
  await new Promise(r => setTimeout(r, 1000));
  rmSync(profile, { recursive: true, force: true });
  writeFileSync(`${prefix}-${browser}.json`, JSON.stringify(result));
  console.log(browser, result.error || 'ok');
}

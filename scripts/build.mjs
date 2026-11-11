// Builds the WebAssembly core and the JavaScript package outputs.
// Adapted from fflate's scripts/rewriteBuilds.ts and scripts/buildUMD.ts (MIT).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => join(root, ...parts);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

// 1. WebAssembly core. Set RFLATE_TARGET_DIR to keep Cargo output elsewhere.
const targetDir = process.env.RFLATE_TARGET_DIR || p('rust', 'target');
const simd = process.env.RFLATE_SIMD !== '0';
run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', p('rust', 'Cargo.toml')], {
  env: {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    RUSTFLAGS: [process.env.RUSTFLAGS, simd && '-C target-feature=+simd128'].filter(Boolean).join(' '),
  },
});
const wasm = readFileSync(join(targetDir, 'wasm32-unknown-unknown', 'release', 'rflate_wasm.wasm'));
const imports = WebAssembly.Module.imports(new WebAssembly.Module(wasm));
if (imports.length) throw new Error('unexpected WebAssembly imports: ' + JSON.stringify(imports));
const b64 = wasm.toString('base64');
const embed = s => {
  if (!s.includes("'__RFLATE_WASM__'")) throw new Error('missing WebAssembly placeholder');
  return s.replace("'__RFLATE_WASM__'", () => `'${b64}'`);
};

// 2. TypeScript
for (const d of ['lib', 'esm', 'umd']) rmSync(p(d), { recursive: true, force: true });
const tsc = p('node_modules', '.bin', 'tsc');
run(tsc, []);
run(tsc, ['--project', 'tsconfig.esm.json']);

// 3. Rewrite into the fflate package layout
const atClass = /\/\*\* \@class \*\//g, pure = '/*#__PURE__*/';
const esModule = /(exports\.__esModule = true;|Object\.defineProperty\(exports, "__esModule", { value: true }\);)\n/;
const libDir = p('lib'), esmDir = p('esm');
const lib = embed(readFileSync(join(libDir, 'index.js'), 'utf-8')
  .replace(atClass, pure)
  .replace(esModule, '')
  .replace(/exports\.(.*) = void 0;\n/, ''));
const libTypes = readFileSync(join(libDir, 'index.d.ts'), 'utf-8');
const esm = embed(readFileSync(join(esmDir, 'index.js'), 'utf-8').replace(atClass, pure));
const wk = readFileSync(join(esmDir, 'worker.js'), 'utf-8'),
      nwk = readFileSync(join(esmDir, 'node-worker.js'), 'utf-8');
writeFileSync(join(libDir, 'worker.cjs'), readFileSync(join(libDir, 'worker.js'), 'utf-8').replace(esModule, ''));
writeFileSync(join(libDir, 'node-worker.cjs'), readFileSync(join(libDir, 'node-worker.js'), 'utf-8').replace(esModule, ''));
for (const f of ['index.js', 'worker.js', 'node-worker.js']) unlinkSync(join(esmDir, f));
for (const f of ['index.js', 'worker.js', 'node-worker.js', 'index.d.ts', 'worker.d.ts', 'node-worker.d.ts']) unlinkSync(join(libDir, f));
const workerImport = /import (.*?) from '\.\/node-worker';/;
const workerRequire = /var (.*?) = require\("\.\/node-worker"\);/;
const defaultExport = /export default/;
const sub = (src, re, fn) => {
  if (!re.test(src)) throw new Error('worker import not found');
  return src.replace(re, fn);
};
writeFileSync(join(esmDir, 'index.mjs'), "import { createRequire } from 'module';\nvar require = createRequire('/');\n" +
  sub(esm, workerImport, name => nwk.replace(defaultExport, `var ${name.slice(7, name.indexOf(' ', 8))} =`)));
writeFileSync(join(esmDir, 'index.d.mts'), libTypes);
writeFileSync(join(esmDir, 'browser.js'), sub(esm, workerImport, name => wk.replace(defaultExport, `var ${name.slice(7, name.indexOf(' ', 8))} =`)));
writeFileSync(join(esmDir, 'browser.d.ts'), libTypes);
writeFileSync(join(libDir, 'node.cjs'), sub(lib, workerRequire, name => {
  name = name.slice(4, name.indexOf(' ', 5));
  return nwk.replace(defaultExport, `var ${name} = {};\n${name}["default"] =`);
}));
writeFileSync(join(libDir, 'node.d.cts'), libTypes);
writeFileSync(join(libDir, 'browser.cjs'), sub(lib, workerRequire, name => {
  name = name.slice(4, name.indexOf(' ', 5));
  return wk.replace(defaultExport, `var ${name} = {};\n${name}["default"] =`);
}));
writeFileSync(join(libDir, 'browser.d.cts'), libTypes);
writeFileSync(join(libDir, 'index.cjs'), sub(lib, workerRequire, name => `var ${name.slice(4, name.indexOf(' ', 5))} = require("./node-worker.cjs");`));
writeFileSync(join(libDir, 'index.d.ts'), libTypes);

// 4. UMD
const opts = { mangle: { toplevel: true }, compress: { passes: 5, unsafe: true, pure_getters: true }, sourceMap: false };
const src = readFileSync(join(libDir, 'index.cjs'), 'utf8');
const out = await minify(src, opts);
const wkrOut = (await minify(readFileSync(join(libDir, 'worker.cjs'), 'utf8'), opts)).code
  .replace(/exports.__esModule=!0;/, '').replace(/exports\./g, '_f.');
const nodeWkrOut = (await minify(readFileSync(join(libDir, 'node-worker.cjs'), 'utf8'), opts)).code
  .replace(/exports.__esModule=!0;/, '');
const umd = "!function(f){typeof module!='undefined'&&typeof exports=='object'?module.exports=f():typeof define!='undefined'&&define.amd?define(f):(typeof self!='undefined'?self:this).rflate=f()}(function(){var _e={};" +
  out.code.replace(/exports\.(.*) = void 0;\n/, '').replace(/exports\./g, '_e.').replace(/require\("\.\/node-worker\.cjs"\)/,
    () => "(typeof module!='undefined'&&typeof exports=='object'?function(_f){" + nodeWkrOut + 'return _f}:function(_f){' + wkrOut + 'return _f})({})'
  ) + 'return _e});';
if (!existsSync(p('umd'))) mkdirSync(p('umd'));
writeFileSync(p('umd', 'index.js'), umd);
console.log(`built: wasm ${wasm.length} bytes (simd ${simd}), umd ${umd.length} bytes`);

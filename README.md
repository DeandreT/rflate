# rflate

[fflate](https://github.com/101arrowz/fflate)'s API with a Rust DEFLATE engine compiled to WebAssembly.

rflate keeps fflate's exports, options, stream classes, async (worker) functions, error codes and ZIP support, and swaps the JavaScript compressor and decompressor for [zlib-rs](https://github.com/trifectatechfoundation/zlib-rs). In benchmarks it is 2.5–10× faster than fflate across operations in Node, Chromium and Firefox, and compresses at least as well at every level.

```js
import { gzipSync, gunzipSync, zipSync, unzip, strToU8 } from 'rflate';

const packed = gzipSync(strToU8('hello '.repeat(1000)), { level: 6 });
const text = gunzipSync(packed);
```

Code written for fflate works unchanged: replace `'fflate'` with `'rflate'` in your imports. fflate's documentation applies to every function and class.

## Install

rflate is not on npm yet. Install it from GitHub, which builds it from source (needs Rust and the `wasm32-unknown-unknown` target):

```sh
npm install github:DeandreT/rflate
```

## Benchmarks

| Operation | Node | Chromium | Firefox |
|---|---:|---:|---:|
| `deflateSync L1` | 3.2× (min 1.49×) | 3.7× (min 1.08×) | 3.4× (min 1.55×) |
| `deflateSync L6` | 2.9× (min 1.72×) | 2.9× (min 1.54×) | 2.5× (min 1.25×) |
| `deflateSync L9` | 3.0× (min 0.94×) | 2.8× (min 1.17×) | 2.6× (min 1.27×) |
| `inflateSync` | 5.9× (min 1.48×) | 5.2× (min 1.55×) | 5.1× (min 1.80×) |
| `gzipSync` | 3.0× (min 1.22×) | 3.2× (min 1.30×) | 2.7× (min 1.27×) |
| `gunzipSync` | 3.8× (min 0.70×) | 3.3× (min 1.24×) | 2.6× (min 0.96×) |
| `zlibSync` | 3.1× (min 1.44×) | – | – |
| `unzlibSync` | 5.7× (min 1.46×) | – | – |
| `Deflate stream 4K chunks` | 3.4× (min 1.43×) | – | – |
| `Deflate stream 64K chunks` | 3.4× (min 1.44×) | – | – |
| `Inflate stream 4K chunks` | 10.2× (min 3.16×) | – | – |
| `Gunzip stream 512B chunks` | 10.2× (min 3.45×) | – | – |
| `zipSync` | 2.0× | – | – |
| `unzipSync` | 2.4× | – | – |

Measured on an AMD Ryzen 7 5800X3D with Node 22.23, Chromium 153 and Firefox 156. Each cell is rflate's speedup over fflate 0.8.3: the geometric mean over the inputs (19 for one-shot calls; the 11 of 64 KiB or more for streams), with the slowest single input in parentheses. The inputs are the Canterbury and large corpora, synthetic JSON from 128 B to 1 MiB, and 1 MiB of random bytes. The browser runs cover the six one-shot operations. Timings include copying data into and out of WebAssembly.

The host was shared and heavily loaded during these runs, so single inputs vary by about ±30% between runs. The minimums below 1× (random data for `gunzipSync`, the bible text at level 9) did not reproduce in isolated reruns: level 9 measured 1.2–1.3× faster, and random-data gunzip, which is mostly memory copying, measured 0.6–1.6×, i.e. parity. Loading the library and making the first call takes about as long as fflate's (5–9 ms in Node here).

Run them yourself:

```sh
node bench/corpus.mjs /tmp/corpus                      # downloads and verifies the corpora
npm run bench -- /tmp/corpus bench/results-node.json
node bench/summary.mjs bench/results-node.json --detail
node bench/browser.mjs /tmp/corpus bench/results chromium firefox
```

## Differences from fflate

- **Size.** The UMD bundle is about 190 kB (80 kB gzipped) against fflate's 33 kB (13 kB gzipped), because it embeds a 122 kB WebAssembly module. Choose fflate when bundle size matters more than speed.
- **Compressed bytes differ.** Output is standard DEFLATE, GZIP, Zlib and ZIP that any decoder reads (the tests check fflate, Node's zlib and `unzip`), but it is not byte-identical to fflate's. Stored (level 0) ZIP files are identical.
- **Compression levels are calibrated.** Each level maps to the zlib-rs level that compresses at least as well as fflate's same level on the Canterbury and large corpora, while running faster: 1→2, 2→3, 3→4, 4→5, 5→6, 6→6, 7→7, 8→7, 9→7. zlib-rs's own level 1 produces about 35% larger output, and its levels 8 and 9 take far longer without compressing better on these corpora. The `mem` option maps to zlib's `memLevel`.
- **Runtime requirements.** WebAssembly with SIMD: Chrome 91, Firefox 89, Safari 16.4, Node 16.4 or newer. The module is compiled synchronously on first use (about 0.4 ms), so the synchronous API works on the main thread.
- **Memory.** Data is copied into WebAssembly memory, which can grow but not shrink. Large inputs are processed in 1 MiB slices, one-shot calls over 16 MiB use a temporary instance, and the shared instance is replaced once it passes 64 MiB while no streams are open, so memory is returned to the garbage collector. Unfinished streams release their state when they are garbage-collected.
- **Content Security Policy.** Pages with a strict CSP need `'wasm-unsafe-eval'` in `script-src`. Async functions also need `worker-src blob:`, as with fflate.
- **Errors.** Error codes and messages follow fflate. An allocation failure inside WebAssembly throws code 99 (`out of memory`). Corrupt stored blocks (a length that fails its check) are rejected, where fflate decodes them anyway.
- **Fixes.** `Decompress` handles streams of 2 bytes or fewer, and the UMD build's async functions work in Node. Both fail in fflate 0.8.3.

## How it works

- `rust/src/lib.rs` is the WebAssembly core: one-shot and streaming DEFLATE on top of zlib-rs, plus CRC-32 and Adler-32. It has no imports.
- `src/index.ts` is generated by `scripts/splice.py` from fflate 0.8.3's source. Only the engine is replaced: the deflate/inflate internals, checksums, the six stream classes (`Deflate`, `Inflate`, `Gzip`, `Gunzip`, `Zlib`, `Unzlib`) and their sync functions. The replacements are in `scripts/engine.ts.txt` and `scripts/streams.ts.txt`. Everything else, including ZIP, UTF-8 and the worker machinery, is fflate's code, so upstream fixes can be merged by re-running the script on a newer fflate checkout.
- Async functions use fflate's workers. Workers receive the compiled `WebAssembly.Module` and instantiate it themselves.
- Incompressible data is stored as raw blocks. Those are copied directly in JavaScript rather than through WebAssembly, which keeps random data at least as fast as fflate.

## Building and testing

Requires Node 18+, Rust 1.95+ and `rustup target add wasm32-unknown-unknown`.

```sh
npm install
npm run build        # set RFLATE_TARGET_DIR to put Cargo output elsewhere
npm test
```

The tests compare rflate with fflate and Node's zlib across every format, level, option, stream, async function and ZIP feature, including corrupt input.

## License

MIT. The JavaScript API layer is derived from fflate by Arjun Barrett (MIT). The engine is zlib-rs (Zlib license) by the Trifecta Tech Foundation.

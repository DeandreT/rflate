// rflate: fflate's API with a Rust/WebAssembly DEFLATE engine (zlib-rs).
// Derived from fflate by Arjun Barrett (MIT). The JavaScript DEFLATE engine below
// was replaced; the comments that follow are fflate's originals.

// DEFLATE is a complex format; to read this code, you should probably check the RFC first:
// https://tools.ietf.org/html/rfc1951
// You may also wish to take a look at the guide I made about this program:
// https://gist.github.com/101arrowz/253f31eb5abc3d9275ab943003ffecad

// Some of the following code is similar to that of UZIP.js:
// https://github.com/photopea/UZIP.js
// However, the vast majority of the codebase has diverged from UZIP.js to increase performance and reduce bundle size.

// Sometimes 0 will appear where -1 would be more appropriate. This is because using a uint
// is better for memory in most engines (I *think*).

import wk from './node-worker';

// aliases for shorter compressed code (most minifers don't do this)
const u8 = Uint8Array, u16 = Uint16Array, i32 = Int32Array;

// get end of byte
const shft = (p: number) => ((p + 7) / 8) | 0;

// typed array slice - allows garbage collector to free original reference,
// while being more compatible than .slice
const slc = (v: Uint8Array, s: number, e?: number) => {
  if (s == null || s < 0) s = 0;
  if (e == null || e > v.length) e = v.length;
  // can't use .constructor in case user-supplied
  return new u8(v.subarray(s, e));
}

/**
 * Codes for errors generated within this library
 */
export const FlateErrorCode = {
  UnexpectedEOF: 0,
  InvalidBlockType: 1,
  InvalidLengthLiteral: 2,
  InvalidDistance: 3,
  StreamFinished: 4,
  NoStreamHandler: 5,
  InvalidHeader: 6,
  NoCallback: 7,
  InvalidUTF8: 8,
  ExtraFieldTooLong: 9,
  InvalidDate: 10,
  FilenameTooLong: 11,
  StreamFinishing: 12,
  InvalidZipData: 13,
  UnknownCompressionMethod: 14
} as const;

// error codes
const ec = [
  'unexpected EOF',
  'invalid block type',
  'invalid length/literal',
  'invalid distance',
  'stream finished',
  'no stream handler',
  , // determined by compression function
  'no callback',
  'invalid UTF-8 data',
  'extra field too long',
  'date not in range 1980-2099',
  'filename too long',
  'stream finishing',
  'invalid zip data'
  // determined by unknown compression method
];

/**
 * An error generated within this library
 */
export interface FlateError extends Error {
  /**
   * The code associated with this error
   */
  code: number;
};

const err = (ind: number, msg?: string | 0, nt?: 1) => {
  const e: Partial<FlateError> = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace) Error.captureStackTrace(e, err);
  if (!nt) throw e;
  return e as FlateError;
}

// The DEFLATE engine is Rust (zlib-rs) compiled to WebAssembly. The module is
// embedded as base64 at build time and instantiated synchronously on first use.
const wsrc = '__RFLATE_WASM__';

interface WasmCore {
  memory: WebAssembly.Memory;
  buf(len: number): number;
  out_len(): number;
  consumed(): number;
  err(): number;
  crc32(start: number, len: number): number;
  adler32(start: number, len: number): number;
  deflate_once(level: number, mem: number, mode: number, dictLen: number, len: number): number;
  last_check(): number;
  def_new(level: number, mem: number, mode: number, dictLen: number): number;
  def_push(h: number, len: number, flush: number): number;
  def_check(h: number): number;
  def_free(h: number): void;
  inf_new(dictLen: number): number;
  inf_push(h: number, len: number, final: number): number;
  inf_ended(h: number): number;
  inf_free(h: number): void;
  inflate_once(dictLen: number, len: number, size: number, hint: number): number;
}

// empty
const et = /*#__PURE__*/ new u8(0);

// base64 decode: native decoders when available
const wbd = (s: string) => {
  const U = u8 as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> };
  if (U.fromBase64) return U.fromBase64(s);
  if (typeof Buffer != 'undefined') return new u8(Buffer.from(s, 'base64'));
  const b = atob(s), o = new u8(b.length);
  for (let i = 0; i < b.length; ++i) o[i] = b.charCodeAt(i);
  return o;
}

// Compiled module, sent to workers by structured clone. The instance and the
// cleanup registry live on the module object rather than in free variables: the
// clone drops them, so each worker instantiates its own, and minifiers cannot
// rewrite an existence check into a reference to an undeclared worker variable.
type WasmModule = WebAssembly.Module & { x?: WasmCore, r?: FinalizationRegistry<number> | false };
let wm: WasmModule;

// get the WebAssembly exports, instantiating on first use
const wx = (): WasmCore => {
  if (!wm) wm = new WebAssembly.Module(wbd(wsrc));
  if (!wm.x) {
    const x = wm.x = new WebAssembly.Instance(wm, {}).exports as unknown as WasmCore;
    // frees stream state that was never finished (positive: deflate, negative: inflate)
    wm.r = typeof FinalizationRegistry != 'undefined' && new FinalizationRegistry((h: number) => {
      if (h > 0) x.def_free(h);
      else x.inf_free(-h);
    });
  }
  return wm.x;
}

// One-shot calls on very large data run in a throwaway instance, so its memory is
// garbage-collected afterwards instead of staying reserved by the shared instance
// (WebAssembly memory can grow but never shrink).
const wbig = (n: number) => n > 16777216 ? (wx(), new WebAssembly.Instance(wm, {}).exports as unknown as WasmCore) : wx();

// copy one or two arrays into the WebAssembly scratch buffer
const wput = (x: WasmCore, a: Uint8Array, b?: Uint8Array) => {
  const al = a.length, n = al + (b ? b.length : 0);
  const ptr = x.buf(n), m = new u8(x.memory.buffer, ptr, n);
  m.set(a);
  if (b) m.set(b, al);
}

// copy WebAssembly output into a new array with pre/post padding
const wget = (x: WasmCore, p: number, pre: number, post: number) => {
  if (!p) err(x.err());
  const n = x.out_len(), o = new u8(pre + n + post);
  o.set(new u8(x.memory.buffer, p, n), pre);
  return o;
}

const wreg = (o: object, h: number) => {
  if (wm.r) wm.r.register(o, h, o);
}
const wunreg = (o: object) => {
  if (wm.r) wm.r.unregister(o);
}

// concatenate
const cat = (a: Uint8Array, b: Uint8Array) => {
  const n = new u8(a.length + b.length);
  n.set(a), n.set(b, a.length);
  return n;
}

// byte swap (big-endian Adler-32 written with wbytes)
const bsw = (v: number) => (v & 255) << 24 | (v & 0xFF00) << 8 | (v >>> 8 & 0xFF00) | (v >>> 24);

// Incompressible data is mostly stored blocks. Copying those directly in JS avoids
// three passes through WebAssembly memory; only the blocks after them go to the
// engine. isc returns [input offset after the leading stored blocks, their output
// size, whether the last of them was final].
const isc = (dat: Uint8Array) => {
  const l = dat.length;
  let p = 0, n = 0, f = 0;
  while (!f && p + 5 <= l && !(dat[p] & 6)) {
    const len = dat[p + 1] | dat[p + 2] << 8;
    if ((len ^ (dat[p + 3] | dat[p + 4] << 8)) != 65535 || p + 5 + len > l) break;
    f = dat[p] & 1, n += len, p += 5 + len;
  }
  return [p, n, f];
}

// copies output bytes [k, k + o.length) of the stored blocks in dat[0, e) into o
const icp = (dat: Uint8Array, e: number, o: Uint8Array, k: number) => {
  let w = 0;
  for (let p = 0, q = 0; p < e && w < o.length; ) {
    const len = dat[p + 1] | dat[p + 2] << 8;
    if (q + len > k) {
      const s = Math.max(k - q, 0), c = Math.min(len - s, o.length - w);
      o.set(dat.subarray(p + 5 + s, p + 5 + s + c), w);
      w += c;
    }
    q += len, p += 5 + len;
  }
  return w;
}

// one-shot inflate. out: buffer to fill (truncates), sz: known output size (truncates)
const inflt = (dat: Uint8Array, out?: Uint8Array, dict?: Uint8Array, sz?: number) => {
  if (!dat.length || (out && !out.length) || sz === 0) return out || new u8(0);
  const cap = out ? out.length : sz || 0, x = wbig(Math.max(dat.length, cap));
  const [p, n, f] = dat[0] & 6 ? [0, 0, 0] : isc(dat);
  let d = dict ? dict.subarray(-32768) : et;
  if (p) {
    if (f || (cap && n >= cap)) {
      const o = out || new u8(cap ? Math.min(n, cap) : n), w = icp(dat, p, o, 0);
      return out ? out.subarray(0, w) : o;
    }
    // the rest of the stream may refer back into the stored data
    const h = new u8(Math.min(n, 32768));
    icp(dat, p, h, n - h.length);
    d = h.length < 32768 && d.length ? cat(d.subarray(h.length - 32768), h) : h;
  }
  wput(x, d, p ? dat.subarray(p) : dat);
  const q = x.inflate_once(d.length, dat.length - p, cap ? cap - n : 0, 0);
  if (!q) err(x.err());
  const t = x.out_len(), o = out || new u8(n + t);
  o.set(new u8(x.memory.buffer, q, t), n);
  if (p) icp(dat, p, o, 0);
  return out ? out.subarray(0, n + t) : o;
}

// crc check
type CRCV = {
  p(d: Uint8Array): void;
  d(): number;
};

// CRC32 table
const crct = /*#__PURE__*/ (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; ++i) {
    let c = i, k = 9;
    while (--k) c = ((c & 1) && -306674912) ^ (c >>> 1);
    t[i] = c;
  }
  return t;
})();

// CRC32
const crc = (): CRCV => {
  let c = 0;
  return {
    p(d) {
      if (d.length < 64) {
        let cr = ~c;
        for (let i = 0; i < d.length; ++i) cr = crct[(cr & 255) ^ d[i]] ^ (cr >>> 8);
        c = ~cr;
      } else {
        const x = wx();
        wput(x, d);
        c = x.crc32(c, d.length);
      }
    },
    d() { return c; }
  }
}

// Adler32
const adler = (): CRCV => {
  let a = 1, b = 0;
  return {
    p(d) {
      if (d.length < 64) {
        // closures have awful performance
        let n = a, m = b;
        const l = d.length | 0;
        for (let i = 0; i != l;) {
          const e = Math.min(i + 2655, l);
          for (; i < e; ++i) m += n += d[i];
          n = (n & 65535) + 15 * (n >> 16), m = (m & 65535) + 15 * (m >> 16);
        }
        a = n, b = m;
      } else {
        const x = wx();
        wput(x, d);
        const v = x.adler32(((b % 65521) << 16) | (a % 65521), d.length);
        a = v & 65535, b = v >>> 16;
      }
    },
    d() {
      a %= 65521, b %= 65521;
      return (a & 255) << 24 | (a & 0xFF00) << 8 | (b & 255) << 8 | (b >> 8);
    }
  }
}

/**
 * Options for decompressing a DEFLATE stream
 */
export interface InflateStreamOptions {
  /**
   * The dictionary used to compress the original data. If no dictionary was used during compression, this option has no effect.
   * 
   * Supplying the wrong dictionary during decompression usually yields corrupt output or causes an invalid distance error.
   */
  dictionary?: Uint8Array;
}

/**
 * Options for decompressing DEFLATE data
 */
export interface InflateOptions<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> extends InflateStreamOptions {
  /**
   * The buffer into which to write the decompressed data. Saves memory if you know the decompressed size in advance.
   * 
   * Note that if the decompression result is larger than the size of this buffer, it will be truncated to fit.
   */
  out?: Uint8Array<TArrayBuffer>;
}

/**
 * Options for decompressing a GZIP stream
 */
export interface GunzipStreamOptions extends InflateStreamOptions {}

/**
 * Options for decompressing GZIP data
 */
export interface GunzipOptions<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> extends InflateStreamOptions {
  /**
   * The buffer into which to write the decompressed data. GZIP already encodes the output size, so providing this doesn't save memory.
   * 
   * Note that if the decompression result is larger than the size of this buffer, it will be truncated to fit.
   */
  out?: Uint8Array<TArrayBuffer>;
}

/**
 * Options for decompressing a Zlib stream
 */
export interface UnzlibStreamOptions extends InflateStreamOptions {}

/**
 * Options for decompressing Zlib data
 */
export interface UnzlibOptions<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> extends InflateOptions<TArrayBuffer> {}

/**
 * Options for compressing data into a DEFLATE format
 */
export interface DeflateOptions {
  /**
   * The level of compression to use, ranging from 0-9.
   * 
   * 0 will store the data without compression.
   * 1 is fastest but compresses the worst, 9 is slowest but compresses the best.
   * The default level is 6.
   * 
   * Typically, binary data benefits much more from higher values than text data.
   * In both cases, higher values usually take disproportionately longer than the reduction in final size that results.
   * 
   * For example, a 1 MB text file could:
   * - become 1.01 MB with level 0 in 1ms
   * - become 400 kB with level 1 in 10ms
   * - become 320 kB with level 9 in 100ms
   */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /**
   * The memory level to use, ranging from 0-12. Increasing this increases speed and compression ratio at the cost of memory.
   * 
   * Note that this is exponential: while level 0 uses 8 kB, level 4 uses 128 kB, level 8 uses 2 MB, and level 12 uses 32 MB.
   * It is recommended not to lower the value below 4, since that tends to hurt performance.
   * In addition, values above 8 tend to help very little on most data and can even hurt performance.
   * 
   * The default value is automatically determined based on the size of the input data.
   */
  mem?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  /**
   * A buffer containing common byte sequences in the input data that can be used to significantly improve compression ratios.
   * 
   * Dictionaries should be 32kB or smaller and include strings or byte sequences likely to appear in the input.
   * The decompressor must supply the same dictionary as the compressor to extract the original data.
   * 
   * Dictionaries only improve aggregate compression ratio when reused across multiple small inputs. They should typically not be used otherwise.
   * 
   * Avoid using dictionaries with GZIP and ZIP to maximize software compatibility.
   */
  dictionary?: Uint8Array;
};

/**
 * Options for compressing data into a GZIP format
 */
export interface GzipOptions extends DeflateOptions {
  /**
   * When the file was last modified. Defaults to the current time.
   * Set this to 0 to avoid revealing a modification date entirely.
   */
  mtime?: Date | string | number;
  /**
   * The filename of the data. If the `gunzip` command is used to decompress the data, it will output a file
   * with this name instead of the name of the compressed file.
   */
  filename?: string;
}

/**
 * Options for compressing data into a Zlib format
 */
export interface ZlibOptions extends DeflateOptions {}

/**
 * Handler for data (de)compression streams
 * @param data The data output from the stream processor
 * @param final Whether this is the final block
 */
export type FlateStreamHandler = (data: Uint8Array<ArrayBuffer>, final: boolean) => void;

/**
 * Handler for asynchronous data (de)compression streams
 * @param err Any error that occurred
 * @param data The data output from the stream processor
 * @param final Whether this is the final block
 */
export type AsyncFlateStreamHandler = (err: FlateError | null, data: Uint8Array<ArrayBuffer>, final: boolean) => void;

/**
 * Handler for the asynchronous completion of (de)compression for a data chunk
 * @param size The number of bytes that were processed. This is measured in terms of the input
 * (i.e. compressed bytes for decompression, uncompressed bytes for compression.)
 */
export type AsyncFlateDrainHandler = (size: number) => void;

/**
 * Callback for asynchronous (de)compression methods
 * @param err Any error that occurred
 * @param data The resulting data. Only present if `err` is null
 */
export type FlateCallback = (err: FlateError | null, data: Uint8Array<ArrayBuffer>) => void;

// async callback-based compression
interface AsyncOptions {
  /**
   * Whether or not to "consume" the source data. This will make the typed array/buffer you pass in
   * unusable but will increase performance and reduce memory usage.
   */
  consume?: boolean;
}

/**
 * Options for compressing data asynchronously into a DEFLATE format
 */
export interface AsyncDeflateOptions extends DeflateOptions, AsyncOptions {}

/**
 * Options for decompressing DEFLATE data asynchronously
 */
export interface AsyncInflateOptions extends AsyncOptions, InflateStreamOptions {
  /**
   * The original size of the data. Currently, the asynchronous API disallows
   * writing into a buffer you provide; the best you can do is provide the
   * size in bytes and be given back a new typed array.
   */
  size?: number;
}

/**
 * Options for compressing data asynchronously into a GZIP format
 */
export interface AsyncGzipOptions extends GzipOptions, AsyncOptions {}

/**
 * Options for decompressing GZIP data asynchronously
 */
export interface AsyncGunzipOptions extends AsyncOptions, InflateStreamOptions {}

/**
 * Options for compressing data asynchronously into a Zlib format
 */
export interface AsyncZlibOptions extends ZlibOptions, AsyncOptions {}

/**
 * Options for decompressing Zlib data asynchronously
 */
export interface AsyncUnzlibOptions extends AsyncInflateOptions {}

/**
 * A terminable compression/decompression process
 */
export interface AsyncTerminable {
  /**
   * Terminates the worker thread immediately. The callback will not be called.
   */
  (): void;
}

// deflate with opts. mode 1/2 also computes the CRC32/Adler32 of dat into ck[0]
const dopt = (dat: Uint8Array, opt: DeflateOptions, pre: number, post: number, mode?: number, ck?: number[]) => {
  const x = wbig(dat.length), dict = opt.dictionary ? opt.dictionary.subarray(-32768) : et;
  wput(x, dict, dat);
  const r = wget(x, x.deflate_once(opt.level == null ? 6 : opt.level, opt.mem == null ? -1 : opt.mem, mode || 0, dict.length, dat.length), pre, post);
  if (ck) ck[0] = x.last_check();
  return r;
}
  

// Walmart object spread
const mrg = <A, B>(a: A, b: B) => {
  const o = {} as Record<string, unknown>;
  for (const k in a) o[k] = a[k];
  for (const k in b) o[k] = b[k];
  return o as A & B;
}

// worker clone

// This is possibly the craziest part of the entire codebase, despite how simple it may seem.
// The only parameter to this function is a closure that returns an array of variables outside of the function scope.
// We're going to try to figure out the variable names used in the closure as strings because that is crucial for workerization.
// We will return an object mapping of true variable name to value (basically, the current scope as a JS object).
// The reason we can't just use the original variable names is minifiers mangling the toplevel scope.

// This took me three weeks to figure out how to do.
const wcln = (fn: () => unknown[], fnStr: string, td: Record<string, unknown>) => {
  const dt = fn();
  const st = fn.toString();
  const ks = st.slice(st.indexOf('[') + 1, st.lastIndexOf(']')).replace(/\s+/g, '').split(',');
  for (let i = 0; i < dt.length; ++i) {
    let v = dt[i], k = ks[i];
    if (typeof v == 'function') {
      fnStr += ';' + k + '=';
      const st = v.toString();
      if (v.prototype) {
        // for global objects
        if (st.indexOf('[native code]') != -1) {
          const spInd = st.indexOf(' ', 8) + 1;
          fnStr += st.slice(spInd, st.indexOf('(', spInd));
        } else {
          fnStr += st;
          for (const t in v.prototype) fnStr += ';' + k + '.prototype.' + t + '=' + v.prototype[t].toString();
        }
      } else fnStr += st;
    } else td[k] = v;
  }
  return fnStr;
}

type CachedWorker = {
  // code
  c: string;
  // extra
  e: Record<string, unknown>
};

const ch: CachedWorker[] = [];
// clone bufs
const cbfs = (v: Record<string, unknown>) => {
  const tl: ArrayBuffer[] = [];
  for (const k in v) {
    if ((v[k] as Uint8Array).buffer) {
      tl.push((v[k] = new (v[k].constructor as typeof u8)(v[k] as Uint8Array)).buffer);
    }
  }
  return tl;
}

// use a worker to execute code
const wrkr = <T, R>(fns: (() => unknown[])[], init: (ev: MessageEvent<T>) => void, id: number, cb: (err: FlateError, msg: R) => void) => {
  wx();
  if (!ch[id]) {
    let fnStr = '', td: Record<string, unknown> = {}, m = fns.length - 1;
    for (let i = 0; i < m; ++i)
      fnStr = wcln(fns[i], fnStr, td);
    ch[id] = { c: wcln(fns[m], fnStr, td), e: td };
  }
  const td = mrg({}, ch[id].e);
  return wk(ch[id].c + ';onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage=' + init.toString() + '}', id, td, cbfs(td), cb);
}

// base async inflate fn
const bInflt = () => [u8, et, ec, err, slc, wm, wx, wbig, wput, wget, wreg, wunreg, cat, isc, icp, inflt, inflateSync, pbf, gopt];
const bDflt = () => [u8, et, ec, err, slc, wm, wx, wbig, wput, wget, wreg, wunreg, dopt, deflateSync, pbf];

// gzip extra
const gze = () => [gzh, gzhl, wbytes, crc, crct];
// gunzip extra
const guze = () => [gzs, gzl, cat];
// zlib extra
const zle = () => [zlh, wbytes, adler, bsw];
// unzlib extra
const zule = () => [zls, cat];

// post buf
const pbf = (msg: Uint8Array) => (postMessage as Worker['postMessage'])(msg, [msg.buffer]);

// get opts
const gopt = (o?: AsyncInflateOptions) => o && {
  out: o.size && new u8(o.size),
  dictionary: o.dictionary
};

// async helper
const cbify = <T extends AsyncOptions>(dat: Uint8Array, opts: T, fns: (() => unknown[])[], init: (ev: MessageEvent<[Uint8Array, T]>) => void, id: number, cb: FlateCallback) => {
  const w = wrkr<[Uint8Array, T], Uint8Array<ArrayBuffer>>(
    fns,
    init,
    id,
    (err, dat) => {
      w.terminate();
      cb(err, dat);
    }
  );
  w.postMessage([dat, opts], opts.consume ? [dat.buffer as ArrayBuffer] : []);
  return () => { w.terminate(); };
}

type CmpDecmpStrm = Inflate | Deflate | Gzip | Gunzip | Zlib | Unzlib;

// auto stream
const astrm = (strm: CmpDecmpStrm) => {
  strm.ondata = (dat, final) => (postMessage as Worker['postMessage'])([dat, final], [dat.buffer]);
  return (ev: MessageEvent<[Uint8Array, boolean] | [0, boolean | undefined]>) => {
    if (ev.data[0]) {
      strm.push(ev.data[0], ev.data[1]);
      (postMessage as Worker['postMessage'])([ev.data[0].length]);
    } else (strm as Deflate | Gzip | Zlib).flush(ev.data[1])
  }
}

type Astrm = { ondata: AsyncFlateStreamHandler; push: (d: Uint8Array, f?: boolean) => void; terminate: AsyncTerminable; flush?: (sync?: boolean) => void; ondrain?: AsyncFlateDrainHandler; queuedSize: number; };

// async stream attach
const astrmify = <T>(fns: (() => unknown[])[], strm: Astrm, opts: T | 0, init: (ev: MessageEvent<T>) => void, id: number, flush: 0 | 1, ext?: (msg: unknown) => unknown) => {
  let t: boolean;
  const w = wrkr<T, [number] | [Uint8Array, boolean]>(
    fns,
    init,
    id,
    (err, dat) => {
      if (err) w.terminate(), strm.ondata.call(strm, err);
      else if (!Array.isArray(dat)) ext(dat);
      else if (dat.length == 1) {
        strm.queuedSize -= dat[0];
        if (strm.ondrain) strm.ondrain(dat[0]);
      } else {
        if (dat[1]) w.terminate();
        strm.ondata.call(strm, err, dat[0], dat[1]);
      }
    }
  )
  w.postMessage(opts);
  strm.queuedSize = 0;
  strm.push = (d, f) => {
    if (!strm.ondata) err(5);
    if (t) strm.ondata(err(4, 0, 1), null, !!f);
    strm.queuedSize += d.length;
    // can fail for cross-realm Uint8Array, but ok - only a small performance penalty
    w.postMessage([d, t = f], d.buffer instanceof ArrayBuffer ? [d.buffer] : []);
  };
  strm.terminate = () => { w.terminate(); };
  if (flush) {
    strm.flush = sync => { w.postMessage([0, sync]); };
  }
}

// read 2 bytes
const b2 = (d: Uint8Array, b: number) => d[b] | (d[b + 1] << 8);

// read 4 bytes
const b4 = (d: Uint8Array, b: number) => (d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0;

// read 8 bytes
const b8 = (d: Uint8Array, b: number) => b4(d, b) + (b4(d, b + 4) * 4294967296);

// write bytes
const wbytes = (d: Uint8Array, b: number, v: number) => {
  for (; v; ++b) d[b] = v, v >>>= 8;
}

// gzip header
const gzh = (c: Uint8Array, o: GzipOptions) => {
  const fn = o.filename;
  c[0] = 31, c[1] = 139, c[2] = 8, c[8] = o.level < 2 ? 4 : o.level == 9 ? 2 : 0, c[9] = 3; // assume Unix
  if (o.mtime != 0) wbytes(c, 4, Math.floor((new Date(o.mtime as (string | number) || Date.now()) as unknown as number) / 1000));
  if (fn) {
    c[3] = 8;
    for (let i = 0; i <= fn.length; ++i) c[i + 10] = fn.charCodeAt(i);
  }
}

// gzip footer: -8 to -4 = CRC, -4 to -0 is length

// gzip start
const gzs = (d: Uint8Array) => {
  if (d[0] != 31 || d[1] != 139 || d[2] != 8) err(6, 'invalid gzip data');
  const flg = d[3];
  let st = 10;
  if (flg & 4) st += (d[10] | d[11] << 8) + 2;
  for (let zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++] as unknown as number);
  return st + (flg & 2);
}

// gzip length
const gzl = (d: Uint8Array) => {
  const l = d.length;
  return (d[l - 4] | d[l - 3] << 8 | d[l - 2] << 16 | d[l - 1] << 24) >>> 0;
}

// gzip header length
const gzhl = (o: GzipOptions) => 10 + (o.filename ? o.filename.length + 1 : 0);

// zlib header
const zlh = (c: Uint8Array, o: ZlibOptions) => {
  const lv = o.level, fl = lv == 0 ? 0 : lv < 6 ? 1 : lv == 9 ? 3 : 2;
  c[0] = 120, c[1] = (fl << 6) | (o.dictionary && 32);
  c[1] |= 31 - ((c[0] << 8) | c[1]) % 31;
  if (o.dictionary) {
    const h = adler();
    h.p(o.dictionary);
    wbytes(c, 2, h.d());
  }
}

// zlib start
const zls = (d: Uint8Array, dict?: unknown) => {
  if ((d[0] & 15) != 8 || (d[0] >> 4) > 7 || ((d[0] << 8 | d[1]) % 31)) err(6, 'invalid zlib data');
  if ((d[1] >> 5 & 1) == +!dict) err(6, 'invalid zlib data: ' + (d[1] & 32 ? 'need' : 'unexpected') + ' dictionary');
  return (d[1] >> 3 & 4) + 2;
}

// stream options and callback
function StrmOpt<T, H>(opts: T, cb?: H): T;
function StrmOpt<T, H>(cb?: H): T;
function StrmOpt<T, H>(opts?: T | H, cb?: H): T {
  if (typeof opts == 'function') cb = opts as H, opts = {} as T;
  this.ondata = cb as H;
  return opts as T;
}

/**
 * Streaming DEFLATE compression
 */
export class Deflate {
  /**
   * Creates a DEFLATE stream
   * @param opts The compression options
   * @param cb The callback to call whenever data is deflated
   */
  constructor(opts: DeflateOptions, cb?: FlateStreamHandler);
  /**
   * Creates a DEFLATE stream
   * @param cb The callback to call whenever data is deflated
   */
  constructor(cb?: FlateStreamHandler);
  constructor(opts?: DeflateOptions | FlateStreamHandler, cb?: FlateStreamHandler) {
    if (typeof opts == 'function') cb = opts as FlateStreamHandler, opts = {};
    this.ondata = cb;
    this.o = (opts as DeflateOptions) || {};
    this.h = 0;
    this.l = 0;
  }
  private o: DeflateOptions;
  // WebAssembly stream handle
  private h: number;
  // finished
  private l: number;
  // checksum of the input once finished
  private k: number;
  /**
   * The handler to call whenever data is available
   */
  ondata: FlateStreamHandler;

  // compresses a chunk. f: 0 none, 1 block flush, 2 sync flush, 3 finish
  // m: checksum mode. Returns null when no output is available yet.
  private q(c: Uint8Array, f: number, m: number, pre: number, post: number) {
    if (!this.ondata) err(5);
    if (this.l) err(4);
    const x = wx();
    if (!this.h) {
      const o = this.o, dict = o.dictionary ? o.dictionary.subarray(-32768) : et;
      wput(x, dict);
      this.h = x.def_new(o.level == null ? 6 : o.level, o.mem == null ? -1 : o.mem, m, dict.length);
      wreg(this, this.h);
    }
    wput(x, c);
    const p = x.def_push(this.h, c.length, f);
    if (!x.out_len() && f < 2) return null;
    const r = wget(x, p, pre, post);
    if (f == 3) {
      this.k = x.def_check(this.h);
      x.def_free(this.h), wunreg(this);
      this.h = 0, this.l = 1;
    }
    return r;
  }

  /**
   * Pushes a chunk to be deflated
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    const r = (Deflate.prototype as unknown as { q: Deflate['q'] }).q.call(this, chunk, final ? 3 : 0, 0, 0, 0);
    if (r) this.ondata(r, !!final);
  }

  /**
   * Flushes buffered uncompressed data. Useful to immediately retrieve the
   * deflated output for small inputs.
   * @param sync Whether to flush to a byte boundary. A sync flush takes 4-5
   *             extra bytes, but guarantees all pushed data is immediately
   *             decompressible. A separate DEFLATE stream may be concatenated
   *             with the current output after a sync flush.
   */
  flush(sync?: boolean) {
    const r = (Deflate.prototype as unknown as { q: Deflate['q'] }).q.call(this, et, sync ? 2 : 1, 0, 0, 0);
    if (r) this.ondata(r, false);
  }
}

/**
 * Asynchronous streaming DEFLATE compression
 */
export class AsyncDeflate {
  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;

  /**
   * The handler to call whenever buffered source data is processed (i.e. `queuedSize` updates)
   */
  ondrain?: AsyncFlateDrainHandler;

  /**
   * The number of uncompressed bytes buffered in the stream
   */
  queuedSize: number;

  /**
   * Creates an asynchronous DEFLATE stream
   * @param opts The compression options
   * @param cb The callback to call whenever data is deflated
   */
  constructor(opts: DeflateOptions, cb?: AsyncFlateStreamHandler);
  /**
   * Creates an asynchronous DEFLATE stream
   * @param cb The callback to call whenever data is deflated
   */
  constructor(cb?: AsyncFlateStreamHandler);
  constructor(opts?: DeflateOptions | AsyncFlateStreamHandler, cb?: AsyncFlateStreamHandler) {
    astrmify([
      bDflt,
      () => [astrm, Deflate]
    ], this as unknown as Astrm, StrmOpt.call(this, opts, cb), ev => {
      const strm = new Deflate(ev.data);
      onmessage = astrm(strm);
    }, 6, 1);
  }

  /**
   * Pushes a chunk to be deflated
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  // @ts-ignore
  push(chunk: Uint8Array, final?: boolean): void;

  /**
   * Flushes buffered uncompressed data. Useful to immediately retrieve the
   * deflated output for small inputs.
   * @param sync Whether to flush to a byte boundary. A sync flush takes 4-5
   *             extra bytes, but guarantees all pushed data is immediately
   *             decompressible. A separate DEFLATE stream may be concatenated
   *             with the current output after a sync flush.
   */
  // @ts-ignore
  flush(sync?: boolean): void;
  
  /**
   * A method to terminate the stream's internal worker. Subsequent calls to
   * push() will silently fail.
   */
  terminate: AsyncTerminable;
}

/**
 * Asynchronously compresses data with DEFLATE without any wrapper
 * @param data The data to compress
 * @param opts The compression options
 * @param cb The function to be called upon compression completion
 * @returns A function that can be used to immediately terminate the compression
 */
export function deflate(data: Uint8Array, opts: AsyncDeflateOptions, cb: FlateCallback): AsyncTerminable;
/**
 * Asynchronously compresses data with DEFLATE without any wrapper
 * @param data The data to compress
 * @param cb The function to be called upon compression completion
 */
export function deflate(data: Uint8Array, cb: FlateCallback): AsyncTerminable;
export function deflate(data: Uint8Array, opts: AsyncDeflateOptions | FlateCallback, cb?: FlateCallback) {
  if (!cb) cb = opts as FlateCallback, opts = {};
  if (typeof cb != 'function') err(7);
  return cbify(data, opts as AsyncDeflateOptions, [
    bDflt,
  ], ev => pbf(deflateSync(ev.data[0], ev.data[1])), 0, cb);
}

/**
 * Compresses data with DEFLATE without any wrapper
 * @param data The data to compress
 * @param opts The compression options
 * @returns The deflated version of the data
 */
export function deflateSync(data: Uint8Array, opts?: DeflateOptions) {
  return dopt(data, opts || {}, 0, 0);
}

/**
 * Streaming DEFLATE decompression
 */
export class Inflate {
  // WebAssembly stream handle
  private h: number;
  // dictionary
  private x: Uint8Array;
  // done (final chunk pushed)
  private d: boolean;
  // DEFLATE stream ended
  private f: number;
  // unconsumed bytes after the end of the stream in the last chunk
  private t: number;
  // bytes pushed into the current stream
  private n: number;
  /**
   * The handler to call whenever data is available
   */
  ondata: FlateStreamHandler;

  /**
   * Creates a DEFLATE decompression stream
   * @param opts The decompression options
   * @param cb The callback to call whenever data is inflated
   */
  constructor(opts: InflateStreamOptions, cb?: FlateStreamHandler);
  /**
   * Creates a DEFLATE decompression stream
   * @param cb The callback to call whenever data is inflated
   */
  constructor(cb?: FlateStreamHandler);
  constructor(opts?: InflateStreamOptions | FlateStreamHandler, cb?: FlateStreamHandler) {
    // no StrmOpt here to avoid adding to workerizer
    if (typeof opts == 'function') cb = opts as FlateStreamHandler, opts = {};
    this.ondata = cb;
    const dict = opts && (opts as InflateStreamOptions).dictionary;
    this.x = dict ? dict.subarray(-32768) : et;
    this.h = this.f = this.t = this.n = 0;
  }

  // frees the WebAssembly state
  private k() {
    if (this.h) wx().inf_free(this.h), wunreg(this), this.h = 0;
  }

  // inflates a chunk of raw DEFLATE data
  private r(c: Uint8Array, final: boolean | number) {
    if (this.f) {
      this.t = c.length;
      return new u8(0);
    }
    const x = wx();
    if (!this.h) {
      wput(x, this.x);
      this.h = x.inf_new(this.x.length);
      wreg(this, -this.h);
    }
    this.n += c.length;
    wput(x, c);
    const p = x.inf_push(this.h, c.length, final && this.n ? 1 : 0);
    if (!p) {
      const e = x.err();
      (Inflate.prototype as unknown as { k: Inflate['k'] }).k.call(this);
      err(e);
    }
    const o = wget(x, p, 0, 0);
    this.t = c.length - x.consumed();
    if (x.inf_ended(this.h)) this.f = 1;
    if (this.f || final) (Inflate.prototype as unknown as { k: Inflate['k'] }).k.call(this);
    return o;
  }

  /**
   * Pushes a chunk to be inflated
   * @param chunk The chunk to push
   * @param final Whether this is the final chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    if (!this.ondata) err(5);
    if (this.d) err(4);
    this.d = !!final;
    this.ondata((Inflate.prototype as unknown as { r: Inflate['r'] }).r.call(this, chunk, final), !!final);
  }
}

/**
 * Asynchronous streaming DEFLATE decompression
 */
export class AsyncInflate {
  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;

  /**
   * The handler to call whenever buffered source data is processed (i.e. `queuedSize` updates)
   */
  ondrain?: AsyncFlateDrainHandler;

  /**
   * The number of compressed bytes buffered in the stream
   */
  queuedSize: number;

  /**
   * Creates an asynchronous DEFLATE decompression stream
   * @param opts The decompression options
   * @param cb The callback to call whenever data is inflated
   */
  constructor(opts: InflateStreamOptions, cb?: AsyncFlateStreamHandler);
  /**
   * Creates an asynchronous DEFLATE decompression stream
   * @param cb The callback to call whenever data is inflated
   */
  constructor(cb?: AsyncFlateStreamHandler);
  constructor(opts?: InflateStreamOptions | AsyncFlateStreamHandler, cb?: AsyncFlateStreamHandler) {
    astrmify([
      bInflt,
      () => [astrm, Inflate]
    ], this as unknown as Astrm, StrmOpt.call(this, opts, cb), ev => {
      const strm = new Inflate(ev.data);
      onmessage = astrm(strm);
    }, 7, 0);
  }

  /**
   * Pushes a chunk to be inflated
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  // @ts-ignore
  push(chunk: Uint8Array, final?: boolean): void;

  /**
   * A method to terminate the stream's internal worker. Subsequent calls to
   * push() will silently fail.
   */
  terminate: AsyncTerminable;
}

/**
 * Asynchronously expands DEFLATE data with no wrapper
 * @param data The data to decompress
 * @param opts The decompression options
 * @param cb The function to be called upon decompression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function inflate(data: Uint8Array, opts: AsyncInflateOptions, cb: FlateCallback): AsyncTerminable;
/**
 * Asynchronously expands DEFLATE data with no wrapper
 * @param data The data to decompress
 * @param cb The function to be called upon decompression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function inflate(data: Uint8Array, cb: FlateCallback): AsyncTerminable;
export function inflate(data: Uint8Array, opts: AsyncInflateOptions | FlateCallback, cb?: FlateCallback) {
  if (!cb) cb = opts as FlateCallback, opts = {};
  if (typeof cb != 'function') err(7);
  return cbify(data, opts as AsyncInflateOptions, [
    bInflt
  ], ev => pbf(inflateSync(ev.data[0], gopt(ev.data[1]))), 1, cb);
}

/**
 * Expands DEFLATE data with no wrapper
 * @param data The data to decompress
 * @returns The decompressed version of the data
 */
export function inflateSync(data: Uint8Array): Uint8Array<ArrayBuffer>;
/**
 * Expands DEFLATE data with no wrapper
 * @param data The data to decompress
 * @param opts The decompression options
 * @returns The decompressed version of the data
 */
export function inflateSync<TArrayBuffer extends ArrayBufferLike = ArrayBuffer>(data: Uint8Array, opts?: InflateOptions<TArrayBuffer>): Uint8Array<TArrayBuffer>;
export function inflateSync(data: Uint8Array, opts?: InflateOptions) {
  return inflt(data, opts && opts.out, opts && opts.dictionary);
}

// before you yell at me for not just using extends, my reason is that TS inheritance is hard to workerize.

/**
 * Streaming GZIP compression
 */
export class Gzip {
  private v = 1;
  private z = 0;
  private o: GzipOptions;
  private k: number;
  /**
   * The handler to call whenever data is available
   */
  ondata: FlateStreamHandler;

  /**
   * Creates a GZIP stream
   * @param opts The compression options
   * @param cb The callback to call whenever data is deflated
   */
  constructor(opts: GzipOptions, cb?: FlateStreamHandler);
  /**
   * Creates a GZIP stream
   * @param cb The callback to call whenever data is deflated
   */
  constructor(cb?: FlateStreamHandler);
  constructor(opts?: GzipOptions | FlateStreamHandler, cb?: FlateStreamHandler) {
    Deflate.call(this, opts, cb);
  }

  /**
   * Pushes a chunk to be GZIPped
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    (Gzip.prototype as unknown as { p: Gzip['p'] }).p.call(this, chunk, final ? 3 : 0);
    this.z += chunk.length;
  }

  private p(c: Uint8Array, f: number) {
    const o = this.o;
    const raw = (Deflate.prototype as unknown as { q: (c: Uint8Array, f: number, m: number, pre: number, post: number) => Uint8Array }).q.call(this, c, f, 1, this.v ? gzhl(o) : 0, f == 3 ? 8 : 0);
    if (raw) {
      if (this.v) gzh(raw, o), this.v = 0;
      if (f == 3) wbytes(raw, raw.length - 8, this.k), wbytes(raw, raw.length - 4, this.z + c.length);
      this.ondata(raw, f == 3);
    }
  }

  /**
   * Flushes buffered uncompressed data. Useful to immediately retrieve the
   * GZIPped output for small inputs.
   * @param sync Whether to flush to a byte boundary. A sync flush takes 4-5
   *             extra bytes, but guarantees all pushed data is immediately
   *             decompressible.
   */
  flush(sync?: boolean) {
    (Gzip.prototype as unknown as { p: Gzip['p'] }).p.call(this, et, sync ? 2 : 1);
  }
}

/**
 * Asynchronous streaming GZIP compression
 */
export class AsyncGzip {
  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;

  /**
   * The handler to call whenever buffered source data is processed (i.e. `queuedSize` updates)
   */
  ondrain?: AsyncFlateDrainHandler;

  /**
   * The number of uncompressed bytes buffered in the stream
   */
  queuedSize: number;

  /**
   * Creates an asynchronous GZIP stream
   * @param opts The compression options
   * @param cb The callback to call whenever data is deflated
   */
  constructor(opts: GzipOptions, cb?: AsyncFlateStreamHandler);
  /**
   * Creates an asynchronous GZIP stream
   * @param cb The callback to call whenever data is deflated
   */
  constructor(cb?: AsyncFlateStreamHandler);
  constructor(opts?: GzipOptions | AsyncFlateStreamHandler, cb?: AsyncFlateStreamHandler) {
    astrmify([
      bDflt,
      gze,
      () => [astrm, Deflate, Gzip]
    ], this as unknown as Astrm, StrmOpt.call(this, opts, cb), ev => {
      const strm = new Gzip(ev.data);
      onmessage = astrm(strm);
    }, 8, 1);
  }

  /**
   * Pushes a chunk to be GZIPped
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  // @ts-ignore
  push(chunk: Uint8Array, final?: boolean): void;

  /**
   * Flushes buffered uncompressed data. Useful to immediately retrieve the
   * GZIPped output for small inputs.
   * @param sync Whether to flush to a byte boundary. A sync flush takes 4-5
   *             extra bytes, but guarantees all pushed data is immediately
   *             decompressible.
   */
  // @ts-ignore
  flush(sync?: boolean): void;

  /**
   * A method to terminate the stream's internal worker. Subsequent calls to
   * push() will silently fail.
   */
  terminate: AsyncTerminable;
}

/**
 * Asynchronously compresses data with GZIP
 * @param data The data to compress
 * @param opts The compression options
 * @param cb The function to be called upon compression completion
 * @returns A function that can be used to immediately terminate the compression
 */
export function gzip(data: Uint8Array, opts: AsyncGzipOptions, cb: FlateCallback): AsyncTerminable;
/**
 * Asynchronously compresses data with GZIP
 * @param data The data to compress
 * @param cb The function to be called upon compression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function gzip(data: Uint8Array, cb: FlateCallback): AsyncTerminable;
export function gzip(data: Uint8Array, opts: AsyncGzipOptions | FlateCallback, cb?: FlateCallback) {
  if (!cb) cb = opts as FlateCallback, opts = {};
  if (typeof cb != 'function') err(7);
  return cbify(data, opts as AsyncGzipOptions, [
    bDflt,
    gze,
    () => [gzipSync]
  ], ev => pbf(gzipSync(ev.data[0], ev.data[1])), 2, cb);
}

/**
 * Compresses data with GZIP
 * @param data The data to compress
 * @param opts The compression options
 * @returns The gzipped version of the data
 */
export function gzipSync(data: Uint8Array, opts?: GzipOptions) {
  if (!opts) opts = {};
  const l = data.length;
  const ck = [0], d = dopt(data, opts, gzhl(opts), 8, 1, ck), s = d.length;
  return gzh(d, opts), wbytes(d, s - 8, ck[0]), wbytes(d, s - 4, l), d;
}

/**
 * Handler for new GZIP members in concatenated GZIP streams. Useful for building indices used to perform random-access reads on compressed files.
 * @param offset The offset of the new member relative to the start of the stream
 */
export type GunzipMemberHandler = (offset: number) => void;

/**
 * Streaming single or multi-member GZIP decompression
 */
export class Gunzip {
  // awaiting a member header
  private v = 1;
  // total bytes pushed
  private r = 0;
  // members started
  private m = 0;
  // pending bytes
  private p: Uint8Array;
  private d: boolean;
  private f: number;
  private t: number;
  private n: number;
  /**
   * The handler to call whenever data is available
   */
  ondata: FlateStreamHandler;
  /**
   * The handler to call whenever a new GZIP member is found
   */
  onmember?: GunzipMemberHandler;

  /**
   * Creates a GUNZIP stream
   * @param opts The decompression options
   * @param cb The callback to call whenever data is inflated
   */
  constructor(opts: GunzipStreamOptions, cb?: FlateStreamHandler);
  /**
   * Creates a GUNZIP stream
   * @param cb The callback to call whenever data is inflated
   */
  constructor(cb?: FlateStreamHandler);
  constructor(opts?: GunzipStreamOptions | FlateStreamHandler, cb?: FlateStreamHandler) {
    Inflate.call(this, opts, cb);
    this.p = et;
  }

  /**
   * Pushes a chunk to be GUNZIPped
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    if (!this.ondata) err(5);
    if (this.d) err(4);
    this.d = !!final;
    this.r += chunk.length;
    let p = this.p.length ? cat(this.p, chunk) : chunk;
    const outs: Uint8Array<ArrayBuffer>[] = [];
    for (;;) {
      if (this.v) {
        if (!p.length) break;
        const s = p.length > 3 ? gzs(p) : 4;
        if (s > p.length) {
          if (final) p = et;
          break;
        }
        if (this.m++ && this.onmember) this.onmember(this.r - p.length);
        p = p.subarray(s);
        this.v = this.f = this.n = 0;
      }
      if (this.f) {
        // skip the CRC32 and ISIZE trailer, then look for another member
        if (p.length < 8) break;
        p = p.subarray(8);
        this.v = 1;
        continue;
      }
      if (!p.length) break;
      outs.push((Inflate.prototype as unknown as { r: (c: Uint8Array, f: number) => Uint8Array }).r.call(this, p, 0));
      p = p.subarray(p.length - this.t);
      if (!this.f) break;
    }
    if (final) {
      const unfinished = !this.v && !this.f && this.n;
      (Inflate.prototype as unknown as { k: () => void }).k.call(this);
      if (unfinished) err(0);
      this.p = et;
    } else this.p = p.length ? slc(p, 0) : et;
    const last = final ? (outs.length ? outs.pop() : new u8(0)) : null;
    for (let i = 0; i < outs.length; ++i) if (outs[i].length) this.ondata(outs[i], false);
    if (last) this.ondata(last, true);
  }
}

/**
 * Asynchronous streaming single or multi-member GZIP decompression
 */
export class AsyncGunzip {
  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;

  /**
   * The handler to call whenever buffered source data is processed (i.e. `queuedSize` updates)
   */
  ondrain?: AsyncFlateDrainHandler;

  /**
   * The number of compressed bytes buffered in the stream
   */
  queuedSize: number;

  /**
   * The handler to call whenever a new GZIP member is found
   */
  onmember?: GunzipMemberHandler;

  /**
   * Creates an asynchronous GUNZIP stream
   * @param opts The decompression options
   * @param cb The callback to call whenever data is inflated
   */
  constructor(opts: GunzipStreamOptions, cb?: AsyncFlateStreamHandler);
  /**
   * Creates an asynchronous GUNZIP stream
   * @param cb The callback to call whenever data is inflated
   */
  constructor(cb?: AsyncFlateStreamHandler);
  constructor(opts?: GunzipStreamOptions | AsyncFlateStreamHandler, cb?: AsyncFlateStreamHandler) {
    astrmify([
      bInflt,
      guze,
      () => [astrm, Inflate, Gunzip]
    ], this as unknown as Astrm, StrmOpt.call(this, opts, cb), ev => {
      const strm = new Gunzip(ev.data);
      strm.onmember = (offset) => (postMessage as Worker['postMessage'])(offset);
      onmessage = astrm(strm);
    }, 9, 0, offset => this.onmember && this.onmember(offset as number));
  }

  /**
   * Pushes a chunk to be GUNZIPped
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  // @ts-ignore
  push(chunk: Uint8Array, final?: boolean): void;

  /**
   * A method to terminate the stream's internal worker. Subsequent calls to
   * push() will silently fail.
   */
  terminate: AsyncTerminable;
}

/**
 * Asynchronously expands GZIP data
 * @param data The data to decompress
 * @param opts The decompression options
 * @param cb The function to be called upon decompression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function gunzip(data: Uint8Array, opts: AsyncGunzipOptions, cb: FlateCallback): AsyncTerminable;
/**
 * Asynchronously expands GZIP data
 * @param data The data to decompress
 * @param cb The function to be called upon decompression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function gunzip(data: Uint8Array, cb: FlateCallback): AsyncTerminable;
export function gunzip(data: Uint8Array, opts: AsyncGunzipOptions | FlateCallback, cb?: FlateCallback) {
  if (!cb) cb = opts as FlateCallback, opts = {};
  if (typeof cb != 'function') err(7);
  return cbify(data, opts as AsyncGunzipOptions, [
    bInflt,
    guze,
    () => [gunzipSync]
  ], ev => pbf(gunzipSync(ev.data[0], ev.data[1])), 3, cb);
}

/**
 * Expands GZIP data
 * @param data The data to decompress
 * @returns The decompressed version of the data
 */
export function gunzipSync(data: Uint8Array): Uint8Array<ArrayBuffer>;
/**
 * Expands GZIP data
 * @param data The data to decompress
 * @param opts The decompression options
 * @returns The decompressed version of the data
 */
export function gunzipSync<TArrayBuffer extends ArrayBufferLike = ArrayBuffer>(data: Uint8Array, opts?: GunzipOptions<TArrayBuffer>): Uint8Array<TArrayBuffer>;
export function gunzipSync(data: Uint8Array, opts?: GunzipOptions) {
  const st = gzs(data);
  if (st + 8 > data.length) err(6, 'invalid gzip data');
  return inflt(data.subarray(st, -8), opts && opts.out, opts && opts.dictionary, gzl(data));
}

/**
 * Streaming Zlib compression
 */
export class Zlib {
  private v = 1;
  private o: ZlibOptions;
  private k: number;
  /**
   * The handler to call whenever data is available
   */
  ondata: FlateStreamHandler;

  /**
   * Creates a Zlib stream
   * @param opts The compression options
   * @param cb The callback to call whenever data is deflated
   */
  constructor(opts: ZlibOptions, cb?: FlateStreamHandler);
  /**
   * Creates a Zlib stream
   * @param cb The callback to call whenever data is deflated
   */
  constructor(cb?: FlateStreamHandler);
  constructor(opts?: ZlibOptions | FlateStreamHandler, cb?: FlateStreamHandler) {
    Deflate.call(this, opts, cb);
  }

  /**
   * Pushes a chunk to be zlibbed
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    (Zlib.prototype as unknown as { p: Zlib['p'] }).p.call(this, chunk, final ? 3 : 0);
  }

  private p(c: Uint8Array, f: number) {
    const o = this.o;
    const raw = (Deflate.prototype as unknown as { q: (c: Uint8Array, f: number, m: number, pre: number, post: number) => Uint8Array }).q.call(this, c, f, 2, this.v ? (o.dictionary ? 6 : 2) : 0, f == 3 ? 4 : 0);
    if (raw) {
      if (this.v) zlh(raw, o), this.v = 0;
      if (f == 3) wbytes(raw, raw.length - 4, bsw(this.k));
      this.ondata(raw, f == 3);
    }
  }

  /**
   * Flushes buffered uncompressed data. Useful to immediately retrieve the
   * zlibbed output for small inputs.
   * @param sync Whether to flush to a byte boundary. A sync flush takes 4-5
   *             extra bytes, but guarantees all pushed data is immediately
   *             decompressible.
   */
  flush(sync?: boolean) {
    (Zlib.prototype as unknown as { p: Zlib['p'] }).p.call(this, et, sync ? 2 : 1);
  }
}

/**
 * Asynchronous streaming Zlib compression
 */
export class AsyncZlib {
  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;

  /**
   * The handler to call whenever buffered source data is processed (i.e. `queuedSize` updates)
   */
  ondrain?: AsyncFlateDrainHandler;

  /**
   * The number of uncompressed bytes buffered in the stream
   */
  queuedSize: number;

  /**
   * Creates an asynchronous Zlib stream
   * @param opts The compression options
   * @param cb The callback to call whenever data is deflated
   */
  constructor(opts: ZlibOptions, cb?: AsyncFlateStreamHandler);
  /**
   * Creates an asynchronous Zlib stream
   * @param cb The callback to call whenever data is deflated
   */
  constructor(cb?: AsyncFlateStreamHandler);
  constructor(opts?: ZlibOptions | AsyncFlateStreamHandler, cb?: AsyncFlateStreamHandler) {
    astrmify([
      bDflt,
      zle,
      () => [astrm, Deflate, Zlib]
    ], this as unknown as Astrm, StrmOpt.call(this, opts, cb), ev => {
      const strm = new Zlib(ev.data);
      onmessage = astrm(strm);
    }, 10, 1);
  }

  /**
   * Pushes a chunk to be deflated
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  // @ts-ignore
  push(chunk: Uint8Array, final?: boolean): void;

  /**
   * Flushes buffered uncompressed data. Useful to immediately retrieve the
   * zlibbed output for small inputs.
   * @param sync Whether to flush to a byte boundary. A sync flush takes 4-5
   *             extra bytes, but guarantees all pushed data is immediately
   *             decompressible.
   */
  // @ts-ignore
  flush(sync?: boolean): void;

  /**
   * A method to terminate the stream's internal worker. Subsequent calls to
   * push() will silently fail.
   */
  terminate: AsyncTerminable;
}

/**
 * Asynchronously compresses data with Zlib
 * @param data The data to compress
 * @param opts The compression options
 * @param cb The function to be called upon compression completion
 */
export function zlib(data: Uint8Array, opts: AsyncZlibOptions, cb: FlateCallback): AsyncTerminable;
/**
 * Asynchronously compresses data with Zlib
 * @param data The data to compress
 * @param cb The function to be called upon compression completion
 * @returns A function that can be used to immediately terminate the compression
 */
export function zlib(data: Uint8Array, cb: FlateCallback): AsyncTerminable;
export function zlib(data: Uint8Array, opts: AsyncZlibOptions | FlateCallback, cb?: FlateCallback) {
  if (!cb) cb = opts as FlateCallback, opts = {};
  if (typeof cb != 'function') err(7);
  return cbify(data, opts as AsyncZlibOptions, [
    bDflt,
    zle,
    () => [zlibSync]
  ], ev => pbf(zlibSync(ev.data[0], ev.data[1])), 4, cb);
}

/**
 * Compress data with Zlib
 * @param data The data to compress
 * @param opts The compression options
 * @returns The zlib-compressed version of the data
 */
export function zlibSync(data: Uint8Array, opts?: ZlibOptions) {
  if (!opts) opts = {};
  const ck = [0], d = dopt(data, opts, opts.dictionary ? 6 : 2, 4, 2, ck);
  return zlh(d, opts), wbytes(d, d.length - 4, bsw(ck[0])), d;
}

/**
 * Streaming Zlib decompression
 */
export class Unzlib {
  // awaiting header (1, or 2 when a dictionary is expected)
  private v: number;
  // pending header bytes
  private p: Uint8Array;
  // trailing bytes after the DEFLATE stream
  private z: number;
  private d: boolean;
  private f: number;
  private t: number;
  /**
   * The handler to call whenever data is available
   */
  ondata: FlateStreamHandler;

  /**
   * Creates a Zlib decompression stream
   * @param opts The decompression options
   * @param cb The callback to call whenever data is inflated
   */
  constructor(opts: UnzlibStreamOptions, cb?: FlateStreamHandler);
  /**
   * Creates a Zlib decompression stream
   * @param cb The callback to call whenever data is inflated
   */
  constructor(cb?: FlateStreamHandler);
  constructor(opts?: UnzlibStreamOptions | FlateStreamHandler, cb?: FlateStreamHandler) {
    Inflate.call(this, opts, cb);
    this.v = opts && (opts as UnzlibStreamOptions).dictionary ? 2 : 1;
    this.p = et;
    this.z = 0;
  }

  /**
   * Pushes a chunk to be unzlibbed
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    if (!this.ondata) err(5);
    if (this.d) err(4);
    let p = chunk;
    if (this.v) {
      p = this.p.length ? cat(this.p, chunk) : chunk;
      if (p.length < 6 && !final) {
        this.p = slc(p, 0);
        return;
      }
      p = p.subarray(zls(p, this.v - 1)), this.v = 0, this.p = et;
    }
    this.d = !!final;
    const o = (Inflate.prototype as unknown as { r: (c: Uint8Array, f: boolean) => Uint8Array }).r.call(this, p, final);
    if (this.f) this.z += this.t;
    if (final && this.z < 4) err(6, 'invalid zlib data');
    this.ondata(o, !!final);
  }
}

/**
 * Asynchronous streaming Zlib decompression
 */
export class AsyncUnzlib {
  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;

  /**
   * The handler to call whenever buffered source data is processed (i.e. `queuedSize` updates)
   */
  ondrain?: AsyncFlateDrainHandler;

  /**
   * The number of compressed bytes buffered in the stream
   */
  queuedSize: number;

  /**
   * Creates an asynchronous Zlib decompression stream
   * @param opts The decompression options
   * @param cb The callback to call whenever data is inflated
   */
  constructor(opts: UnzlibStreamOptions, cb?: AsyncFlateStreamHandler);
  /**
   * Creates an asynchronous Zlib decompression stream
   * @param cb The callback to call whenever data is inflated
   */
  constructor(cb?: AsyncFlateStreamHandler);
  constructor(opts?: UnzlibStreamOptions | AsyncFlateStreamHandler, cb?: AsyncFlateStreamHandler) {
    astrmify([
      bInflt,
      zule,
      () => [astrm, Inflate, Unzlib]
    ], this as unknown as Astrm, StrmOpt.call(this, opts, cb), ev => {
      const strm = new Unzlib(ev.data);
      onmessage = astrm(strm);
    }, 11, 0);
  }

  /**
   * Pushes a chunk to be decompressed from Zlib
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  // @ts-ignore
  push(chunk: Uint8Array, final?: boolean): void;

  /**
   * A method to terminate the stream's internal worker. Subsequent calls to
   * push() will silently fail.
   */
  terminate: AsyncTerminable;
}

/**
 * Asynchronously expands Zlib data
 * @param data The data to decompress
 * @param opts The decompression options
 * @param cb The function to be called upon decompression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function unzlib(data: Uint8Array, opts: AsyncUnzlibOptions, cb: FlateCallback): AsyncTerminable;
/**
 * Asynchronously expands Zlib data
 * @param data The data to decompress
 * @param cb The function to be called upon decompression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function unzlib(data: Uint8Array, cb: FlateCallback): AsyncTerminable;
export function unzlib(data: Uint8Array, opts: AsyncUnzlibOptions | FlateCallback, cb?: FlateCallback) {
  if (!cb) cb = opts as FlateCallback, opts = {};
  if (typeof cb != 'function') err(7);
  return cbify(data, opts as AsyncUnzlibOptions, [
    bInflt,
    zule,
    () => [unzlibSync]
  ], ev => pbf(unzlibSync(ev.data[0], gopt(ev.data[1]))), 5, cb);
}

/**
 * Expands Zlib data
 * @param data The data to decompress
 * @returns The decompressed version of the data
 */
export function unzlibSync(data: Uint8Array): Uint8Array<ArrayBuffer>;
/**
 * Expands Zlib data
 * @param data The data to decompress
 * @param opts The decompression options
 * @returns The decompressed version of the data
 */
export function unzlibSync<TArrayBuffer extends ArrayBufferLike = ArrayBuffer>(data: Uint8Array, opts?: UnzlibOptions<TArrayBuffer>): Uint8Array<TArrayBuffer>;
export function unzlibSync(data: Uint8Array, opts?: UnzlibOptions) {
  return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), opts && opts.out, opts && opts.dictionary);
}

// Default algorithm for compression (used because having a known output size allows faster decompression)
export { gzip as compress, AsyncGzip as AsyncCompress }
export { gzipSync as compressSync, Gzip as Compress }

/**
 * Streaming GZIP, Zlib, or raw DEFLATE decompression
 */
export class Decompress {
  private G: typeof Gunzip;
  private I: typeof Inflate;
  private Z: typeof Unzlib;
  private o: InflateOptions;
  private s: Inflate | Gunzip | Unzlib;
  private p: Uint8Array;

  /**
   * The handler to call whenever data is available
   */
  ondata: FlateStreamHandler;

  /**
   * Creates a decompression stream
   * @param opts The decompression options
   * @param cb The callback to call whenever data is decompressed
   */
  constructor(opts: InflateStreamOptions, cb?: FlateStreamHandler);
  /**
   * Creates a decompression stream
   * @param cb The callback to call whenever data is decompressed
   */
  constructor(cb?: FlateStreamHandler);
  constructor(opts?: InflateStreamOptions | FlateStreamHandler, cb?: FlateStreamHandler) {
    this.o = StrmOpt.call(this, opts, cb) || {};
    this.G = Gunzip;
    this.I = Inflate;
    this.Z = Unzlib;
  }

  // init substream
  // overriden by AsyncDecompress
  private i() {
    this.s.ondata = (dat, final) => {
      this.ondata(dat, final);
    }
  }

  /**
   * Pushes a chunk to be decompressed
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    if (!this.ondata) err(5);
    if (!this.s) {
      if (this.p && this.p.length) {
        this.p = cat(this.p, chunk);
      } else this.p = chunk;
      if (this.p.length > 2 || final) {
        this.s = (this.p[0] == 31 && this.p[1] == 139 && this.p[2] == 8)
          ? new this.G(this.o)
          : ((this.p[0] & 15) != 8 || (this.p[0] >> 4) > 7 || ((this.p[0] << 8 | this.p[1]) % 31))
            ? new this.I(this.o)
            : new this.Z(this.o);
        this.i();
        this.s.push(this.p, final);
        this.p = null;
      }
    } else this.s.push(chunk, final);
  }


}

/**
 * Asynchronous streaming GZIP, Zlib, or raw DEFLATE decompression
 */
export class AsyncDecompress {
  private G: typeof AsyncGunzip;
  private I: typeof AsyncInflate;
  private Z: typeof AsyncUnzlib;

  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;

  /**
   * The handler to call whenever buffered source data is processed (i.e. `queuedSize` updates)
   */
  ondrain?: AsyncFlateDrainHandler;

  /**
   * The number of compressed bytes buffered in the stream
   */
  queuedSize: number;

  /**
   * Creates an asynchronous decompression stream
   * @param opts The decompression options
   * @param cb The callback to call whenever data is decompressed
   */
  constructor(opts: InflateStreamOptions, cb?: AsyncFlateStreamHandler);
  /**
   * Creates an asynchronous decompression stream
   * @param cb The callback to call whenever data is decompressed
   */
  constructor(cb?: AsyncFlateStreamHandler);
  constructor(opts?: InflateStreamOptions | AsyncFlateStreamHandler, cb?: AsyncFlateStreamHandler) {
    Decompress.call(this, opts, cb);
    this.queuedSize = 0;
    this.G = AsyncGunzip;
    this.I = AsyncInflate;
    this.Z = AsyncUnzlib;
  }

  private i() {
    (this as unknown as { s: AsyncInflate }).s.ondata = (err, dat, final) => {
      this.ondata(err, dat, final);
    }
    (this as unknown as { s: AsyncInflate }).s.ondrain = size => {
      this.queuedSize -= size;
      if (this.ondrain) this.ondrain(size);
    }
  }

  /**
   * Pushes a chunk to be decompressed
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    this.queuedSize += chunk.length;
    Decompress.prototype.push.call(this, chunk, final);
  }
}

/**
 * Asynchrononously expands compressed GZIP, Zlib, or raw DEFLATE data, automatically detecting the format
 * @param data The data to decompress
 * @param opts The decompression options
 * @param cb The function to be called upon decompression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function decompress(data: Uint8Array, opts: AsyncInflateOptions, cb: FlateCallback): AsyncTerminable;
/**
 * Asynchrononously expands compressed GZIP, Zlib, or raw DEFLATE data, automatically detecting the format
 * @param data The data to decompress
 * @param cb The function to be called upon decompression completion
 * @returns A function that can be used to immediately terminate the decompression
 */
export function decompress(data: Uint8Array, cb: FlateCallback): AsyncTerminable;
export function decompress(data: Uint8Array, opts: AsyncInflateOptions | FlateCallback, cb?: FlateCallback) {
  if (!cb) cb = opts as FlateCallback, opts = {};
  if (typeof cb != 'function') err(7);
  return (data[0] == 31 && data[1] == 139 && data[2] == 8)
    ? gunzip(data, opts as AsyncInflateOptions, cb)
    : ((data[0] & 15) != 8 || (data[0] >> 4) > 7 || ((data[0] << 8 | data[1]) % 31))
      ? inflate(data, opts as AsyncInflateOptions, cb)
      : unzlib(data, opts as AsyncInflateOptions, cb);
}

/**
 * Expands compressed GZIP, Zlib, or raw DEFLATE data, automatically detecting the format
 * @param data The data to decompress
 * @param opts The decompression options
 * @returns The decompressed version of the data
 */
export function decompressSync(data: Uint8Array, opts?: InflateOptions) {
  return (data[0] == 31 && data[1] == 139 && data[2] == 8)
    ? gunzipSync(data, opts)
    : ((data[0] & 15) != 8 || (data[0] >> 4) > 7 || ((data[0] << 8 | data[1]) % 31))
      ? inflateSync(data, opts)
      : unzlibSync(data, opts);
}

/**
 * Attributes for files added to a ZIP archive object
 */
export interface ZipAttributes {
  /**
   * The operating system of origin for this file. The value is defined
   * by PKZIP's APPNOTE.txt, section 4.4.2.2. For example, 0 (the default)
   * is MS/DOS, 3 is Unix, 19 is macOS.
   */
  os?: number;

  /**
   * The file's attributes. These are traditionally somewhat complicated
   * and platform-dependent, so using them is scarcely necessary. However,
   * here is a representation of what this is, bit by bit:
   * 
   * `TTTTugtrwxrwxrwx0000000000ADVSHR`
   * 
   * TTTT = file type (rarely useful)
   * 
   * u = setuid, g = setgid, t = sticky
   * 
   * rwx = user permissions, rwx = group permissions, rwx = other permissions
   * 
   * 0000000000 = unused
   * 
   * A = archive, D = directory, V = volume label, S = system file, H = hidden, R = read-only
   * 
   * If you want to set the Unix permissions, for instance, just bit shift by 16, e.g. 0o644 << 16.
   * Note that attributes usually only work in conjunction with the `os` setting: you must use
   * `os` = 3 (Unix) if you want to set Unix permissions
   */
  attrs?: number;

  /**
   * Extra metadata to add to the file. This field is defined by PKZIP's APPNOTE.txt,
   * section 4.4.28. At most 65,535 bytes may be used in each ID. The ID must be an
   * integer between 0 and 65,535, inclusive.
   * 
   * This field is incredibly rare and almost never needed except for compliance with
   * proprietary standards and software.
   */
  extra?: Record<number, Uint8Array>;

  /**
   * The comment to attach to the file. This field is defined by PKZIP's APPNOTE.txt,
   * section 4.4.26. The comment must be at most 65,535 bytes long UTF-8 encoded. This
   * field is not read by consumer software.
   */
  comment?: string;

  /**
   * When the file was last modified. Defaults to the current time.
   */
  mtime?: GzipOptions['mtime'];
}

/**
 * Options for creating a ZIP archive
 */
export interface ZipOptions extends DeflateOptions, ZipAttributes {}

/**
 * Options for expanding a ZIP archive
 */
export interface UnzipOptions {
  /**
   * A filter function to extract only certain files from a ZIP archive
   */
  filter?: UnzipFileFilter;
}

/**
 * Options for asynchronously creating a ZIP archive
 */
export interface AsyncZipOptions extends AsyncDeflateOptions, ZipAttributes {}

/**
 * Options for asynchronously expanding a ZIP archive
 */
export interface AsyncUnzipOptions extends UnzipOptions {}

/**
 * A file that can be used to create a ZIP archive
 */
export type ZippableFile = Uint8Array | Zippable | [Uint8Array | Zippable, ZipOptions];

/**
 * A file that can be used to asynchronously create a ZIP archive
 */
export type AsyncZippableFile = Uint8Array | AsyncZippable | [Uint8Array | AsyncZippable, AsyncZipOptions]

/**
 * The complete directory structure of a ZIPpable archive
 */
export interface Zippable {
  [path: string]: ZippableFile;
}

/**
 * The complete directory structure of an asynchronously ZIPpable archive
 */
export interface AsyncZippable {
  [path: string]: AsyncZippableFile;
}

/**
 * An unzipped archive. The full path of each file is used as the key,
 * and the file is the value
 */
export interface Unzipped {
  [path: string]: Uint8Array<ArrayBuffer>;
}

/**
 * Handler for string generation streams
 * @param data The string output from the stream processor
 * @param final Whether this is the final block
 */
export type StringStreamHandler = (data: string, final: boolean) => void;

/**
 * Callback for asynchronous ZIP decompression
 * @param err Any error that occurred
 * @param data The decompressed ZIP archive
 */
export type UnzipCallback = (err: FlateError | null, data: Unzipped) => void;

/**
 * Handler for streaming ZIP decompression
 * @param file The file that was found in the archive
 */
export type UnzipFileHandler = (file: UnzipFile) => void;

// flattened Zippable
type FlatZippable<A extends boolean> = Record<string, [Uint8Array, (A extends true ? AsyncZipOptions : ZipOptions)]>;

// flatten a directory structure
const fltn = <A extends boolean, D = A extends true ? AsyncZippable : Zippable>(d: D, p: string, t: FlatZippable<A>, o: ZipOptions) => {
  for (const k in d) {
    let val = d[k], n = p + k, op = o;
    if (Array.isArray(val)) op = mrg(o, val[1]), val = val[0] as unknown as D[Extract<keyof D, string>];
    if (ArrayBuffer.isView(val)) t[n] = [val, op] as unknown as FlatZippable<A>[string];
    else {
      t[n += '/'] = [new u8(0), op] as unknown as FlatZippable<A>[string];
      fltn(val as unknown as (A extends true ? AsyncZippable : Zippable), n, t, o);
    }
  }
}

// text encoder
const te = typeof TextEncoder != 'undefined' && /*#__PURE__*/ new TextEncoder();
// text decoder
const td = typeof TextDecoder != 'undefined' && /*#__PURE__*/ new TextDecoder();
// text decoder stream
let tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch(e) {}

// decode UTF8
const dutf8 = (d: Uint8Array) => {
  for (let r = '', i = 0;;) {
    let c = d[i++];
    const eb = ((c > 127) as unknown as number) + ((c > 223) as unknown as number) + ((c > 239) as unknown as number);
    if (i + eb > d.length) return { s: r, r: slc(d, i - 1) };
    if (!eb) r += String.fromCharCode(c)
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | (d[i++] & 63)) - 65536,
      r += String.fromCharCode(55296 | (c >> 10), 56320 | (c & 1023));
    } else if (eb & 1) r += String.fromCharCode((c & 31) << 6 | (d[i++] & 63));
    else r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | (d[i++] & 63));
  }
}

/**
 * Streaming UTF-8 decoding
 */
export class DecodeUTF8 {
  private p: Uint8Array;
  private t: TextDecoder;
  /**
   * Creates a UTF-8 decoding stream
   * @param cb The callback to call whenever data is decoded
   */
  constructor(cb?: StringStreamHandler) {
    this.ondata = cb;
    if (tds) this.t = new TextDecoder();
    else this.p = et;
  }

  /**
   * Pushes a chunk to be decoded from UTF-8 binary
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    if (!this.ondata) err(5);
    final = !!final;
    if (this.t) {
      this.ondata(this.t.decode(chunk, { stream: true }), final);
      if (final) {
        if (this.t.decode().length) err(8);
        this.t = null;
      }
      return;
    }
    if (!this.p) err(4);
    const dat = new u8(this.p.length + chunk.length);
    dat.set(this.p);
    dat.set(chunk, this.p.length);
    const { s, r } = dutf8(dat);
    if (final) {
      if (r.length) err(8);
      this.p = null;
    } else this.p = r;
    this.ondata(s, final);
  }

  /**
   * The handler to call whenever data is available
   */
  ondata: StringStreamHandler;
}

/**
 * Streaming UTF-8 encoding
 */
export class EncodeUTF8 {
  private d: boolean;
  /**
   * Creates a UTF-8 decoding stream
   * @param cb The callback to call whenever data is encoded
   */
  constructor(cb?: FlateStreamHandler) {
    this.ondata = cb;
  }

  /**
   * Pushes a chunk to be encoded to UTF-8
   * @param chunk The string data to push
   * @param final Whether this is the last chunk
   */
  push(chunk: string, final?: boolean) {
    if (!this.ondata) err(5);
    if (this.d) err(4);
    this.ondata(strToU8(chunk), this.d = final || false);
  }

  /**
   * The handler to call whenever data is available
   */
  ondata: FlateStreamHandler;
}

/**
 * Converts a string into a Uint8Array for use with compression/decompression methods
 * @param str The string to encode
 * @param latin1 Whether or not to interpret the data as Latin-1. This should
 *               not need to be true unless decoding a binary string.
 * @returns The string encoded in UTF-8/Latin-1 binary
 */
export function strToU8(str: string, latin1?: boolean) {
  if (latin1) {
    const ar = new u8(str.length);
    for (let i = 0; i < str.length; ++i) ar[i] = str.charCodeAt(i);
    return ar;
  }
  if (te) return te.encode(str);
  const l = str.length;
  let ar = new u8(str.length + (str.length >> 1));
  let ai = 0;
  const w = (v: number) => { ar[ai++] = v; };
  for (let i = 0; i < l; ++i) {
    if (ai + 5 > ar.length) {
      const n = new u8(ai + 8 + ((l - i) << 1));
      n.set(ar);
      ar = n;
    }
    let c = str.charCodeAt(i);
    if (c < 128 || latin1) w(c);
    else if (c < 2048) w(192 | (c >> 6)), w(128 | (c & 63));
    else if (c > 55295 && c < 57344)
      c = 65536 + (c & 1023 << 10) | (str.charCodeAt(++i) & 1023),
      w(240 | (c >> 18)), w(128 | ((c >> 12) & 63)), w(128 | ((c >> 6) & 63)), w(128 | (c & 63));
    else w(224 | (c >> 12)), w(128 | ((c >> 6) & 63)), w(128 | (c & 63));
  }
  return slc(ar, 0, ai);
}

/**
 * Converts a Uint8Array to a string
 * @param dat The data to decode to string
 * @param latin1 Whether or not to interpret the data as Latin-1. This should
 *               not need to be true unless encoding to binary string.
 * @returns The original UTF-8/Latin-1 string
 */
export function strFromU8(dat: Uint8Array, latin1?: boolean) {
  if (latin1) {
    let r = '';
    for (let i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat)
  } else {
    const { s, r } = dutf8(dat);
    if (r.length) err(8);
    return s;
  } 
};

// deflate bit flag
const dbf = (l: number) => l == 1 ? 3 : l < 6 ? 2 : l == 9 ? 1 : 0;

// skip local zip header
const slzh = (d: Uint8Array, b: number) => b + 30 + b2(d, b + 26) + b2(d, b + 28);

// read zip header
const zh = (d: Uint8Array, b: number, z: boolean) => {
  const fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  const [sc, su, off] = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42));
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off] as const;
}

// read zip64 header sizes
const z64hs = (d: Uint8Array, b: number, l: number, z: boolean | number, sc: number, su: number, off: number) => {
  const nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  const nf = (nsc as unknown as number) + (nsu as unknown as number) + (noff as unknown as number);
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * (nsu as unknown as number)) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * ((nsu as unknown as number) + (nsc as unknown as number))) : off,
          1
        ] as const;
      }
    }
    // z == 2 for unknown whether or not zip64
    if (z as unknown as number < 2) err(13);
  }
  return [sc, su, off, 0] as const;
}

// zip header file
type ZHF = Omit<ZipInputFile, 'terminate' | 'ondata' | 'filename'>;

// extra field length
const exfl = (ex?: ZHF['extra']) => {
  let le = 0;
  if (ex) {
    for (const k in ex) {
      const l = ex[k].length;
      if (l > 65535) err(9);
      le += l + 4;
    }
  }
  return le;
}

// write zip header
const wzh = (d: Uint8Array, b: number, f: ZHF, fn: Uint8Array, u: boolean, c: number, ce?: number, co?: Uint8Array) => {
  const fl = fn.length, ex = f.extra, col = co && co.length;
  let exl = exfl(ex);
  wbytes(d, b, ce != null ? 0x2014B50 : 0x4034B50), b += 4;
  if (ce != null) d[b++] = 20, d[b++] = f.os;
  d[b] = 20, b += 2; // spec compliance? what's that?
  d[b++] = (f.flag << 1) | (c < 0 && 8), d[b++] = u && 8;
  d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
  const dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
  if (y < 0 || y > 119) err(10);
  wbytes(d, b, (y << 25) | ((dt.getMonth() + 1) << 21) | (dt.getDate() << 16) | (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1)), b += 4;
  if (c != -1) {
    wbytes(d, b, f.crc);
    wbytes(d, b + 4, c < 0 ? -c - 2 : c);
    wbytes(d, b + 8, f.size);
  }
  wbytes(d, b + 12, fl);
  wbytes(d, b + 14, exl), b += 16;
  if (ce != null) {
    wbytes(d, b, col);
    wbytes(d, b + 6, f.attrs);
    wbytes(d, b + 10, ce), b += 14;
  }
  d.set(fn, b);
  b += fl;
  if (exl) {
    for (const k in ex) {
      const exf = ex[k], l = exf.length;
      wbytes(d, b, +k);
      wbytes(d, b + 2, l);
      d.set(exf, b + 4), b += 4 + l;
    }
  }
  if (col) d.set(co, b), b += col;
  return b;
}

// write zip footer (end of central directory)
const wzf = (o: Uint8Array, b: number, c: number, d: number, e: number) => {
  wbytes(o, b, 0x6054B50); // skip disk
  wbytes(o, b + 8, c);
  wbytes(o, b + 10, c);
  wbytes(o, b + 12, d);
  wbytes(o, b + 16, e);
}

/**
 * A stream that can be used to create a file in a ZIP archive
 */
export interface ZipInputFile extends ZipAttributes {
  /**
   * The filename to associate with the data provided to this stream. If you
   * want a file in a subdirectory, use forward slashes as a separator (e.g.
   * `directory/filename.ext`). This will still work on Windows.
   */
  filename: string;

  /**
   * The size of the file in bytes. This attribute may be invalid after
   * the file is added to the ZIP archive; it must be correct only before the
   * stream completes.
   * 
   * If you don't want to have to compute this yourself, consider extending the
   * ZipPassThrough class and overriding its process() method, or using one of
   * ZipDeflate or AsyncZipDeflate.
   */
  size: number;

  /**
   * A CRC of the original file contents. This attribute may be invalid after
   * the file is added to the ZIP archive; it must be correct only before the
   * stream completes.
   * 
   * If you don't want to have to generate this yourself, consider extending the
   * ZipPassThrough class and overriding its process() method, or using one of
   * ZipDeflate or AsyncZipDeflate.
   */
  crc: number;

  /**
   * The compression format for the data stream. This number is determined by
   * the spec in PKZIP's APPNOTE.txt, section 4.4.5. For example, 0 = no
   * compression, 8 = deflate, 14 = LZMA
   */
  compression: number;

  /**
   * Bits 1 and 2 of the general purpose bit flag, specified in PKZIP's
   * APPNOTE.txt, section 4.4.4. Should be between 0 and 3. This is unlikely
   * to be necessary.
   */
  flag?: number;

  /**
   * The handler to be called when data is added. After passing this stream to
   * the ZIP file object, this handler will always be defined. To call it:
   * 
   * `stream.ondata(error, chunk, final)`
   * 
   * error = any error that occurred (null if there was no error)
   * 
   * chunk = a Uint8Array of the data that was added (null if there was an
   * error)
   * 
   * final = boolean, whether this is the final chunk in the stream
   */
  ondata?: AsyncFlateStreamHandler;
  
  /**
   * A method called when the stream is no longer needed, for clean-up
   * purposes. This will not always be called after the stream completes,
   * so you may wish to call this.terminate() after the final chunk is
   * processed if you have clean-up logic.
   */
  terminate?: AsyncTerminable;
}

type AsyncZipDat = ZHF & {
  // compressed data
  c: Uint8Array;
  // filename
  f: Uint8Array;
  // comment
  m?: Uint8Array;
  // unicode
  u: boolean;
};

type ZipDat = AsyncZipDat & {
  // offset
  o: number;
}

/**
 * A pass-through stream to keep data uncompressed in a ZIP archive.
 */
export class ZipPassThrough implements ZipInputFile {
  filename: string;
  crc: number;
  size: number;
  compression: number;
  os?: number;
  attrs?: number;
  comment?: string;
  extra?: Record<number, Uint8Array>;
  mtime?: GzipOptions['mtime'];
  ondata: AsyncFlateStreamHandler;
  private c: CRCV;

  /**
   * Creates a pass-through stream that can be added to ZIP archives
   * @param filename The filename to associate with this data stream
   */
  constructor(filename: string) {
    this.filename = filename;
    this.c = crc();
    this.size = 0;
    this.compression = 0;
  }

  /**
   * Processes a chunk and pushes to the output stream. You can override this
   * method in a subclass for custom behavior, but by default this passes
   * the data through. You must call this.ondata(err, chunk, final) at some
   * point in this method.
   * @param chunk The chunk to process
   * @param final Whether this is the last chunk
   */
  protected process(chunk: Uint8Array<ArrayBuffer>, final: boolean) {
    this.ondata(null, chunk, final);
  }

  /**
   * Pushes a chunk to be added. If you are subclassing this with a custom
   * compression algorithm, note that you must push data from the source
   * file only, pre-compression.
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    if (!this.ondata) err(5);
    this.c.p(chunk);
    this.size += chunk.length;
    if (final) this.crc = this.c.d();
    // we shouldn't really do this cast, but properly handling ArrayBufferLike
    // makes the API unergonomic with Buffer
    this.process(chunk as Uint8Array<ArrayBuffer>, final || false);
  }
}

// I don't extend because TypeScript extension adds 1kB of runtime bloat

/**
 * Streaming DEFLATE compression for ZIP archives. Prefer using AsyncZipDeflate
 * for better performance
 */
export class ZipDeflate implements ZipInputFile {
  filename: string;
  crc: number;
  size: number;
  compression: number;
  flag: 0 | 1 | 2 | 3;
  os?: number;
  attrs?: number;
  comment?: string;
  extra?: Record<number, Uint8Array>;
  mtime?: GzipOptions['mtime'];
  ondata: AsyncFlateStreamHandler;
  private d: Deflate;

  /**
   * Creates a DEFLATE stream that can be added to ZIP archives
   * @param filename The filename to associate with this data stream
   * @param opts The compression options
   */
  constructor(filename: string, opts?: DeflateOptions) {
    if (!opts) opts = {};
    ZipPassThrough.call(this, filename);
    this.d = new Deflate(opts, (dat, final) => {
      this.ondata(null, dat, final);
    });
    this.compression = 8;
    this.flag = dbf(opts.level);
  }
  
  private process(chunk: Uint8Array, final: boolean) {
    try {
      this.d.push(chunk, final);
    } catch(e) {
      this.ondata(e, null, final);
    }
  }

  /**
   * Pushes a chunk to be deflated
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    ZipPassThrough.prototype.push.call(this, chunk, final);
  }
}

/**
 * Asynchronous streaming DEFLATE compression for ZIP archives
 */
export class AsyncZipDeflate implements ZipInputFile {
  filename: string;
  crc: number;
  size: number;
  compression: number;
  flag: 0 | 1 | 2 | 3;
  os?: number;
  attrs?: number;
  comment?: string;
  extra?: Record<number, Uint8Array>;
  mtime?: GzipOptions['mtime'];
  ondata: AsyncFlateStreamHandler;
  private d: AsyncDeflate;
  terminate: AsyncTerminable;

  /**
   * Creates an asynchronous DEFLATE stream that can be added to ZIP archives
   * @param filename The filename to associate with this data stream
   * @param opts The compression options
   */
  constructor(filename: string, opts?: DeflateOptions) {
    if (!opts) opts = {};
    ZipPassThrough.call(this, filename);
    this.d = new AsyncDeflate(opts, (err, dat, final) => {
      this.ondata(err, dat, final);
    });
    this.compression = 8;
    this.flag = dbf(opts.level);
    this.terminate = this.d.terminate;
  }
  
  private process(chunk: Uint8Array, final: boolean) {
    this.d.push(chunk, final);
  }

  /**
   * Pushes a chunk to be deflated
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean) {
    ZipPassThrough.prototype.push.call(this, chunk, final);
  }
}

type ZIFE = {
  // compressed size
  c: number;
  // filename
  f: Uint8Array;
  // comment
  o?: Uint8Array;
  // unicode
  u: boolean;
  // byte offset
  b: number;
  // header offset
  h: number;
  // terminator
  t: () => void;
  // turn
  r: () => void;
};

type ZipInternalFile = ZHF & ZIFE;

// TODO: Better tree shaking

/**
 * A zippable archive to which files can incrementally be added
 */
export class Zip {
  private u: ZipInternalFile[];
  private d: number;

  /**
   * Creates an empty ZIP archive to which files can be added
   * @param cb The callback to call whenever data for the generated ZIP archive
   *           is available
   */
  constructor(cb?: AsyncFlateStreamHandler) {
    this.ondata = cb;
    this.u = [];
    this.d = 1;
  }
  /**
   * Adds a file to the ZIP archive
   * @param file The file stream to add
   */
  add(file: ZipInputFile) {
    if (!this.ondata) err(5);
    // finishing or finished
    if (this.d & 2) this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, false);
    else {
      const f = strToU8(file.filename), fl = f.length;
      const com = file.comment, o = com && strToU8(com);
      const u = fl != file.filename.length || (o && (com.length != o.length));
      const hl = fl + exfl(file.extra) + 30;
      if (fl > 65535) this.ondata(err(11, 0, 1), null, false);
      const header = new u8(hl);
      wzh(header, 0, file, f, u, -1);
      let chks: Uint8Array<ArrayBuffer>[] = [header];
      const pAll = () => {
        for (const chk of chks) this.ondata(null, chk, false);
        chks = [];
      };
      let tr = this.d;
      this.d = 0;
      const ind = this.u.length;
      const uf = mrg(file, {
        f,
        u,
        o,
        t: () => { 
          if (file.terminate) file.terminate();
        },
        r: () => {
          pAll();
          if (tr) {
            const nxt = this.u[ind + 1];
            if (nxt) nxt.r();
            else this.d = 1;
          }
          tr = 1;
        }
      } as ZIFE);
      let cl = 0;
      file.ondata = (err, dat, final) => {
        if (err) {
          this.ondata(err, dat, final);
          this.terminate();
        } else {
          cl += dat.length;
          chks.push(dat);
          if (final) {
            const dd = new u8(16);
            wbytes(dd, 0, 0x8074B50)
            wbytes(dd, 4, file.crc);
            wbytes(dd, 8, cl);
            wbytes(dd, 12, file.size);
            chks.push(dd);
            uf.c = cl, uf.b = hl + cl + 16, uf.crc = file.crc, uf.size = file.size;
            if (tr) uf.r();
            tr = 1;
          } else if (tr) pAll();
        }
      }
      this.u.push(uf);
    }
  }

  /**
   * Ends the process of adding files and prepares to emit the final chunks.
   * This *must* be called after adding all desired files for the resulting
   * ZIP file to work properly.
   */
  end() {
    if (this.d & 2) {
      this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, true);
      return;
    }
    if (this.d) this.e();
    else this.u.push({
      r: () => {
        if (!(this.d & 1)) return;
        this.u.splice(-1, 1);
        this.e();
      },
      t: () => {}
    } as unknown as ZipInternalFile);
    this.d = 3;
  }

  private e() {
    let bt = 0, l = 0, tl = 0;
    for (const f of this.u) tl += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0);
    const out = new u8(tl + 22);
    for (const f of this.u) {
      wzh(out, bt, f, f.f, f.u, -f.c - 2, l, f.o);
      bt += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0), l += f.b;
    }
    wzf(out, bt, this.u.length, tl, l)
    this.ondata(null, out, true);
    this.d = 2;
  }

  /**
   * A method to terminate any internal workers used by the stream. Subsequent
   * calls to add() will fail.
   */
  terminate() {
    for (const f of this.u) f.t();
    this.d = 2;
  }

  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;
}

/**
 * Asynchronously creates a ZIP file
 * @param data The directory structure for the ZIP archive
 * @param opts The main options, merged with per-file options
 * @param cb The callback to call with the generated ZIP archive
 * @returns A function that can be used to immediately terminate the compression
 */
export function zip(data: AsyncZippable, opts: AsyncZipOptions, cb: FlateCallback): AsyncTerminable;
/**
 * Asynchronously creates a ZIP file
 * @param data The directory structure for the ZIP archive
 * @param cb The callback to call with the generated ZIP archive
 * @returns A function that can be used to immediately terminate the compression
 */
export function zip(data: AsyncZippable, cb: FlateCallback): AsyncTerminable;
export function zip(data: AsyncZippable, opts: AsyncZipOptions | FlateCallback, cb?: FlateCallback) {
  if (!cb) cb = opts as FlateCallback, opts = {};
  if (typeof cb != 'function') err(7);
  const r: FlatZippable<true> = {};
  fltn(data, '', r, opts as AsyncZipOptions);
  const k = Object.keys(r);
  let lft = k.length, o = 0, tot = 0;
  const slft = lft, files = new Array<AsyncZipDat>(lft);
  const term: AsyncTerminable[] = [];
  const tAll = () => {
    for (let i = 0; i < term.length; ++i) term[i]();
  }
  let cbd: FlateCallback = (a, b) => {
    mt(() => { cb(a, b); });
  }
  mt(() => { cbd = cb; });
  const cbf = () => {
    const out = new u8(tot + 22), oe = o, cdl = tot - o;
    tot = 0;
    for (let i = 0; i < slft; ++i) {
      const f = files[i];
      try {
        const l = f.c.length;
        wzh(out, tot, f, f.f, f.u, l);
        const badd = 30 + f.f.length + exfl(f.extra);
        const loc = tot + badd;
        out.set(f.c, loc);
        wzh(out, o, f, f.f, f.u, l, tot, f.m), o += 16 + badd + (f.m ? f.m.length : 0), tot = loc + l;
      } catch(e) {
        return cbd(e, null);
      }
    }
    wzf(out, o, files.length, cdl, oe);
    cbd(null, out);
  }
  if (!lft) cbf();
  // Cannot use lft because it can decrease
  for (let i = 0; i < slft; ++i) {
    const fn = k[i];
    const [file, p] = r[fn];
    const c = crc(), size = file.length;
    c.p(file);
    const f = strToU8(fn), s = f.length;
    const com = p.comment, m = com && strToU8(com), ms = m && m.length;
    const exl = exfl(p.extra);
    const compression = p.level == 0 ? 0 : 8;
    const cbl = (e: FlateError, d: Uint8Array) => {
      if (e) {
        tAll();
        cbd(e, null);
      } else {
        const l = d.length;
        files[i] = mrg(p, {
          size,
          crc: c.d(),
          c: d,
          f,
          m,
          u: s != fn.length || (m && (com.length != ms)),
          compression
        });
        o += 30 + s + exl + l;
        tot += 76 + 2 * (s + exl) + (ms || 0) + l;
        if (!--lft) cbf();
      }
    }
    if (s > 65535) cbl(err(11, 0, 1), null);
    if (!compression) cbl(null, file);
    else if (size < 160000) {
      try {
        cbl(null, deflateSync(file, p));
      } catch(e) {
        cbl(e, null);
      }
    } else term.push(deflate(file, p, cbl));
  }
  return tAll;
}

/**
 * Synchronously creates a ZIP file. Prefer using `zip` for better performance
 * with more than one file.
 * @param data The directory structure for the ZIP archive
 * @param opts The main options, merged with per-file options
 * @returns The generated ZIP archive
 */
export function zipSync(data: Zippable, opts?: ZipOptions) {
  if (!opts) opts = {};
  const r: FlatZippable<false> = {};
  const files: ZipDat[] = [];
  fltn(data, '', r, opts);
  let o = 0;
  let tot = 0;
  for (const fn in r) {
    const [file, p] = r[fn];
    const compression = p.level == 0 ? 0 : 8;
    const f = strToU8(fn), s = f.length;
    const com = p.comment, m = com && strToU8(com), ms = m && m.length;
    const exl = exfl(p.extra);
    if (s > 65535) err(11);
    const ck = [0], d = compression ? dopt(file, p, 0, 0, 1, ck) : file, l = d.length;
    let cv = ck[0];
    if (!compression) {
      const c = crc();
      c.p(file);
      cv = c.d();
    }
    files.push(mrg(p, {
      size: file.length,
      crc: cv,
      c: d,
      f,
      m,
      u: s != fn.length || (m && (com.length != ms)),
      o,
      compression
    }));
    o += 30 + s + exl + l;
    tot += 76 + 2 * (s + exl) + (ms || 0) + l;
  }
  const out = new u8(tot + 22), oe = o, cdl = tot - o;
  for (let i = 0; i < files.length; ++i) {
    const f = files[i];
    wzh(out, f.o, f, f.f, f.u, f.c.length);
    const badd = 30 + f.f.length + exfl(f.extra);
    out.set(f.c, f.o + badd);
    wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
  }
  wzf(out, o, files.length, cdl, oe);
  return out;
}

/**
 * A decoder for files in ZIP streams
 */
export interface UnzipDecoder {  
  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;
  
  /**
   * Pushes a chunk to be decompressed
   * @param chunk The data in this chunk. Do not consume (detach) this buffer.
   * @param final Whether this is the last chunk in the data stream
   */
  push(chunk: Uint8Array, final: boolean): void;

  /**
   * A method to terminate any internal workers used by the stream. Subsequent
   * calls to push() should silently fail.
   */
  terminate?: AsyncTerminable
}

/**
 * A constructor for a decoder for unzip streams
 */
export interface UnzipDecoderConstructor {
  /**
   * Creates an instance of the decoder
   * @param filename The name of the file
   * @param size The compressed size of the file
   * @param originalSize The original size of the file
   */
  new(filename: string, size?: number, originalSize?: number): UnzipDecoder;

  /**
   * The compression format for the data stream. This number is determined by
   * the spec in PKZIP's APPNOTE.txt, section 4.4.5. For example, 0 = no
   * compression, 8 = deflate, 14 = LZMA
   */
  compression: number;
}

/**
 * Information about a file to be extracted from a ZIP archive
 */
export interface UnzipFileInfo {
  /**
   * The name of the file
   */
  name: string;

  /**
   * The compressed size of the file
   */
  size: number;

  /**
   * The original size of the file
   */
  originalSize: number;

  /**
   * The compression format for the data stream. This number is determined by
   * the spec in PKZIP's APPNOTE.txt, section 4.4.5. For example, 0 = no
   * compression, 8 = deflate, 14 = LZMA. If the filter function returns true
   * but this value is not 8, the unzip function will throw.
   */
  compression: number;
}

/**
 * A filter for files to be extracted during the unzipping process
 * @param file The info for the current file being processed
 * @returns Whether or not to extract the current file
 */
export type UnzipFileFilter = (file: UnzipFileInfo) => boolean;

/**
 * Streaming file extraction from ZIP archives
 */
export interface UnzipFile {
  /**
   * The handler to call whenever data is available
   */
  ondata: AsyncFlateStreamHandler;

  /**
   * The name of the file
   */
  name: string;

  /**
   * The compression format for the data stream. This number is determined by
   * the spec in PKZIP's APPNOTE.txt, section 4.4.5. For example, 0 = no
   * compression, 8 = deflate, 14 = LZMA. If start() is called but there is no
   * decompression stream available for this method, start() will throw.
   */
  compression: number;

  /**
   * The compressed size of the file. Will not be present for archives created
   * in a streaming fashion.
   */
  size?: number;

  /**
   * The original size of the file. Will not be present for archives created
   * in a streaming fashion.
   */
  originalSize?: number;

  /**
   * Starts reading from the stream. Calling this function will always enable
   * this stream, but ocassionally the stream will be enabled even without
   * this being called.
   */
  start(): void;

  /**
   * A method to terminate any internal workers used by the stream. ondata
   * will not be called any further.
   */
  terminate: AsyncTerminable
}

/**
 * Streaming pass-through decompression for ZIP archives
 */
export class UnzipPassThrough implements UnzipDecoder {
  static compression = 0;
  ondata: AsyncFlateStreamHandler;
  push(chunk: Uint8Array, final: boolean) {
    // same as ZipPassThrough: cast to retain Buffer ergonomics
    this.ondata(null, chunk as Uint8Array<ArrayBuffer>, final);
  }
}

/**
 * Streaming DEFLATE decompression for ZIP archives. Prefer AsyncZipInflate for
 * better performance.
 */
export class UnzipInflate implements UnzipDecoder {
  static compression = 8;
  private i: Inflate;
  ondata: AsyncFlateStreamHandler;

  /**
   * Creates a DEFLATE decompression that can be used in ZIP archives
   */
  constructor() {
    this.i = new Inflate((dat, final) => {
      this.ondata(null, dat, final);
    });
  }

  push(chunk: Uint8Array, final: boolean) {
    try {
      this.i.push(chunk, final);
    } catch(e) {
      this.ondata(e, null, final);
    }
  }
}

/**
 * Asynchronous streaming DEFLATE decompression for ZIP archives
 */
export class AsyncUnzipInflate implements UnzipDecoder {
  static compression = 8;
  private i: AsyncInflate | Inflate;
  ondata: AsyncFlateStreamHandler;
  terminate: AsyncTerminable;

  /**
   * Creates a DEFLATE decompression that can be used in ZIP archives
   */
  constructor(_: string, sz?: number) {
    if (sz < 320000) {
      this.i = new Inflate((dat, final) => {
        this.ondata(null, dat, final);
      });
    } else {
      this.i = new AsyncInflate((err, dat, final) => {
        this.ondata(err, dat, final);
      });
      this.terminate = this.i.terminate;
    }
  }

  push(chunk: Uint8Array, final: boolean) {
    if ((this.i as AsyncInflate).terminate) chunk = slc(chunk, 0);
    this.i.push(chunk, final);
  }
}

/**
 * A ZIP archive decompression stream that emits files as they are discovered
 */
export class Unzip {
  private d: UnzipDecoder;
  private c: number;
  private p: Uint8Array;
  private k: Uint8Array[][];
  private o: Record<number, UnzipDecoderConstructor>;

  /**
   * Creates a ZIP decompression stream
   * @param cb The callback to call whenever a file in the ZIP archive is found
   */
  constructor(cb?: UnzipFileHandler) {
    this.onfile = cb;
    this.k = [];
    this.o = {
      0: UnzipPassThrough
    };
    this.p = et;
  }
  
  /**
   * Pushes a chunk to be unzipped
   * @param chunk The chunk to push
   * @param final Whether this is the last chunk
   */
  push(chunk: Uint8Array, final?: boolean): void {
    if (!this.onfile) err(5);
    if (!this.p) err(4);
    if (this.c > 0) {
      const len = Math.min(this.c, chunk.length);
      const toAdd = chunk.subarray(0, len);
      this.c -= len;
      if (this.d) this.d.push(toAdd, !this.c);
      else this.k[0].push(toAdd);
      chunk = chunk.subarray(len);
      if (chunk.length) return this.push(chunk, final);
    } else {
      let f = 0, i = 0, is: number, buf: Uint8Array;
      if (!this.p.length) buf = chunk;
      else if (!chunk.length) buf = this.p;
      else {
        buf = new u8(this.p.length + chunk.length)
        buf.set(this.p), buf.set(chunk, this.p.length);
      }
      const l = buf.length, oc = this.c, add = oc && this.d;
      for (; i < l - 4; ++i) {
        const sig = b4(buf, i);
        if (sig == 0x4034B50) {
          f = 1, is = i;
          this.d = null;
          this.c = 0;
          const bf = b2(buf, i + 6), cmp = b2(buf, i + 8), u = bf & 2048, dd = bf & 8, fnl = b2(buf, i + 26), es = b2(buf, i + 28);
          if (l > i + 30 + fnl + es) {
            const chks: Uint8Array[] = [];
            this.k.unshift(chks);
            f = 2;
            let lsc = b4(buf, i + 18), lsu = b4(buf, i + 22);
            const fn = strFromU8(buf.subarray(i + 30, i += 30 + fnl), !u);
            let [sc, su,, z64] = z64hs(buf, i, es, 2, lsc, lsu, 0);
            if (dd) sc = -1 - z64;
            i += es;
            this.c = sc;
            let d: UnzipDecoder;
            const file = {
              name: fn,
              compression: cmp,
              start: () => {
                if (!file.ondata) err(5);
                if (!sc) file.ondata(null, et, true);
                else {
                  const ctr = this.o[cmp];
                  if (!ctr) file.ondata(err(14, 'unknown compression type ' + cmp, 1), null, false);
                  d = sc < 0 ? new ctr(fn) : new ctr(fn, sc, su);
                  d.ondata = (err, dat, final) => { file.ondata(err, dat, final); }
                  for (const dat of chks) d.push(dat, false);
                  if (this.k[0] == chks && this.c) this.d = d;
                  else d.push(et, true);
                }
              },
              terminate: () => {
                if (d && d.terminate) d.terminate();
              }
            } as UnzipFile;
            if (sc >= 0) file.size = sc, file.originalSize = su;
            this.onfile(file);
          }
          break;
        } else if (oc) {
          if (sig == 0x8074B50) {
            is = i += 12 + (oc == -2 && 8), f = 3, this.c = 0;
            break;
          } else if (sig == 0x2014B50) {
            is = i -= 4, f = 3, this.c = 0;
            break;
          }
        }
      }
      this.p = et
      if (oc < 0) {
        const dat = f ? buf.subarray(0, is - 12 - (oc == -2 && 8) - (b4(buf, is - 16) == 0x8074B50 && 4)) : buf.subarray(0, i);
        if (add) add.push(dat, !!f);
        else this.k[+(f == 2)].push(dat);
      }
      if (f & 2) return this.push(buf.subarray(i), final);
      this.p = buf.subarray(i);
    }
    if (final) {
      if (this.c) err(13);
      this.p = null;
    }
  }

  /**
   * Registers a decoder with the stream, allowing for files compressed with
   * the compression type provided to be expanded correctly
   * @param decoder The decoder constructor
   */
  register(decoder: UnzipDecoderConstructor) {
    this.o[decoder.compression] = decoder;
  }

  /**
   * The handler to call whenever a file is discovered
   */
  onfile: UnzipFileHandler;
}

const mt = typeof queueMicrotask == 'function' ? queueMicrotask : typeof setTimeout == 'function' ? setTimeout : (fn: Function) => { fn(); };


/**
 * Asynchronously decompresses a ZIP archive
 * @param data The raw compressed ZIP file
 * @param opts The ZIP extraction options
 * @param cb The callback to call with the decompressed files
 * @returns A function that can be used to immediately terminate the unzipping
 */
export function unzip(data: Uint8Array, opts: AsyncUnzipOptions, cb: UnzipCallback): AsyncTerminable;
/**
 * Asynchronously decompresses a ZIP archive
 * @param data The raw compressed ZIP file
 * @param cb The callback to call with the decompressed files
 * @returns A function that can be used to immediately terminate the unzipping
 */
export function unzip(data: Uint8Array, cb: UnzipCallback): AsyncTerminable;
export function unzip(data: Uint8Array, opts: AsyncUnzipOptions | UnzipCallback, cb?: UnzipCallback): AsyncTerminable {
  if (!cb) cb = opts as UnzipCallback, opts = {};
  if (typeof cb != 'function') err(7);
  const term: AsyncTerminable[] = [];
  const tAll = () => {
    for (let i = 0; i < term.length; ++i) term[i]();
  }
  const files: Unzipped = {};
  let cbd: UnzipCallback = (a, b) => {
    mt(() => { cb(a, b); });
  }
  mt(() => { cbd = cb; });
  let e = data.length - 22;
  for (; b4(data, e) != 0x6054B50; --e) {
    if (!e || data.length - e > 65558) {
      cbd(err(13, 0, 1), null);
      return tAll;
    }
  };
  let lft = b2(data, e + 8);
  if (lft) {
    let c = lft;
    let o = b4(data, e + 16);
    let z = b4(data, e - 20) == 0x7064B50;
    if (z) {
      let ze = b4(data, e - 12);
      z = b4(data, ze) == 0x6064B50;
      if (z) {
        c = lft = b4(data, ze + 32);
        o = b4(data, ze + 48);
      }
    }
    const fltr = opts && (opts as AsyncUnzipOptions).filter;
    for (let i = 0; i < c; ++i) {
      const [c, sc, su, fn, no, off] = zh(data, o, z), b = slzh(data, off);
      o = no
      const cbl: FlateCallback = (e, d) => {
        if (e) {
          tAll();
          cbd(e, null);
        } else {
          if (d) files[fn] = d;
          if (!--lft) cbd(null, files);
        }
      }
      if (!fltr || fltr({
        name: fn,
        size: sc,
        originalSize: su,
        compression: c
      })) {
        if (!c) cbl(null, slc(data, b, b + sc))
        else if (c == 8) {
          const infl = data.subarray(b, b + sc);
          // Synchronously decompress under 512KB, or barely-compressed data
          if (su < 524288 || sc > 0.8 * su) {
            try {
              cbl(null, inflateSync(infl, { out: new u8(su) }));
            } catch(e) {
              cbl(e, null);
            }
          }
          else term.push(inflate(infl, { size: su }, cbl));
        } else cbl(err(14, 'unknown compression type ' + c, 1), null);
      } else cbl(null, null);
    }
  } else cbd(null, {});
  return tAll;
}

/**
 * Synchronously decompresses a ZIP archive. Prefer using `unzip` for better
 * performance with more than one file.
 * @param data The raw compressed ZIP file
 * @param opts The ZIP extraction options
 * @returns The decompressed files
 */
export function unzipSync(data: Uint8Array, opts?: UnzipOptions) {
  const files: Unzipped = {};
  let e = data.length - 22;
  for (; b4(data, e) != 0x6054B50; --e) {
    if (!e || data.length - e > 65558) err(13);
  };
  let c = b2(data, e + 8);
  if (!c) return {};
  let o = b4(data, e + 16);
  let z = b4(data, e - 20) == 0x7064B50;
  if (z) {
    let ze = b4(data, e - 12);
    z = b4(data, ze) == 0x6064B50;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  const fltr = opts && opts.filter;
  for (let i = 0; i < c; ++i) {
    const [c, sc, su, fn, no, off] = zh(data, o, z), b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c
    })) {
      if (!c) files[fn] = slc(data, b, b + sc);
      else if (c == 8) files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else err(14, 'unknown compression type ' + c);
    }
  }
  return files;
}

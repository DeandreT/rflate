"""Generate src/index.ts from fflate's src/index.ts, replacing its JavaScript
DEFLATE engine with the WebAssembly engine.

Usage: python scripts/splice.py <path-to-fflate-checkout>

Everything outside the replaced engine sections (ZIP, UTF-8, errors, worker
plumbing) is kept as upstream wrote it, so upstream fixes can be merged by
re-running this script.
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = (Path(sys.argv[1]) / "src" / "index.ts").read_text()
engine = (root / "scripts" / "engine.ts.txt").read_text()
pieces = dict(re.findall(r"//@@(\w+)\n(.*?)(?=//@@|\Z)", (root / "scripts" / "streams.ts.txt").read_text(), re.S))


def cut(text, start, end, replacement, include_end=False):
    a = text.index(start)
    b = text.index(end, a + len(start))
    if include_end:
        b += len(end)
    assert text.count(start) == 1, start
    return text[:a] + replacement + text[b:]


def replace_block(text, header, replacement):
    """Replace a top-level block (with its preceding doc comment) that starts at `header`."""
    a = text.index(header)
    assert text.count(header) == 1, header
    doc = text.rfind("/**", 0, a)
    if text[doc:a].count("*/") == 1 and text[text.index("*/", doc) + 2:a].strip() == "":
        a = doc
    b = text.index("\n}\n", a) + 3
    return text[:a] + replacement.rstrip() + "\n" + text[b:]


def replace_impl(text, header, replacement):
    """Replace only an implementation signature line through its closing brace."""
    a = text.index(header)
    assert text.count(header) == 1, header
    b = text.index("\n}\n", a) + 3
    return text[:a] + replacement.rstrip() + "\n" + text[b:]


out = src
out = out.replace(
    "// DEFLATE is a complex format; to read this code, you should probably check the RFC first:",
    "// rflate: fflate's API with a Rust/WebAssembly DEFLATE engine (zlib-rs).\n"
    "// Derived from fflate by Arjun Barrett (MIT). The JavaScript DEFLATE engine below\n"
    "// was replaced; the comments that follow are fflate's originals.\n\n"
    "// DEFLATE is a complex format; to read this code, you should probably check the RFC first:", 1)
# Tables, Huffman helpers and InflateState: everything between the aliases and shft.
out = cut(out, "// fixed length extra bits", "// get end of byte", "")
out = cut(out, "// inflate state\ntype InflateState", "/**\n * Codes for errors", "")
# JS inflate/deflate engines and checksums, up to the public option interfaces.
out = cut(out, "// expands raw DEFLATE data", "// crc check\ntype CRCV", engine + "\n")
crc_js = '''// crc check
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
'''
out = cut(out, "// crc check\ntype CRCV", "/**\n * Options for decompressing a DEFLATE stream", crc_js + "\n")
dopt = '''// deflate with opts. mode 1/2 also computes the CRC32/Adler32 of dat into ck[0]
const dopt = (dat: Uint8Array, opt: DeflateOptions, pre: number, post: number, mode?: number, ck?: number[]) => {
  const x = wbig(dat.length), dict = opt.dictionary ? opt.dictionary.subarray(-32768) : et;
  wput(x, dict, dat);
  const r = wget(x, x.deflate_once(opt.level == null ? 6 : opt.level, opt.mem == null ? -1 : opt.mem, mode || 0, dict.length, dat.length), pre, post);
  if (ck) ck[0] = x.last_check();
  return r;
}
'''
out = cut(out, "// deflate with opts\nconst dopt", "// Walmart object spread", dopt + "  \n\n")
# Workers receive the compiled module instead of the engine's source.
out = out.replace("  if (!ch[id]) {\n    let fnStr", "  wx();\n  if (!ch[id]) {\n    let fnStr", 1)
out = cut(out, "const bInflt = () =>", "\n", "const bInflt = () => [u8, et, ec, err, slc, wm, wx, wbig, wput, wget, wreg, wunreg, cat, isc, icp, inflt, inflateSync, pbf, gopt];")
out = cut(out, "const bDflt = () =>", "\n", "const bDflt = () => [u8, et, ec, err, slc, wm, wx, wbig, wput, wget, wreg, wunreg, dopt, deflateSync, pbf];")
out = cut(out, "const gze = () =>", "\n", "const gze = () => [gzh, gzhl, wbytes, crc, crct];")
out = cut(out, "const guze = () =>", "\n", "const guze = () => [gzs, gzl, cat];")
out = cut(out, "const zle = () =>", "\n", "const zle = () => [zlh, wbytes, adler, bsw];")
out = cut(out, "const zule = () =>", "\n", "const zule = () => [zls, cat];")

out = replace_block(out, "export class Deflate {", pieces["DEFLATE"])
out = replace_impl(out, "export function deflateSync(data: Uint8Array, opts?: DeflateOptions) {", pieces["DEFLATESYNC"])
out = replace_block(out, "export class Inflate {", pieces["INFLATE"])
out = replace_impl(out, "export function inflateSync(data: Uint8Array, opts?: InflateOptions) {", pieces["INFLATESYNC"])
out = replace_block(out, "export class Gzip {", pieces["GZIP"])
out = replace_impl(out, "export function gzipSync(data: Uint8Array, opts?: GzipOptions) {", pieces["GZIPSYNC"])
out = replace_block(out, "export class Gunzip {", pieces["GUNZIP"])
out = replace_impl(out, "export function gunzipSync(data: Uint8Array, opts?: GunzipOptions) {", pieces["GUNZIPSYNC"])
out = replace_block(out, "export class Zlib {", pieces["ZLIB"])
out = replace_impl(out, "export function zlibSync(data: Uint8Array, opts?: ZlibOptions) {", pieces["ZLIBSYNC"])
out = replace_block(out, "export class Unzlib {", pieces["UNZLIB"])
out = replace_impl(out, "export function unzlibSync(data: Uint8Array, opts?: UnzlibOptions) {", pieces["UNZLIBSYNC"])

# Decompress: keep the buffered prefix when the first chunks are tiny.
out = out.replace(
    "        const n = new u8(this.p.length + chunk.length);\n        n.set(this.p), n.set(chunk, this.p.length);\n      } else this.p = chunk;",
    "        this.p = cat(this.p, chunk);\n      } else this.p = chunk;", 1)
# Decompress: the final chunk decides the format even when shorter than 3 bytes.
assert "      if (this.p.length > 2) {" in out
out = out.replace("      if (this.p.length > 2) {", "      if (this.p.length > 2 || final) {", 1)
# zipSync: compress and checksum in one pass.
old_zip = "    const d = compression ? deflateSync(file, p) : file, l = d.length;\n    const c = crc();\n    c.p(file);\n"
assert old_zip in out
out = out.replace(old_zip,
    "    const ck = [0], d = compression ? dopt(file, p, 0, 0, 1, ck) : file, l = d.length;\n"
    "    let cv = ck[0];\n"
    "    if (!compression) {\n      const c = crc();\n      c.p(file);\n      cv = c.d();\n    }\n", 1)
out = out.replace("      crc: c.d(),\n      c: d,\n      f,\n      m,\n      u: s != fn.length || (m && (com.length != ms)),\n      o,",
                  "      crc: cv,\n      c: d,\n      f,\n      m,\n      u: s != fn.length || (m && (com.length != ms)),\n      o,", 1)

for gone in ["inflt(data, { i: 2 }", "dflt(", "hMap(", "InflateState", "DeflateState", "fleb"]:
    assert gone not in out, gone
(root / "src").mkdir(exist_ok=True)
(root / "src" / "index.ts").write_text(out)
print("wrote src/index.ts", len(out.splitlines()), "lines")

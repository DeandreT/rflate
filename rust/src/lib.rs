//! WebAssembly core for rflate: raw DEFLATE compression and decompression
//! (via zlib-rs) plus CRC-32 and Adler-32.
//!
//! The ABI is deliberately small and only meant for the bundled JavaScript
//! wrapper. JavaScript copies input into the buffer returned by [`buf`], calls
//! an operation, then copies the result out of the buffer described by
//! [`out_len`] and the returned pointer. Pointers are only valid until the next
//! call into the module.
use core::ptr::addr_of_mut;
use zlib_rs::{Deflate, DeflateConfig, DeflateFlush, Inflate, InflateFlush, Method, Status, Strategy};

struct Globals {
    inp: Vec<u8>,
    out: Vec<u8>,
    out_len: usize,
    consumed: usize,
    err: i32,
}

static mut G: Globals = Globals { inp: Vec::new(), out: Vec::new(), out_len: 0, consumed: 0, err: -1 };

#[inline(always)]
fn glob() -> &'static mut Globals {
    // SAFETY: wasm32 without threads; the module is only entered from one JS thread.
    unsafe { &mut *addr_of_mut!(G) }
}

/// Error codes match fflate's `FlateErrorCode`.
const E_EOF: i32 = 0;
const E_BLOCK: i32 = 1;
const E_LITLEN: i32 = 2;
const E_DIST: i32 = 3;

fn map_inflate_error(msg: Option<&str>) -> i32 {
    match msg {
        Some(m) if m.contains("block type") => E_BLOCK,
        Some(m) if m.contains("distance") => E_DIST,
        _ => E_LITLEN,
    }
}

/// Returns a pointer to an input buffer of at least `len` bytes.
#[no_mangle]
pub extern "C" fn buf(len: usize) -> *mut u8 {
    let g = glob();
    if g.inp.capacity() < len {
        g.inp = Vec::with_capacity(len);
    }
    g.inp.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    glob().out_len
}

#[no_mangle]
pub extern "C" fn consumed() -> usize {
    glob().consumed
}

#[no_mangle]
pub extern "C" fn err() -> i32 {
    glob().err
}

/// Releases the scratch buffers if they have grown beyond `keep` bytes.
#[no_mangle]
pub extern "C" fn trim(keep: usize) {
    let g = glob();
    if g.inp.capacity() > keep {
        g.inp = Vec::new();
    }
    if g.out.capacity() > keep {
        g.out = Vec::new();
    }
}

fn input(offset: usize, len: usize) -> &'static [u8] {
    // SAFETY: JS wrote `offset + len` bytes into the buffer returned by `buf`.
    unsafe { core::slice::from_raw_parts(glob().inp.as_ptr().add(offset), len) }
}

#[no_mangle]
pub extern "C" fn crc32(start: u32, len: usize) -> u32 {
    zlib_rs::crc32::crc32(start, input(0, len))
}

#[no_mangle]
pub extern "C" fn adler32(start: u32, len: usize) -> u32 {
    zlib_rs::adler32::adler32(start, input(0, len))
}

/// Checksum modes: 0 none, 1 CRC-32 (gzip/zip), 2 Adler-32 (zlib).
fn checksum(mode: i32, state: u32, data: &[u8]) -> u32 {
    match mode {
        1 => zlib_rs::crc32::crc32(state, data),
        2 => zlib_rs::adler32::adler32(state, data),
        _ => 0,
    }
}

fn initial_checksum(mode: i32) -> u32 {
    if mode == 2 { 1 } else { 0 }
}

/// zlib's memLevel from fflate's `mem` option (0-12), or a size-based default.
fn mem_level(mem: i32, size_hint: usize) -> i32 {
    if mem >= 0 {
        return (mem - 3).clamp(1, 9);
    }
    // Small inputs do not benefit from large literal buffers.
    match size_hint {
        0..=4096 => 5,
        4097..=65536 => 7,
        _ => 8,
    }
}

fn window_bits(size_hint: usize) -> i32 {
    // A smaller window is valid raw DEFLATE for any decoder and makes
    // initialisation cheaper for small inputs.
    let mut bits = 9;
    while bits < 15 && (1usize << bits) < size_hint {
        bits += 1;
    }
    bits
}

fn new_deflate(level: i32, mem: i32, size_hint: usize) -> Deflate {
    // zlib-rs level 1 is a "quick" mode whose output is ~40% larger than
    // fflate's level 1; its level 2 matches fflate's level 1 size closely.
    let level = match level.clamp(0, 9) {
        1 => 2,
        l => l,
    };
    Deflate::new_with_config(DeflateConfig {
        level,
        method: Method::Deflated,
        window_bits: -window_bits(size_hint),
        mem_level: mem_level(mem, size_hint),
        strategy: Strategy::Default,
    })
}

/// Runs `deflate` until the input is consumed and, for flushing modes, until
/// all pending output has been written. Appends to `g.out`.
fn run_deflate(d: &mut Deflate, data: &[u8], flush: DeflateFlush) -> bool {
    let g = glob();
    let start_in = d.total_in();
    loop {
        let used = (d.total_in() - start_in) as usize;
        let spare = (data.len() - used) / 2 + 1024;
        g.out.reserve(spare);
        let before_out = d.total_out();
        let cap = g.out.capacity() - g.out.len();
        let status = match d.compress_uninit(&data[used..], g.out.spare_capacity_mut(), flush) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let produced = (d.total_out() - before_out) as usize;
        // SAFETY: zlib-rs initialised `produced` bytes of spare capacity.
        unsafe { g.out.set_len(g.out.len() + produced) };
        let done_in = (d.total_in() - start_in) as usize == data.len();
        match flush {
            DeflateFlush::Finish => {
                if status == Status::StreamEnd {
                    return true;
                }
            }
            _ => {
                if done_in && produced < cap {
                    return true;
                }
            }
        }
    }
}

/// One-shot raw DEFLATE. The scratch buffer holds `[dictionary | data]`.
/// Returns a pointer to the output; `check` receives the checksum of `data`.
#[no_mangle]
pub extern "C" fn deflate_once(level: i32, mem: i32, mode: i32, dict_len: usize, len: usize) -> *const u8 {
    let data = input(dict_len, len);
    let g = glob();
    g.out.clear();
    g.out.reserve(zlib_rs::compress_bound(len));
    let mut d = new_deflate(level, mem, len + dict_len);
    if dict_len > 0 {
        let dict = input(0, dict_len);
        let _ = d.set_dictionary(dict);
    }
    let ok = run_deflate(&mut d, data, DeflateFlush::Finish);
    let g = glob();
    g.err = if ok { -1 } else { E_LITLEN };
    g.consumed = checksum(mode, initial_checksum(mode), data) as usize;
    g.out_len = g.out.len();
    g.out.as_ptr()
}

/// Checksum of the last `deflate_once` input (stored in `consumed`).
#[no_mangle]
pub extern "C" fn last_check() -> u32 {
    glob().consumed as u32
}

pub struct DeflateStream {
    d: Deflate,
    mode: i32,
    check: u32,
}

#[no_mangle]
pub extern "C" fn def_new(level: i32, mem: i32, mode: i32, dict_len: usize) -> *mut DeflateStream {
    let mut d = new_deflate(level, mem, usize::MAX);
    if dict_len > 0 {
        let _ = d.set_dictionary(input(0, dict_len));
    }
    Box::into_raw(Box::new(DeflateStream { d, mode, check: initial_checksum(mode) }))
}

/// `flush`: 0 none, 1 block boundary (unaligned), 2 sync (byte aligned), 3 finish.
#[no_mangle]
pub unsafe extern "C" fn def_push(h: *mut DeflateStream, len: usize, flush: i32) -> *const u8 {
    let s = &mut *h;
    let data = input(0, len);
    s.check = checksum(s.mode, s.check, data);
    glob().out.clear();
    let flush = match flush {
        1 => DeflateFlush::Block,
        2 => DeflateFlush::SyncFlush,
        3 => DeflateFlush::Finish,
        _ => DeflateFlush::NoFlush,
    };
    let ok = run_deflate(&mut s.d, data, flush);
    let g = glob();
    g.err = if ok { -1 } else { E_LITLEN };
    g.out_len = g.out.len();
    g.out.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn def_check(h: *mut DeflateStream) -> u32 {
    (*h).check
}

#[no_mangle]
pub unsafe extern "C" fn def_free(h: *mut DeflateStream) {
    drop(Box::from_raw(h));
}

pub struct InflateStream {
    i: Inflate,
    ended: bool,
}

#[no_mangle]
pub extern "C" fn inf_new(dict_len: usize) -> *mut InflateStream {
    let mut i = Inflate::new(false, 15);
    if dict_len > 0 {
        let _ = i.set_dictionary(input(0, dict_len));
    }
    Box::into_raw(Box::new(InflateStream { i, ended: false }))
}

/// Inflates as much of `data` as possible into `g.out`, growing it unless
/// `limit` (> 0) caps the output. Returns 1 at end of stream, 0 when more input
/// is needed or the limit was reached, and -1 on error (`err` is set).
fn run_inflate(i: &mut Inflate, data: &[u8], limit: usize) -> i32 {
    let g = glob();
    let start_in = i.total_in();
    loop {
        let used = (i.total_in() - start_in) as usize;
        if limit > 0 {
            if g.out.len() >= limit {
                return 0;
            }
        } else if g.out.capacity() - g.out.len() < 1024 {
            let grow = (g.out.capacity()).max((data.len() - used) * 4).max(32768);
            g.out.reserve(grow);
        }
        let before_out = i.total_out();
        let spare = if limit > 0 {
            let room = limit - g.out.len();
            &mut g.out.spare_capacity_mut()[..room]
        } else {
            g.out.spare_capacity_mut()
        };
        let room = spare.len();
        let r = i.decompress_uninit(&data[used..], spare, InflateFlush::NoFlush);
        let produced = (i.total_out() - before_out) as usize;
        // SAFETY: zlib-rs initialised `produced` bytes of spare capacity.
        unsafe { g.out.set_len(g.out.len() + produced) };
        let now_used = (i.total_in() - start_in) as usize;
        match r {
            Ok(Status::StreamEnd) => {
                g.consumed = now_used;
                return 1;
            }
            Ok(_) => {
                if now_used == data.len() && produced < room {
                    g.consumed = now_used;
                    return 0;
                }
                if produced == 0 && now_used == used && produced < room {
                    g.consumed = now_used;
                    return 0;
                }
            }
            Err(_) => {
                g.err = map_inflate_error(i.error_message());
                g.consumed = now_used;
                return -1;
            }
        }
    }
}

/// Pushes `len` bytes from the scratch buffer. Returns the output pointer, or
/// null on error. `consumed` reports input bytes used; after the end of the
/// stream, remaining bytes are trailing data. `final_` makes a truncated
/// stream an unexpected-EOF error.
#[no_mangle]
pub unsafe extern "C" fn inf_push(h: *mut InflateStream, len: usize, final_: i32) -> *const u8 {
    let s = &mut *h;
    let g = glob();
    g.out.clear();
    g.err = -1;
    if s.ended {
        g.consumed = 0;
        g.out_len = 0;
        return g.out.as_ptr();
    }
    let r = run_inflate(&mut s.i, input(0, len), 0);
    let g = glob();
    if r < 0 {
        return core::ptr::null();
    }
    if r == 1 {
        s.ended = true;
    } else if final_ != 0 {
        g.err = E_EOF;
        return core::ptr::null();
    }
    g.out_len = g.out.len();
    g.out.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn inf_ended(h: *mut InflateStream) -> i32 {
    (*h).ended as i32
}

#[no_mangle]
pub unsafe extern "C" fn inf_free(h: *mut InflateStream) {
    drop(Box::from_raw(h));
}

/// One-shot raw inflate. Scratch buffer holds `[dictionary | data]`.
/// `size` > 0 caps the output at exactly that many bytes (truncating); otherwise
/// `hint` is an initial capacity guess. Returns null on error.
#[no_mangle]
pub extern "C" fn inflate_once(dict_len: usize, len: usize, size: usize, hint: usize) -> *const u8 {
    let data = input(dict_len, len);
    let g = glob();
    g.out.clear();
    g.err = -1;
    let want = if size > 0 { size } else { hint.max(len.saturating_mul(3)).max(1024) };
    g.out.reserve(want);
    let mut i = Inflate::new(false, 15);
    if dict_len > 0 {
        let _ = i.set_dictionary(input(0, dict_len));
    }
    let r = run_inflate(&mut i, data, size);
    let g = glob();
    if r < 0 {
        return core::ptr::null();
    }
    if r == 0 && !(size > 0 && g.out.len() >= size) {
        g.err = E_EOF;
        return core::ptr::null();
    }
    g.out_len = g.out.len();
    g.out.as_ptr()
}

/**
 * @shrug/serial-port — rolling-capture engine (Design B).
 *
 * The §2b session holder keeps a `socat` bridge open so a logged-in shell
 * survives across method runs, but it captures nothing emitted while *no* client
 * is attached — async kernel printk, a watchdog message, a panic trace that lands
 * on an idle line. Design B adds a **dedicated always-on drainer** that is the
 * sole reader of the holder's PTY slave and appends every console byte to an
 * on-disk ring, so those bytes are durably captured. Methods then read from a
 * saved stream offset.
 *
 * `socat -r` is deliberately NOT used: it records bytes only *as socat relays
 * them*, and with no PTY reader socat's write to the master blocks once the
 * ~16 KB buffer fills, so it stops reading the device and capture freezes
 * (measured: a 1 MB stream captured exactly 16,384 bytes and stalled). A UART
 * cannot be backpressured, so the overflow is dropped unseen — exactly the panic
 * trace the ring exists for. Capture is fed by a drainer that drains the device
 * *unconditionally*, in blocking read mode (`min 1 time 0`) so an idle gap is not
 * a 0-byte read that `cat` treats as EOF.
 *
 * ## What is pure vs live
 *
 * The offset/eviction/rotation arithmetic ({@link computeReadPlan},
 * {@link shouldRotate}, {@link retainedStart}, {@link captureBytes}) is pure over
 * the two-file (`.1` + current) window and is unit-tested with fixture files —
 * no hardware, no socat, no drainer. The drainer + socat spawn and the ring reads
 * touch the OS through subprocesses (like the device transport), so they are
 * proven live, not faked: the spawn has no in-process injection seam, exactly as
 * the §2b holder spawn does not.
 *
 * @module
 */
import type { SerialPort } from "./serial_port.ts";

/** Subprocess I/O timeout (mirrors serial_port.ts). */
const SUBPROC_IO_TIMEOUT_MS = 5_000;

// ── Ring paths ──────────────────────────────────────────────────────────────

/**
 * The per-user runtime dir the capture ring lives in. The ring holds the entire
 * console history — more sensitive than the §2b PTY link — so it lands in
 * `$XDG_RUNTIME_DIR` (0700, per-user) when set, falling back to `/tmp`. Promoted
 * into scope here from the §2b `/tmp`-hardening follow-up.
 */
export function captureRuntimeDir(): string {
  const x = Deno.env.get("XDG_RUNTIME_DIR");
  return x && x.length > 0 ? x : "/tmp";
}

/** Deterministic capture-ring path for a device (sanitised, sibling to the PTY). */
export function sessionCapturePath(device: string): string {
  return `${captureRuntimeDir()}/swamp-serial-${
    device.replace(/\W+/g, "_")
  }.cap`;
}

/** The retained previous-generation file for a ring (the single `.1` we keep). */
export function prevCapturePath(ringPath: string): string {
  return `${ringPath}.1`;
}

// ── Pure offset engine (unit-tested, no I/O) ────────────────────────────────

/**
 * The three numbers that locate the readable window in the capture stream. The
 * window retains two files (`.1` + current), so a *single* "bytes evicted"
 * scalar is off by exactly one file — the `.1` range is still readable but a
 * lone `captureBase` would mark it evicted. Hence two thresholds.
 */
export interface CaptureThresholds {
  /** Stream offset where the current file begins = Σ sizes of rotated-away files. */
  captureBase: number;
  /** Size of the retained `.1` file (0 when nothing has rotated yet). */
  prevSize: number;
  /** Size of the current ring file. */
  currentSize: number;
}

/** Lowest still-readable stream offset = the start of `.1`. */
export function retainedStart(t: CaptureThresholds): number {
  return t.captureBase - t.prevSize;
}

/** Total stream length ever produced = `captureBase + size(current)`. */
export function captureBytes(t: CaptureThresholds): number {
  return t.captureBase + t.currentSize;
}

/** A contiguous read from one backing file. */
export interface ReadSegment {
  file: "prev" | "current";
  /** Byte offset within that file. */
  start: number;
  len: number;
}

/** The resolved plan for a `capture_read`, independent of any byte I/O. */
export interface ReadPlan {
  /** Stream offset actually served (clamped up to `retainedStart` when evicted). */
  fromOffset: number;
  /** `fromOffset + bytes served`; the new cursor. Resumes mid-stream on truncation. */
  nextOffset: number;
  /** True when the requested `sinceOffset` was below `retainedStart` (rolled off). */
  evicted: boolean;
  /** Zero, one, or two segments (two when the range spans `.1` → current). */
  segments: ReadSegment[];
}

/**
 * Resolve which bytes a `capture_read` from `sinceOffset` (bounded by `maxBytes`)
 * should return, purely from the thresholds — no file access. The served range is
 * `[max(sinceOffset, retainedStart), min(sinceOffset + maxBytes, captureBytes))`;
 * an empty range (e.g. a deeply-evicted offset with a small `maxBytes`) is legal
 * and yields zero bytes with `evicted=true`. `len` is clamped to ≥ 0 — never
 * trust `upper − lower`, which can go negative.
 */
export function computeReadPlan(
  t: CaptureThresholds,
  sinceOffset: number,
  maxBytes: number,
): ReadPlan {
  const rStart = retainedStart(t);
  const cBytes = captureBytes(t);
  // `evicted` keys on retainedStart, NOT captureBase: the `.1` range
  // [retainedStart, captureBase) is still readable.
  const evicted = sinceOffset < rStart;
  // Clamp the low end into [retainedStart, captureBytes]: a caller-supplied
  // sinceOffset past the current stream end must not pin the cursor to a future
  // value (which would silently stall every default read until volume catches
  // up). An out-of-range-high offset resolves to "caught up at EOF".
  const lower = Math.min(Math.max(sinceOffset, rStart), cBytes);
  const upper = Math.min(sinceOffset + maxBytes, cBytes);
  const len = Math.max(0, upper - lower);
  const fromOffset = lower;
  const nextOffset = fromOffset + len;
  const segments: ReadSegment[] = [];
  if (len > 0) {
    const end = fromOffset + len;
    // Part backed by `.1`: [fromOffset, min(end, captureBase)).
    if (fromOffset < t.captureBase) {
      const pEnd = Math.min(end, t.captureBase);
      segments.push({
        file: "prev",
        start: fromOffset - rStart,
        len: pEnd - fromOffset,
      });
    }
    // Part backed by the current file: [max(fromOffset, captureBase), end).
    if (end > t.captureBase) {
      const cStart = Math.max(fromOffset, t.captureBase);
      segments.push({
        file: "current",
        start: cStart - t.captureBase,
        len: end - cStart,
      });
    }
  }
  return { fromOffset, nextOffset, evicted, segments };
}

/** The threshold updates a rotation applies (pure — the file dance is separate). */
export interface RotationThresholds {
  /** New `captureBase` after the current file becomes `.1`. */
  newCaptureBase: number;
  /** New `prevSize` (the rotated current file's final size). */
  newPrevSize: number;
}

/**
 * Whether the ring should rotate: the CURRENT FILE (not the monotonic total
 * stream length) has crossed `captureMaxBytes`. `captureMaxBytes` bounds one
 * generation, so the retained window (`.1` + current) is at most ~2×. Gating on
 * `captureBytes` would be a bug — that value only ever grows, so once the stream
 * first crosses the bound every subsequent read would rotate again, discarding
 * the `.1` the ring exists to keep.
 */
export function shouldRotate(
  t: CaptureThresholds,
  captureMaxBytes: number,
): boolean {
  return t.currentSize > captureMaxBytes;
}

/**
 * The thresholds after the current file (final size `currentSize`, sampled
 * AFTER the drainer is stopped so no in-flight append is stranded) becomes `.1`
 * and the old `.1` is discarded: `captureBase` advances by that size and
 * `prevSize` becomes it. `retainedStart` afterwards equals the old `captureBase`
 * — the old `.1` range rolls off to evicted.
 */
export function rotationThresholds(
  captureBase: number,
  currentSize: number,
): RotationThresholds {
  return {
    newCaptureBase: captureBase + currentSize,
    newPrevSize: currentSize,
  };
}

// ── Base64 (no dependency) ──────────────────────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode raw bytes as standard base64 (capture output carries control bytes). */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

// ── Subprocess-backed ring I/O (live; regular-file reads via dd/stat) ────────

/** Run a short shell snippet; returns {ok, stdout}. Never throws. */
async function sh(
  script: string,
  timeoutMs = SUBPROC_IO_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const out = await new Deno.Command("sh", {
      args: ["-c", script],
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    return { ok: out.success, stdout: new TextDecoder().decode(out.stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Byte size of a file, or 0 when it does not exist. */
export async function fileSize(path: string): Promise<number> {
  const { ok, stdout } = await sh(`stat -c %s -- ${shq(path)} 2>/dev/null`);
  const n = parseInt(stdout.trim(), 10);
  return ok && Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Single-quote a path for safe shell interpolation. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Read up to `len` bytes from `path` starting at byte `offset`, via `dd` (the
 * subprocess discipline the session holder uses — no in-process fs permission is
 * assumed). `iflag=skip_bytes,fullblock` makes `skip` a byte count and forces a
 * full block so a single short read cannot truncate the result. Returns the raw
 * bytes (binary-safe: `Deno.Command` stdout is a `Uint8Array`, not text).
 */
export async function readFileBytes(
  path: string,
  offset: number,
  len: number,
): Promise<Uint8Array> {
  if (len <= 0) return new Uint8Array(0);
  try {
    const out = await new Deno.Command("dd", {
      args: [
        `if=${path}`,
        `bs=${len}`,
        `skip=${offset}`,
        "count=1",
        "iflag=skip_bytes,fullblock",
      ],
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(SUBPROC_IO_TIMEOUT_MS),
    }).output();
    return out.success ? out.stdout : new Uint8Array(0);
  } catch {
    return new Uint8Array(0);
  }
}

/** Concatenate byte chunks into one buffer. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Read the bytes a {@link ReadPlan} resolves to from the backing files. Spans
 * `.1` → current when the plan has two segments. File-backed and testable
 * against fixture rings (no hardware).
 */
export async function readCaptureRange(
  currentPath: string,
  prevPath: string,
  plan: ReadPlan,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const seg of plan.segments) {
    const path = seg.file === "current" ? currentPath : prevPath;
    parts.push(await readFileBytes(path, seg.start, seg.len));
  }
  return concatBytes(parts);
}

/**
 * Load the live thresholds for a ring: `captureBase`/`prevSize` are the canonical
 * stored values; only the current file's size is stat'd fresh (it grows as the
 * drainer appends).
 */
export async function loadThresholds(
  ringPath: string,
  captureBase: number,
  prevSize: number,
): Promise<CaptureThresholds> {
  return { captureBase, prevSize, currentSize: await fileSize(ringPath) };
}

// ── Drainer + rotation (live spawn; no injection seam, like the §2b holder) ──

/** True when `pid` is a live process this user may signal. */
async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  return (await sh(`kill -0 ${pid} 2>/dev/null`)).ok;
}

/**
 * Spawn the detached drainer: the sole reader of the holder's PTY slave, blindly
 * appending every byte to `ringPath`. `setsid` detaches it from the spawning run
 * (no SIGHUP on exit); `stty min 1 time 0` forces blocking reads so an idle gap
 * is not a 0-byte read that ends `cat` at EOF; `>>`/`O_APPEND` means a benign
 * reopen cannot duplicate bytes at a seam. It never parses and never self-rotates
 * — rotation is a model operation ({@link rotateRing}) so it serialises against
 * `exec`/`read` on the model lock. Returns the drainer pid.
 *
 * The ring is force-created `0600` before capture begins: it holds the entire
 * console history and `captureRuntimeDir()` may fall back to world-traversable
 * `/tmp` (when `$XDG_RUNTIME_DIR` is unset, e.g. a systemd/cron/container run),
 * so its confidentiality cannot rest on the directory mode alone.
 */
export async function startDrainer(
  ptyLink: string,
  ringPath: string,
): Promise<number> {
  const prev = prevCapturePath(ringPath);
  const script = `umask 077; touch ${shq(ringPath)}; ` +
    `chmod 600 ${shq(ringPath)} ${shq(prev)} 2>/dev/null; ` +
    `stty -F ${shq(ptyLink)} min 1 time 0 2>/dev/null; ` +
    `exec cat ${shq(ptyLink)} >> ${shq(ringPath)}`;
  const started = await sh(
    `setsid sh -c ${shq(script)} >/dev/null 2>&1 </dev/null & echo $!`,
  );
  const pid = parseInt(started.stdout.trim(), 10);
  if (!started.ok || !Number.isInteger(pid)) {
    throw new Error(
      `Failed to launch capture drainer for ${ptyLink} → ${ringPath}.`,
    );
  }
  // Confirm it came up (the PTY slave must be openable — the holder is up).
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await pidAlive(pid)) return pid;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Capture drainer for ${ptyLink} did not stay up (is the holder PTY live?).`,
  );
}

/** SIGTERM the drainer (if alive). Best-effort. */
export async function stopDrainer(pid: number | null): Promise<void> {
  if (pid !== null && await pidAlive(pid)) await sh(`kill ${pid} 2>/dev/null`);
}

/** Remove a ring and its retained `.1` (used on `session_stop` without keep). */
export async function removeRing(ringPath: string): Promise<void> {
  await sh(`rm -f ${shq(ringPath)} ${shq(prevCapturePath(ringPath))}`);
}

/** The outcome of a rotation: the new thresholds + whether capture is still up. */
export interface RotationResult extends RotationThresholds {
  /** New drainer pid, or null when the restart failed. */
  drainerPid: number | null;
  /** True when a fresh drainer is confirmed running post-rotation. */
  drainerAlive: boolean;
}

/**
 * Perform a rotation: stop the old drainer, sample the current file's FINAL size
 * (only now that the drainer can no longer append — so bytes drained in the
 * decision→kill window are not stranded, and the offset math matches disk),
 * discard the old `.1`, `mv current → .1`, recreate an empty current, and start
 * a fresh drainer. Returns the post-rotation thresholds and whether the restart
 * succeeded. The caller (holding the model lock, so no `exec`/`read` overlaps)
 * persists these thresholds to the `session` resource REGARDLESS of restart
 * success — otherwise a failed restart would leave the record's offsets
 * disagreeing with the on-disk files and mis-seek the next read.
 *
 * A brief gap (the drainer down for the `mv`+restart, a few ms) drops bytes the
 * board emits into the closed tty; accepted for v1 (true zero-gap needs an
 * in-place wrap or an fd handoff — B.5).
 */
export async function rotateRing(
  ptyLink: string,
  ringPath: string,
  oldDrainerPid: number | null,
  captureBase: number,
): Promise<RotationResult> {
  const prev = prevCapturePath(ringPath);
  await stopDrainer(oldDrainerPid);
  const finalSize = await fileSize(ringPath); // stable: drainer is stopped
  const th = rotationThresholds(captureBase, finalSize);
  // `umask 077` so the freshly-recreated current file is 0600 from creation —
  // startDrainer re-chmods it too, but this closes the window before that runs
  // (the ring may land in world-traversable /tmp). `.1` keeps current's bits
  // through the `mv`.
  await sh(
    `umask 077; rm -f ${shq(prev)}; mv -f ${shq(ringPath)} ${shq(prev)}; : > ${
      shq(ringPath)
    }`,
  );
  try {
    const drainerPid = await startDrainer(ptyLink, ringPath);
    return { ...th, drainerPid, drainerAlive: true };
  } catch {
    // The irreversible file dance is done; report the dead drainer so the
    // caller records capturing=false + the new thresholds (disk == record).
    return { ...th, drainerPid: null, drainerAlive: false };
  }
}

/**
 * A {@link SerialPort} whose writes go to the holder's PTY (socat → device) but
 * whose reads come *forward from the capture ring* rather than the PTY. This is
 * the read-path unification: with the drainer owning the one PTY slave, an
 * interactive call must not also read the PTY (two readers would split the byte
 * stream), so it records the ring's current end and reads forward from there —
 * `execOn`/`drainUntil`/`loginOn` run unchanged over this port. No rotation can
 * fire mid-call (rotation is a model op on the same lock), so the current file is
 * stable and a plain forward file cursor suffices.
 *
 * Each read is stat-gated: `drainUntil` polls every ~20 ms, so spawning a `dd`
 * on every idle poll would be a subprocess storm. A cheap `stat` short-circuits
 * to 0 bytes when the ring has not grown, and `dd` runs only when there is new
 * data (bounded to `buf.length`). (A persistent tail reader would cut even the
 * stat spawns — a follow-up; the subprocess discipline of #1350 is kept here.)
 */
export async function ringReadPort(
  pty: SerialPort,
  ringPath: string,
): Promise<SerialPort> {
  // Record the current stream end BEFORE any command is written: the response
  // is whatever the drainer appends past this point.
  let pos = await fileSize(ringPath);
  return {
    write: (bytes: Uint8Array) => pty.write(bytes),
    read: async (buf: Uint8Array): Promise<number | null> => {
      const size = await fileSize(ringPath);
      if (size <= pos) return 0; // nothing new — no dd spawn while idle
      const want = Math.min(buf.length, size - pos);
      const bytes = await readFileBytes(ringPath, pos, want);
      if (bytes.length === 0) return 0;
      buf.set(bytes.subarray(0, buf.length));
      pos += bytes.length;
      return bytes.length;
    },
    close: () => pty.close(),
  };
}

// ── Secret redaction in the ring (CAP-2) ─────────────────────────────────────

/** First index of `needle` in `hay` at or after `from`, or -1. */
export function indexOfBytes(
  hay: Uint8Array,
  needle: Uint8Array,
  from = 0,
): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  outer:
  for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Overwrite `bytes` at byte `offset` in `path` in place (no truncation). */
async function writeFileBytesAt(
  path: string,
  offset: number,
  bytes: Uint8Array,
): Promise<boolean> {
  if (bytes.length === 0) return true;
  try {
    const child = new Deno.Command("dd", {
      args: [
        `of=${path}`,
        `bs=${bytes.length}`,
        `seek=${offset}`,
        "count=1",
        "conv=notrunc",
        // `iflag=fullblock` is LOAD-BEARING: dd reads its (piped) stdin one
        // read() at a time, and a pipe read returns as soon as any bytes are
        // available (often ≤64 KiB). Without fullblock, `count=1` would treat
        // that first short read as the whole block, write only a prefix, and
        // still exit 0 — silently leaving the rest of a large redaction tail
        // (i.e. plaintext password bytes past the boundary) unwritten. fullblock
        // makes dd accumulate the full `bs` from stdin before writing.
        "iflag=fullblock",
        "oflag=seek_bytes",
      ],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
      signal: AbortSignal.timeout(SUBPROC_IO_TIMEOUT_MS),
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(bytes);
    await w.close();
    return (await child.status).success;
  } catch {
    return false;
  }
}

/**
 * Redact every occurrence of `secret` in the ring's tail `[fromOffset, EOF)`,
 * overwriting each with an EQUAL-length run of `*` (offset-preserving, so the
 * capture stream offsets are unchanged) via an in-place `dd conv=notrunc`. The
 * drainer records raw PTY bytes with no scrub of its own, so a `login` whose
 * far-end console echoes the password would otherwise persist it in plaintext;
 * this is called after such a login (which serialises on the model lock, so no
 * concurrent reader), bounded to the login span. Post-login appends past EOF are
 * untouched. Same substring-match limitation as the transcript `scrubSecret`.
 * Returns the number of occurrences redacted.
 */
export async function redactSecretInRing(
  ringPath: string,
  fromOffset: number,
  secret: string,
): Promise<number> {
  if (!secret) return 0;
  const sec = new TextEncoder().encode(secret);
  if (sec.length === 0) return 0;
  const size = await fileSize(ringPath);
  if (size <= fromOffset) return 0;
  const tail = await readFileBytes(ringPath, fromOffset, size - fromOffset);
  let count = 0;
  let idx = indexOfBytes(tail, sec, 0);
  while (idx >= 0) {
    tail.fill(0x2a, idx, idx + sec.length); // '*'
    count++;
    idx = indexOfBytes(tail, sec, idx + sec.length);
  }
  if (count > 0) await writeFileBytesAt(ringPath, fromOffset, tail);
  return count;
}

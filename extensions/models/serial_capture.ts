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
 * {@link planRotation}, {@link retainedStart}, {@link captureBytes}) is pure over
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
  const lower = Math.max(sinceOffset, rStart);
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
export interface RotationPlan {
  rotate: boolean;
  /** New `captureBase` after the current file becomes `.1`. */
  newCaptureBase: number;
  /** New `prevSize` (the old current file's size). */
  newPrevSize: number;
}

/**
 * Decide whether the ring should rotate and the thresholds it moves to. Rotation
 * fires when the total stream length crosses `captureMaxBytes`: the current file
 * becomes `.1` (the old `.1` is discarded), so `captureBase` advances by the old
 * current size and `prevSize` becomes that size. `retainedStart` after rotation
 * equals the *old* `captureBase` — the old `.1` range rolls off to evicted.
 */
export function planRotation(
  t: CaptureThresholds,
  captureMaxBytes: number,
): RotationPlan {
  if (captureBytes(t) <= captureMaxBytes || t.currentSize <= 0) {
    return {
      rotate: false,
      newCaptureBase: t.captureBase,
      newPrevSize: t.prevSize,
    };
  }
  return {
    rotate: true,
    newCaptureBase: t.captureBase + t.currentSize,
    newPrevSize: t.currentSize,
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
 */
export async function startDrainer(
  ptyLink: string,
  ringPath: string,
): Promise<number> {
  const script = `stty -F ${shq(ptyLink)} min 1 time 0 2>/dev/null; ` +
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

/**
 * Perform the file dance of a rotation: stop the old drainer, discard the old
 * `.1`, `mv current → .1`, recreate an empty current, and start a fresh drainer.
 * Returns the new drainer pid. The threshold updates are computed separately by
 * {@link planRotation} and written to the `session` resource by the caller, which
 * holds the model lock — so no `exec`/`read` overlaps this teardown.
 *
 * A brief gap (the drainer/socat down for the `mv`+restart, a few ms) drops bytes
 * the board emits into the closed tty; accepted for v1 (true zero-gap needs an
 * in-place wrap or an fd handoff — B.5).
 */
export async function rotateRing(
  ptyLink: string,
  ringPath: string,
  oldDrainerPid: number | null,
): Promise<number> {
  const prev = prevCapturePath(ringPath);
  await stopDrainer(oldDrainerPid);
  await sh(
    `rm -f ${shq(prev)}; mv -f ${shq(ringPath)} ${shq(prev)}; : > ${
      shq(ringPath)
    }`,
  );
  return await startDrainer(ptyLink, ringPath);
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
      const bytes = await readFileBytes(ringPath, pos, buf.length);
      if (bytes.length === 0) return 0;
      buf.set(bytes.subarray(0, buf.length));
      pos += bytes.length;
      return bytes.length;
    },
    close: () => pty.close(),
  };
}

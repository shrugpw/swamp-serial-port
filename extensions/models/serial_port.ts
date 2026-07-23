/**
 * @shrug/serial-port — do actions over a USB-UART serial line.
 *
 * A swamp model type for driving a device on a serial console (e.g. a Banana Pi
 * on /dev/ttyUSB0 at 115200 8N1): configure the port, send commands, and
 * capture responses. Methods:
 *
 * - `establish` — validate + configure the port (stty), probe it, record the
 *   `port` resource. Fails loudly when the port is held by another process.
 * - `send`      — write one line (or raw bytes) to the port.
 * - `read`      — drain inbound bytes until idle or a cap.
 * - `exec`      — send a command line, read the response until the prompt
 *   returns or the line goes idle. The console-shell primitive.
 * - `login`     — answer a getty login (login: / Password:) from a vaulted
 *   credential, then confirm the shell prompt.
 * - `session_start` / `session_stop` / `session_status` — run a persistent
 *   `socat` holder that keeps the port (and its login) open across separate
 *   method runs; the I/O methods above auto-attach to it when it is live.
 *
 * ## Design
 *
 * Deno has no native termios/serial API, and native npm serial modules do not
 * survive swamp's bundler. So line configuration always shells out to `stty(1)`,
 * and byte I/O runs over one of two transports selected by the `transport`
 * global:
 *
 * - `direct` — `Deno.open()` raw fd read/write. Fast, but needs the runtime to
 *   grant read+write on the device path.
 * - `subprocess` — `dd(1)` for each read/write. Needs only `--allow-run`, so it
 *   works under a swamp build that scopes fs permissions and denies an in-process
 *   `Deno.open` of a device node.
 * - `auto` (default) — try `direct`, and transparently fall back to `subprocess`
 *   when the runtime denies the device open.
 *
 * The protocol logic (drain / exec / login) is written against an abstract
 * `SerialPort` and an injectable `Clock`, so the whole method surface is unit
 * tested with a scripted fake port and a fake clock — no hardware attached.
 * Only the transport layer touches the OS.
 *
 * ## Config inheritance
 *
 * `establish` records the active line config as the `port` resource. `send` /
 * `read` / `exec` / `login` resolve their effective config as
 * `method arg > establish-recorded port resource > model global default`.
 *
 * ## Safety
 *
 * `device` is constrained to real serial tty paths, so `login` cannot be steered
 * to write the vaulted password to an arbitrary terminal. Stop-pattern matching
 * runs against a bounded suffix of the captured output, and `idleMs`/`maxMs`
 * carry ceilings — bounding both memory and regex work. Cross-instance
 * exclusivity is a documented limitation for one-shot methods (external holders
 * are detected via EBUSY; this model does not claim a TIOCEXCL lock) — but while
 * a `session_start` holder runs it owns the device, so a rival open sees EBUSY
 * for real. Attach only ever redirects to a PTY recorded in our own `session`
 * resource, so the vaulted password still cannot be steered to an arbitrary path.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ── Constants ───────────────────────────────────────────────────────────────

/** Data/parity/stop framing grammar, e.g. 8N1. */
const FRAMING_RE = /^[5-8][NEO][12]$/;
/** Serial device paths login() may write secrets to. */
const ALLOWED_DEVICE_RE =
  /^\/dev\/(ttyUSB\d+|ttyACM\d+|ttyS\d+|serial\/[A-Za-z0-9._/-]+)$/;
/** Ceilings so a caller cannot remove the time bound entirely. */
const IDLE_MS_MAX = 60_000;
const MAX_MS_MAX = 600_000;
/** Stop-regex is tested against at most this many trailing chars. */
const STOP_TAIL = 512;
/** Deci-seconds VTIME: each blocking read waits at most this long. */
const READ_VTIME_DS = 1;
/** Safety timeout for a single dd write spawn. */
const SUBPROC_IO_TIMEOUT_MS = 5_000;
/** How long a subprocess read waits for new bytes before reporting idle. */
const SUBPROC_READ_POLL_MS = 100;

// ── Config schemas ──────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  device: z.string().min(1).default("/dev/ttyUSB0").describe(
    "Serial device path, e.g. /dev/ttyUSB0.",
  ),
  baud: z.number().int().positive().default(115200).describe(
    "Baud rate. Default 115200.",
  ),
  framing: z.string().regex(FRAMING_RE).default("8N1").describe(
    "Data/parity/stop framing, e.g. 8N1 (8 data bits, no parity, 1 stop bit).",
  ),
  lineEnding: z.string().default("\n").describe(
    "Line terminator appended to sent lines. Default LF; use \\r for consoles that need carriage return.",
  ),
  transport: z.enum(["auto", "direct", "subprocess"]).default("auto").describe(
    "Byte-I/O transport: 'direct' (Deno.open raw fd), 'subprocess' (dd, needs only allow-run), or 'auto' (direct with subprocess fallback on a device-open permission denial).",
  ),
  username: z.string().optional().describe(
    "Default username for `login`.",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Default password for `login`, resolved from a vault reference. Never a literal.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Per-call overrides shared by every method. */
interface Overrides {
  device?: string;
  baud?: number;
  framing?: string;
  lineEnding?: string;
}

/** The effective per-call line configuration. */
interface PortConfig {
  device: string;
  baud: number;
  framing: string;
  lineEnding: string;
}

const OverrideArgs = {
  device: z.string().min(1).optional(),
  baud: z.number().int().positive().optional(),
  framing: z.string().regex(FRAMING_RE).optional(),
  lineEnding: z.string().optional(),
};

const idleMsArg = (def: number) =>
  z.number().int().positive().max(IDLE_MS_MAX).default(def);
const maxMsArg = (def: number) =>
  z.number().int().positive().max(MAX_MS_MAX).default(def);

// ── Resource schemas ────────────────────────────────────────────────────────

const PortResourceSchema = z.object({
  device: z.string(),
  baud: z.number(),
  framing: z.string(),
  lineEnding: z.string(),
  probedAt: z.iso.datetime(),
  probe: z.string(),
});

type PortResource = z.infer<typeof PortResourceSchema>;

const SentResourceSchema = z.object({
  device: z.string(),
  bytesWritten: z.number(),
  sentAt: z.iso.datetime(),
});

const CapturedResourceSchema = z.object({
  device: z.string(),
  capturedAt: z.iso.datetime(),
  output: z.string(),
});

const ExecResourceSchema = z.object({
  device: z.string(),
  command: z.string(),
  ranAt: z.iso.datetime(),
  matchedPrompt: z.boolean(),
  output: z.string(),
});

const LoginResourceSchema = z.object({
  device: z.string(),
  username: z.string(),
  attemptedAt: z.iso.datetime(),
  status: z.enum(["ok", "failed"]),
  transcript: z.string(),
});

const SessionResourceSchema = z.object({
  device: z.string(),
  ptyLink: z.string().describe(
    "The PTY the holder exposes; I/O methods attach here instead of `device`.",
  ),
  holderPid: z.number().int(),
  baud: z.number(),
  framing: z.string(),
  lineEnding: z.string(),
  startedAt: z.iso.datetime(),
  live: z.boolean().describe("Liveness at the time this record was written."),
  checkedAt: z.iso.datetime(),
  stoppedAt: z.iso.datetime().optional(),
});
type SessionResource = z.infer<typeof SessionResourceSchema>;

// ── Device allow-list ───────────────────────────────────────────────────────

/** True when `device` is a real serial tty path this model may drive. */
export function isAllowedDevice(device: string): boolean {
  if (!ALLOWED_DEVICE_RE.test(device)) return false;
  // The serial/ branch permits '.' (by-path names use it), so guard against
  // `.`/`..` path segments that would traverse out of /dev — critical because
  // the subprocess (dd) transport is NOT subject to Deno's fs sandbox.
  return !device.split("/").some((seg) => seg === "." || seg === "..");
}

/** Throw unless `device` is an allowed serial tty path. */
export function assertAllowedDevice(device: string): void {
  if (!isAllowedDevice(device)) {
    throw new Error(
      `Refusing device "${device}": only serial tty paths are allowed ` +
        `(/dev/ttyUSB*, /dev/ttyACM*, /dev/ttyS*, /dev/serial/*). This guards ` +
        `login() against writing the password to an arbitrary terminal.`,
    );
  }
}

// ── Transport seam ──────────────────────────────────────────────────────────

/** An open serial port. read() returns bytes read, or null on no-data/EOF. */
export interface SerialPort {
  write(bytes: Uint8Array): Promise<number>;
  read(buf: Uint8Array): Promise<number | null>;
  close(): void;
}

/** Opens and configures serial ports. The one OS-touching seam. */
export interface Transport {
  /** Apply line settings (baud, framing, raw, VMIN/VTIME). Throws on a held port. */
  configure(cfg: PortConfig): Promise<void>;
  /** Open the device for read+write. Throws on a held port. */
  open(device: string): Promise<SerialPort>;
}

/** A clock, injectable so drains are deterministic under test. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
};

/** Translate an 8N1-style framing string into stty tokens. */
export function framingArgs(framing: string): string[] {
  const m = /^([5-8])([NEO])([12])$/.exec(framing);
  if (!m) throw new Error(`Invalid framing "${framing}" (expected e.g. 8N1)`);
  const [, bits, parity, stop] = m;
  const args = [`cs${bits}`];
  if (parity === "N") args.push("-parenb");
  else args.push("parenb", parity === "O" ? "parodd" : "-parodd");
  args.push(stop === "2" ? "cstopb" : "-cstopb");
  return args;
}

/** True when an error is a Deno permission denial (device open refused). */
export function isPermissionError(e: unknown): boolean {
  const NotCapable = (Deno.errors as { NotCapable?: new () => Error })
    .NotCapable;
  if (NotCapable && e instanceof NotCapable) return true;
  if (e instanceof Deno.errors.PermissionDenied) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /requires .*access|permission denied|--allow-all|not capable/i.test(
    msg,
  );
}

/** Run one stty(1) invocation against `device`, mapping failures to clear
 *  errors (busy port held elsewhere, missing binary). */
async function runStty(device: string, settings: string[]): Promise<void> {
  let out;
  try {
    out = await new Deno.Command("stty", {
      args: ["-F", device, ...settings],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    throw new Error(
      `Failed to run stty for ${device}: ${
        (e as Error).message
      }. Is stty(1) on PATH?`,
    );
  }
  if (!out.success) {
    const err = new TextDecoder().decode(out.stderr).trim();
    if (/busy/i.test(err)) {
      throw new Error(
        `Port ${device} is busy — held by another process (screen/minicom/another swamp run). Free it first.`,
      );
    }
    throw new Error(
      `stty failed for ${device}: ${err || `exit ${out.code}`}`,
    );
  }
}

/**
 * stty(1) line configuration shared by every transport: baud, raw framing,
 * no echo. VMIN/VTIME are deliberately NOT set here — each transport applies
 * its own read timing via applyReadMode() right before it opens the port,
 * because the subprocess `cat` reader and the in-process direct poll loop need
 * opposite settings. (Note: `raw` alone leaves min 1 / time 0, so any transport
 * that wants promptly-returning reads must assert it explicitly.)
 */
async function configureStty(cfg: PortConfig): Promise<void> {
  await runStty(cfg.device, [
    String(cfg.baud),
    "raw",
    "-echo",
    "clocal",
    "-crtscts",
    ...framingArgs(cfg.framing),
  ]);
}

/**
 * Read-timing mode, applied per transport after the shared line config:
 *  - "poll"  (min 0 / time N): read() returns 0 promptly on an idle line, which
 *    the direct transport's in-process loop relies on to detect quiescence.
 *  - "block" (min 1 / time 0): read() blocks until ≥1 byte arrives, so the
 *    long-lived `cat` reader never sees a zero-length read — which it would
 *    treat as EOF and exit on the first quiet moment, delivering only one
 *    command's response per session. The subprocess transport detects idle
 *    host-side (ByteQueue + SUBPROC_READ_POLL_MS), so blocking reads are
 *    exactly what it wants. This is the fix for the gather-all-unknown bug.
 */
async function applyReadMode(
  device: string,
  mode: "poll" | "block",
): Promise<void> {
  const settings = mode === "block"
    ? ["min", "1", "time", "0"]
    : ["min", "0", "time", String(READ_VTIME_DS)];
  await runStty(device, settings);
}

/** Direct raw-fd port via Deno.open (needs read+write on the device path). */
async function openDirect(device: string): Promise<SerialPort> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(device, { read: true, write: true });
  } catch (e) {
    if (e instanceof Deno.errors.Busy) {
      throw new Error(
        `Port ${device} is busy — held by another process. Free it first.`,
      );
    }
    if (isPermissionError(e)) throw e; // let `auto` detect / surface
    throw new Error(`Failed to open ${device}: ${(e as Error).message}`);
  }
  // The in-process read loop polls, so it needs promptly-returning reads.
  await applyReadMode(device, "poll");
  return {
    async write(bytes: Uint8Array): Promise<number> {
      let total = 0;
      while (total < bytes.length) {
        const n = await file.write(bytes.subarray(total));
        if (n <= 0) {
          throw new Error(
            `Serial write to ${device} made no progress (${total}/${bytes.length} bytes)`,
          );
        }
        total += n;
      }
      return total;
    },
    read(buf: Uint8Array): Promise<number | null> {
      return file.read(buf);
    },
    close(): void {
      file.close();
    },
  };
}

/** Spawn a helper, feed optional stdin, and return its stdout bytes. */
async function runCapture(
  cmd: string,
  args: string[],
  stdin: Uint8Array | undefined,
): Promise<Uint8Array> {
  const command = new Deno.Command(cmd, {
    args,
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(SUBPROC_IO_TIMEOUT_MS),
  });
  let res;
  try {
    if (!stdin) {
      res = await command.output();
    } else {
      const child = command.spawn();
      try {
        const w = child.stdin.getWriter();
        await w.write(stdin);
        await w.close();
        res = await child.output();
      } catch (e) {
        // Broken pipe / dead child mid-write: kill and reap so a lingering dd
        // can't keep the serial device held (self-inflicted port-busy).
        try {
          child.kill("SIGTERM");
        } catch { /* already gone */ }
        await child.status.catch(() => {});
        throw e;
      }
    }
  } catch (e) {
    throw new Error(`${cmd} on serial device failed: ${(e as Error).message}`);
  }
  if (!res.success) {
    // Killed by our timeout signal → res.signal set; otherwise a real failure.
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(
      `${cmd} on serial device failed: ${
        err || `exit ${res.code ?? res.signal}`
      }`,
    );
  }
  return res.stdout;
}

/**
 * A FIFO byte buffer that drains into fixed-size reads. Splits chunks larger
 * than the read buffer across successive `take` calls, so no bytes are dropped.
 */
export class ByteQueue {
  #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#length += chunk.length;
    }
  }

  /** Copy up to `buf.length` bytes into `buf`, buffering any remainder. */
  take(buf: Uint8Array): number {
    let off = 0;
    while (off < buf.length && this.#chunks.length > 0) {
      const head = this.#chunks[0];
      const n = Math.min(head.length, buf.length - off);
      buf.set(head.subarray(0, n), off);
      off += n;
      this.#length -= n;
      if (n === head.length) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(n);
    }
    return off;
  }
}

/**
 * Subprocess port: needs only --allow-run, so it works under a swamp build that
 * denies an in-process Deno.open of a device node. A single long-lived `cat`
 * holds the port open for the whole session and streams RX into a ByteQueue, so
 * bytes are never dropped between reads (the fix for dd-per-poll gap loss).
 * Reads drain the queue, waiting up to SUBPROC_READ_POLL_MS for new bytes before
 * reporting idle. Writes are short-lived `dd of=DEV` spawns.
 *
 * The port is switched to blocking reads (min 1 / time 0) before `cat` starts:
 * with the poll setting (min 0 / time N) `cat`'s read() returns 0 on an idle
 * line, which it treats as EOF and exits — so a multi-command session would get
 * exactly one response. We assert it here, before the reader opens, so no opener
 * touches the device path once the reader is live.
 */
async function openSubprocess(device: string): Promise<SerialPort> {
  await applyReadMode(device, "block");
  const child = new Deno.Command("cat", {
    args: [device],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const streamReader = child.stdout.getReader();
  const queue = new ByteQueue();
  let ended = false;
  let pumpError: unknown = null;
  let closed = false;

  // Background pump: continuously drain the reader into the queue.
  (async () => {
    try {
      while (true) {
        const { value, done } = await streamReader.read();
        if (done) break;
        if (value) queue.push(value);
      }
    } catch (e) {
      if (!closed) pumpError = e;
    } finally {
      ended = true;
    }
  })();

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    async write(bytes: Uint8Array): Promise<number> {
      await runCapture(
        "dd",
        [`of=${device}`, "conv=notrunc", "status=none"],
        bytes,
      );
      return bytes.length;
    },
    async read(buf: Uint8Array): Promise<number | null> {
      const deadline = Date.now() + SUBPROC_READ_POLL_MS;
      while (queue.length === 0 && !ended && Date.now() < deadline) {
        await sleep(5);
      }
      if (pumpError) {
        throw new Error(
          `Serial read from ${device} failed: ${(pumpError as Error).message}`,
        );
      }
      if (queue.length > 0) return queue.take(buf);
      return ended ? null : 0; // stream closed vs. quiet-line idle
    },
    close(): void {
      if (closed) return;
      closed = true;
      streamReader.cancel().catch(() => {});
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      child.status.catch(() => {}); // reap, don't await
    },
  };
}

/** Direct-only transport (surfaces a permission denial with a hint). */
export function makeDirectTransport(): Transport {
  return {
    configure: configureStty,
    async open(device: string): Promise<SerialPort> {
      try {
        return await openDirect(device);
      } catch (e) {
        if (isPermissionError(e)) {
          throw new Error(
            `Direct Deno.open of ${device} was denied by the runtime (${
              (e as Error).message
            }). ` +
              `Set transport: "subprocess" or "auto".`,
          );
        }
        throw e;
      }
    },
  };
}

/** Subprocess-only transport (dd). */
export function makeSubprocessTransport(): Transport {
  return {
    configure: configureStty,
    open: (device: string) => openSubprocess(device),
  };
}

/** Direct, falling back to subprocess on a device-open permission denial. */
export function makeAutoTransport(
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void },
): Transport {
  return {
    configure: configureStty,
    async open(device: string): Promise<SerialPort> {
      try {
        return await openDirect(device);
      } catch (e) {
        if (isPermissionError(e)) {
          logger?.info(
            "Direct Deno.open denied on {device}; falling back to subprocess (dd) I/O",
            { device },
          );
          return await openSubprocess(device);
        }
        throw e;
      }
    },
  };
}

/** Pick a transport by mode. */
export function selectTransport(
  mode: "auto" | "direct" | "subprocess",
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void },
): Transport {
  switch (mode) {
    case "direct":
      return makeDirectTransport();
    case "subprocess":
      return makeSubprocessTransport();
    default:
      return makeAutoTransport(logger);
  }
}

/** Configure + open a port, run `fn`, and always close the fd. */
export async function withPort<T>(
  transport: Transport,
  cfg: PortConfig,
  fn: (port: SerialPort) => Promise<T>,
): Promise<T> {
  await transport.configure(cfg);
  const port = await transport.open(cfg.device);
  try {
    return await fn(port);
  } finally {
    port.close();
  }
}

// ── Session holder (socat + PTY) ────────────────────────────────────────────
//
// A persistent session keeps the port open across *separate* method runs so the
// logged-in shell survives (logout→login→gather as distinct runs, or a workflow
// chaining serial steps). `socat` opens the real device ONCE and bridges it to a
// PTY; each I/O method attaches to that PTY instead of the device, opening and
// closing only the PTY between calls while the real port — and the login on it —
// stays up. Validated on hardware: a `cd` in one run is still in effect in the
// next. This upgrades the "cross-instance exclusivity is a documented
// limitation" note: while a holder runs it owns the device, so a rival open sees
// EBUSY for real. All OS pokes here go through subprocesses (like the transport),
// so nothing depends on an in-process fs/device permission the runtime may deny.

/** Deterministic PTY link + holder log paths for a device (sanitised). */
export function sessionPtyPath(device: string): string {
  return `/tmp/swamp-serial-${device.replace(/\W+/g, "_")}.pty`;
}
function holderLogPath(device: string): string {
  return `/tmp/swamp-serial-${device.replace(/\W+/g, "_")}.log`;
}

/** Translate line config into socat serial address options (mirrors stty). */
export function socatDeviceOpts(cfg: PortConfig): string {
  const m = /^([5-8])([NEO])([12])$/.exec(cfg.framing);
  if (!m) {
    throw new Error(`Invalid framing "${cfg.framing}" (expected e.g. 8N1)`);
  }
  const [, bits, parity, stop] = m;
  const opts = ["raw", "echo=0", `b${cfg.baud}`, `cs${bits}`];
  if (parity === "N") opts.push("parenb=0");
  else opts.push("parenb=1", parity === "O" ? "parodd=1" : "parodd=0");
  opts.push(
    `cstopb=${stop === "2" ? 1 : 0}`,
    "clocal=1",
    "crtscts=0",
    "hupcl=0",
  );
  return opts.join(",");
}

/** Run a short shell snippet; returns {ok, stdout}. Never throws on non-zero. */
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

/** True when `pid` is a live process this user may signal. */
async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  return (await sh(`kill -0 ${pid} 2>/dev/null`)).ok;
}

/** True when the PTY link the holder created still exists. */
async function linkExists(path: string): Promise<boolean> {
  return (await sh(`test -e ${path}`)).ok;
}

/**
 * A recorded session is live iff its PTY link still exists AND its holder pid is
 * still running. The link path is derived from the device (ours alone), so an
 * existing link + a live pid uniquely identifies our holder for MVP purposes.
 */
async function isSessionLive(s: SessionResource): Promise<boolean> {
  return (await linkExists(s.ptyLink)) && (await pidAlive(s.holderPid));
}

/**
 * Host-level liveness for a device's held session, usable by callers that cannot
 * read the (instance-scoped) `session` resource — notably the sibling
 * `@shrug/serial-cfgmgmt/*` types, whose model instance differs from the one the
 * `serial-port` `session_start` recorded the resource on. Both share the same
 * host device, and the PTY link path is deterministic (`sessionPtyPath`), so a
 * `test -e` on that link is enough to decide whether to attach: `-e` follows the
 * symlink to `/dev/pts/N`, which disappears when the socat holder dies, so a dead
 * holder reads false and the caller transparently falls back to open/close.
 *
 * This is deliberately weaker than {@link isSessionLive} (link-only, no pid
 * check) because a cross-model caller has no pid to check. The residual risk —
 * an unrelated process reusing the exact `/dev/pts/N` the stale link still points
 * at — is negligible and the same class `isSessionLive`'s pid check guards
 * against; cfgmgmt simply can't perform that check.
 */
export async function sessionLinkLive(device: string): Promise<boolean> {
  return await linkExists(sessionPtyPath(device));
}

/**
 * Spawn a detached `socat` that owns `cfg.device` and exposes it as `ptyLink`.
 * `setsid` puts it in a new session (no SIGHUP when the spawning run exits) and
 * its stdio is redirected to a log file, so this returns as soon as the shell
 * backgrounds it. Returns the holder pid once the PTY link appears.
 */
async function startHolder(cfg: PortConfig, ptyLink: string): Promise<number> {
  await stopHolder(null, ptyLink); // clear any stale link first
  const devAddr = `${cfg.device},${socatDeviceOpts(cfg)}`;
  const ptyAddr = `PTY,link=${ptyLink},raw,echo=0`;
  const log = holderLogPath(cfg.device);
  const started = await sh(
    `setsid socat ${devAddr} ${ptyAddr} >${log} 2>&1 </dev/null & echo $!`,
  );
  const pid = parseInt(started.stdout.trim(), 10);
  if (!started.ok || !Number.isInteger(pid)) {
    throw new Error(
      `Failed to launch socat holder for ${cfg.device} (is socat installed?).`,
    );
  }
  // Wait for socat to create the PTY link and confirm it is running.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await linkExists(ptyLink) && await pidAlive(pid)) return pid;
    await new Promise((r) => setTimeout(r, 50));
  }
  const tail = (await sh(`tail -n 3 ${log} 2>/dev/null`)).stdout.trim();
  await stopHolder(pid, ptyLink);
  throw new Error(
    `socat holder for ${cfg.device} did not come up within 3s` +
      (tail ? `: ${tail}` : " (is the port free?)."),
  );
}

/** SIGTERM the holder (if alive) and remove its PTY link. Best-effort. */
async function stopHolder(pid: number | null, ptyLink: string): Promise<void> {
  if (pid !== null && await pidAlive(pid)) await sh(`kill ${pid} 2>/dev/null`);
  await sh(`rm -f ${ptyLink}`);
}

// ── Protocol logic (hardware-agnostic, unit-tested) ─────────────────────────

const encoder = new TextEncoder();
const POLL_MS = 20;

/** The trailing window a stop-pattern is matched against. */
function stopWindow(output: string): string {
  return output.length > STOP_TAIL ? output.slice(-STOP_TAIL) : output;
}

/**
 * Read from an open port until it goes idle (`idleMs` with no new bytes),
 * `maxMs` elapses, or `stopRegex` matches the trailing window of the output.
 * Returns the decoded text and whether the stop pattern matched. Never
 * busy-spins: an empty read yields to the clock's sleep. The stop-regex is only
 * ever tested against a bounded suffix, so a large/adversarial pattern cannot
 * scan an unbounded buffer.
 */
export async function drainUntil(
  port: SerialPort,
  opts: { idleMs: number; maxMs: number; stopRegex?: RegExp },
  clock: Clock = realClock,
): Promise<{ output: string; matched: boolean }> {
  const buf = new Uint8Array(4096);
  const decoder = new TextDecoder();
  const start = clock.now();
  let lastData = start;
  let output = "";
  let matched = false;
  while (true) {
    const t = clock.now();
    if (t - start >= opts.maxMs) break;
    if (t - lastData >= opts.idleMs) break;
    const n = await port.read(buf);
    if (n && n > 0) {
      output += decoder.decode(buf.subarray(0, n), { stream: true });
      lastData = clock.now();
      if (opts.stopRegex && opts.stopRegex.test(stopWindow(output))) {
        matched = true;
        break;
      }
    } else {
      // No data this poll — yield so we don't spin the CPU.
      await clock.sleep(POLL_MS);
    }
  }
  output += decoder.decode();
  return { output, matched };
}

/** Write text to the port, optionally appending the line ending. */
export async function sendLine(
  port: SerialPort,
  text: string,
  opts: { lineEnding: string; appendNewline: boolean },
): Promise<number> {
  const payload = opts.appendNewline ? text + opts.lineEnding : text;
  return await port.write(encoder.encode(payload));
}

/** Strip a leading echoed command line from captured output. */
export function stripEchoedCommand(output: string, command: string): string {
  const trimmed = output.replace(/^[\r\n]+/, "");
  if (trimmed.startsWith(command)) {
    return trimmed.slice(command.length).replace(/^[\r\n]+/, "");
  }
  return output;
}

/** Send a command line and capture the response. */
export async function execOn(
  port: SerialPort,
  opts: {
    command: string;
    lineEnding: string;
    prompt?: RegExp;
    idleMs: number;
    maxMs: number;
    stripEcho: boolean;
  },
  clock: Clock = realClock,
): Promise<{ output: string; matchedPrompt: boolean }> {
  await sendLine(port, opts.command, {
    lineEnding: opts.lineEnding,
    appendNewline: true,
  });
  const { output, matched } = await drainUntil(
    port,
    { idleMs: opts.idleMs, maxMs: opts.maxMs, stopRegex: opts.prompt },
    clock,
  );
  const cleaned = opts.stripEcho
    ? stripEchoedCommand(output, opts.command)
    : output;
  return { output: cleaned, matchedPrompt: matched };
}

/** Remove a secret from a transcript before it is persisted or logged. */
export function scrubSecret(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join("«redacted»");
}

// Non-multiline: `$` anchors to the end of the (bounded) stop window, so these
// match only when the prompt is what the console is currently waiting on — not
// a decorative `#`/`$` mid-banner.
const LOGIN_RE = /login:\s*$/i;
const PASSWORD_RE = /password:\s*$/i;
const INCORRECT_RE = /login incorrect|authentication failure/i;
// A real shell prompt ends in "$ " / "# " / "> "; the trailing space excludes
// MOTD box lines that end in a bare `#` before a newline.
const DEFAULT_PROMPT_RE = /[$#>] $/;

/**
 * Drive a getty login. Nudges the console, answers login:/Password: if prompted,
 * and confirms the shell prompt. Status is decided from the raw transcript
 * (before scrubbing, so a password containing a prompt character cannot corrupt
 * the decision); the returned transcript is then scrubbed of the password. The
 * remote disables echo during password entry, so the secret is not captured
 * inbound either.
 */
export async function loginOn(
  port: SerialPort,
  opts: {
    username: string;
    password: string;
    lineEnding: string;
    promptAfter?: RegExp;
    idleMs: number;
    maxMs: number;
  },
  clock: Clock = realClock,
): Promise<{ status: "ok" | "failed"; transcript: string }> {
  const prompt = opts.promptAfter ?? DEFAULT_PROMPT_RE;
  let transcript = "";

  // Nudge and see where we are.
  await sendLine(port, "", {
    lineEnding: opts.lineEnding,
    appendNewline: true,
  });
  let phase = await drainUntil(
    port,
    { idleMs: opts.idleMs, maxMs: opts.maxMs, stopRegex: LOGIN_RE },
    clock,
  );
  transcript += phase.output;

  if (LOGIN_RE.test(stopWindow(phase.output))) {
    await sendLine(port, opts.username, {
      lineEnding: opts.lineEnding,
      appendNewline: true,
    });
    phase = await drainUntil(
      port,
      { idleMs: opts.idleMs, maxMs: opts.maxMs, stopRegex: PASSWORD_RE },
      clock,
    );
    transcript += phase.output;

    if (PASSWORD_RE.test(stopWindow(phase.output))) {
      await sendLine(port, opts.password, {
        lineEnding: opts.lineEnding,
        appendNewline: true,
      });
      phase = await drainUntil(
        port,
        { idleMs: opts.idleMs, maxMs: opts.maxMs, stopRegex: prompt },
        clock,
      );
      transcript += phase.output;
    }
  }

  // Decide on the RAW transcript, then scrub for storage.
  const status: "ok" | "failed" =
    !INCORRECT_RE.test(transcript) && prompt.test(stopWindow(transcript))
      ? "ok"
      : "failed";
  return { status, transcript: scrubSecret(transcript, opts.password) };
}

// ── Config resolution ───────────────────────────────────────────────────────

function toRegex(pattern?: string): RegExp | undefined {
  return pattern ? new RegExp(pattern) : undefined;
}

/** Merge config with precedence: method arg > port resource > model global. */
export function mergeConfig(
  g: GlobalArgs,
  resource: Partial<PortResource> | null,
  a: Overrides,
): PortConfig {
  return {
    device: a.device ?? g.device,
    baud: a.baud ?? resource?.baud ?? g.baud,
    framing: a.framing ?? resource?.framing ?? g.framing,
    lineEnding: a.lineEnding ?? resource?.lineEnding ?? g.lineEnding,
  };
}

function instanceKey(spec: string, device: string): string {
  return `${spec}-${device.replace(/\W+/g, "_")}`;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

type Handles = { dataHandles: Array<{ name: string }> };

/**
 * Resolve line config for a method: validate the device, then inherit
 * baud/framing/lineEnding from the establish-recorded `port` resource where the
 * call did not override them. Does NOT consider session attach — session
 * lifecycle methods (`session_*`) act on the real device, so they use this.
 */
async function resolveLineConfig(
  context: MethodContext,
  args: Overrides,
): Promise<PortConfig> {
  const device = args.device ?? context.globalArgs.device;
  assertAllowedDevice(device);
  const record = await context.readResource?.(instanceKey("port", device)) ??
    null;
  return mergeConfig(context.globalArgs, record as PortResource | null, {
    ...args,
    device,
  });
}

/** Read the recorded session for a device, or null. */
async function readSession(
  context: MethodContext,
  device: string,
): Promise<SessionResource | null> {
  const rec = await context.readResource?.(instanceKey("session", device)) ??
    null;
  return rec as SessionResource | null;
}

/**
 * Resolve the effective config for an I/O method. `cfg` always names the REAL
 * device — resource keys, logs, and stored content use it, so records don't
 * scatter under an ephemeral PTY path. `ioCfg` is what the transport opens: the
 * holder's PTY when a live session owns the device, else the real device. The
 * PTY path comes from our own session record (not user input) and is bound to an
 * already-allow-listed device, so it needs no separate allow-list.
 *
 * `attached` is true when redirected to a holder — the caller then drains any
 * bytes the PTY buffered while unattached before sending, so a command's
 * response is not preceded by a previous call's stale output.
 */
async function resolveConfig(
  context: MethodContext,
  args: Overrides,
): Promise<{ cfg: PortConfig; ioCfg: PortConfig; attached: boolean }> {
  const cfg = await resolveLineConfig(context, args);
  const session = await readSession(context, cfg.device);
  if (session && await isSessionLive(session)) {
    context.logger.info("Attaching to held session on {device} via {pty}", {
      device: cfg.device,
      pty: session.ptyLink,
    });
    return { cfg, ioCfg: { ...cfg, device: session.ptyLink }, attached: true };
  }
  return { cfg, ioCfg: cfg, attached: false };
}

/** Attach drain bounds: clear stale PTY bytes before an attached command. */
const SESSION_DRAIN_IDLE_MS = 200;
const SESSION_DRAIN_MAX_MS = 1500;

/** Discard bytes the holder's PTY buffered while unattached (no-op if quiet). */
async function drainStaleOnAttach(port: SerialPort): Promise<void> {
  await drainUntil(port, {
    idleMs: SESSION_DRAIN_IDLE_MS,
    maxMs: SESSION_DRAIN_MAX_MS,
  });
}

/** The transport for this method call, per the `transport` global. */
function transportFor(context: MethodContext): Transport {
  return selectTransport(context.globalArgs.transport, context.logger);
}

// ── Model ───────────────────────────────────────────────────────────────────

/** Model definition for the @shrug/serial-port USB-UART model type. */
export const model = {
  type: "@shrug/serial-port",
  version: "2026.07.22.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    port: {
      description: "The configured serial port and its probe capture.",
      schema: PortResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    sent: {
      description: "Record of a send() write.",
      schema: SentResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    captured: {
      description: "Output captured by read().",
      schema: CapturedResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    execResult: {
      description: "Result of an exec() command/response round-trip.",
      schema: ExecResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    loginResult: {
      description: "Result of a login() attempt (password scrubbed).",
      schema: LoginResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    session: {
      description:
        "A persistent socat session holder for the port (pid + PTY link).",
      schema: SessionResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    establish: {
      description:
        "Validate + configure the serial port (baud/framing/raw), probe it briefly, and record the `port` resource that later calls inherit config from. Fails loudly when the port is held by another process.",
      arguments: z.object({ ...OverrideArgs }),
      execute: async (
        args: Overrides,
        context: MethodContext,
      ): Promise<Handles> => {
        const cfg = mergeConfig(context.globalArgs, null, args);
        assertAllowedDevice(cfg.device);
        const probe = await withPort(
          transportFor(context),
          cfg,
          async (port) => {
            await sendLine(port, "", {
              lineEnding: cfg.lineEnding,
              appendNewline: true,
            });
            const res = await drainUntil(port, { idleMs: 300, maxMs: 1500 });
            return res.output;
          },
        );
        context.logger.info(
          "Established {device} @ {baud} {framing} ({probeLen} probe bytes)",
          {
            device: cfg.device,
            baud: cfg.baud,
            framing: cfg.framing,
            probeLen: probe.length,
          },
        );
        const handle = await context.writeResource(
          "port",
          instanceKey("port", cfg.device),
          {
            device: cfg.device,
            baud: cfg.baud,
            framing: cfg.framing,
            lineEnding: cfg.lineEnding,
            probedAt: new Date().toISOString(),
            probe,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    send: {
      description:
        "Write one line to the port (appends the line ending unless raw). Does not read a response.",
      arguments: z.object({
        text: z.string().describe("Text to send."),
        appendNewline: z.boolean().default(true).describe(
          "Append the configured line ending. Set false with `raw` to send exact bytes.",
        ),
        raw: z.boolean().default(false).describe(
          "Treat `text` as an exact payload (implies appendNewline=false).",
        ),
        ...OverrideArgs,
      }),
      execute: async (
        args: Overrides & {
          text: string;
          appendNewline: boolean;
          raw: boolean;
        },
        context: MethodContext,
      ): Promise<Handles> => {
        const { cfg, ioCfg } = await resolveConfig(context, args);
        const bytesWritten = await withPort(
          transportFor(context),
          ioCfg,
          (port) =>
            sendLine(port, args.text, {
              lineEnding: cfg.lineEnding,
              appendNewline: args.raw ? false : args.appendNewline,
            }),
        );
        context.logger.info("Sent {n} bytes to {device}", {
          n: bytesWritten,
          device: cfg.device,
        });
        const handle = await context.writeResource(
          "sent",
          instanceKey("sent", cfg.device),
          {
            device: cfg.device,
            bytesWritten,
            sentAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    read: {
      description:
        "Drain inbound bytes from the port until it goes idle or the cap is reached.",
      arguments: z.object({
        idleMs: idleMsArg(300).describe(
          "Stop after this many ms with no new bytes.",
        ),
        maxMs: maxMsArg(3000).describe("Hard cap on total read time."),
        ...OverrideArgs,
      }),
      execute: async (
        args: Overrides & { idleMs: number; maxMs: number },
        context: MethodContext,
      ): Promise<Handles> => {
        // `read` wants whatever the port (or held PTY) has buffered, so it
        // deliberately does NOT drain on attach.
        const { cfg, ioCfg } = await resolveConfig(context, args);
        const { output } = await withPort(
          transportFor(context),
          ioCfg,
          (port) =>
            drainUntil(port, { idleMs: args.idleMs, maxMs: args.maxMs }),
        );
        context.logger.info("Read {n} bytes from {device}", {
          n: output.length,
          device: cfg.device,
        });
        const handle = await context.writeResource(
          "captured",
          instanceKey("captured", cfg.device),
          {
            device: cfg.device,
            capturedAt: new Date().toISOString(),
            output,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    exec: {
      description:
        "Send a command line and capture the response until the prompt returns (if given) or the line goes idle. The console-shell primitive.",
      arguments: z.object({
        command: z.string().describe("Command line to send."),
        prompt: z.string().optional().describe(
          "Optional regex; stop reading once the response's tail matches it (e.g. the shell prompt).",
        ),
        idleMs: idleMsArg(500).describe(
          "Stop after this many ms with no new bytes.",
        ),
        maxMs: maxMsArg(10000).describe("Hard cap on total time."),
        stripEcho: z.boolean().default(true).describe(
          "Strip the echoed command line from the captured output.",
        ),
        ...OverrideArgs,
      }),
      execute: async (
        args: Overrides & {
          command: string;
          prompt?: string;
          idleMs: number;
          maxMs: number;
          stripEcho: boolean;
        },
        context: MethodContext,
      ): Promise<Handles> => {
        const { cfg, ioCfg, attached } = await resolveConfig(context, args);
        const result = await withPort(
          transportFor(context),
          ioCfg,
          async (port) => {
            if (attached) await drainStaleOnAttach(port);
            return execOn(port, {
              command: args.command,
              lineEnding: cfg.lineEnding,
              prompt: toRegex(args.prompt),
              idleMs: args.idleMs,
              maxMs: args.maxMs,
              stripEcho: args.stripEcho,
            });
          },
        );
        context.logger.info(
          "exec on {device}: {cmd} ({n} bytes, prompt matched: {matched})",
          {
            device: cfg.device,
            cmd: args.command,
            n: result.output.length,
            matched: result.matchedPrompt,
          },
        );
        const handle = await context.writeResource(
          "execResult",
          instanceKey("execResult", cfg.device),
          {
            device: cfg.device,
            command: args.command,
            ranAt: new Date().toISOString(),
            matchedPrompt: result.matchedPrompt,
            output: result.output,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    login: {
      description:
        "Answer a getty login (login:/Password:) using the vaulted credential, then confirm the shell prompt. The password is never written to the recorded transcript.",
      arguments: z.object({
        username: z.string().optional().describe(
          "Username; defaults to the model's `username` global.",
        ),
        promptAfter: z.string().optional().describe(
          "Optional regex for the shell prompt to expect after login (default matches a trailing $ , # , or > ).",
        ),
        idleMs: idleMsArg(800).describe("Per-phase idle timeout."),
        maxMs: maxMsArg(15000).describe("Per-phase hard cap."),
        ...OverrideArgs,
      }),
      execute: async (
        args: Overrides & {
          username?: string;
          promptAfter?: string;
          idleMs: number;
          maxMs: number;
        },
        context: MethodContext,
      ): Promise<Handles> => {
        const g = context.globalArgs;
        const { cfg, ioCfg, attached } = await resolveConfig(context, args);
        const username = args.username ?? g.username;
        if (!username) {
          throw new Error(
            "No username: pass `username` or set the model's `username` global.",
          );
        }
        if (!g.password) {
          throw new Error(
            "No password: set the model's `password` global to a vault reference.",
          );
        }
        const password = g.password;
        const result = await withPort(
          transportFor(context),
          ioCfg,
          async (port) => {
            if (attached) await drainStaleOnAttach(port);
            return loginOn(port, {
              username,
              password,
              lineEnding: cfg.lineEnding,
              promptAfter: toRegex(args.promptAfter),
              idleMs: args.idleMs,
              maxMs: args.maxMs,
            });
          },
        );
        context.logger.info("login on {device} as {user}: {status}", {
          device: cfg.device,
          user: username,
          status: result.status,
        });
        const handle = await context.writeResource(
          "loginResult",
          instanceKey("loginResult", cfg.device),
          {
            device: cfg.device,
            username,
            attemptedAt: new Date().toISOString(),
            status: result.status,
            transcript: result.transcript,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    session_start: {
      description:
        "Start a persistent session holder: a detached `socat` opens the port once and bridges it to a PTY, so the logged-in shell survives across separate method runs. Later send/read/exec/login (and serial-cfgmgmt) calls automatically attach to the holder. Idempotency: errors if one is already live — stop it first with session_stop.",
      arguments: z.object({ ...OverrideArgs }),
      execute: async (
        args: Overrides,
        context: MethodContext,
      ): Promise<Handles> => {
        const cfg = await resolveLineConfig(context, args);
        const existing = await readSession(context, cfg.device);
        if (existing && await isSessionLive(existing)) {
          throw new Error(
            `A session holder is already running on ${cfg.device} (pid ${existing.holderPid}). Stop it with session_stop first.`,
          );
        }
        const ptyLink = sessionPtyPath(cfg.device);
        const holderPid = await startHolder(cfg, ptyLink);
        const now = new Date().toISOString();
        context.logger.info(
          "Session holder up on {device} (pid {pid}) → {pty}",
          { device: cfg.device, pid: holderPid, pty: ptyLink },
        );
        const handle = await context.writeResource(
          "session",
          instanceKey("session", cfg.device),
          {
            device: cfg.device,
            ptyLink,
            holderPid,
            baud: cfg.baud,
            framing: cfg.framing,
            lineEnding: cfg.lineEnding,
            startedAt: now,
            live: true,
            checkedAt: now,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    session_stop: {
      description:
        "Stop the persistent session holder on the port (SIGTERM the socat holder, remove the PTY link). Safe to call when none is running.",
      arguments: z.object({ ...OverrideArgs }),
      execute: async (
        args: Overrides,
        context: MethodContext,
      ): Promise<Handles> => {
        const device = args.device ?? context.globalArgs.device;
        assertAllowedDevice(device);
        const session = await readSession(context, device);
        const now = new Date().toISOString();
        if (!session) {
          await stopHolder(null, sessionPtyPath(device)); // clear any stray link
          context.logger.info("No session holder recorded on {device}", {
            device,
          });
          return { dataHandles: [] };
        }
        await stopHolder(session.holderPid, session.ptyLink);
        context.logger.info("Session holder stopped on {device} (pid {pid})", {
          device,
          pid: session.holderPid,
        });
        const handle = await context.writeResource(
          "session",
          instanceKey("session", device),
          {
            device: session.device,
            ptyLink: session.ptyLink,
            holderPid: session.holderPid,
            baud: session.baud,
            framing: session.framing,
            lineEnding: session.lineEnding,
            startedAt: session.startedAt,
            live: false,
            checkedAt: now,
            stoppedAt: now,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    session_status: {
      description:
        "Report whether a persistent session holder is running on the port. Recomputes liveness from the holder pid + PTY link (a dead holder reads as not-live and I/O methods fall back to open/close).",
      arguments: z.object({ ...OverrideArgs }),
      execute: async (
        args: Overrides,
        context: MethodContext,
      ): Promise<Handles> => {
        const device = args.device ?? context.globalArgs.device;
        assertAllowedDevice(device);
        const session = await readSession(context, device);
        const now = new Date().toISOString();
        if (!session) {
          context.logger.info("No session holder on {device}", { device });
          return { dataHandles: [] };
        }
        const live = await isSessionLive(session);
        context.logger.info("Session on {device}: {state} (pid {pid})", {
          device,
          state: live ? "live" : "dead",
          pid: session.holderPid,
        });
        const handle = await context.writeResource(
          "session",
          instanceKey("session", device),
          {
            device: session.device,
            ptyLink: session.ptyLink,
            holderPid: session.holderPid,
            baud: session.baud,
            framing: session.framing,
            lineEnding: session.lineEnding,
            startedAt: session.startedAt,
            live,
            checkedAt: now,
            ...(session.stoppedAt ? { stoppedAt: session.stoppedAt } : {}),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

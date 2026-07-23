/**
 * `@shrug/serial-cfgmgmt/file` — move files to and from a networkless board over
 * the serial console (shell regime). Serial counterpart to file transfer that
 * would normally ride scp/rsync — but the target has no network, only a getty on
 * the UART.
 *
 * Protocol (design/serial-file-transfer.md §3): gzip + base64, chunked over the
 * existing exec loop. Coreutils-only on the target (`base64`, `gzip`,
 * `sha256sum` — always present; no network means nothing else can be installed).
 * Text-safe, so it rides the prompt-regex / echo-strip / `__RC:$?:RC__` session
 * machinery unchanged and survives printk interleaving: one corrupt line is
 * caught by the per-chunk `$?` ack or the final checksum and retried, never a
 * wedged binary state machine.
 *
 * `push` MUTATES the target (writes a file); `pull`/`verify` are read-only. All
 * three compose purely from the session/exec lib — no new transport code — so
 * the orchestration is unit-testable against a fake `Session` (see `_test.ts`).
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  ConnectionGlobals,
  type Ctx,
  type Session,
  withSession,
} from "./serial_cfgmgmt_lib.ts";
import { deviceAllowlistCheck } from "./serial_port.ts";

// ── Pure encode / decode / hash helpers (self-contained, control-byte-safe) ──

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 encode of raw bytes (payloads may carry arbitrary bytes). */
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

const B64_INV: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64.length; i++) m[B64[i]] = i;
  return m;
})();

/**
 * Standard base64 decode. Ignores all non-alphabet bytes (whitespace, CR, line
 * wraps from `base64 -w`), so it is robust to the console's line handling.
 */
export function fromBase64(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    if (ch === "=") break;
    const v = B64_INV[ch];
    if (v === undefined) continue; // skip whitespace / CR / wraps / stray noise
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** SHA-256 of raw bytes as lowercase hex — matches `sha256sum` output. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** gzip raw bytes via the platform CompressionStream (RFC 1952; `gzip -d` reads it). */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  // Swallow the writer-side settlement so a stream error surfaces ONLY on the
  // readable side (awaited below, hence catchable) rather than as a dangling
  // unhandled rejection.
  w.write(bytes as BufferSource).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/**
 * gunzip raw bytes (reads what `gzip -c` produces on the target). Rejects on a
 * corrupt stream (e.g. a printk byte spliced into a pulled payload) — the error
 * propagates to the caller so pull can retry instead of crashing the process.
 */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(bytes as BufferSource).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/**
 * Split a base64 string into lines of at most `chunkBytes` characters. The line
 * length — NOT the pre-encode byte count — is what must stay well under the
 * 4096-byte N_TTY canonical-mode line buffer, since each line is shipped inside
 * a `printf '%s\n' '<line>' >> staging` wrapper that adds ~40 bytes of overhead.
 */
export function chunkBase64(b64: string, chunkBytes: number): string[] {
  if (chunkBytes < 1) throw new Error("chunkBytes must be >= 1");
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += chunkBytes) {
    chunks.push(b64.slice(i, i + chunkBytes));
  }
  return chunks;
}

/**
 * Extract the payload strictly between a line equal to `begin` and a later line
 * equal to `end`. Full-line equality (not substring) so the echoed command line
 * — which contains the marker literals as arguments — is never mistaken for a
 * marker. Returns "" if the markers are absent/empty.
 */
export function extractBetweenMarkers(
  text: string,
  begin: string,
  end: string,
): string {
  const lines = text.replace(/\r/g, "").split("\n");
  let start = -1;
  let stop = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].trim() === begin) start = i;
    else if (start !== -1 && lines[i].trim() === end) {
      stop = i;
      break;
    }
  }
  if (start === -1 || stop === -1) return "";
  return lines.slice(start + 1, stop).join("\n");
}

// ── Shell-quoting + command builders (pure, testable) ────────────────────────

/** Single-quote a value for safe interpolation into a shell command line. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The base64 alphabet — the only bytes a chunk line may legally contain. */
const B64_LINE_RE = /^[A-Za-z0-9+/=]*$/;

/**
 * Append one base64 line to the staging file. The base64 alphabet contains no
 * shell metacharacter, so the line rides inside single quotes un-escaped — but
 * this is a load-bearing invariant, so it is asserted here rather than trusted
 * to caller discipline (a future non-base64 caller would otherwise be a shell
 * injection primitive).
 */
export function appendChunkCmd(stagingPath: string, b64Line: string): string {
  if (!B64_LINE_RE.test(b64Line)) {
    throw new Error("appendChunkCmd: chunk is not pure base64");
  }
  return `printf '%s\\n' '${b64Line}' >> ${shq(stagingPath)}`;
}

/**
 * Create the staging file exclusively (noclobber), after removing any leftover.
 * `set -C` makes the create fail if the path already exists — defeating a
 * pre-placed symlink an attacker may have dropped in a world-writable /tmp
 * (a non-zero rc then aborts the push). Residual symlink-swap windows on later
 * appends are covered by the sticky-bit assumption documented on `push`.
 */
export function stagingCreateCmd(stagingPath: string): string {
  return `rm -f ${shq(stagingPath)} && (set -C; : > ${shq(stagingPath)})`;
}

/** Roll a staging file back to a known-good byte length after a failed append. */
export function truncateCmd(stagingPath: string, bytes: number): string {
  return `truncate -s ${bytes} ${shq(stagingPath)} 2>/dev/null`;
}

/**
 * Decode the staging file into a TEMP destination (never the live target
 * directly), gzip-aware. pipefail so any pipeline stage surfaces. The caller
 * verifies the temp's sha256 and only then atomically renames it over the real
 * path, so a garbled transfer can never truncate/clobber the existing file.
 */
export function finalizeCmd(
  stagingPath: string,
  tempDest: string,
  gzip: boolean,
): string {
  const decode = gzip
    ? `base64 -d ${shq(stagingPath)} | gzip -d > ${shq(tempDest)}`
    : `base64 -d ${shq(stagingPath)} > ${shq(tempDest)}`;
  return `set -o pipefail 2>/dev/null; ${decode}`;
}

/** Atomically move the verified temp file over the final path (same filesystem). */
export function moveCmd(tempDest: string, remotePath: string): string {
  return `mv -f ${shq(tempDest)} ${shq(remotePath)}`;
}

/** The same-directory temp path a verified decode lands in before the atomic mv. */
export function tempDestFor(remotePath: string, localSha: string): string {
  return `${remotePath}.swampxfer-${localSha.slice(0, 12)}.tmp`;
}

/** Read a file's sha256 (first field of `sha256sum`). */
export function remoteSha256Cmd(remotePath: string): string {
  return `sha256sum ${shq(remotePath)} 2>/dev/null | awk '{print $1}'`;
}

const MARK_BEGIN = "__SWAMP_XFER_BEGIN__";
const MARK_END = "__SWAMP_XFER_END__";

/** Emit the remote file as base64 between unique markers (gzip-aware). */
export function pullCmd(remotePath: string, gzip: boolean): string {
  const enc = gzip
    ? `gzip -c ${shq(remotePath)} | base64`
    : `base64 ${shq(remotePath)}`;
  return `printf '%s\\n' '${MARK_BEGIN}'; ${enc}; printf '%s\\n' '${MARK_END}'`;
}

// ── Orchestration over an injected Session (unit-testable, no hardware) ───────

/**
 * Best-effort console quieting: read the current printk level (so we know what
 * to restore) and only then `dmesg -n 1`. Returns the level to restore, or null
 * if quieting was skipped/unavailable — this never fails the caller.
 */
async function quietConsole(
  session: Session,
  enabled: boolean,
): Promise<string | null> {
  if (!enabled) return null;
  const lvl = await session.run(
    "cat /proc/sys/kernel/printk 2>/dev/null | awk '{print $1}'",
  );
  if (lvl.exitCode === 0 && /^\d+$/.test(lvl.stdout.trim())) {
    const set = await session.run("dmesg -n 1 2>/dev/null");
    if (set.exitCode === 0) return lvl.stdout.trim();
  }
  return null;
}

/** Restore a previously-read console level (no-op when null). */
async function restoreConsole(
  session: Session,
  level: string | null,
): Promise<void> {
  if (level !== null) await session.run(`dmesg -n ${level} 2>/dev/null`);
}

export interface PushResult {
  chunks: number;
  verified: boolean;
  remoteSha: string | null;
}

/**
 * Push `chunks` (base64 lines of the gzip'd/plain payload) to `remotePath` via
 * the session: quiet the console (best-effort), exclusively create a fresh
 * staging file, append each chunk with a per-chunk `$?` ack + bounded retry
 * (rolling back any partial write before a retry), decode into a same-directory
 * TEMP file, verify the temp's sha256 against `localSha`, apply mode/owner to the
 * temp, and only then atomically `mv` it over the real path. The live target is
 * therefore never truncated or clobbered unless a byte-verified copy is ready.
 * On any failure the staging (and any temp) files are deliberately LEFT for
 * diagnosis; they are removed only after a verified, renamed success. The console
 * log level is always restored (finally).
 *
 * Security note: the staging file is created with `set -C` (noclobber) to defeat
 * a pre-placed symlink; a fully symlink-race-proof staging on a world-writable
 * `/tmp` would require target-side `mktemp`, which assumes a holder-persistent
 * shell. For the single-user recovery boards this targets (`/tmp` sticky-bit),
 * the exclusive create plus the temp+verify+rename destination discipline is the
 * accepted bound.
 */
export async function pushViaSession(
  session: Session,
  opts: {
    chunks: string[];
    stagingPath: string;
    remotePath: string;
    gzip: boolean;
    localSha: string;
    maxRetries: number;
    mode?: string;
    owner?: string;
    quietConsole: boolean;
  },
): Promise<PushResult> {
  const restoreLevel = await quietConsole(session, opts.quietConsole);
  const tempDest = tempDestFor(opts.remotePath, opts.localSha);

  try {
    // Exclusively create a fresh staging file (defeats a stale file or a
    // pre-placed symlink). An empty payload still creates an empty staging file
    // so the decode below has a real file to read.
    const cr = await session.run(stagingCreateCmd(opts.stagingPath));
    if (cr.exitCode !== 0) {
      throw new Error(
        `could not create staging file ${opts.stagingPath} (rc=${cr.exitCode}); a racing file or symlink may exist at that path`,
      );
    }

    let committed = 0; // confirmed staging length, for partial-write rollback
    for (let i = 0; i < opts.chunks.length; i++) {
      let ok = false;
      for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        const r = await session.run(
          appendChunkCmd(opts.stagingPath, opts.chunks[i]),
        );
        if (r.exitCode === 0) {
          ok = true;
          break;
        }
        // A failed append may have written a partial line; roll the file back to
        // the last confirmed length before retrying so we never double-append.
        await session.run(truncateCmd(opts.stagingPath, committed));
      }
      if (!ok) {
        throw new Error(
          `chunk ${i + 1}/${opts.chunks.length} failed after ${
            opts.maxRetries + 1
          } attempts; staging file left at ${opts.stagingPath} for diagnosis`,
        );
      }
      committed += opts.chunks[i].length + 1; // + the newline printf adds
    }

    const fin = await session.run(
      finalizeCmd(opts.stagingPath, tempDest, opts.gzip),
    );
    if (fin.exitCode !== 0) {
      throw new Error(
        `decode/finalize into ${tempDest} failed (rc=${fin.exitCode}); staging file left at ${opts.stagingPath}. Target ${opts.remotePath} untouched.`,
      );
    }

    // Verify the TEMP file — the live target is still untouched at this point.
    const shaR = await session.run(remoteSha256Cmd(tempDest));
    const remoteSha = shaR.exitCode === 0
      ? (shaR.stdout.trim().split(/\s+/)[0] || null)
      : null;
    const verified = remoteSha !== null && remoteSha === opts.localSha;
    if (!verified) {
      throw new Error(
        `sha256 mismatch: local=${opts.localSha} remote=${
          remoteSha ?? "<unreadable>"
        }. Target ${opts.remotePath} left UNTOUCHED; staging (${opts.stagingPath}) and temp (${tempDest}) left for diagnosis.`,
      );
    }

    // Apply ownership/permissions to the temp BEFORE the rename, so a chmod/chown
    // failure (e.g. unprivileged shell) leaves the live target untouched.
    if (opts.mode) {
      const c = await session.run(`chmod ${shq(opts.mode)} ${shq(tempDest)}`);
      if (c.exitCode !== 0) {
        throw new Error(
          `chmod ${opts.mode} failed (rc=${c.exitCode}); verified content left at ${tempDest}, target ${opts.remotePath} untouched`,
        );
      }
    }
    if (opts.owner) {
      const c = await session.run(`chown ${shq(opts.owner)} ${shq(tempDest)}`);
      if (c.exitCode !== 0) {
        throw new Error(
          `chown ${opts.owner} failed (rc=${c.exitCode}); verified content left at ${tempDest}, target ${opts.remotePath} untouched`,
        );
      }
    }

    // Atomic swap into place (same filesystem — tempDest is a sibling of remotePath).
    const mv = await session.run(moveCmd(tempDest, opts.remotePath));
    if (mv.exitCode !== 0) {
      throw new Error(
        `atomic move to ${opts.remotePath} failed (rc=${mv.exitCode}); verified content left at ${tempDest}`,
      );
    }

    // Verified and swapped — the staging file is now safe to remove.
    await session.run(`rm -f ${shq(opts.stagingPath)}`);
    return { chunks: opts.chunks.length, verified, remoteSha };
  } finally {
    await restoreConsole(session, restoreLevel);
  }
}

export interface PullResult {
  bytes: Uint8Array;
  remoteSha: string | null;
  localSha: string;
  match: boolean;
}

/**
 * Pull `remotePath`: emit it base64 between markers, decode + gunzip locally,
 * and verify the decoded bytes' sha256 against the remote `sha256sum` taken in
 * the same session. Symmetric with push: the console is quieted (best-effort)
 * and the whole pull is retried up to `maxRetries` on a corrupt stream (a printk
 * line interleaved into the base64 → decode/gunzip error or a sha mismatch), so
 * a single burst of kernel logging doesn't doom the transfer. Distinguishes a
 * genuinely empty remote file (valid) from a missing one (error). Throws only
 * after exhausting retries; never returns unverified bytes.
 */
export async function pullViaSession(
  session: Session,
  opts: {
    remotePath: string;
    gzip: boolean;
    maxRetries?: number;
    quietConsole?: boolean;
  },
): Promise<PullResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const restoreLevel = await quietConsole(session, opts.quietConsole ?? true);
  try {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const r = await session.run(pullCmd(opts.remotePath, opts.gzip));
      const b64 = extractBetweenMarkers(r.stdout, MARK_BEGIN, MARK_END).replace(
        /\s+/g,
        "",
      );

      if (b64 === "") {
        // Empty payload: an empty file is legal; a missing file is not.
        const ex = await session.run(
          `test -e ${shq(opts.remotePath)} && echo __SWAMP_EXISTS__`,
        );
        if (!ex.stdout.includes("__SWAMP_EXISTS__")) {
          throw new Error(`pull of ${opts.remotePath}: no such file`);
        }
        const bytes = new Uint8Array(0);
        const localSha = await sha256Hex(bytes);
        const rs = await verifyViaSession(session, {
          localSha,
          remotePath: opts.remotePath,
        });
        if (rs.match) {
          return { bytes, remoteSha: rs.remoteSha, localSha, match: true };
        }
        lastErr = new Error(
          `pull of empty ${opts.remotePath}: sha mismatch (remote=${
            rs.remoteSha ?? "<unreadable>"
          })`,
        );
        continue;
      }

      let bytes: Uint8Array;
      try {
        const payload = fromBase64(b64);
        bytes = opts.gzip ? await gunzipBytes(payload) : payload;
      } catch (e) {
        // A printk byte in the stream corrupts the gzip frame — retry the pull.
        lastErr = e instanceof Error ? e : new Error(String(e));
        continue;
      }
      const localSha = await sha256Hex(bytes);
      const shaR = await session.run(remoteSha256Cmd(opts.remotePath));
      const remoteSha = shaR.exitCode === 0
        ? (shaR.stdout.trim().split(/\s+/)[0] || null)
        : null;
      if (remoteSha !== null && remoteSha === localSha) {
        return { bytes, remoteSha, localSha, match: true };
      }
      lastErr = new Error(
        `pull sha256 mismatch on ${opts.remotePath}: local=${localSha} remote=${
          remoteSha ?? "<unreadable>"
        }`,
      );
    }
    throw lastErr ?? new Error(`pull of ${opts.remotePath} failed`);
  } finally {
    await restoreConsole(session, restoreLevel);
  }
}

/** Compare a local sha256 against the remote file's sha256 without transferring. */
export async function verifyViaSession(
  session: Session,
  opts: { localSha: string; remotePath: string },
): Promise<{ match: boolean; remoteSha: string | null }> {
  const shaR = await session.run(remoteSha256Cmd(opts.remotePath));
  const remoteSha = shaR.exitCode === 0
    ? (shaR.stdout.trim().split(/\s+/)[0] || null)
    : null;
  return {
    match: remoteSha !== null && remoteSha === opts.localSha,
    remoteSha,
  };
}

// ── Local file / input helpers ───────────────────────────────────────────────

/** Load the bytes to push from either an inline `content` string or a local path. */
async function loadInputBytes(
  localPath: string | undefined,
  content: string | undefined,
): Promise<Uint8Array> {
  if ((localPath == null) === (content == null)) {
    throw new Error("provide exactly one of `localPath` or `content`");
  }
  if (content != null) return new TextEncoder().encode(content);
  return await Deno.readFile(localPath!);
}

/** A per-transfer staging path derived from content hash + timestamp (collision-safe). */
export function stagingPathFor(localSha: string): string {
  return `/tmp/.swamp-xfer-${localSha.slice(0, 12)}-${Date.now()}.b64`;
}

/**
 * Filesystem/instance-safe resource key from a remote path. Note: distinct
 * remote paths that sanitize to the same key (e.g. differing only past char 60,
 * or only in non-word chars) share one `file` resource — the later transfer's
 * record overwrites the earlier. Acceptable for a transfer log; the sha256 in
 * the payload still records exactly what moved.
 */
export function resourceKey(remotePath: string): string {
  return remotePath.replace(/\W+/g, "_").slice(0, 60) || "file";
}

/**
 * Reject control characters (notably CR/LF) in shell-path arguments. A newline
 * cannot break out of `shq()`'s single quotes, but it leaves the remote shell at
 * a PS2 continuation prompt mid-command, desyncing the prompt/RC_RE read loop —
 * a reliability hazard, not an injection one. Fail fast at the schema instead.
 */
const NO_CONTROL = z.string().regex(/^[^\r\n]+$/, "must not contain a newline");

const FileSchema = z.object({
  op: z.enum(["push", "pull", "verify"]),
  remotePath: z.string(),
  sha256: z.string().nullable(),
  bytes: z.number().nullable(),
  chunks: z.number().nullable(),
  verified: z.boolean().nullable(),
  match: z.boolean().nullable(),
  remoteSha256: z.string().nullable(),
  mode: z.string().nullable(),
  owner: z.string().nullable(),
  contentBase64: z.string().nullable(),
  ranAt: z.string(),
});

export const model = {
  type: "@shrug/serial-cfgmgmt/file",
  version: "2026.07.22.2",
  globalArguments: z.object({ ...ConnectionGlobals }),
  resources: {
    file: {
      description: "Result of a file transfer over the serial console.",
      schema: FileSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  // push MUTATES the target (writes a file); fail before opening the port if the
  // device is not an allowed tty path. pull/verify are read-only (still gated by
  // withSession's in-method assertAllowedDevice).
  checks: deviceAllowlistCheck(["push"]),

  methods: {
    push: {
      description:
        "Upload a local file (or inline content) to a remote path over the serial console (gzip+base64 chunked). MUTATING. Verifies sha256 both ends.",
      arguments: z.object({
        localPath: z.string().optional().describe(
          "Local file to upload (mutually exclusive with `content`).",
        ),
        content: z.string().optional().describe(
          "Inline content to upload (mutually exclusive with `localPath`).",
        ),
        remotePath: NO_CONTROL.min(1).describe(
          "Destination path on the target.",
        ),
        mode: NO_CONTROL.optional().describe("chmod mode to apply, e.g. 0644."),
        owner: NO_CONTROL.optional().describe(
          "chown owner[:group] to apply (needs a privileged shell).",
        ),
        chunkBytes: z.number().int().min(64).max(3072).default(768).describe(
          "Max base64 line length per chunk (ceiling under the 4096-byte tty line buffer).",
        ),
        gzip: z.boolean().default(true).describe(
          "gzip the payload before transfer.",
        ),
        maxRetries: z.number().int().min(0).max(10).default(3).describe(
          "Per-chunk retries on a non-zero exit before failing.",
        ),
        quietConsole: z.boolean().default(true).describe(
          "Best-effort `dmesg -n 1` during transfer (restored after).",
        ),
      }),
      execute: async (args: {
        localPath?: string;
        content?: string;
        remotePath: string;
        mode?: string;
        owner?: string;
        chunkBytes: number;
        gzip: boolean;
        maxRetries: number;
        quietConsole: boolean;
      }, context: Ctx) => {
        const g = context.globalArgs;
        const bytes = await loadInputBytes(args.localPath, args.content);
        const localSha = await sha256Hex(bytes);
        const payload = args.gzip ? await gzipBytes(bytes) : bytes;
        const chunks = chunkBase64(toBase64(payload), args.chunkBytes);
        const stagingPath = stagingPathFor(localSha);

        const result = await withSession(
          g,
          context.logger,
          (session) =>
            pushViaSession(session, {
              chunks,
              stagingPath,
              remotePath: args.remotePath,
              gzip: args.gzip,
              localSha,
              maxRetries: args.maxRetries,
              mode: args.mode,
              owner: args.owner,
              quietConsole: args.quietConsole,
            }),
        );
        context.logger.info(
          "push {bytes}B -> {device}:{path} in {chunks} chunks verified={verified}",
          {
            bytes: bytes.length,
            device: g.device,
            path: args.remotePath,
            chunks: result.chunks,
            verified: result.verified,
          },
        );
        const handle = await context.writeResource(
          "file",
          resourceKey(args.remotePath),
          {
            op: "push",
            remotePath: args.remotePath,
            sha256: localSha,
            bytes: bytes.length,
            chunks: result.chunks,
            verified: result.verified,
            match: null,
            remoteSha256: result.remoteSha,
            mode: args.mode ?? null,
            owner: args.owner ?? null,
            contentBase64: null,
            ranAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    pull: {
      description:
        "Download a remote file over the serial console (base64, gzip-aware). Verifies sha256 against a remote sha256sum. Read-only on the target.",
      arguments: z.object({
        remotePath: NO_CONTROL.min(1).describe("Source path on the target."),
        localPath: z.string().optional().describe(
          "Local path to write; if omitted the base64 content lands in the resource (avoid for secrets — resources persist).",
        ),
        gzip: z.boolean().default(true).describe(
          "Expect a gzip'd stream (gunzip locally).",
        ),
        maxRetries: z.number().int().min(0).max(10).default(3).describe(
          "Whole-pull retries on a corrupt stream (e.g. printk interleaving) before failing.",
        ),
        quietConsole: z.boolean().default(true).describe(
          "Best-effort `dmesg -n 1` during the pull (restored after).",
        ),
      }),
      execute: async (
        args: {
          remotePath: string;
          localPath?: string;
          gzip: boolean;
          maxRetries: number;
          quietConsole: boolean;
        },
        context: Ctx,
      ) => {
        const g = context.globalArgs;
        const result = await withSession(
          g,
          context.logger,
          (session) =>
            pullViaSession(session, {
              remotePath: args.remotePath,
              gzip: args.gzip,
              maxRetries: args.maxRetries,
              quietConsole: args.quietConsole,
            }),
        );
        let contentBase64: string | null = null;
        if (args.localPath) {
          await Deno.writeFile(args.localPath, result.bytes);
        } else {
          contentBase64 = toBase64(result.bytes); // resource carries base64 (may be binary)
        }
        context.logger.info(
          "pull {device}:{path} -> {bytes}B sha={sha}",
          {
            device: g.device,
            path: args.remotePath,
            bytes: result.bytes.length,
            sha: result.localSha,
          },
        );
        const handle = await context.writeResource(
          "file",
          resourceKey(args.remotePath),
          {
            op: "pull",
            remotePath: args.remotePath,
            sha256: result.localSha,
            bytes: result.bytes.length,
            chunks: null,
            verified: null,
            match: result.match,
            remoteSha256: result.remoteSha,
            mode: null,
            owner: null,
            contentBase64,
            ranAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Compare a local file's sha256 (or a given sha256) against the remote file's sha256sum without transferring. Read-only.",
      arguments: z.object({
        remotePath: NO_CONTROL.min(1).describe("Path on the target to hash."),
        localPath: z.string().optional().describe(
          "Local file whose sha256 to compare (mutually exclusive with `sha256`).",
        ),
        sha256: z.string().optional().describe(
          "Expected sha256 hex (mutually exclusive with `localPath`).",
        ),
      }),
      execute: async (
        args: { remotePath: string; localPath?: string; sha256?: string },
        context: Ctx,
      ) => {
        const g = context.globalArgs;
        if ((args.localPath == null) === (args.sha256 == null)) {
          throw new Error("provide exactly one of `localPath` or `sha256`");
        }
        // Normalize a supplied hash to lowercase hex so an uppercase expected
        // value (common from other tooling) matches sha256sum's lowercase output.
        const localSha = args.sha256
          ? args.sha256.trim().toLowerCase()
          : await sha256Hex(await Deno.readFile(args.localPath!));
        const result = await withSession(
          g,
          context.logger,
          (session) =>
            verifyViaSession(session, {
              localSha,
              remotePath: args.remotePath,
            }),
        );
        context.logger.info(
          "verify {device}:{path} match={match} (local={local} remote={remote})",
          {
            device: g.device,
            path: args.remotePath,
            match: result.match,
            local: localSha,
            remote: result.remoteSha ?? "-",
          },
        );
        const handle = await context.writeResource(
          "file",
          resourceKey(args.remotePath),
          {
            op: "verify",
            remotePath: args.remotePath,
            sha256: localSha,
            bytes: null,
            chunks: null,
            verified: null,
            match: result.match,
            remoteSha256: result.remoteSha,
            mode: null,
            owner: null,
            contentBase64: null,
            ranAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
  reports: [],
};

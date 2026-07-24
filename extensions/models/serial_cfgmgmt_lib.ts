/**
 * Shared serial-console transport for the `@shrug/serial-cfgmgmt/*` type family.
 *
 * `@adam/cfgmgmt/*` drives a target over SSH; that is useless for a board with
 * no network. This family is the serial-console counterpart: the same
 * config-management surface (node facts, exec, packages, services, …) executed
 * over a USB-UART console instead of SSH.
 *
 * Nothing here reimplements serial byte-I/O — it reuses the transport +
 * console-shell primitives from the sibling `@shrug/serial-port` extension
 * (`selectTransport` / `withPort` / `execOn` / `loginOn`). This module adds the
 * two things every cfgmgmt type needs on top of that raw console:
 *
 *   1. a single {@link ConnectionGlobals} block (device/baud/framing/creds), so
 *      each type's *model* owns its connection config — including a vaulted
 *      login password — rather than smuggling secrets through per-call inputs;
 *   2. a {@link Session} that runs a shell command and returns clean stdout
 *      **plus an exit code** (via an `echo $?` sentinel), which the mutating
 *      types (package/service) need to decide success and idempotency.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  assertAllowedDevice,
  type Clock,
  drainUntil,
  execOn,
  loginOn,
  selectTransport,
  type SerialPort,
  sessionLinkLive,
  sessionPtyPath,
  stripEscapes,
  withPort,
} from "./serial_port.ts";

/** Framing grammar, e.g. 8N1. Mirrors the serial-port model. */
const FRAMING_RE = /^[5-8][NEO][12]$/;

/** Matches the trailing shell-prompt line after right-trim (…`~]$`, `#`, `>`). */
const PROMPT_LINE_RE = /[#$>]\s*$/;

/**
 * Exit-code sentinel appended to every command so we can read `$?` over serial.
 * Also serves as the read **stop condition**: it requires a real digit, so it
 * matches only the executed `echo` output — never the pty-echoed command line,
 * which still carries a literal `$?`. That gives a per-command sync point that a
 * stale ambient prompt cannot false-match.
 */
export const RC_RE = /__RC:(-?\d+):RC__/;

/**
 * Connection + credential global arguments shared by every serial-cfgmgmt type.
 * Spread into a type's `globalArguments` so the model owns its console config.
 */
export const ConnectionGlobals = {
  device: z.string().min(1).default("/dev/ttyUSB0").describe(
    "Serial device path, e.g. /dev/ttyUSB0.",
  ),
  baud: z.number().int().positive().default(115200).describe(
    "Baud rate. Default 115200.",
  ),
  framing: z.string().regex(FRAMING_RE).default("8N1").describe(
    "Data/parity/stop framing, e.g. 8N1.",
  ),
  lineEnding: z.string().default("\n").describe(
    "Line terminator appended to sent lines. Use \\r for consoles that need CR.",
  ),
  transport: z.enum(["auto", "direct", "subprocess"]).default("auto").describe(
    "Byte-I/O transport: 'direct', 'subprocess' (cat/dd), or 'auto'.",
  ),
  prompt: z.string().default("[#$>] $").describe(
    "Regex for the shell prompt; command reads stop once the tail matches it.",
  ),
  username: z.string().optional().describe(
    "Login username. When set with `password`, the session authenticates a getty before running commands.",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Login password, resolved from a vault reference (never a literal). Required to log in a getty.",
  ),
  idleMs: z.number().int().positive().max(60_000).default(1000).describe(
    "Stop a command read after this many ms with no new bytes (fallback bound; commands normally stop on their output sentinel).",
  ),
  maxMs: z.number().int().positive().max(600_000).default(15_000).describe(
    "Hard cap on a single command's read time.",
  ),
  settleMs: z.number().int().min(0).max(60_000).default(0).describe(
    "Before the first command, drain the console to quiet for this many ms and discard stale buffered output (residual login/shell prompt, MOTD tail, late printk). 0 disables — commands already synchronize on their `__RC:<n>:RC__` output sentinel, so a settle is only insurance for the login preamble.",
  ),
  requireSession: z.boolean().default(false).describe(
    "Strict mode: fail unless a live `serial-port` session holder owns the device (start one with `session_start`). Off by default — calls auto-attach to a holder when present and otherwise open/close the port per call. Set true in workflows (or any caller that needs cross-call shell state guaranteed) so a missing holder is a hard error, not a silent fall back to per-call opens.",
  ),
};

/** Validated shape of {@link ConnectionGlobals}. */
export type ConnectionArgs = z.infer<z.ZodObject<typeof ConnectionGlobals>>;

/** Minimal method-context shape the family relies on. */
export interface Ctx {
  globalArgs: ConnectionArgs;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Result of running one command over the console. */
export interface CommandResult {
  stdout: string;
  /** Exit code parsed from the `$?` sentinel, or null if it could not be read. */
  exitCode: number | null;
}

/** A live, logged-in console shell. */
export interface Session {
  run(command: string): Promise<CommandResult>;
}

/**
 * Strip console noise so only the command's stdout remains: ANSI/bracketed-paste
 * escapes, CR, the echoed command line, and the trailing shell prompt.
 */
export function cleanOutput(
  raw: string,
  command: string,
  promptLineRe: RegExp = PROMPT_LINE_RE,
): string {
  const noAnsi = stripEscapes(raw).replace(/\r/g, "");
  const cmd = command.trim();
  const lines = noAnsi.split("\n").map((l) => l.replace(/\s+$/, ""));
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    // Drop the echoed command (possibly the first line) and any prompt line.
    // On the first kept line the remote may glue a preceding shell prompt onto
    // the echo (e.g. "[u@h ~]$ id -un") when an earlier prompt was left
    // un-drained — so on line 0 also match the command at the END of the line.
    if (
      t === cmd ||
      (kept.length === 0 && t !== "" &&
        (cmd.startsWith(t) || t.endsWith(cmd)))
    ) {
      continue;
    }
    if (promptLineRe.test(line)) continue;
    kept.push(line);
  }
  while (kept.length && kept[0].trim() === "") kept.shift();
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  return kept.join("\n");
}

/**
 * Split a cleaned, RC-sentinel-terminated capture into stdout + exit code.
 *
 * The sentinel is the command's true end-of-output marker, so stdout is
 * everything BEFORE it — never merely the capture with the sentinel token
 * deleted. `drainUntil` stops the read once `RC_RE` matches but returns the
 * whole buffer, so the same final chunk can carry post-sentinel bytes: the
 * shell prompt that follows. A *full* prompt is dropped by {@link cleanOutput}'s
 * `PROMPT_LINE_RE`, but a **partial** prompt caught mid-emit (`[user@host ~`,
 * no closing `]$ `) matches nothing and would otherwise bleed into stdout — and
 * when that stdout is spliced back into a shell command (e.g. a captured
 * `mktemp -d` path), the embedded newline+prompt fragment corrupts every
 * downstream command. Truncating at the sentinel discards anything after it
 * regardless of shape, so no trailing prompt noise can survive.
 */
export function splitExitCode(cleaned: string): CommandResult {
  const m = cleaned.match(RC_RE);
  const exitCode = m ? Number(m[1]) : null;
  const beforeSentinel = m ? cleaned.slice(0, m.index) : cleaned;
  const stdout = beforeSentinel
    .replace(/\n[ \t]*$/, "")
    .replace(/^[ \t]*\n/, "");
  return { stdout: stdout.replace(/\s+$/, ""), exitCode };
}

/**
 * Drain the port to quiet and discard the bytes. After a login or nudge the
 * console can leave a stale prompt / MOTD tail / late printk buffered; sweeping
 * it before the first command keeps that noise out of the first capture.
 *
 * This is *insurance*, not the primary defence: {@link withSession}'s session
 * stops each command read on its unique `__RC:<n>:RC__` sentinel (not on the
 * ambient prompt), so a stranded prompt no longer false-matches. Returns the
 * discarded text for observability/tests. `clock` is injectable for tests;
 * omit it in production to use the real clock.
 */
export async function settle(
  port: SerialPort,
  opts: { settleMs: number; maxMs: number },
  clock?: Clock,
): Promise<string> {
  const { output } = await drainUntil(
    port,
    { idleMs: opts.settleMs, maxMs: opts.maxMs },
    clock,
  );
  return output;
}

/** Effective per-call config resolved from the connection globals. */
function portConfig(g: ConnectionArgs) {
  return {
    device: g.device,
    baud: g.baud,
    framing: g.framing,
    lineEnding: g.lineEnding,
  };
}

/**
 * Which device path to actually open. When a live socat holder owns the real
 * device (see {@link sessionLinkLive}), I/O is redirected to its PTY so the
 * logged-in shell persists across separate cfgmgmt runs (logout→login→gather as
 * distinct method runs, or a workflow chaining serial steps). Bookkeeping, the
 * allowlist check, and error messages stay on the real `device`; only the byte
 * path moves to the PTY. Falls back to the real device when no holder is live.
 * Pure and injectable so the attach decision is unit-testable.
 */
export function ioDeviceFor(device: string, live: boolean): string {
  return live ? sessionPtyPath(device) : device;
}

/** Attach drain bounds: clear stale PTY bytes buffered while no client was
 * attached, before the first login/command (mirrors serial-port's attach). */
const SESSION_DRAIN_IDLE_MS = 200;
const SESSION_DRAIN_MAX_MS = 1500;

/**
 * Open the console, authenticate a getty when credentials are configured
 * (otherwise nudge to a fresh prompt), run `fn` against a {@link Session}, and
 * always close the port. `loginOn` is a no-op login when the board already sits
 * at a shell prompt, so passing credentials is safe either way.
 */
export async function withSession<T>(
  g: ConnectionArgs,
  logger: Ctx["logger"],
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  assertAllowedDevice(g.device);
  const stopRe = new RegExp(g.prompt);
  const cfg = portConfig(g);

  // Attach to a live socat holder (started via `serial-port session_start` on the
  // same host device) so the login + shell state survive across separate runs.
  // The holder's `session` resource lives on the serial-port instance, invisible
  // here, so liveness is decided host-side by the deterministic PTY link path.
  const attached = await sessionLinkLive(g.device);
  if (g.requireSession && !attached) {
    throw new Error(
      `requireSession is set but no live session holder owns ${g.device}. ` +
        `Start one with \`session_start\` on the serial-port model bound to ` +
        `this device before running this method.`,
    );
  }
  const ioCfg = { ...cfg, device: ioDeviceFor(g.device, attached) };
  if (attached) {
    logger.info("Attaching to held session on {device} via {pty}", {
      device: g.device,
      pty: ioCfg.device,
    });
  }

  return await withPort(
    selectTransport(g.transport, logger),
    ioCfg,
    async (port: SerialPort) => {
      // Attached: sweep bytes the PTY buffered while no client was attached
      // (a prior call's tail, async console output) so they can't confuse the
      // login prompt detection below. The post-login drain is what keeps them
      // out of the first command's output.
      if (attached) {
        await settle(port, {
          settleMs: SESSION_DRAIN_IDLE_MS,
          maxMs: SESSION_DRAIN_MAX_MS,
        });
      }
      if (g.username && g.password) {
        const res = await loginOn(port, {
          username: g.username,
          password: g.password,
          lineEnding: g.lineEnding,
          promptAfter: stopRe,
          idleMs: g.idleMs,
          maxMs: g.maxMs,
        });
        if (res.status !== "ok") {
          throw new Error(
            `Serial login as "${g.username}" on ${g.device} failed ` +
              `(no shell prompt after credentials).`,
          );
        }
      } else if (g.username || g.password) {
        throw new Error(
          "Serial login needs both `username` and `password` " +
            "(set `password` to a vault reference).",
        );
      } else {
        // No creds: assume an already-open shell, nudge to a fresh prompt.
        await execOn(port, {
          command: "",
          lineEnding: g.lineEnding,
          prompt: stopRe,
          idleMs: 500,
          maxMs: 3000,
          stripEcho: true,
        });
      }

      // Drain the post-login residue (prompt, MOTD tail, bracketed-paste /
      // cursor escapes bash emits when readline starts) to quiet before the
      // first command, so it can't bleed into that command's captured output.
      // Always done when attached — over the PTY that residue reliably trails
      // into the first `session.run` (observed polluting the hostname probe);
      // otherwise it's opt-in insurance via `settleMs` (the sentinel-synced
      // reads below already tolerate a stranded prompt on the open/close path).
      if (attached || g.settleMs > 0) {
        const idle = attached ? SESSION_DRAIN_IDLE_MS : g.settleMs;
        await settle(port, {
          settleMs: idle,
          maxMs: attached
            ? SESSION_DRAIN_MAX_MS
            : Math.max(g.settleMs * 8, 2000),
        });
      }

      const session: Session = {
        run: async (command: string) => {
          // Append a `$?` sentinel so we recover the exit code over a dumb
          // console, and — crucially — stop the read on that sentinel rather
          // than the ambient shell prompt. A residual prompt left in the buffer
          // (e.g. by loginOn) would false-match a prompt stop-regex immediately
          // and return before the real output; RC_RE requires an actual digit,
          // so it matches only the executed `echo` (the pty-echoed command line
          // still carries a literal `$?`), giving a deterministic sync point.
          const wrapped = `${command}; echo "__RC:$?:RC__"`;
          const { output } = await execOn(port, {
            command: wrapped,
            lineEnding: g.lineEnding,
            prompt: RC_RE,
            idleMs: g.idleMs,
            maxMs: g.maxMs,
            stripEcho: true,
          });
          return splitExitCode(cleanOutput(output, wrapped));
        },
      };
      return await fn(session);
    },
  );
}

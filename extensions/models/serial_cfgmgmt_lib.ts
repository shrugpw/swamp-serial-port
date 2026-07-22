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
  execOn,
  loginOn,
  type SerialPort,
  selectTransport,
  withPort,
} from "./serial_port.ts";

/** Framing grammar, e.g. 8N1. Mirrors the serial-port model. */
const FRAMING_RE = /^[5-8][NEO][12]$/;

/** CSI / bracketed-paste escape sequences a console interleaves with output. */
export const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Matches the trailing shell-prompt line after right-trim (…`~]$`, `#`, `>`). */
const PROMPT_LINE_RE = /[#$>]\s*$/;

/** Exit-code sentinel appended to every command so we can read `$?` over serial. */
const RC_RE = /__RC:(-?\d+):RC__/;

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
    "Stop a command read after this many ms with no new bytes.",
  ),
  maxMs: z.number().int().positive().max(600_000).default(15_000).describe(
    "Hard cap on a single command's read time.",
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
  const noAnsi = raw.replace(ANSI_RE, "").replace(/\r/g, "");
  const cmd = command.trim();
  const lines = noAnsi.split("\n").map((l) => l.replace(/\s+$/, ""));
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    // Drop the echoed command (possibly the first line) and any prompt line.
    if (t === cmd || (kept.length === 0 && t !== "" && cmd.startsWith(t))) {
      continue;
    }
    if (promptLineRe.test(line)) continue;
    kept.push(line);
  }
  while (kept.length && kept[0].trim() === "") kept.shift();
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  return kept.join("\n");
}

/** Split a cleaned, RC-sentinel-terminated capture into stdout + exit code. */
export function splitExitCode(cleaned: string): CommandResult {
  const m = cleaned.match(RC_RE);
  const exitCode = m ? Number(m[1]) : null;
  const stdout = cleaned
    .replace(RC_RE, "")
    .replace(/\n[ \t]*$/, "")
    .replace(/^[ \t]*\n/, "");
  return { stdout: stdout.replace(/\s+$/, ""), exitCode };
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

  return await withPort(
    selectTransport(g.transport, logger),
    cfg,
    async (port: SerialPort) => {
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

      const session: Session = {
        run: async (command: string) => {
          // Append a `$?` sentinel so we recover the exit code over a dumb console.
          const wrapped = `${command}; echo "__RC:$?:RC__"`;
          const { output } = await execOn(port, {
            command: wrapped,
            lineEnding: g.lineEnding,
            prompt: stopRe,
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

/**
 * `@shrug/serial-cfgmgmt/package` — query and install packages over the serial
 * console. Serial counterpart to `@adam/cfgmgmt/{dnf,apt,pacman,…}`.
 *
 * `query` is read-only and safe. `install` mutates the target and assumes a
 * privileged (root) shell — it is scaffolding: exercise it deliberately, never
 * against a device without confirming the target first.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type CommandResult,
  type ConnectionArgs,
  ConnectionGlobals,
  type Ctx,
  type Session,
  withSession,
} from "./serial_cfgmgmt_lib.ts";
import {
  assertAllowedDevice,
  type Clock,
  deviceAllowlistCheck,
  drainUntil,
  loginOn,
  selectTransport,
  sendLine,
  type SerialPort,
  sessionLinkLive,
  stripEscapes,
} from "./serial_port.ts";

const PackageSchema = z.object({
  name: z.string(),
  manager: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  checkedAt: z.string(),
});

/** Supported managers and the `command -v` binary that detects each. */
const MANAGERS = ["dnf", "yum", "apt-get", "pacman", "apk", "zypper"] as const;
type Manager = (typeof MANAGERS)[number];

/** Detect the target's package manager over the console (first match wins). */
export async function detectManager(
  run: (command: string) => Promise<CommandResult>,
): Promise<Manager> {
  const list = MANAGERS.join(" ");
  const out = (await run(
    `for b in ${list}; do command -v "$b" >/dev/null 2>&1 && { echo "$b"; break; }; done`,
  )).stdout.trim();
  const found = out.split("\n")[0]?.trim();
  if (found && (MANAGERS as readonly string[]).includes(found)) {
    return found as Manager;
  }
  throw new Error(
    `No supported package manager found on target (looked for: ${list}).`,
  );
}

/** Query whether `name` is installed and, if so, its version. */
export async function queryPackage(
  session: Session,
  manager: Manager,
  name: string,
): Promise<{ installed: boolean; version: string | null }> {
  const q = (name: string) => name.replace(/[^\w.+-]/g, "");
  const pkg = q(name);
  const cmd = manager === "apt-get"
    ? `dpkg-query -W -f='\${Version}' ${pkg} 2>/dev/null`
    : manager === "pacman"
    ? `pacman -Q ${pkg} 2>/dev/null | awk '{print $2}'`
    : manager === "apk"
    ? `apk info -e ${pkg} >/dev/null 2>&1 && apk version ${pkg} 2>/dev/null | awk 'NR==2{print $1}'`
    : `rpm -q --qf '%{VERSION}-%{RELEASE}' ${pkg} 2>/dev/null`; // dnf/yum/zypper
  const res = await session.run(cmd);
  const installed = res.exitCode === 0 && res.stdout.trim() !== "";
  return { installed, version: installed ? res.stdout.trim() : null };
}

/** Privilege-escalation methods for `become` (the login user is unprivileged). */
export type BecomeMethod = "sudo" | "doas";

/**
 * Command prefix that escalates privilege when `become` is set. `sudo -n` is
 * non-interactive (fails fast rather than hanging on a password prompt over the
 * dumb console); `doas` is non-interactive by configuration. Empty when `become`
 * is false (the session is already privileged, e.g. a root console). The prefix
 * is quote/`$`-free so a become-prefixed upgrade command still satisfies
 * {@link launchCommand}'s nested-quoting contract when spliced into the detached
 * launcher.
 */
export function becomePrefix(become: boolean, method: BecomeMethod): string {
  if (!become) return "";
  return method === "doas" ? "doas " : "sudo -n ";
}

/** Resolve the become prefix from a method's globalArgs (untyped in Ctx). */
function becomeOf(globalArgs: unknown): string {
  const g = globalArgs as { become?: boolean; becomeMethod?: BecomeMethod };
  return becomePrefix(g.become ?? false, g.becomeMethod ?? "sudo");
}

/**
 * The install command line for a manager. Mutating, so it needs root: pass a
 * {@link becomePrefix} (`sudo -n `/`doas `) when the login user is unprivileged,
 * or `""` when the session is already root.
 */
export function installCommand(
  manager: Manager,
  name: string,
  become = "",
): string {
  const pkg = name.replace(/[^\w.+-]/g, "");
  switch (manager) {
    case "apt-get":
      // `DEBIAN_FRONTEND` is an env var, not a command: under `become` it must
      // ride inside the escalated process (`sudo -n env VAR=… apt-get`), since
      // `sudo` would otherwise treat the assignment as a command to run.
      return become
        ? `${become}env DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg}`
        : `DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg}`;
    case "pacman":
      return `${become}pacman -S --noconfirm ${pkg}`;
    case "apk":
      return `${become}apk add ${pkg}`;
    case "zypper":
      return `${become}zypper --non-interactive install ${pkg}`;
    default:
      return `${become}${manager} install -y ${pkg}`; // dnf/yum
  }
}

/**
 * The whole-system upgrade command per manager (mirrors {@link installCommand}).
 * Non-interactive; assumes a privileged shell. `--refresh` / `--security` are
 * dnf/yum-only flags — the other managers refresh implicitly and have no
 * security-only mode over this surface.
 */
export function upgradeCommand(
  manager: Manager,
  opts: {
    refreshMetadata: boolean;
    securityOnly: boolean;
    becomePrefix?: string;
  },
): string {
  const bp = opts.becomePrefix ?? "";
  switch (manager) {
    case "apt-get":
      // Both halves of the chain need root; the noninteractive env rides inside
      // the escalated `apt-get upgrade` (see {@link installCommand}).
      return bp
        ? `${bp}apt-get update && ${bp}env DEBIAN_FRONTEND=noninteractive apt-get upgrade -y`
        : "DEBIAN_FRONTEND=noninteractive apt-get update && apt-get upgrade -y";
    case "pacman":
      return `${bp}pacman -Syu --noconfirm`;
    case "apk":
      return `${bp}apk upgrade`;
    case "zypper":
      return `${bp}zypper --non-interactive update`;
    default: {
      // dnf/yum: -y answers the transaction confirm *and* new-GPG-key imports.
      const refresh = opts.refreshMetadata ? " --refresh" : "";
      const security = opts.securityOnly ? " --security" : "";
      return `${bp}${manager} upgrade -y${refresh}${security}`;
    }
  }
}

/**
 * The non-mutating preview command per manager: solve + list the plan, install
 * nothing. dnf/yum answer "no" via `--assumeno`; the others use their standard
 * simulate flag. Runs inline (bounded) — never detached.
 */
export function dryRunCommand(
  manager: Manager,
  opts: {
    refreshMetadata: boolean;
    securityOnly: boolean;
    becomePrefix?: string;
  },
): string {
  // Preview under the SAME privilege as the real run so a `become`-only failure
  // (e.g. sudo not configured) surfaces in the dry-run, not the live upgrade.
  const bp = opts.becomePrefix ?? "";
  switch (manager) {
    case "apt-get":
      return bp
        ? `${bp}apt-get update && ${bp}apt-get -s upgrade`
        : "DEBIAN_FRONTEND=noninteractive apt-get update && apt-get -s upgrade";
    case "pacman":
      return `${bp}pacman -Syu --print`;
    case "apk":
      return `${bp}apk upgrade --simulate`;
    case "zypper":
      return `${bp}zypper --non-interactive update --dry-run`;
    default: {
      // dnf/yum: --assumeno solves + lists then aborts (exit 1 when there is a
      // plan) — no download, no install.
      const refresh = opts.refreshMetadata ? " --refresh" : "";
      const security = opts.securityOnly ? " --security" : "";
      return `${bp}${manager} upgrade --assumeno${refresh}${security}`;
    }
  }
}

/** Upper bound on the log tail stored in the resource / read over the console. */
const LOG_TAIL_BYTES = 4096;

/** Delay before the confirmation re-poll (see {@link pollWithConfirm}). Short —
 * a live worker only needs one more read to answer `RUNNING`, and a truly dead
 * one stays gone. */
const POLL_CONFIRM_MS = 2000;

/**
 * Create a unique, exclusively-owned staging dir on the TARGET for one run and
 * echo its path. `mktemp -d` gives an unpredictable, atomically-created dir
 * (defeats the symlink / TOCTOU class — a pre-planted `/tmp/.swamp-dnf.*` symlink
 * can't be guessed or reused) and per-run uniqueness (so overlapping or
 * back-to-back invocations can't collide on a shared rc/log the way a fixed
 * `/tmp/.swamp-dnf.rc` did). {@link runUpgrade} runs this first, then threads the
 * returned dir through launch/poll/collect/cleanup instead of any global literal.
 */
export function makeStagingDirCommand(): string {
  return `mktemp -d /tmp/.swamp-dnf.XXXXXX`;
}

/** The rc / log / pid file paths under a run's unique staging dir. */
function stagingFiles(dir: string): { rc: string; log: string; pid: string } {
  return { rc: `${dir}/rc`, log: `${dir}/log`, pid: `${dir}/pid` };
}

/**
 * Launch line for the transaction (one `Session.run`, returns immediately):
 * `setsid … </dev/null` detaches from the console with a closed stdin so no tty
 * prompt can block; the transaction writes its own log and, on exit, its rc into
 * this run's unique staging `dir` (no stale-rc `rm` is needed — the dir is freshly
 * created per run). The trailing `& true` backgrounds it and yields a clean exit
 * for the RC sentinel the session appends (a bare trailing `&` before that `;`
 * would be a syntax error).
 *
 * The recorded pid is the WORKER's own `$$`, written from inside the payload,
 * NOT the launcher's `$!`. Under the only real caller — an interactive getty
 * login shell (a process-group leader), which is what `withSession`/`loginOn`
 * produce — util-linux `setsid` forks (`getpgrp()==getpid()`): the parent exits
 * within ms and the transaction runs under a different pid. `$!` would capture
 * that short-lived parent, so `kill -0 $!` fails on the first poll of a healthy
 * upgrade and {@link pollCommand} would abort it. Instead the payload records
 * `$$` and then `exec`s the transaction, so the pid file holds the long-lived
 * process actually running dnf/apt; `kill -0 $(cat pid)` stays true for its whole
 * duration. `echo \$?` is escaped so the UPGRADE's exit code (not `exec`'s) is
 * what lands in the rc file.
 *
 * Nested-quoting contract: `upgradeCmd` is spliced verbatim into a double-quoted
 * inner `sh -c "…"` nested inside an outer single-quoted payload, with NO
 * escaping. That is sound only while the command carries no single quote (would
 * close the payload) and no `$` (would be expanded by the wrong shell — inner sh,
 * or the outer at parse time). Every {@link upgradeCommand} output today is static
 * and quote/$-free; the guard below turns any future violation into a loud error
 * instead of a silently broken launcher.
 */
export function launchCommand(upgradeCmd: string, dir: string): string {
  if (/['$]/.test(upgradeCmd)) {
    throw new Error(
      `launchCommand: upgrade command must contain no single quote or '$' ` +
        `(nested-quoting contract) — got ${JSON.stringify(upgradeCmd)}.`,
    );
  }
  const { rc, log, pid } = stagingFiles(dir);
  return `setsid sh -c 'echo $$ >${pid}; ` +
    `exec sh -c "${upgradeCmd} >${log} 2>&1; echo \\$? >${rc}"' ` +
    `</dev/null >/dev/null 2>&1 & true`;
}

/**
 * Completion poll for this run's `dir`, in strict precedence:
 *   1. rc file exists            → `DONE:<rc>` (transaction recorded its exit)
 *   2. worker pid answers kill -0 → `RUNNING` (authoritative — alive regardless
 *      of whether it has logged anything yet)
 *   3. no rc, worker gone, log has bytes → `WORKER_GONE` (it started then died —
 *      OOM/crash/kill — without recording an rc; fail fast with the log tail)
 *   4. no rc, worker gone, empty log     → `LAUNCH_FAILED` (never started)
 *
 * Liveness (`kill -0`) is tested BEFORE the log-bytes check: a dead worker that
 * had already emitted output must NOT read as `RUNNING` (that would spin to the
 * timeout), and a live worker must never be mis-declared gone. `kill -0` only
 * tests for liveness — it never signals the transaction.
 */
export function pollCommand(dir: string): string {
  const { rc, log, pid } = stagingFiles(dir);
  return `if [ -f ${rc} ]; then echo "DONE:$(cat ${rc})"; ` +
    `elif [ -s ${pid} ] && kill -0 "$(cat ${pid})" 2>/dev/null; then echo RUNNING; ` +
    `elif [ -s ${log} ]; then echo WORKER_GONE; ` +
    `else echo LAUNCH_FAILED; fi`;
}

/** Bounded collect: last {@link LOG_TAIL_BYTES} bytes of this run's log. */
export function collectCommand(dir: string): string {
  const { log } = stagingFiles(dir);
  return `tail -c ${LOG_TAIL_BYTES} ${log} 2>/dev/null`;
}

/** Remove this run's staging dir (success path only; left in place on timeout). */
export function cleanupCommand(dir: string): string {
  return `rm -rf ${dir}`;
}

/** Parse a poll line into completion + exit code. `DONE:<rc>` (real digits) means
 * finished; `WORKER_GONE` means it started then died without recording an rc
 * (fail fast); `LAUNCH_FAILED` means the background job never started (fail fast);
 * `RUNNING`, empty, or garbage means keep polling. */
export function parsePollLine(
  line: string,
): { done: boolean; rc: number | null; launchFailed: boolean; died: boolean } {
  const t = (line ?? "").trim();
  const m = t.match(/DONE:(-?\d+)/);
  if (m) {
    return { done: true, rc: Number(m[1]), launchFailed: false, died: false };
  }
  if (/WORKER_GONE/.test(t)) {
    return { done: false, rc: null, launchFailed: false, died: true };
  }
  if (/LAUNCH_FAILED/.test(t)) {
    return { done: false, rc: null, launchFailed: true, died: false };
  }
  return { done: false, rc: null, launchFailed: false, died: false };
}

/**
 * Poll once, and NEVER believe a terminal `WORKER_GONE`/`LAUNCH_FAILED` verdict
 * on a single read — re-poll to confirm first. A lone poll over an unreliable
 * serial transport (dd/cat subprocess I/O, a first-poll race with the pid-file
 * write, a garbled `kill -0 $(cat pid)` read) can spuriously miss a worker that
 * is in fact running, and both poll loops fail FAST on `died`/`launchFailed` — so
 * one bad read would abort a healthy long transaction. Caught live on the Banana
 * Pi F3 F42→F43 download (2026-07-24): a first-poll `WORKER_GONE` killed a 953 MiB
 * download that was running fine to completion. A genuinely dead worker stays
 * gone on the confirmation poll; a live one answers `RUNNING` (or its rc has since
 * landed → `DONE`). The confirmation verdict is authoritative and returned as-is.
 */
async function pollWithConfirm(
  session: Session,
  dir: string,
  hooks: UpgradeHooks,
): Promise<ReturnType<typeof parsePollLine>> {
  const first = parsePollLine((await session.run(pollCommand(dir))).stdout);
  if (!first.died && !first.launchFailed) return first;
  await hooks.sleep(POLL_CONFIRM_MS);
  return parsePollLine((await session.run(pollCommand(dir))).stdout);
}

/**
 * Derive {@link UpgradeOutcome.packagesUpdated} / `changed` from a bounded log
 * tail. A "Nothing to do" (or apt "0 upgraded") is the universal no-op signal;
 * otherwise pull the count from the manager's transaction summary.
 */
export function parseUpgradeSummary(
  logTail: string,
  manager: Manager,
): { packagesUpdated: number; changed: boolean } {
  const text = logTail ?? "";
  if (/nothing to do/i.test(text)) {
    return { packagesUpdated: 0, changed: false };
  }
  let n: number | null = null;
  switch (manager) {
    case "apt-get": {
      const m = text.match(/(\d+)\s+upgraded/i);
      n = m ? Number(m[1]) : null;
      break;
    }
    case "pacman": {
      const m = text.match(/Packages\s*\((\d+)\)/i);
      n = m ? Number(m[1]) : null;
      break;
    }
    default: {
      // dnf4/yum/zypper "Upgrade  N Package(s)"; dnf5 "Upgrading: N package(s)".
      const m = text.match(/Upgrad(?:e|ing):?\s+(\d+)\s+[Pp]ackage/i);
      n = m ? Number(m[1]) : null;
    }
  }
  if (n === null) {
    // No parseable count — infer change from a completion marker.
    const changed = /^\s*(Complete!|Upgraded:)/im.test(text);
    return { packagesUpdated: 0, changed };
  }
  return { packagesUpdated: n, changed: n > 0 };
}

/**
 * Best-effort, REPORT-ONLY reboot inference (pure). `needs-restarting -r` is
 * authoritative when it clearly answers (exit 1 ⇒ advised, exit 0 ⇒ not);
 * otherwise fall back to "newest installed kernel differs from the running one".
 * `upgrade` never acts on this — a workflow / operator decides.
 */
export function inferRebootRequired(input: {
  needsRestartingExit: number | null;
  newestKernel: string | null;
  runningKernel: string | null;
}): boolean {
  if (input.needsRestartingExit === 1) return true;
  if (input.needsRestartingExit === 0) return false;
  const newest = (input.newestKernel ?? "").trim();
  const running = (input.runningKernel ?? "").trim();
  if (!newest || !running) return false;
  return newest !== running;
}

/** Injectable clock so the poll loop is unit-testable without real waits. */
export interface UpgradeHooks {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Resolved inputs for one {@link runUpgrade}. */
export interface UpgradeParams {
  manager: Manager;
  refreshMetadata: boolean;
  securityOnly: boolean;
  dryRun: boolean;
  pollIntervalMs: number;
  maxWaitMs: number;
  /** Privilege-escalation prefix (`sudo -n `/`doas `/`""`) from {@link becomeOf}. */
  becomePrefix: string;
}

/** What a run records into the `upgrade` resource (minus `device`). */
export interface UpgradeOutcome {
  manager: Manager;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  changed: boolean;
  packagesUpdated: number;
  rebootRequired: boolean;
  releaseVersion: string | null;
  summary: string;
}

/**
 * Thrown when an upgrade run fails or times out. Carries the partial
 * {@link UpgradeOutcome} (exitCode non-zero / `-1` sentinel, `changed=false`,
 * a captured log/preview tail, `finishedAt`) so the caller can STILL persist a
 * queryable `upgrade` resource before the error propagates — a failed or
 * timed-out run leaves a durable record, not a hole.
 */
export class UpgradeFailure extends Error {
  readonly outcome: UpgradeOutcome;
  constructor(message: string, outcome: UpgradeOutcome) {
    super(message);
    this.name = "UpgradeFailure";
    this.outcome = outcome;
  }
}

/** Running release id from /etc/os-release (best-effort; null when absent). */
async function probeReleaseVersion(session: Session): Promise<string | null> {
  const res = await session.run(
    `. /etc/os-release 2>/dev/null; printf '%s' "$VERSION_ID"`,
  );
  return res.stdout.trim() || null;
}

/** Report-only reboot probe (dnf/yum only; see {@link inferRebootRequired}). */
async function probeRebootRequired(
  session: Session,
  manager: Manager,
): Promise<boolean> {
  if (manager !== "dnf" && manager !== "yum") return false;
  // Deliberately NOT `become`-escalated: `needs-restarting -r` is a read-only
  // reboot hint that runs fine unprivileged, and keeping sudo out of this path
  // means exit 1 unambiguously signals "reboot advised" — never a sudo policy
  // denial (a narrowly-scoped sudoers grant could authorize `dnf upgrade` yet
  // refuse `needs-restarting`, and sudo's denial also exits 1, which would read
  // as a false reboot flag). If the bare probe can't answer, inferRebootRequired
  // falls back to comparing the newest installed kernel with the running one.
  const nr = await session.run(`${manager} needs-restarting -r`);
  const newestKernel = (await session.run(
    `rpm -q --qf '%{VERSION}-%{RELEASE}.%{ARCH}\\n' kernel 2>/dev/null | sort -V | tail -n1`,
  )).stdout.trim() || null;
  const runningKernel = (await session.run("uname -r")).stdout.trim() || null;
  return inferRebootRequired({
    needsRestartingExit: nr.exitCode,
    newestKernel,
    runningKernel,
  });
}

/**
 * Drive a whole-system upgrade over one {@link Session}. Isolated from transport
 * and from the clock so it is fully unit-testable against a scripted fake
 * session. `dryRun` runs the preview inline (bounded, no mutation) — a `null`
 * exit code there means the session timed out mid-solve and is treated as a
 * FAILURE (never coerced to success). A real run stages under a unique per-run
 * `mktemp -d` dir on the target, launches the transaction detached (§3.2), and
 * polls short RC-synced reads until `DONE:<rc>`; a launch that never started
 * fails fast, exceeding `maxWaitMs` fails loudly and leaves the transaction
 * running (never reaped, staging dir left in place), and a non-zero rc throws.
 * Every failure path throws {@link UpgradeFailure} carrying a partial outcome so
 * the caller can persist a record. The vaulted login password is owned by
 * {@link withSession} — it never reaches this function, the commands, or the
 * summary.
 */
export async function runUpgrade(
  session: Session,
  params: UpgradeParams,
  hooks: UpgradeHooks,
): Promise<UpgradeOutcome> {
  const startedAt = new Date(hooks.now()).toISOString();
  /** Build a failure outcome for {@link UpgradeFailure} (never fabricates a plan). */
  const fail = (exitCode: number, summary: string): UpgradeOutcome => ({
    manager: params.manager,
    startedAt,
    finishedAt: new Date(hooks.now()).toISOString(),
    exitCode,
    changed: false,
    packagesUpdated: 0,
    rebootRequired: false,
    releaseVersion: null,
    summary,
  });

  if (params.dryRun) {
    const res = await session.run(dryRunCommand(params.manager, params));
    const summary = res.stdout.slice(-LOG_TAIL_BYTES);
    if (res.exitCode === null) {
      // A null exit code means the preview never produced its sentinel — the
      // session timed out mid-solve. Do NOT coerce that to success (?? 0) or
      // fabricate a plan from the truncated tail; report the timeout loudly.
      throw new UpgradeFailure(
        `${params.manager} dry-run did not complete within maxMs ` +
          `(no exit-code sentinel) — raise maxMs or check the console. ` +
          `Captured tail:\n${summary}`,
        fail(-1, summary),
      );
    }
    const { packagesUpdated } = parseUpgradeSummary(summary, params.manager);
    const releaseVersion = await probeReleaseVersion(session);
    return {
      manager: params.manager,
      startedAt,
      finishedAt: new Date(hooks.now()).toISOString(),
      exitCode: res.exitCode, // non-null here; dnf `--assumeno` exits 1 on a plan
      changed: false, // preview only — nothing was applied
      packagesUpdated, // what WOULD be updated
      rebootRequired: false,
      releaseVersion,
      summary,
    };
  }

  // Stage under a unique, exclusively-owned dir on the target so concurrent /
  // back-to-back runs can't collide and no pre-planted symlink can be reused.
  // Validate the WHOLE captured path, not just its prefix: this value is spliced
  // verbatim into launch/poll/collect commands, so any embedded whitespace or
  // console residue (a prompt fragment bled past the RC sentinel) would corrupt
  // every downstream command. `splitExitCode` truncates at the sentinel so this
  // should already be clean — the exact-match guard makes that a hard invariant.
  const dir = (await session.run(makeStagingDirCommand())).stdout.trim();
  if (!/^\/tmp\/\.swamp-dnf\.[A-Za-z0-9]+$/.test(dir)) {
    throw new UpgradeFailure(
      `could not create a staging dir on the target ` +
        `(mktemp returned ${JSON.stringify(dir)}).`,
      fail(-1, dir),
    );
  }

  // Launch detached, then poll — never read the whole transaction in one call.
  await session.run(launchCommand(upgradeCommand(params.manager, params), dir));

  const deadline = hooks.now() + params.maxWaitMs;
  let rc: number | null = null;
  while (true) {
    const parsed = await pollWithConfirm(session, dir, hooks);
    if (parsed.done) {
      rc = parsed.rc;
      break;
    }
    if (parsed.launchFailed) {
      // Worker gone with an empty log: `setsid`/`sh -c` never started. Fail fast
      // instead of spinning to maxWaitMs on a false "still RUNNING".
      const tail = (await session.run(collectCommand(dir))).stdout.slice(
        -LOG_TAIL_BYTES,
      );
      throw new UpgradeFailure(
        `${params.manager} background upgrade failed to launch ` +
          `(worker pid gone, no log written) — see ${dir}/log on the target.`,
        fail(-1, tail),
      );
    }
    if (parsed.died) {
      // Worker gone AFTER logging but without recording an rc: it crashed / was
      // OOM-killed / was killed mid-transaction. Fail fast with the log tail
      // rather than spinning to maxWaitMs on a stale "still RUNNING".
      const tail = (await session.run(collectCommand(dir))).stdout.slice(
        -LOG_TAIL_BYTES,
      );
      throw new UpgradeFailure(
        `${params.manager} upgrade process exited without recording an exit code ` +
          `(worker gone, partial log) — likely crashed / OOM-killed / killed ` +
          `mid-transaction. See ${dir}/log on the target. Log tail:\n${tail}`,
        fail(-1, tail),
      );
    }
    if (hooks.now() >= deadline) {
      const tail = (await session.run(collectCommand(dir))).stdout.slice(
        -LOG_TAIL_BYTES,
      );
      throw new UpgradeFailure(
        `${params.manager} upgrade did not finish within ${params.maxWaitMs} ms — ` +
          `the transaction is STILL RUNNING and was NOT killed. Its staging dir ` +
          `${dir} (log at ${dir}/log, rc at ${dir}/rc) was LEFT IN PLACE so the ` +
          `running transaction is not disturbed; inspect it on the target before ` +
          `retrying.`,
        fail(-1, tail),
      );
    }
    await hooks.sleep(params.pollIntervalMs);
  }

  const summary = (await session.run(collectCommand(dir))).stdout.slice(
    -LOG_TAIL_BYTES,
  );
  if (rc !== 0) {
    throw new UpgradeFailure(
      `${params.manager} upgrade failed (rc=${rc}). Log tail:\n${summary}`,
      fail(rc ?? -1, summary),
    );
  }
  const { packagesUpdated, changed } = parseUpgradeSummary(
    summary,
    params.manager,
  );
  const releaseVersion = await probeReleaseVersion(session);
  const rebootRequired = await probeRebootRequired(session, params.manager);
  // Success: transaction done and its output collected — drop the staging dir.
  await session.run(cleanupCommand(dir));
  return {
    manager: params.manager,
    startedAt,
    finishedAt: new Date(hooks.now()).toISOString(),
    exitCode: rc,
    changed,
    packagesUpdated,
    rebootRequired,
    releaseVersion,
    summary,
  };
}

/** Production hooks: real wall clock + timer sleep. */
const realHooks: UpgradeHooks = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ── system_upgrade (work item B): Fedora release jump, reboot-aware ──────────
//
// Moves the host to `targetRelease` via the offline `dnf system-upgrade`
// transaction (design §4). It reboots the board TWICE and cannot be rolled back
// over serial, so `confirm` is a hard gate: with `confirm=false` (default) the
// method runs preflight + download and STOPS before the reboot, reporting the
// staged transaction. Only `confirm=true` (and not `downloadOnly`) ever issues a
// reboot. dnf/Fedora ONLY — a non-dnf manager is a hard error before any action.

/** dnf flavor on the target — dnf5 (Fedora 41+) vs legacy dnf4/yum. Decides the
 * system-upgrade plugin package name (they differ). */
export type DnfFlavor = "dnf5" | "dnf4";

/** Detect the dnf flavor: dnf5 is present as its own binary on Fedora 41+. */
export function detectFlavorCommand(): string {
  return `command -v dnf5 >/dev/null 2>&1 && echo dnf5 || echo dnf4`;
}

/** Parse {@link detectFlavorCommand} output (default dnf4 when unrecognised). */
export function parseDnfFlavor(out: string): DnfFlavor {
  return /dnf5/.test((out ?? "").trim()) ? "dnf5" : "dnf4";
}

/**
 * Install the offline system-upgrade plugin under the detected flavor. The
 * package name differs: dnf5 ships `dnf5-plugin-system-upgrade`, dnf4 ships
 * `dnf-plugin-system-upgrade`. `-y` is non-interactive; `become` supplies root.
 */
export function ensurePluginCommand(flavor: DnfFlavor, become = ""): string {
  const pkg = flavor === "dnf5"
    ? "dnf5-plugin-system-upgrade"
    : "dnf-plugin-system-upgrade";
  return `${become}dnf install -y ${pkg}`;
}

/**
 * Is `dnf system-upgrade` already usable WITHOUT installing anything? Modern
 * dnf5 (e.g. 5.2.x on Fedora riscv) ships the subcommand built-in — there is no
 * `dnf5-plugin-system-upgrade` package to install, and trying to install it
 * fails the run on an otherwise-capable box. So probe the capability first and
 * only fall back to {@link ensurePluginCommand} when the subcommand is missing
 * (older dnf4 without the plugin). Read-only `--help` returns immediately (no
 * network) so it can't idle the synchronous read out, and it is deliberately NOT
 * `become`-escalated: exit 0 means "available", non-zero means "install needed"
 * — never a sudo-policy denial muddying the signal.
 */
export function systemUpgradeAvailableCommand(): string {
  return `dnf system-upgrade --help >/dev/null 2>&1`;
}

/**
 * Probe that `targetRelease` actually exists in the repos BEFORE committing to a
 * download + reboot — a bad releasever must fail here, never after a reboot into
 * an offline transaction. `makecache --refresh` under the substituted releasever
 * pulls that release's metadata; a nonexistent release 404s on the mirror and the
 * command exits non-zero.
 *
 * Launched DETACHED and RC-polled by {@link runSystemUpgradeDownload} (step 3),
 * NOT read synchronously — this is the fix for a false-negative that blocked valid
 * upgrades. A synchronous `session.run` returns as soon as the console is idle for
 * `idleMs`, but `makecache --refresh` is not continuously chatty: after the per-repo
 * progress bars finish it goes quiet building solvables / writing the cache for
 * longer than `idleMs`, so the synchronous read stops at idle BEFORE the RC sentinel
 * and reports a `null` exit code — misread as "release does not exist". An earlier
 * pass tried to keep the console active by dropping `-q` (non-quiet per-repo
 * progress); that covered the download phase but not the post-download quiet gap, so
 * the idle-out still fired. Running it detached (like the offline download) polls the
 * worker's own rc file until it lands, immune to any console-idle window. Progress
 * output is kept (non-quiet) purely so the staged `log` tail is useful on failure.
 * Regression: caught by the Banana Pi F3 F42→F43 live proof, 2026-07-24 (makecache
 * resolved f43 + f43-spacemit fine but the synchronous probe idled out during the
 * solvable build and reported null → false "release missing").
 */
export function probeReleaseCommand(
  targetRelease: number,
  become = "",
): string {
  return `${become}dnf --releasever=${targetRelease} makecache --refresh`;
}

/**
 * The long, detached offline-download command (reuses the §3.2 detached-run +
 * RC-poll mechanism via {@link launchCommand}/{@link pollCommand}). `-y` answers
 * the transaction confirm and GPG-key imports; `become` supplies root. Static and
 * quote/`$`-free (int releasever) so it satisfies {@link launchCommand}'s
 * nested-quoting contract.
 */
export function systemUpgradeDownloadCommand(
  targetRelease: number,
  become = "",
): string {
  return `${become}dnf system-upgrade download -y --releasever=${targetRelease}`;
}

/**
 * Fire the offline-transaction reboot. `dnf system-upgrade reboot` reboots the
 * board into the staged transaction — it is issued fire-and-forget (§4.3): no RC
 * sentinel is coming because the console dies, so the caller sends this and does
 * NOT wait for a prompt. `become` supplies root.
 *
 * `-y` is REQUIRED, not optional: dnf5 (5.2.x) prints an interactive
 * confirmation — `The system will now reboot to upgrade to release version N.
 * Is this ok [y/N]:` — and defaults to N. Since the reboot is fired
 * fire-and-forget over a raw port (nobody answers the prompt), without `-y` the
 * board silently stays up and the reboot barrier waits out its full timeout for a
 * `login:` that never comes. Global `-y` (before the subcommand) unambiguously
 * assumes-yes for that confirmation. Caught live on the Banana Pi F3 F42→F43 jump
 * (2026-07-24): a bare `reboot` left the board sitting at its shell for 40 min.
 */
export function rebootCommand(become = ""): string {
  return `${become}dnf -y system-upgrade reboot`;
}

/**
 * The single irreversibility gate (§4.1/§4.4): the board is rebooted ONLY when
 * the operator explicitly passes `confirm=true` AND did not ask for
 * `downloadOnly`. Every other combination stages the transaction and stops. Pure
 * so this critical decision is exhaustively unit-tested — no code path may reach
 * the reboot without `shouldReboot` returning true.
 */
export function shouldReboot(confirm: boolean, downloadOnly: boolean): boolean {
  return confirm === true && downloadOnly === false;
}

/** The read-only running-release probe command (VERSION_ID from os-release). */
export function osReleaseVersionCommand(): string {
  return `. /etc/os-release 2>/dev/null; printf '%s' "$VERSION_ID"`;
}

/**
 * Parse a Fedora release integer from an os-release probe. Prefers an explicit
 * `VERSION_ID=43` / `VERSION_ID="43"` assignment (so a fuller os-release dump
 * can't have its integer stolen by an unrelated line like `PLATFORM_ID` or a
 * hostname); otherwise accepts a line that is EXACTLY the bare integer the
 * {@link osReleaseVersionCommand} prints ("43"). Null when neither is present
 * (a non-numeric VERSION_ID such as rawhide, or unreadable/garbled input).
 */
export function parseOsReleaseVersionId(text: string): number | null {
  const t = (text ?? "").trim();
  const tagged = t.match(/VERSION_ID=["']?(\d+)/);
  if (tagged) return Number(tagged[1]);
  const bare = t.match(/^"?(\d+)"?$/);
  return bare ? Number(bare[1]) : null;
}

/** The returning getty banner ends in `login:` — the barrier's stop condition. */
const LOGIN_PROMPT_RE = /login:\s*$/i;

/** Bytes of returning-console transcript retained for observability. */
const BARRIER_TAIL_BYTES = 2048;

/**
 * Pure detector for the returning getty `login:` prompt in a raw console chunk.
 * Strips terminal-escape/CR noise (incl. F43 agetty's cursor-query + OSC burst)
 * and matches the banner at the tail so mid-scroll "login:" substrings (e.g.
 * inside a log line) don't false-trigger. Named in the spec's testSeam as the
 * barrier's unit-testable core.
 */
export function detectLoginPrompt(chunk: string): boolean {
  const t = stripEscapes(chunk ?? "").replace(/\r/g, "");
  return LOGIN_PROMPT_RE.test(t.slice(-256));
}

/** Resolved inputs for one {@link runSystemUpgradeDownload}. */
export interface SystemUpgradeParams {
  manager: Manager;
  targetRelease: number;
  downloadOnly: boolean;
  confirm: boolean;
  pollIntervalMs: number;
  downloadMaxWaitMs: number;
  rebootMaxWaitMs: number;
  /** Privilege-escalation prefix (`sudo -n `/`doas `/`""`) from {@link becomeOf}. */
  becomePrefix: string;
}

/** What a run records into the `systemUpgrade` resource (minus `device`). */
export interface SystemUpgradeOutcome {
  manager: Manager;
  fromRelease: string | null;
  targetRelease: number;
  staged: boolean;
  rebooted: boolean;
  verified: boolean;
  finalRelease: string | null;
  downloadExitCode: number;
  startedAt: string;
  finishedAt: string;
  summary: string;
}

/**
 * Thrown when any system_upgrade phase fails. Carries a partial
 * {@link SystemUpgradeOutcome} so the caller can persist a durable, queryable
 * `systemUpgrade` resource before the error propagates — a failed preflight,
 * download, or reboot barrier leaves a record, not a hole.
 */
export class SystemUpgradeFailure extends Error {
  readonly outcome: SystemUpgradeOutcome;
  constructor(message: string, outcome: SystemUpgradeOutcome) {
    super(message);
    this.name = "SystemUpgradeFailure";
    this.outcome = outcome;
  }
}

/**
 * Preflight + offline download over one {@link Session} (design §4.2 steps 1–2).
 * Isolated from transport and clock so it is fully unit-testable against a
 * scripted fake session. In strict order, so a failure can NEVER leave the board
 * mid-way to a reboot:
 *   1. Guard: manager is dnf/yum — a non-dnf manager is a hard error, no action.
 *   2. Running release strictly below `targetRelease` (no downgrade / no-op jump).
 *   3. Probe that `targetRelease` exists in the repos — BEFORE any download or
 *      reboot (a bad releasever fails here, not after a reboot).
 *   4. Ensure the flavor-correct system-upgrade plugin.
 *   5. Download the offline transaction detached (§3.2) and poll to completion
 *      under `downloadMaxWaitMs`; a non-zero rc / launch failure / timeout throws
 *      (the timeout leaves the transaction running, staging dir in place).
 * Returns the staged outcome (`staged=true`, `rebooted=false`) — the reboot is
 * the caller's separate, `confirm`-gated phase. The vaulted login password is
 * owned by {@link withSession}; it never reaches this function or the summary.
 */
export async function runSystemUpgradeDownload(
  session: Session,
  params: SystemUpgradeParams,
  hooks: UpgradeHooks,
): Promise<SystemUpgradeOutcome> {
  const startedAt = new Date(hooks.now()).toISOString();
  const base = (
    over: Partial<SystemUpgradeOutcome> = {},
  ): SystemUpgradeOutcome => ({
    manager: params.manager,
    fromRelease: null,
    targetRelease: params.targetRelease,
    staged: false,
    rebooted: false,
    verified: false,
    finalRelease: null,
    downloadExitCode: -1,
    startedAt,
    finishedAt: new Date(hooks.now()).toISOString(),
    summary: "",
    ...over,
  });

  // 1. dnf/Fedora only — hard error before ANY mutating action.
  if (params.manager !== "dnf" && params.manager !== "yum") {
    throw new SystemUpgradeFailure(
      `system_upgrade is a Fedora/dnf-only operation; detected manager ` +
        `"${params.manager}". Use the within-release \`upgrade\` method, or a ` +
        `manager-appropriate release-upgrade path.`,
      base(),
    );
  }

  // 2. Running release must be READABLE and strictly below the target. An
  // unparseable running release is a HARD failure, not a bypass: we cannot
  // confirm the jump is forward-only (design §7 — no downgrade/rollback), so we
  // refuse rather than risk committing a live board to a same-or-lower release.
  const fromReleaseStr =
    (await session.run(osReleaseVersionCommand())).stdout.trim() || null;
  const fromRelease = parseOsReleaseVersionId(fromReleaseStr ?? "");
  if (fromRelease === null) {
    throw new SystemUpgradeFailure(
      `could not read the running Fedora release from /etc/os-release ` +
        `(VERSION_ID probe returned ${
          JSON.stringify(fromReleaseStr)
        }). Refusing ` +
        `to system_upgrade toward ${params.targetRelease} without confirming the ` +
        `jump is forward-only — inspect the console/os-release on the target.`,
      base({ fromRelease: fromReleaseStr }),
    );
  }
  if (fromRelease >= params.targetRelease) {
    throw new SystemUpgradeFailure(
      `target release ${params.targetRelease} is not newer than the running ` +
        `release ${fromRelease} — system_upgrade only moves forward.`,
      base({ fromRelease: fromReleaseStr }),
    );
  }

  // 3. Probe the target release exists in the repos BEFORE download/reboot.
  //    Run the metadata refresh DETACHED and RC-polled — NEVER a single
  //    synchronous read. `makecache --refresh` goes quiet building solvables past
  //    the session's `idleMs`, so a synchronous probe stops at idle before the RC
  //    sentinel and reports a null exit code, misread as "release does not exist"
  //    (a false negative that blocks a valid upgrade). See
  //    {@link probeReleaseCommand}. Bounded by `downloadMaxWaitMs` (the same
  //    metadata/download ceiling); the poll exits the instant the rc lands, so a
  //    healthy probe is never slowed by the generous bound.
  const probeDir = (await session.run(makeStagingDirCommand())).stdout.trim();
  if (!/^\/tmp\/\.swamp-dnf\.[A-Za-z0-9]+$/.test(probeDir)) {
    throw new SystemUpgradeFailure(
      `could not create a staging dir on the target for the release probe ` +
        `(mktemp returned ${JSON.stringify(probeDir)}).`,
      base({ fromRelease: fromReleaseStr }),
    );
  }
  await session.run(
    launchCommand(
      probeReleaseCommand(params.targetRelease, params.becomePrefix),
      probeDir,
    ),
  );
  const probeDeadline = hooks.now() + params.downloadMaxWaitMs;
  let probeRc: number | null = null;
  while (true) {
    const parsed = await pollWithConfirm(session, probeDir, hooks);
    if (parsed.done) {
      probeRc = parsed.rc;
      break;
    }
    if (parsed.launchFailed || parsed.died) {
      const tail = (await session.run(collectCommand(probeDir))).stdout.slice(
        -LOG_TAIL_BYTES,
      );
      throw new SystemUpgradeFailure(
        `release probe for ${params.targetRelease} ${
          parsed.launchFailed ? "failed to launch" : "process died"
        } (see ${probeDir}/log on the target). Log tail:\n${tail}`,
        base({ fromRelease: fromReleaseStr, summary: tail }),
      );
    }
    if (hooks.now() >= probeDeadline) {
      const tail = (await session.run(collectCommand(probeDir))).stdout.slice(
        -LOG_TAIL_BYTES,
      );
      throw new SystemUpgradeFailure(
        `release probe for ${params.targetRelease} did not finish within ` +
          `${params.downloadMaxWaitMs} ms — the metadata refresh is STILL ` +
          `RUNNING and was NOT killed; staging dir ${probeDir} was left in ` +
          `place. Inspect the target before retrying.`,
        base({ fromRelease: fromReleaseStr, summary: tail }),
      );
    }
    await hooks.sleep(params.pollIntervalMs);
  }
  const probeTail = (await session.run(collectCommand(probeDir))).stdout.slice(
    -LOG_TAIL_BYTES,
  );
  // Drop the probe's staging dir on both outcomes — unlike the download, the
  // metadata refresh registers nothing durable, so its dir is always disposable.
  await session.run(cleanupCommand(probeDir));
  if (probeRc !== 0) {
    throw new SystemUpgradeFailure(
      `target release ${params.targetRelease} could not be resolved in the ` +
        `repos (releasever metadata probe exited ${probeRc}). ` +
        `Refusing to download/reboot toward a release that may not exist. ` +
        `Probe tail:\n${probeTail}`,
      base({ fromRelease: fromReleaseStr }),
    );
  }

  // 4. Ensure `dnf system-upgrade` is usable. Modern dnf5 ships it built-in (no
  //    package — installing a nonexistent `dnf5-plugin-system-upgrade` would
  //    fail a perfectly capable box), while older dnf4 needs the flavor-correct
  //    plugin. Probe the capability first and install ONLY when it's missing.
  const available = await session.run(systemUpgradeAvailableCommand());
  if (available.exitCode !== 0) {
    const flavor = parseDnfFlavor(
      (await session.run(detectFlavorCommand())).stdout,
    );
    const plugin = await session.run(
      ensurePluginCommand(flavor, params.becomePrefix),
    );
    if (plugin.exitCode !== 0) {
      throw new SystemUpgradeFailure(
        `could not install the ${flavor} system-upgrade plugin ` +
          `(rc=${plugin.exitCode}). Tail:\n${
            plugin.stdout.slice(-LOG_TAIL_BYTES)
          }`,
        base({ fromRelease: fromReleaseStr }),
      );
    }
  }

  // 5. Download the offline transaction detached, then poll — never one giant read.
  const dir = (await session.run(makeStagingDirCommand())).stdout.trim();
  if (!/^\/tmp\/\.swamp-dnf\.[A-Za-z0-9]+$/.test(dir)) {
    throw new SystemUpgradeFailure(
      `could not create a staging dir on the target ` +
        `(mktemp returned ${JSON.stringify(dir)}).`,
      base({ fromRelease: fromReleaseStr }),
    );
  }
  await session.run(
    launchCommand(
      systemUpgradeDownloadCommand(params.targetRelease, params.becomePrefix),
      dir,
    ),
  );

  const deadline = hooks.now() + params.downloadMaxWaitMs;
  let rc: number | null = null;
  while (true) {
    const parsed = await pollWithConfirm(session, dir, hooks);
    if (parsed.done) {
      rc = parsed.rc;
      break;
    }
    if (parsed.launchFailed || parsed.died) {
      const tail = (await session.run(collectCommand(dir))).stdout.slice(
        -LOG_TAIL_BYTES,
      );
      throw new SystemUpgradeFailure(
        `system-upgrade download ${
          parsed.launchFailed ? "failed to launch" : "process died"
        } (see ${dir}/log on the target). Log tail:\n${tail}`,
        base({ fromRelease: fromReleaseStr, summary: tail }),
      );
    }
    if (hooks.now() >= deadline) {
      const tail = (await session.run(collectCommand(dir))).stdout.slice(
        -LOG_TAIL_BYTES,
      );
      throw new SystemUpgradeFailure(
        `system-upgrade download did not finish within ` +
          `${params.downloadMaxWaitMs} ms — the transaction is STILL RUNNING and ` +
          `was NOT killed; its staging dir ${dir} was left in place. Inspect the ` +
          `target before retrying.`,
        base({ fromRelease: fromReleaseStr, summary: tail }),
      );
    }
    await hooks.sleep(params.pollIntervalMs);
  }

  const summary = (await session.run(collectCommand(dir))).stdout.slice(
    -LOG_TAIL_BYTES,
  );
  if (rc !== 0) {
    throw new SystemUpgradeFailure(
      `system-upgrade download failed (rc=${rc}). Log tail:\n${summary}`,
      base({
        fromRelease: fromReleaseStr,
        downloadExitCode: rc ?? -1,
        summary,
      }),
    );
  }
  // Success: the offline transaction is staged. Drop the download staging dir —
  // the transaction itself is registered with dnf, independent of this dir.
  await session.run(cleanupCommand(dir));
  return base({
    fromRelease: fromReleaseStr,
    staged: true,
    downloadExitCode: rc,
    summary,
  });
}

/**
 * Fire-and-forget the offline-transaction reboot on an already-logged-in raw
 * port (§4.3 step 1). Sends `dnf system-upgrade reboot` and does a short,
 * best-effort drain so the command is accepted and the transaction begins — it
 * deliberately does NOT wait for a shell prompt or RC sentinel, because none is
 * coming: the console dies as the board reboots. Injectable `clock` for tests.
 */
export async function issueReboot(
  port: SerialPort,
  rebootCmd: string,
  opts: { lineEnding: string; settleIdleMs: number; settleMaxMs: number },
  clock?: Clock,
): Promise<void> {
  await sendLine(port, rebootCmd, {
    lineEnding: opts.lineEnding,
    appendNewline: true,
  });
  // Best-effort: let the command register / the transaction start. No stopRegex —
  // we are NOT waiting for a prompt (the PTY is about to die).
  await drainUntil(
    port,
    { idleMs: opts.settleIdleMs, maxMs: opts.settleMaxMs },
    clock,
  );
}

/**
 * The reboot barrier (§4.3 step 2): wait through the dark for the returning getty
 * `login:` prompt. Polls the RAW console open/close-per-read via `openPort` (NOT
 * the RC-sentinel session loop — there is no continuous session across a reboot),
 * bounded by `rebootMaxWaitMs`. A long console silence during the offline
 * transaction is EXPECTED, not failure — each poll drains a bounded chunk and the
 * loop only gives up when the deadline passes with no `login:` seen. `openPort` is
 * the injectable seam (a fresh port per read); `hooks` drives the clock. Returns
 * whether the login prompt returned plus a bounded transcript tail; it never
 * power-cycles or assumes the board bricked (out-of-band recovery is operator-owned).
 */
export async function awaitLoginReturn(
  openPort: () => Promise<SerialPort>,
  opts: {
    lineEnding: string;
    rebootMaxWaitMs: number;
    pollIntervalMs: number;
    readIdleMs: number;
    readMaxMs: number;
  },
  hooks: UpgradeHooks,
): Promise<{ returned: boolean; transcript: string }> {
  const clock: Clock = { now: hooks.now, sleep: hooks.sleep };
  const deadline = hooks.now() + opts.rebootMaxWaitMs;
  let transcript = "";
  // The FIRST poll is a FLUSH, not a detection: it drains and DISCARDS whatever
  // is currently buffered — a getty banner or shell prompt left over from BEFORE
  // the reboot (e.g. a stale holder PTY tail) that would otherwise false-match as
  // "the board is back" seconds after the reboot was issued. Only from the second
  // poll on do we detect `login:`, and we re-nudge each poll so a getty sitting at
  // the prompt re-prints its banner — so even if the whole reboot→login
  // transition lands inside that first flush window, the next poll's nudge
  // re-elicits the real `login:` (no dependence on catching a separate dark poll).
  let flushed = false;
  while (true) {
    const port = await openPort();
    try {
      // Nudge to elicit a getty banner, then read a bounded chunk.
      await sendLine(port, "", {
        lineEnding: opts.lineEnding,
        appendNewline: true,
      });
      if (!flushed) {
        // Flush: drain to idle (no stop condition) and discard the pre-reboot
        // residue without ever treating it as the returning prompt.
        await drainUntil(
          port,
          { idleMs: opts.readIdleMs, maxMs: opts.readMaxMs },
          clock,
        );
        flushed = true;
      } else {
        const { output } = await drainUntil(
          port,
          {
            idleMs: opts.readIdleMs,
            maxMs: opts.readMaxMs,
            stopRegex: LOGIN_PROMPT_RE,
          },
          clock,
        );
        transcript = (transcript + output).slice(-BARRIER_TAIL_BYTES);
        if (detectLoginPrompt(output)) return { returned: true, transcript };
      }
    } finally {
      port.close();
    }
    if (hooks.now() >= deadline) return { returned: false, transcript };
    await hooks.sleep(opts.pollIntervalMs);
  }
}

/**
 * Open a raw console port with NO login and NO RC-sentinel session — the reboot
 * phase needs the bare byte path. The reboot barrier requires EXCLUSIVE console
 * access for its whole (multi-minute) duration: Phase 2 has already refused to
 * proceed if a session holder was live, so this ALWAYS opens the REAL device,
 * never a holder's PTY. That is deliberate — re-deriving `sessionLinkLive` per
 * poll (as {@link withSession} does) would silently start attaching to any holder
 * that appeared MID-barrier, resplitting the returning-banner byte stream (SU-3).
 * Opening the real device instead means a rogue holder that grabs the device
 * mid-barrier surfaces as a loud EBUSY open failure, not silent contention.
 * Caller owns closing the port.
 */
async function openRawConsole(
  g: ConnectionArgs,
  logger: Ctx["logger"],
): Promise<SerialPort> {
  const ioCfg = {
    device: g.device, // real device only — see the exclusivity note above.
    baud: g.baud,
    framing: g.framing,
    lineEnding: g.lineEnding,
  };
  const transport = selectTransport(g.transport, logger);
  await transport.configure(ioCfg);
  return await transport.open(ioCfg.device);
}

/**
 * Open a raw console port, authenticate a getty when credentials are configured
 * (otherwise assume an already-open shell), run `fn` against the bare port, and
 * always close it. Used to issue the fire-and-forget reboot from a privileged,
 * logged-in shell without the RC-sentinel {@link Session} wrapper (which would
 * hang waiting for a sentinel the dying console will never emit). The vaulted
 * password is passed only to {@link loginOn}; it is never logged or returned.
 */
async function withLoggedInRawPort<T>(
  g: ConnectionArgs,
  logger: Ctx["logger"],
  fn: (port: SerialPort) => Promise<T>,
): Promise<T> {
  assertAllowedDevice(g.device);
  const port = await openRawConsole(g, logger);
  try {
    const stopRe = new RegExp(g.prompt);
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
          `Serial login as "${g.username}" on ${g.device} failed before ` +
            `issuing the system-upgrade reboot (no shell prompt after credentials).`,
        );
      }
    } else if (g.username || g.password) {
      throw new Error(
        "Serial login needs both `username` and `password` " +
          "(set `password` to a vault reference).",
      );
    } else {
      // No creds: assume an already-privileged open shell; nudge to a prompt.
      await sendLine(port, "", {
        lineEnding: g.lineEnding,
        appendNewline: true,
      });
      await drainUntil(port, { idleMs: 500, maxMs: 3000, stopRegex: stopRe });
    }
    return await fn(port);
  } finally {
    port.close();
  }
}

const UpgradeSchema = z.object({
  device: z.string(),
  manager: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  exitCode: z.number(),
  changed: z.boolean(),
  packagesUpdated: z.number(),
  rebootRequired: z.boolean(),
  releaseVersion: z.string().nullable(),
  summary: z.string(),
});

const SystemUpgradeSchema = z.object({
  device: z.string(),
  manager: z.string(),
  fromRelease: z.string().nullable(),
  targetRelease: z.number(),
  staged: z.boolean(),
  rebooted: z.boolean(),
  verified: z.boolean(),
  finalRelease: z.string().nullable(),
  downloadExitCode: z.number(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: z.string(),
});

export const model = {
  type: "@shrug/serial-cfgmgmt/package",
  version: "2026.07.28.1",
  upgrades: [
    {
      toVersion: "2026.07.28.1",
      description:
        "Version-align with serial-port 2026.07.28.1 release; no schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: z.object({
    ...ConnectionGlobals,
    become: z.boolean().default(false).describe(
      "Escalate privilege for every mutating command (install, upgrade) and the reboot probe (the login user is unprivileged, e.g. a `fedora` serial console with sudo). Leave false when the session is already root.",
    ),
    becomeMethod: z.enum(["sudo", "doas"]).default("sudo").describe(
      "Privilege-escalation command used when `become` is true. `sudo` runs as `sudo -n` (non-interactive).",
    ),
  }),
  resources: {
    package: {
      description: "State of a package on the target.",
      schema: PackageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    upgrade: {
      description: "Outcome of a whole-system upgrade on the target.",
      schema: UpgradeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    systemUpgrade: {
      description:
        "Outcome of a Fedora release jump (offline dnf system-upgrade) on the target.",
      schema: SystemUpgradeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  // install, upgrade, and system_upgrade are mutating (assume a privileged
  // shell); fail before opening the port if the device is not an allowed tty
  // path. query is read-only, unscoped.
  checks: deviceAllowlistCheck(["install", "upgrade", "system_upgrade"]),

  methods: {
    query: {
      description:
        "Check whether a package is installed on the target (read-only) and record its version.",
      arguments: z.object({
        name: z.string().min(1).describe("Package name."),
      }),
      execute: async (args: { name: string }, context: Ctx) => {
        const g = context.globalArgs;
        const state = await withSession(g, context.logger, async (session) => {
          const manager = await detectManager((c) => session.run(c));
          const q = await queryPackage(session, manager, args.name);
          return { manager, ...q };
        });
        context.logger.info(
          "package query {name} on {device}: installed={installed} version={version}",
          {
            name: args.name,
            device: g.device,
            installed: state.installed,
            version: state.version ?? "-",
          },
        );
        const handle = await context.writeResource(
          "package",
          args.name.replace(/\W+/g, "_"),
          {
            name: args.name,
            manager: state.manager,
            installed: state.installed,
            version: state.version,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    install: {
      description:
        "Install a package on the target (MUTATING; needs root — set `become` when the login user is unprivileged). Idempotent: no-op when already installed.",
      arguments: z.object({
        name: z.string().min(1).describe("Package name."),
      }),
      execute: async (args: { name: string }, context: Ctx) => {
        const g = context.globalArgs;
        const state = await withSession(g, context.logger, async (session) => {
          const manager = await detectManager((c) => session.run(c));
          const before = await queryPackage(session, manager, args.name);
          if (!before.installed) {
            const res = await session.run(
              installCommand(manager, args.name, becomeOf(g)),
            );
            if (res.exitCode !== 0) {
              throw new Error(
                `Install of "${args.name}" via ${manager} failed (rc=${res.exitCode}): ${
                  res.stdout.slice(-400)
                }`,
              );
            }
          }
          const after = await queryPackage(session, manager, args.name);
          return { manager, ...after };
        });
        context.logger.info(
          "package install {name} on {device}: installed={installed} version={version}",
          {
            name: args.name,
            device: g.device,
            installed: state.installed,
            version: state.version ?? "-",
          },
        );
        const handle = await context.writeResource(
          "package",
          args.name.replace(/\W+/g, "_"),
          {
            name: args.name,
            manager: state.manager,
            installed: state.installed,
            version: state.version,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    upgrade: {
      description:
        "Bring all installed packages current within the running release (MUTATING; needs root — set `become` when the login user is unprivileged). Runs the transaction detached and polls to completion — never reboots. Idempotent: nothing-to-do => changed=false.",
      arguments: z.object({
        refreshMetadata: z.boolean().default(true).describe(
          "Refresh repo metadata first (dnf/yum `--refresh`).",
        ),
        securityOnly: z.boolean().default(false).describe(
          "Apply only security errata (dnf/yum `--security`).",
        ),
        dryRun: z.boolean().default(false).describe(
          "Solve and list the plan inline without installing anything.",
        ),
        pollIntervalMs: z.number().int().positive().default(10_000).describe(
          "Delay between completion polls.",
        ),
        maxWaitMs: z.number().int().positive().default(3_600_000).describe(
          "Overall bound; exceeding it fails loudly WITHOUT killing the running transaction.",
        ),
      }),
      execute: async (
        args: {
          refreshMetadata: boolean;
          securityOnly: boolean;
          dryRun: boolean;
          pollIntervalMs: number;
          maxWaitMs: number;
        },
        context: Ctx,
      ) => {
        const g = context.globalArgs;
        let outcome: UpgradeOutcome;
        try {
          outcome = await withSession(g, context.logger, async (session) => {
            const manager = await detectManager((c) => session.run(c));
            return await runUpgrade(
              session,
              { manager, ...args, becomePrefix: becomeOf(g) },
              realHooks,
            );
          });
        } catch (err) {
          // A failed / timed-out run still records a durable, queryable `upgrade`
          // resource (failure fields) before the error propagates to the caller.
          if (err instanceof UpgradeFailure) {
            context.logger.info(
              "package upgrade on {device} FAILED: manager={manager} exit={exit} — {message}",
              {
                device: g.device,
                manager: err.outcome.manager,
                exit: err.outcome.exitCode,
                message: err.message,
              },
            );
            await context.writeResource(
              "upgrade",
              g.device.replace(/\W+/g, "_"),
              {
                device: g.device,
                manager: err.outcome.manager,
                startedAt: err.outcome.startedAt,
                finishedAt: err.outcome.finishedAt,
                exitCode: err.outcome.exitCode,
                changed: err.outcome.changed,
                packagesUpdated: err.outcome.packagesUpdated,
                rebootRequired: err.outcome.rebootRequired,
                releaseVersion: err.outcome.releaseVersion,
                summary: err.outcome.summary,
              },
            );
          }
          throw err;
        }
        context.logger.info(
          "package upgrade on {device}: manager={manager} exit={exit} changed={changed} updated={updated} reboot={reboot}",
          {
            device: g.device,
            manager: outcome.manager,
            exit: outcome.exitCode,
            changed: outcome.changed,
            updated: outcome.packagesUpdated,
            reboot: outcome.rebootRequired,
          },
        );
        const handle = await context.writeResource(
          "upgrade",
          g.device.replace(/\W+/g, "_"),
          {
            device: g.device,
            manager: outcome.manager,
            startedAt: outcome.startedAt,
            finishedAt: outcome.finishedAt,
            exitCode: outcome.exitCode,
            changed: outcome.changed,
            packagesUpdated: outcome.packagesUpdated,
            rebootRequired: outcome.rebootRequired,
            releaseVersion: outcome.releaseVersion,
            summary: outcome.summary,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    system_upgrade: {
      description:
        "Move the host to a newer Fedora release via the offline dnf system-upgrade transaction (MUTATING + IRREVERSIBLE; needs root — set `become` when the login user is unprivileged). dnf/Fedora ONLY. SAFE by default: confirm=false downloads and stages the transaction but NEVER reboots. Only confirm=true (and not downloadOnly) rides the reboots and verifies the new release.",
      arguments: z.object({
        targetRelease: z.number().int().positive().describe(
          "Target Fedora release, e.g. 43. Required; must be newer than the running release.",
        ),
        downloadOnly: z.boolean().default(false).describe(
          "Download and stage the offline transaction only; never reboot (same effect as leaving confirm false).",
        ),
        confirm: z.boolean().default(false).describe(
          "HARD GATE for the irreversible reboot. false (default) => download + stage, then STOP before rebooting. Must be true (and downloadOnly false) to actually reboot into the new release.",
        ),
        pollIntervalMs: z.number().int().positive().default(15_000).describe(
          "Delay between download-completion polls and reboot-barrier reads.",
        ),
        downloadMaxWaitMs: z.number().int().positive().default(5_400_000)
          .describe(
            "Overall bound on the offline download (90 min); exceeding it fails loudly WITHOUT killing the running transaction.",
          ),
        rebootMaxWaitMs: z.number().int().positive().default(7_200_000)
          .describe(
            "Bound on the reboot barrier (2 h): how long to wait through the dark for the returning login prompt before failing loudly. The offline apply is the long pole — a full release jump takes 40-80 min on slow riscv (SpacemiT K1), and the barrier must span reboot → offline apply → reboot → getty. Too short reports a FALSE failure on a healthy upgrade (the transaction still completes; the method never assumes bricked). Raise further for larger jumps or slower boards.",
          ),
      }),
      execute: async (
        args: {
          targetRelease: number;
          downloadOnly: boolean;
          confirm: boolean;
          pollIntervalMs: number;
          downloadMaxWaitMs: number;
          rebootMaxWaitMs: number;
        },
        context: Ctx,
      ) => {
        const g = context.globalArgs;
        const bp = becomeOf(g);
        const write = (o: SystemUpgradeOutcome) =>
          context.writeResource(
            "systemUpgrade",
            g.device.replace(/\W+/g, "_"),
            {
              device: g.device,
              manager: o.manager,
              fromRelease: o.fromRelease,
              targetRelease: o.targetRelease,
              staged: o.staged,
              rebooted: o.rebooted,
              verified: o.verified,
              finalRelease: o.finalRelease,
              downloadExitCode: o.downloadExitCode,
              startedAt: o.startedAt,
              finishedAt: o.finishedAt,
              summary: o.summary,
            },
          );

        // Phase 1 — preflight + offline download (never reboots). A failure here
        // records a durable resource then rethrows, so the board is never left
        // mid-way to a reboot.
        let staged: SystemUpgradeOutcome;
        try {
          staged = await withSession(g, context.logger, async (session) => {
            const manager = await detectManager((c) => session.run(c));
            return await runSystemUpgradeDownload(
              session,
              {
                manager,
                targetRelease: args.targetRelease,
                downloadOnly: args.downloadOnly,
                confirm: args.confirm,
                pollIntervalMs: args.pollIntervalMs,
                downloadMaxWaitMs: args.downloadMaxWaitMs,
                rebootMaxWaitMs: args.rebootMaxWaitMs,
                becomePrefix: bp,
              },
              realHooks,
            );
          });
        } catch (err) {
          // Record a durable resource for ANY preflight/download failure — a
          // SystemUpgradeFailure carries a partial outcome; any other error
          // (e.g. withSession's own login/transport failure) still gets a
          // minimal record so the run never leaves a hole. Either way the board
          // is never mid-way to a reboot (Phase 2 hasn't run).
          const msg = err instanceof Error ? err.message : String(err);
          context.logger.info(
            "system_upgrade on {device} FAILED (download/preflight): {message}",
            { device: g.device, message: msg },
          );
          const outcome: SystemUpgradeOutcome =
            err instanceof SystemUpgradeFailure ? err.outcome : {
              manager: "dnf",
              fromRelease: null,
              targetRelease: args.targetRelease,
              staged: false,
              rebooted: false,
              verified: false,
              finalRelease: null,
              downloadExitCode: -1,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              summary: `preflight/download errored before staging: ${msg}`,
            };
          await write(outcome);
          throw err;
        }

        // SAFE default: with confirm=false OR downloadOnly, stop after staging —
        // the irreversible reboot is never issued (single gate: shouldReboot).
        if (!shouldReboot(args.confirm, args.downloadOnly)) {
          context.logger.info(
            "system_upgrade on {device}: STAGED only (confirm={confirm} downloadOnly={downloadOnly}) — no reboot. from={from} target={target}",
            {
              device: g.device,
              confirm: args.confirm,
              downloadOnly: args.downloadOnly,
              from: staged.fromRelease ?? "-",
              target: args.targetRelease,
            },
          );
          const handle = await write(staged);
          return { dataHandles: [handle] };
        }

        // Phase 2 — issue the reboot fire-and-forget, then ride the barrier.
        // The reboot barrier needs EXCLUSIVE console access: a live socat session
        // holder (or its capture drainer) reading the same PTY would race us for
        // the returning getty banner and could make the barrier miss it (false
        // "did not return") or read stale buffered state. Rather than kill another
        // agent's holder (dangerous on a shared device), refuse and make the
        // operator stop it first — this realises design §4.3's "drop the session
        // holder" as an explicit precondition, before anything irreversible.
        if (await sessionLinkLive(g.device)) {
          throw new SystemUpgradeFailure(
            `a live serial-port session holder owns ${g.device}. The reboot ` +
              `barrier needs exclusive console access — stop the holder ` +
              `(\`session_stop\`) and free the port before a confirm=true ` +
              `system_upgrade. No reboot was issued.`,
            {
              ...staged,
              rebooted: false,
              summary:
                `refused: live session holder on ${g.device} — free the port first`,
              finishedAt: new Date().toISOString(),
            },
          );
        }

        context.logger.info(
          "system_upgrade on {device}: staged OK — issuing reboot into F{target} (IRREVERSIBLE)",
          { device: g.device, target: args.targetRelease },
        );
        // Tracks whether the actual `dnf system-upgrade reboot` was sent, so a
        // failure BEFORE the send (e.g. the pre-reboot login) records rebooted=false
        // truthfully rather than claiming a reboot that never happened (SU-4).
        let rebootIssued = false;
        try {
          // Reboot must be issued from a privileged, logged-in shell. Open a raw
          // port, log in (or nudge), fire-and-forget the reboot, then drop the port.
          await withLoggedInRawPort(
            g,
            context.logger,
            (port) =>
              issueReboot(port, rebootCommand(bp), {
                lineEnding: g.lineEnding,
                settleIdleMs: 2000,
                settleMaxMs: 10_000,
              }),
          );
          rebootIssued = true;

          // Reboot barrier: poll the raw console open/close-per-read for the
          // returning getty login: prompt, bounded by rebootMaxWaitMs.
          const barrier = await awaitLoginReturn(
            () => openRawConsole(g, context.logger),
            {
              lineEnding: g.lineEnding,
              rebootMaxWaitMs: args.rebootMaxWaitMs,
              pollIntervalMs: args.pollIntervalMs,
              readIdleMs: Math.min(g.idleMs * 4, 8000),
              readMaxMs: Math.min(args.pollIntervalMs, 30_000),
            },
            realHooks,
          );
          if (!barrier.returned) {
            const o: SystemUpgradeOutcome = {
              ...staged,
              rebooted: true,
              verified: false,
              finalRelease: null,
              finishedAt: new Date().toISOString(),
              summary:
                `board did not return to a login prompt within ${args.rebootMaxWaitMs} ms — ` +
                `inspect the console (never assumed bricked, never auto-power-cycled). ` +
                `Barrier transcript tail:\n${barrier.transcript}`,
            };
            await write(o);
            throw new SystemUpgradeFailure(o.summary, o);
          }

          // Phase 3 — re-login and verify the new release from os-release.
          const finalReleaseStr = await withSession(
            g,
            context.logger,
            async (session) =>
              (await session.run(osReleaseVersionCommand())).stdout.trim() ||
              null,
          );
          const finalRelease = parseOsReleaseVersionId(finalReleaseStr ?? "");
          const verified = finalRelease === args.targetRelease;
          const o: SystemUpgradeOutcome = {
            ...staged,
            rebooted: true,
            verified,
            finalRelease: finalReleaseStr,
            finishedAt: new Date().toISOString(),
          };
          context.logger.info(
            "system_upgrade on {device}: rebooted; from={from} target={target} final={final} verified={verified}",
            {
              device: g.device,
              from: staged.fromRelease ?? "-",
              target: args.targetRelease,
              final: finalReleaseStr ?? "-",
              verified,
            },
          );
          const handle = await write(o);
          if (!verified) {
            throw new SystemUpgradeFailure(
              `board returned but /etc/os-release VERSION_ID is ` +
                `${finalReleaseStr ?? "unreadable"}, not the target ` +
                `${args.targetRelease} — the release jump did not take. Inspect the ` +
                `console/dnf history on the target.`,
              o,
            );
          }
          return { dataHandles: [handle] };
        } catch (err) {
          if (err instanceof SystemUpgradeFailure) throw err;
          // Reboot/verify transport error: record what we know before rethrowing
          // so the run leaves a durable record. `rebooted` reflects whether the
          // reboot was ACTUALLY sent — a failure in the pre-reboot login records
          // rebooted=false (the board is still on the old release, transaction
          // merely staged), not a phantom reboot.
          const o: SystemUpgradeOutcome = {
            ...staged,
            rebooted: rebootIssued,
            verified: false,
            finalRelease: null,
            finishedAt: new Date().toISOString(),
            summary:
              `reboot/verify phase errored (rebootIssued=${rebootIssued}): ${
                err instanceof Error ? err.message : String(err)
              }`,
          };
          context.logger.info(
            "system_upgrade on {device} FAILED (reboot/verify): {message}",
            { device: g.device, message: o.summary },
          );
          await write(o);
          throw err;
        }
      },
    },
  },
  reports: [],
};

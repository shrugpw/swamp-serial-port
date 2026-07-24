/**
 * Unit tests for `@shrug/serial-cfgmgmt/package` method `upgrade` — the
 * within-release whole-system update. Covers the pure command/parse helpers and
 * the detached-launch → poll → collect orchestration against a scripted fake
 * session (regex-keyed, optionally sequenced). NO device required.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_package_upgrade_test.ts`
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { type CommandResult, type Session } from "./serial_cfgmgmt_lib.ts";
import {
  becomePrefix,
  cleanupCommand,
  collectCommand,
  dryRunCommand,
  inferRebootRequired,
  installCommand,
  launchCommand,
  makeStagingDirCommand,
  parsePollLine,
  parseUpgradeSummary,
  pollCommand,
  runUpgrade,
  upgradeCommand,
  UpgradeFailure,
  type UpgradeHooks,
  type UpgradeParams,
} from "./serial_cfgmgmt_package.ts";

/** A staging dir a scripted `mktemp -d` returns; stands in for a real per-run dir. */
const STAGE = "/tmp/.swamp-dnf.Ab3Xz9";

/** True when a command would actually terminate the transaction (not `kill -0`). */
const terminates = (c: string): boolean =>
  /\bpkill\b/.test(c) || /\breap\b/.test(c) || /\bkill\b(?!\s+-0\b)/.test(c);

/** A canned reply, or a sequence consumed in order (last entry repeats). */
type Reply = CommandResult | CommandResult[];

/** A session that answers each command from a regex-keyed table. */
function fakeSession(
  routes: Array<[RegExp, Reply]>,
): Session & { calls: string[] } {
  const calls: string[] = [];
  const cursor = new Map<number, number>();
  return {
    calls,
    run(command: string): Promise<CommandResult> {
      calls.push(command);
      for (let i = 0; i < routes.length; i++) {
        const [re, reply] = routes[i];
        if (!re.test(command)) continue;
        if (Array.isArray(reply)) {
          const k = cursor.get(i) ?? 0;
          cursor.set(i, k + 1);
          return Promise.resolve(reply[Math.min(k, reply.length - 1)]);
        }
        return Promise.resolve(reply);
      }
      return Promise.resolve({ stdout: "", exitCode: 127 });
    },
  };
}

const ok = (stdout: string): CommandResult => ({ stdout, exitCode: 0 });

/** Deterministic clock: `sleep(ms)` advances `now` by exactly `ms`. */
function fakeHooks(): UpgradeHooks & { elapsed: () => number } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    elapsed: () => t,
  };
}

const baseParams: Omit<UpgradeParams, "manager"> = {
  refreshMetadata: true,
  securityOnly: false,
  dryRun: false,
  pollIntervalMs: 10_000,
  maxWaitMs: 3_600_000,
  becomePrefix: "", // already-root session unless a test overrides it
};

// ── pure helpers ────────────────────────────────────────────────────────────

Deno.test("upgradeCommand is manager-appropriate with flag combos", () => {
  assertEquals(
    upgradeCommand("dnf", { refreshMetadata: true, securityOnly: false }),
    "dnf upgrade -y --refresh",
  );
  assertEquals(
    upgradeCommand("dnf", { refreshMetadata: false, securityOnly: false }),
    "dnf upgrade -y",
  );
  assertEquals(
    upgradeCommand("dnf", { refreshMetadata: true, securityOnly: true }),
    "dnf upgrade -y --refresh --security",
  );
  assertEquals(
    upgradeCommand("yum", { refreshMetadata: false, securityOnly: true }),
    "yum upgrade -y --security",
  );
  assertEquals(
    upgradeCommand("apt-get", { refreshMetadata: true, securityOnly: false }),
    "DEBIAN_FRONTEND=noninteractive apt-get update && apt-get upgrade -y",
  );
  assertEquals(
    upgradeCommand("pacman", { refreshMetadata: true, securityOnly: false }),
    "pacman -Syu --noconfirm",
  );
  assertEquals(
    upgradeCommand("zypper", { refreshMetadata: true, securityOnly: false }),
    "zypper --non-interactive update",
  );
  assertEquals(
    upgradeCommand("apk", { refreshMetadata: true, securityOnly: false }),
    "apk upgrade",
  );
});

Deno.test("dryRunCommand solves without mutating", () => {
  assertEquals(
    dryRunCommand("dnf", { refreshMetadata: true, securityOnly: false }),
    "dnf upgrade --assumeno --refresh",
  );
  assertEquals(
    dryRunCommand("apt-get", { refreshMetadata: true, securityOnly: false }),
    "DEBIAN_FRONTEND=noninteractive apt-get update && apt-get -s upgrade",
  );
});

Deno.test("becomePrefix escalates only when asked", () => {
  assertEquals(becomePrefix(false, "sudo"), ""); // already-root session
  assertEquals(becomePrefix(true, "sudo"), "sudo -n "); // non-interactive
  assertEquals(becomePrefix(true, "doas"), "doas ");
  assertEquals(becomePrefix(false, "doas"), ""); // false wins over method
  // Prefix must stay within launchCommand's no-quote/no-$ nested contract.
  assertEquals(/['$]/.test(becomePrefix(true, "sudo")), false);
  assertEquals(/['$]/.test(becomePrefix(true, "doas")), false);
});

Deno.test("upgrade/dryRun/install commands escalate under become", () => {
  const bp = becomePrefix(true, "sudo");
  // dnf/yum: single-command managers just get the prefix.
  assertEquals(
    upgradeCommand("dnf", {
      refreshMetadata: true,
      securityOnly: false,
      becomePrefix: bp,
    }),
    "sudo -n dnf upgrade -y --refresh",
  );
  assertEquals(
    dryRunCommand("dnf", {
      refreshMetadata: false,
      securityOnly: true,
      becomePrefix: bp,
    }),
    "sudo -n dnf upgrade --assumeno --security",
  );
  assertEquals(installCommand("dnf", "vim", bp), "sudo -n dnf install -y vim");
  // apt-get: both chain halves escalate; the noninteractive env rides inside the
  // escalated upgrade (a bare `sudo -n VAR=… apt-get` would treat VAR=… as a cmd).
  assertEquals(
    upgradeCommand("apt-get", {
      refreshMetadata: true,
      securityOnly: false,
      becomePrefix: bp,
    }),
    "sudo -n apt-get update && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get upgrade -y",
  );
  assertEquals(
    installCommand("apt-get", "vim", bp),
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y vim",
  );
  // A become'd dnf command still passes the detached-launch quoting contract.
  launchCommand(
    upgradeCommand("dnf", {
      refreshMetadata: true,
      securityOnly: false,
      becomePrefix: bp,
    }),
    STAGE,
  );
});

Deno.test("makeStagingDirCommand creates a unique, exclusive per-run dir", () => {
  const cmd = makeStagingDirCommand();
  assertStringIncludes(cmd, "mktemp -d"); // atomic + unpredictable (TOCTOU-safe)
  assertStringIncludes(cmd, "/tmp/.swamp-dnf.XXXXXX"); // per-run uniqueness
});

Deno.test("launchCommand records the worker's own $$ from inside the payload, never $!", () => {
  const cmd = launchCommand("dnf upgrade -y --refresh", STAGE);
  assertStringIncludes(cmd, "setsid sh -c"); // detached
  assertStringIncludes(cmd, "</dev/null"); // no tty prompt can block
  assertStringIncludes(cmd, `>${STAGE}/log`); // log under THIS run's dir
  // The pid file holds the WORKER's own pid ($$), written from inside the payload
  // which then `exec`s the transaction — so `kill -0` stays true while dnf runs.
  assertStringIncludes(cmd, `echo $$ >${STAGE}/pid`);
  assertStringIncludes(cmd, "exec sh -c");
  // NEVER the launcher's `$!`: under an interactive getty login shell (a
  // process-group leader) setsid forks and `$!` captures the short-lived parent
  // that exits in ms — mis-reporting a healthy upgrade as a failed launch.
  assertEquals(/\$!/.test(cmd), false);
  // The UPGRADE's exit code lands in rc — escaped so it isn't `exec`'s rc.
  assertStringIncludes(cmd, `echo \\$? >${STAGE}/rc`);
  // No global literal, and no stale-rc rm is needed with a fresh per-run dir.
  assertEquals(/\/tmp\/\.swamp-dnf\.(rc|log)\b/.test(cmd), false);
  assertEquals(/rm -f/.test(cmd), false);
  // The launcher never waits on the transaction and never kills anything.
  assertEquals(terminates(cmd), false);
});

Deno.test("cleanupCommand removes only this run's staging dir", () => {
  assertEquals(cleanupCommand(STAGE), `rm -rf ${STAGE}`);
});

// QUOTE-1: the nested single/double quoting splices upgradeCmd verbatim, so a
// command with a single quote or `$` must be rejected loudly, not silently
// produce a broken launcher. Today's upgradeCommand outputs are quote/$-free.
Deno.test("launchCommand rejects a command with a single quote or $", () => {
  assertThrows(
    () => launchCommand("dnf install 'weird pkg'", STAGE),
    Error,
    "nested-quoting contract",
  );
  assertThrows(
    () => launchCommand("echo $HOME && dnf upgrade -y", STAGE),
    Error,
    "nested-quoting contract",
  );
  // The real, static upgradeCommand outputs pass the guard.
  for (
    const m of ["dnf", "yum", "apt-get", "pacman", "apk", "zypper"] as const
  ) {
    launchCommand(
      upgradeCommand(m, { refreshMetadata: true, securityOnly: true }),
      STAGE,
    );
  }
});

Deno.test("parsePollLine distinguishes RUNNING / DONE / WORKER_GONE / LAUNCH_FAILED / garbage", () => {
  const r = (
    done: boolean,
    rc: number | null,
    launchFailed = false,
    died = false,
  ) => ({
    done,
    rc,
    launchFailed,
    died,
  });
  assertEquals(parsePollLine("RUNNING"), r(false, null));
  assertEquals(parsePollLine("DONE:0"), r(true, 0));
  assertEquals(parsePollLine("DONE:1\n"), r(true, 1));
  assertEquals(parsePollLine("  DONE:137  "), r(true, 137));
  assertEquals(parsePollLine("WORKER_GONE"), r(false, null, false, true));
  assertEquals(parsePollLine("LAUNCH_FAILED"), r(false, null, true, false));
  assertEquals(parsePollLine("garbage"), r(false, null));
  assertEquals(parsePollLine(""), r(false, null));
  assertEquals(parsePollLine("DONE:"), r(false, null));
});

Deno.test("parseUpgradeSummary counts updates and detects no-op", () => {
  const upgraded = [
    "Upgraded:",
    "  bash-5.2.26-1.fc42.riscv64  kernel-6.14.0-500.fc42.riscv64",
    "Transaction Summary",
    "================================",
    "Upgrade  2 Packages",
    "Complete!",
  ].join("\n");
  assertEquals(parseUpgradeSummary(upgraded, "dnf"), {
    packagesUpdated: 2,
    changed: true,
  });
  // dnf5 phrasing.
  assertEquals(
    parseUpgradeSummary("Upgrading: 5 packages\nComplete!", "dnf"),
    { packagesUpdated: 5, changed: true },
  );
  // Nothing to do => idempotent no-op.
  assertEquals(parseUpgradeSummary("Nothing to do.\nComplete!", "dnf"), {
    packagesUpdated: 0,
    changed: false,
  });
  // apt phrasing.
  assertEquals(
    parseUpgradeSummary(
      "0 upgraded, 0 newly installed, 0 to remove",
      "apt-get",
    ),
    { packagesUpdated: 0, changed: false },
  );
});

Deno.test("inferRebootRequired: needs-restarting authoritative, kernel fallback", () => {
  // needs-restarting -r exit 1 => advised.
  assertEquals(
    inferRebootRequired({
      needsRestartingExit: 1,
      newestKernel: null,
      runningKernel: null,
    }),
    true,
  );
  // exit 0 => not advised (even if kernels differ).
  assertEquals(
    inferRebootRequired({
      needsRestartingExit: 0,
      newestKernel: "b",
      runningKernel: "a",
    }),
    false,
  );
  // Plugin absent (null) => kernel comparison.
  assertEquals(
    inferRebootRequired({
      needsRestartingExit: null,
      newestKernel: "6.14.0-500.fc42.riscv64",
      runningKernel: "6.13.0-1.fc42.riscv64",
    }),
    true,
  );
  assertEquals(
    inferRebootRequired({
      needsRestartingExit: null,
      newestKernel: "6.14.0-500.fc42.riscv64",
      runningKernel: "6.14.0-500.fc42.riscv64",
    }),
    false,
  );
  // Missing data => conservative false.
  assertEquals(
    inferRebootRequired({
      needsRestartingExit: null,
      newestKernel: null,
      runningKernel: "x",
    }),
    false,
  );
});

// ── orchestration (runUpgrade against a scripted fake session) ───────────────

/** Routes shared by the reboot/release probes in a successful dnf run. */
const probeRoutes = (): Array<[RegExp, Reply]> => [
  [/os-release/, ok("42")],
  [/needs-restarting -r/, { stdout: "", exitCode: 0 }],
  [/rpm -q .*kernel/, ok("6.14.0-500.fc42.riscv64")],
  [/uname -r/, ok("6.14.0-500.fc42.riscv64")],
];

Deno.test("runUpgrade happy path: detached launch -> RUNNING -> DONE:0 -> summary", async () => {
  const log = [
    "Upgraded:",
    "  bash-5.2.26-1.fc42.riscv64  curl-8.6.0-2.fc42.riscv64",
    "Transaction Summary",
    "Upgrade  2 Packages",
    "Complete!",
  ].join("\n");
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, [ok("RUNNING"), ok("RUNNING"), ok("DONE:0")]],
    [/tail -c/, ok(log)],
    ...probeRoutes(),
  ]);
  const hooks = fakeHooks();
  const out = await runUpgrade(s, { manager: "dnf", ...baseParams }, hooks);

  assertEquals(out.exitCode, 0);
  assertEquals(out.changed, true);
  assertEquals(out.packagesUpdated, 2);
  assertEquals(out.rebootRequired, false);
  assertEquals(out.releaseVersion, "42");
  assertStringIncludes(out.summary, "Complete!");
  // Launched exactly once, detached; the transaction is never read in one call.
  assertEquals(s.calls.filter((c) => /setsid/.test(c)).length, 1);
  // Slept between the two RUNNING polls (2 x pollIntervalMs).
  assertEquals(hooks.elapsed(), 20_000);
  // Success path removes this run's staging dir.
  assertStringIncludes(s.calls.find((c) => /rm -rf/.test(c))!, STAGE);
});

Deno.test("runUpgrade escalates the transaction and reboot probe under become", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("DONE:0")],
    [/tail -c/, ok("Nothing to do.\nComplete!")],
    ...probeRoutes(),
  ]);
  const out = await runUpgrade(
    s,
    { manager: "dnf", ...baseParams, becomePrefix: becomePrefix(true, "sudo") },
    fakeHooks(),
  );
  assertEquals(out.exitCode, 0);
  // The detached launch carries the escalated dnf command...
  const launch = s.calls.find((c) => /setsid/.test(c))!;
  assertStringIncludes(launch, "sudo -n dnf upgrade -y --refresh");
  // ...but the read-only probes are NOT escalated — including the reboot probe:
  // keeping sudo out of `needs-restarting -r` means its exit 1 can only mean
  // "reboot advised", never a sudo policy denial (which also exits 1).
  for (const re of [/needs-restarting/, /uname -r/, /rpm -q/, /mktemp/]) {
    assertEquals(
      /sudo|doas/.test(s.calls.find((c) => re.test(c))!),
      false,
      `probe ${re} must not be privilege-escalated`,
    );
  }
});

Deno.test("runUpgrade nothing-to-do is idempotent (changed=false)", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("DONE:0")],
    [/tail -c/, ok("Nothing to do.\nComplete!")],
    ...probeRoutes(),
  ]);
  const out = await runUpgrade(
    s,
    { manager: "dnf", ...baseParams },
    fakeHooks(),
  );
  assertEquals(out.exitCode, 0);
  assertEquals(out.changed, false);
  assertEquals(out.packagesUpdated, 0);
});

// Reject path for the staging-dir guard: if `mktemp` comes back as anything but
// a single clean path — e.g. a trailing prompt fragment bled past the sentinel,
// the live-observed failure `/tmp/.swamp-dnf.o1zo5w\n[fedora@bpif3-004 ~` — the
// value must NOT be spliced into launch/poll/collect (its embedded newline would
// corrupt them). runUpgrade must fail fast at the guard, before any `setsid`.
Deno.test("runUpgrade rejects a corrupted staging dir before launching", async () => {
  const s = fakeSession([
    [/mktemp/, ok(`${STAGE}\n[fedora@bpif3-004 ~`)],
  ]);
  await assertRejects(
    () => runUpgrade(s, { manager: "dnf", ...baseParams }, fakeHooks()),
    Error,
    "could not create a staging dir",
  );
  // Never launched the transaction with a poisoned path.
  assertEquals(s.calls.some((c) => /setsid/.test(c)), false);
});

Deno.test("runUpgrade rebootRequired reported when needs-restarting exits 1", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("DONE:0")],
    [/tail -c/, ok("Upgrade  1 Package\nComplete!")],
    [/os-release/, ok("42")],
    [/needs-restarting -r/, { stdout: "", exitCode: 1 }],
    [/rpm -q .*kernel/, ok("6.14.0-500.fc42.riscv64")],
    [/uname -r/, ok("6.13.0-1.fc42.riscv64")],
  ]);
  const out = await runUpgrade(
    s,
    { manager: "dnf", ...baseParams },
    fakeHooks(),
  );
  assertEquals(out.rebootRequired, true);
});

Deno.test("runUpgrade surfaces the log tail on a non-zero rc", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("DONE:1")],
    [/tail -c/, ok("Error: GPG check FAILED for pkg-1.fc42")],
  ]);
  await assertRejects(
    () => runUpgrade(s, { manager: "dnf", ...baseParams }, fakeHooks()),
    Error,
    "GPG check FAILED",
  );
  // Never probed reboot / release after a failure, and never terminated anything
  // (the `kill -0` liveness poll is not a termination). Staging dir left intact.
  assertEquals(s.calls.some((c) => /needs-restarting/.test(c)), false);
  assertEquals(s.calls.some(terminates), false);
  assertEquals(s.calls.some((c) => /rm -rf/.test(c)), false);
});

// RES-1: a failed run still yields a queryable outcome (the resource `execute`
// persists before re-throwing). We assert the failure carries the record.
Deno.test("runUpgrade failure carries a queryable outcome for the resource record", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("DONE:1")],
    [/tail -c/, ok("Error: GPG check FAILED for pkg-1.fc42")],
  ]);
  const err = await runUpgrade(
    s,
    { manager: "dnf", ...baseParams },
    fakeHooks(),
  )
    .then(() => null, (e) => e);
  assert(err instanceof UpgradeFailure);
  assertEquals(err.outcome.exitCode, 1); // real non-zero rc preserved
  assertEquals(err.outcome.changed, false);
  assertEquals(err.outcome.manager, "dnf");
  assertEquals(err.outcome.packagesUpdated, 0); // never fabricated from a failure
  assertEquals(typeof err.outcome.startedAt, "string");
  assertEquals(typeof err.outcome.finishedAt, "string");
  assertStringIncludes(err.outcome.summary, "GPG check FAILED");
});

Deno.test("runUpgrade times out without killing the transaction", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("RUNNING")], // never finishes
  ]);
  const params: UpgradeParams = {
    manager: "dnf",
    ...baseParams,
    pollIntervalMs: 1_000,
    maxWaitMs: 5_000,
  };
  const err = await runUpgrade(s, params, fakeHooks()).then(
    () => null,
    (e) => e,
  );
  assert(err instanceof UpgradeFailure);
  assertStringIncludes(err.message, "STILL RUNNING and was NOT killed");
  assertStringIncludes(err.message, STAGE); // operator can find the staging dir
  assertEquals(err.outcome.exitCode, -1); // timeout sentinel, still queryable
  // No termination of the half-applied transaction (the `kill -0` liveness poll
  // is not one); the staging dir is LEFT IN PLACE, never removed.
  assertEquals(s.calls.some(terminates), false);
  assertEquals(s.calls.some((c) => /rm -rf/.test(c)), false);
  // It did launch once and then only polled.
  assertEquals(s.calls.filter((c) => /setsid/.test(c)).length, 1);
});

Deno.test("runUpgrade dryRun previews inline without detaching or mutating", async () => {
  const s = fakeSession([
    [/upgrade --assumeno/, { stdout: "Upgrade  3 Packages", exitCode: 1 }],
    [/os-release/, ok("42")],
  ]);
  const out = await runUpgrade(
    s,
    { manager: "dnf", ...baseParams, dryRun: true },
    fakeHooks(),
  );
  assertEquals(out.exitCode, 1); // dnf `--assumeno` exits 1 on a real plan — OK
  assertEquals(out.changed, false); // nothing applied
  assertEquals(out.packagesUpdated, 3); // what WOULD change
  // Never staged, never detached, never polled.
  assertEquals(s.calls.some((c) => /mktemp/.test(c)), false);
  assertEquals(s.calls.some((c) => /setsid/.test(c)), false);
  assertEquals(s.calls.some((c) => /kill -0/.test(c)), false);
});

// DRY-1: a null exit code from the dry-run means the session timed out mid-solve
// (partial text, no `$?` sentinel). It must be a FAILURE, never coerced to 0.
Deno.test("runUpgrade dryRun with a null exit code fails (no fake success)", async () => {
  const s = fakeSession([
    [/upgrade --assumeno/, {
      stdout: "Dependencies resolved.\n(partial…",
      exitCode: null,
    }],
  ]);
  const err = await runUpgrade(
    s,
    { manager: "dnf", ...baseParams, dryRun: true },
    fakeHooks(),
  ).then(() => null, (e) => e);
  assert(err instanceof UpgradeFailure);
  assertStringIncludes(err.message, "did not complete within maxMs");
  assertEquals(err.outcome.exitCode, -1); // sentinel, not a fabricated 0
  assertEquals(err.outcome.changed, false);
  assertEquals(err.outcome.packagesUpdated, 0); // never fabricated from truncated text
  // Never queried release / detached after the timeout.
  assertEquals(s.calls.some((c) => /os-release/.test(c)), false);
  assertEquals(s.calls.some((c) => /setsid/.test(c)), false);
});

// Referenced so the poll/collect command shapes stay covered by name.
Deno.test("pollCommand / collectCommand target this run's staging files", () => {
  const poll = pollCommand(STAGE);
  assertStringIncludes(poll, `${STAGE}/rc`);
  assertStringIncludes(poll, `${STAGE}/pid`);
  assertStringIncludes(poll, `${STAGE}/log`);
  assertStringIncludes(poll, "RUNNING");
  assertStringIncludes(poll, "WORKER_GONE");
  assertStringIncludes(poll, "LAUNCH_FAILED");
  assertStringIncludes(poll, `kill -0 "$(cat ${STAGE}/pid)"`); // liveness probe only
  assertStringIncludes(collectCommand(STAGE), `tail -c 4096 ${STAGE}/log`);
});

// POLL-2: liveness (kill -0) must be checked BEFORE the log-bytes test, so a dead
// worker that had already logged output is NOT mis-reported RUNNING (which would
// spin to maxWaitMs). Precedence: DONE → RUNNING(alive) → WORKER_GONE(logged then
// died) → LAUNCH_FAILED(never started).
Deno.test("pollCommand tests liveness before log bytes (dead+logged => WORKER_GONE, not RUNNING)", () => {
  const poll = pollCommand(STAGE);
  const rcIdx = poll.indexOf(`[ -f ${STAGE}/rc ]`);
  const killIdx = poll.indexOf("kill -0");
  const logIdx = poll.indexOf(`[ -s ${STAGE}/log ]`);
  const goneIdx = poll.indexOf("WORKER_GONE");
  const failIdx = poll.indexOf("LAUNCH_FAILED");
  // Ordered: rc → kill-0(RUNNING) → log(WORKER_GONE) → LAUNCH_FAILED.
  assert(rcIdx >= 0 && killIdx > rcIdx && logIdx > killIdx && goneIdx > logIdx);
  assert(failIdx > goneIdx);
  // Exactly ONE RUNNING arm, gated by liveness — not by log bytes.
  assertEquals((poll.match(/echo RUNNING/g) ?? []).length, 1);
  // The log-bytes branch resolves to the died verdict, never RUNNING.
  assertStringIncludes(poll.slice(logIdx, failIdx), "WORKER_GONE");
});

// RC-1 + SEC-1: every run stages under its own unpredictable mktemp dir; launch,
// poll, and collect all thread THAT dir — never a shared /tmp/.swamp-dnf.rc|log.
Deno.test("runUpgrade stages under a unique per-run dir (no shared literals)", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("DONE:0")],
    [/tail -c/, ok("Nothing to do.\nComplete!")],
    ...probeRoutes(),
  ]);
  await runUpgrade(s, { manager: "dnf", ...baseParams }, fakeHooks());
  // Created a unique, exclusively-owned staging dir on the target first.
  assertEquals(
    s.calls.some((c) => /mktemp -d \/tmp\/\.swamp-dnf\.XXXXXX/.test(c)),
    true,
  );
  // launch, poll, and collect all reference THIS run's dir …
  const launch = s.calls.find((c) => /setsid/.test(c))!;
  const poll = s.calls.find((c) => /kill -0/.test(c))!;
  const collect = s.calls.find((c) => /tail -c/.test(c))!;
  assertStringIncludes(launch, `${STAGE}/rc`);
  assertStringIncludes(launch, `${STAGE}/log`);
  assertStringIncludes(launch, `${STAGE}/pid`);
  assertStringIncludes(poll, `${STAGE}/rc`);
  assertStringIncludes(collect, `${STAGE}/log`);
  // … and never the old shared global literal that could collide / be symlinked.
  assertEquals(
    s.calls.some((c) => /\/tmp\/\.swamp-dnf\.(rc|log)\b/.test(c)),
    false,
  );
});

// LNC-1: if the detached job never started (child PID gone, empty log), fail fast
// instead of spinning to maxWaitMs on a false "still RUNNING".
Deno.test("runUpgrade fails fast when the background job never launched", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("LAUNCH_FAILED")],
    [/tail -c/, ok("")], // no log — nothing ever ran
  ]);
  const hooks = fakeHooks();
  const err = await runUpgrade(s, { manager: "dnf", ...baseParams }, hooks)
    .then(() => null, (e) => e);
  assert(err instanceof UpgradeFailure);
  assertStringIncludes(err.message, "failed to launch");
  assertEquals(err.outcome.exitCode, -1);
  // Fast: only the single confirmation re-poll delay (< one poll interval), never
  // spun toward the (default 1h) maxWait, never terminated anything. (The poll
  // loop re-confirms a terminal verdict once before believing it — a lone bad
  // serial read must not fail-fast a healthy worker; see pollWithConfirm.)
  assert(hooks.elapsed() < baseParams.pollIntervalMs);
  assertEquals(s.calls.some(terminates), false);
});

// POLL-2: a worker that logs output then dies WITHOUT recording an rc (crash /
// OOM / killed mid-transaction) must fail fast with the log tail — never spin to
// maxWaitMs on a stale "still RUNNING".
Deno.test("runUpgrade fails fast when the worker dies after logging without an rc", async () => {
  const s = fakeSession([
    [/mktemp/, ok(STAGE)],
    [/setsid/, ok("")],
    [/kill -0/, ok("WORKER_GONE")], // logged, then pid dead, still no rc
    [/tail -c/, ok("Downloading packages...\nKilled")],
  ]);
  const hooks = fakeHooks();
  const err = await runUpgrade(s, { manager: "dnf", ...baseParams }, hooks)
    .then(() => null, (e) => e);
  assert(err instanceof UpgradeFailure);
  assertStringIncludes(err.message, "exited without recording an exit code");
  assertStringIncludes(err.message, "Killed"); // surfaces the log tail
  assertEquals(err.outcome.exitCode, -1);
  assertStringIncludes(err.outcome.summary, "Killed"); // queryable failure record
  // Fast: only the single confirmation re-poll delay (< one poll interval), never
  // spun toward maxWait; the staging dir is left in place, not removed. (Two
  // consecutive WORKER_GONE reads = a confirmed death, not a spurious one.)
  assert(hooks.elapsed() < baseParams.pollIntervalMs);
  assertEquals(s.calls.some((c) => /rm -rf/.test(c)), false);
  assertEquals(s.calls.some(terminates), false);
});

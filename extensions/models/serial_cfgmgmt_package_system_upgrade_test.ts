/**
 * Unit tests for `@shrug/serial-cfgmgmt/package` method `system_upgrade` — the
 * Fedora release jump (F42→F43) via the offline `dnf system-upgrade` transaction
 * (design §4). Covers the pure command/parse helpers, the preflight+download
 * orchestration against a scripted fake session, and the reboot barrier against a
 * scripted fake raw console. NO device required, NO real waits (injected clock).
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_package_system_upgrade_test.ts`
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { type CommandResult, type Session } from "./serial_cfgmgmt_lib.ts";
import { type SerialPort } from "./serial_port.ts";
import {
  awaitLoginReturn,
  detectFlavorCommand,
  detectLoginPrompt,
  ensurePluginCommand,
  issueReboot,
  launchCommand,
  model,
  osReleaseVersionCommand,
  parseDnfFlavor,
  parseOsReleaseVersionId,
  probeReleaseCommand,
  rebootCommand,
  runSystemUpgradeDownload,
  shouldReboot,
  systemUpgradeAvailableCommand,
  systemUpgradeDownloadCommand,
  SystemUpgradeFailure,
  type SystemUpgradeParams,
  type UpgradeHooks,
} from "./serial_cfgmgmt_package.ts";

// ── Fakes (mirror the upgrade test's scripted-session pattern) ───────────────

/** A staging dir a scripted `mktemp -d` returns; stands in for a real per-run dir. */
const STAGE = "/tmp/.swamp-dnf.Ab3Xz9";

/** The release probe's (first) `mktemp -d` dir — distinct from the download's
 * {@link STAGE} so the detached probe's poll/collect never collide with the
 * download's on a shared sequence. Suffix stays alphanumeric to satisfy the
 * method's `^/tmp/\.swamp-dnf\.[A-Za-z0-9]+$` staging-dir guard. */
const PROBE_STAGE = "/tmp/.swamp-dnf.Pr0be1";

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
const rc = (stdout: string, exitCode: number): CommandResult => ({
  stdout,
  exitCode,
});

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

/**
 * A raw serial port that emits `chunks` in order across reads (one chunk per
 * read), then returns null (idle). Records everything written for assertions.
 */
function fakePort(chunks: string[]): SerialPort & { written: string[] } {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const written: string[] = [];
  let i = 0;
  return {
    written,
    write(bytes: Uint8Array): Promise<number> {
      written.push(dec.decode(bytes));
      return Promise.resolve(bytes.length);
    },
    read(buf: Uint8Array): Promise<number | null> {
      if (i >= chunks.length) return Promise.resolve(null);
      const bytes = enc.encode(chunks[i++]);
      const n = Math.min(bytes.length, buf.length);
      buf.set(bytes.subarray(0, n));
      return Promise.resolve(n);
    },
    close() {},
  };
}

const baseParams: Omit<SystemUpgradeParams, "manager"> = {
  targetRelease: 43,
  downloadOnly: false,
  confirm: true,
  pollIntervalMs: 15_000,
  downloadMaxWaitMs: 5_400_000,
  rebootMaxWaitMs: 2_400_000,
  becomePrefix: "sudo -n ",
};

/** The full happy-path route table for a dnf download that stages cleanly. */
function downloadRoutes(
  pollSeq: CommandResult[],
  over: Partial<{
    osRelease: CommandResult;
    probePoll: CommandResult[];
    probeTail: CommandResult;
    available: CommandResult;
    flavor: CommandResult;
    plugin: CommandResult;
  }> = {},
): Array<[RegExp, Reply]> {
  return [
    [/os-release/, over.osRelease ?? ok("42")],
    // dnf5 ships `system-upgrade` built-in by default → available, no install.
    [/system-upgrade --help/, over.available ?? ok("")],
    [/command -v dnf5/, over.flavor ?? ok("dnf5")],
    [/install -y \S*plugin-system-upgrade/, over.plugin ?? ok("")],
    // Two detached stages per run, each under its own `mktemp -d`: FIRST the
    // release probe (step 3), THEN the offline download (step 5).
    [/mktemp -d/, [ok(PROBE_STAGE), ok(STAGE)]],
    // Probe poll/collect keyed on the probe dir — MUST precede the generic
    // download poll/collect so the probe resolves on its OWN sequence (default:
    // done cleanly on the first poll) and never drains the download's `pollSeq`.
    [/-f \S*Pr0be1\/rc \]/, over.probePoll ?? [ok("DONE:0")]],
    [/tail -c \d+ \S*Pr0be1\/log/, over.probeTail ?? ok("")],
    // Both stages launch via `setsid`; the download's poll/collect follow.
    [/setsid/, ok("")],
    [/-f \S*\/rc \]/, pollSeq],
    [/tail -c/, ok("Complete!\nDownload complete!")],
  ];
}

// ── Pure command builders ────────────────────────────────────────────────────

Deno.test("ensurePluginCommand: flavor-correct package name + become", () => {
  assertEquals(
    ensurePluginCommand("dnf5", "sudo -n "),
    "sudo -n dnf install -y dnf5-plugin-system-upgrade",
  );
  assertEquals(
    ensurePluginCommand("dnf4", ""),
    "dnf install -y dnf-plugin-system-upgrade",
  );
});

Deno.test("systemUpgradeAvailableCommand: read-only, unprivileged capability probe", () => {
  const cmd = systemUpgradeAvailableCommand();
  assertEquals(cmd, "dnf system-upgrade --help >/dev/null 2>&1");
  // Never become-escalated (a plain exit code, never a sudo denial) and not
  // quiet-idling: `--help` returns immediately, so no RC-sentinel idle risk.
  assertFalse(/sudo|doas/.test(cmd));
});

Deno.test("parseDnfFlavor: dnf5 detected, else dnf4 default", () => {
  assertEquals(parseDnfFlavor("dnf5\n"), "dnf5");
  assertEquals(parseDnfFlavor("dnf4"), "dnf4");
  assertEquals(parseDnfFlavor(""), "dnf4");
  assertEquals(parseDnfFlavor("garbage"), "dnf4");
});

Deno.test("probeReleaseCommand: releasever metadata probe, launch-safe, non-quiet", () => {
  assertEquals(
    probeReleaseCommand(43, "sudo -n "),
    "sudo -n dnf --releasever=43 makecache --refresh",
  );
  // The probe is launched DETACHED + RC-polled (step 3), so it must satisfy
  // launchCommand's nested-quoting contract (no ' or $) exactly like the
  // download command does.
  assertStringIncludes(
    launchCommand(probeReleaseCommand(43, "sudo -n "), STAGE),
    "setsid",
  );
  // Keep it non-quiet: `-q` would suppress the per-repo progress that makes the
  // staged `log` tail useful on a probe failure. Idle-out is no longer a concern
  // (the detached poll reads the worker's rc file, not the live console), but a
  // readable failure tail still matters — so guard against re-introducing `-q`.
  assertFalse(/(^|\s)-q(\s|$)/.test(probeReleaseCommand(43)));
});

Deno.test("systemUpgradeDownloadCommand: releasever download, launch-safe", () => {
  const cmd = systemUpgradeDownloadCommand(43, "sudo -n ");
  assertEquals(cmd, "sudo -n dnf system-upgrade download -y --releasever=43");
  // Must satisfy launchCommand's nested-quoting contract (no ' or $).
  const launched = launchCommand(cmd, STAGE);
  assertStringIncludes(launched, "setsid");
});

Deno.test("rebootCommand: become-prefixed offline reboot, auto-confirmed", () => {
  assertEquals(rebootCommand("doas "), "doas dnf -y system-upgrade reboot");
  assertEquals(rebootCommand(), "dnf -y system-upgrade reboot");
  // `-y` is mandatory: dnf5 prompts `Is this ok [y/N]` (defaults N) and the
  // reboot is fired fire-and-forget over a raw port with nobody to answer, so a
  // missing -y silently never reboots. See the Banana Pi F3 F42→F43 live jump.
  assertStringIncludes(rebootCommand(), "-y");
});

Deno.test("detectFlavorCommand / osReleaseVersionCommand are stable", () => {
  assertStringIncludes(detectFlavorCommand(), "command -v dnf5");
  assertStringIncludes(osReleaseVersionCommand(), "VERSION_ID");
});

Deno.test("parseOsReleaseVersionId: bare value or full line, else null", () => {
  assertEquals(parseOsReleaseVersionId("42"), 42);
  assertEquals(parseOsReleaseVersionId('VERSION_ID="43"'), 43);
  assertEquals(parseOsReleaseVersionId("VERSION_ID=43"), 43);
  assertEquals(parseOsReleaseVersionId(""), null);
  assertEquals(parseOsReleaseVersionId("rawhide"), null);
});

Deno.test("parseOsReleaseVersionId: VERSION_ID wins over other digits (SU-7)", () => {
  // A fuller os-release dump: the integer must come from VERSION_ID, not from an
  // unrelated line (PLATFORM_ID, a hostname) that happens to contain digits.
  const dump =
    'PLATFORM_ID="platform:f42"\nHOSTNAME=bpif3-004\nVERSION_ID=43\n';
  assertEquals(parseOsReleaseVersionId(dump), 43);
  // A bare non-numeric token is not mistaken for a release.
  assertEquals(parseOsReleaseVersionId("bpif3-004"), null);
});

// ── The irreversibility gate ─────────────────────────────────────────────────

Deno.test("shouldReboot: ONLY confirm=true AND downloadOnly=false reboots", () => {
  assert(shouldReboot(true, false));
  assertFalse(shouldReboot(false, false)); // default safe path
  assertFalse(shouldReboot(true, true)); // download-only wins
  assertFalse(shouldReboot(false, true));
});

Deno.test("system_upgrade rebootMaxWaitMs default spans a slow-riscv offline apply (#6)", () => {
  // The offline apply is the long pole: a full release jump takes 40-80 min on
  // slow riscv, and the barrier must span reboot → apply → reboot → getty. A too
  // short default reports a FALSE failure on a healthy upgrade (proven live on
  // bpif3-004: the F43 apply exceeded the old 40-min bound). The default must
  // clear the observed 80-min worst case with margin.
  const parsed = model.methods.system_upgrade.arguments.parse({
    targetRelease: 43,
  });
  assertEquals(parsed.rebootMaxWaitMs, 7_200_000);
  assert(
    parsed.rebootMaxWaitMs >= 80 * 60_000,
    "reboot barrier default must clear the observed 80-min offline apply",
  );
});

Deno.test("detectLoginPrompt: getty banner at tail only", () => {
  assert(detectLoginPrompt("bpif3-004 login: "));
  assert(detectLoginPrompt("boot noise\nfedora login:"));
  assert(detectLoginPrompt("\x1b[0mbpif3-004 login: ")); // ANSI-prefixed
  // F43 agetty trails a DSR query + OSC-3008 metadata after `login:` (#7).
  assert(
    detectLoginPrompt(
      "bpif3-004 login: \x1b[6n\x1b]3008;serial-getty@ttyS0.service\x07",
    ),
  );
  assertFalse(detectLoginPrompt("Starting login: service now")); // mid-scroll
  assertFalse(detectLoginPrompt("just some output"));
  assertFalse(detectLoginPrompt(""));
});

// ── runSystemUpgradeDownload: guards + preflight + download ───────────────────

Deno.test("download: wrong manager is a hard error before ANY action", async () => {
  const session = fakeSession(downloadRoutes([ok("DONE:0")]));
  const err = await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "apt-get", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "Fedora/dnf-only",
  );
  // No command may run before the guard trips — nothing was executed.
  assertEquals(session.calls.length, 0);
  assertEquals((err as SystemUpgradeFailure).outcome.staged, false);
});

Deno.test("download: unparseable running release is a HARD failure (SU-1)", async () => {
  // /etc/os-release probe returns garbage (console noise / odd spin): we cannot
  // confirm the jump is forward-only, so we must REFUSE, never fall through to
  // download/reboot.
  const session = fakeSession(
    downloadRoutes([ok("DONE:0")], { osRelease: ok("¤garbled¤") }),
  );
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "could not read the running Fedora release",
  );
  // Never reached the probe or the detached launch.
  assert(session.calls.every((c) => !/setsid/.test(c)));
  assert(session.calls.every((c) => !/makecache/.test(c)));
});

Deno.test("download: refuses a target not newer than the running release", async () => {
  const session = fakeSession(
    downloadRoutes([ok("DONE:0")], { osRelease: ok("43") }),
  );
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "not newer than the running release",
  );
  // Only the os-release probe ran — no probe/plugin/download.
  assert(session.calls.every((c) => !/setsid/.test(c)));
  assert(session.calls.every((c) => !/makecache/.test(c)));
});

Deno.test("download: bad releasever fails at the probe — NO download/reboot", async () => {
  // A nonexistent release 404s on the mirror: the detached makecache worker
  // records a non-zero rc, the probe poll reads DONE:1, and the run refuses.
  const session = fakeSession(
    downloadRoutes([ok("DONE:0")], {
      probePoll: [ok("DONE:1")],
      probeTail: ok("No repos"),
    }),
  );
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "could not be resolved in the",
  );
  // The critical invariant: a bad releasever never reaches the DOWNLOAD launch
  // (the probe itself now launches detached, so assert on the download command,
  // not on `setsid` in general).
  assert(session.calls.every((c) => !/system-upgrade download/.test(c)));
});

Deno.test("download: a slow/quiet makecache probe is polled to completion, NOT idled out (detached-probe regression)", async () => {
  // Real-hardware regression (Banana Pi F3 F42→F43 live proof, 2026-07-24): the
  // OLD synchronous probe read returned exitCode=null when `makecache --refresh`
  // went quiet building solvables past `idleMs` — even though f43 + f43-spacemit
  // metadata resolved fine — and the caller misread null as "release missing", a
  // false negative that blocked a valid upgrade. The fix launches the probe
  // DETACHED and RC-polls it, so a quiet stretch just reads RUNNING until the
  // worker's rc lands. Here the probe polls RUNNING, RUNNING, then DONE:0, and
  // the run proceeds to stage the download — the exact path the old code failed.
  const session = fakeSession(
    downloadRoutes([ok("RUNNING"), ok("DONE:0")], {
      probePoll: [ok("RUNNING"), ok("RUNNING"), ok("DONE:0")],
    }),
  );
  const out = await runSystemUpgradeDownload(
    session,
    { manager: "dnf", ...baseParams },
    fakeHooks(),
  );
  assertEquals(out.staged, true);
  assertEquals(out.downloadExitCode, 0);
  // The probe genuinely launched its detached makecache (not a synchronous read)
  // and the download launched after it — two distinct detached stages.
  assert(session.calls.some((c) => /setsid/.test(c) && /makecache/.test(c)));
  assert(
    session.calls.some((c) =>
      /setsid/.test(c) && /system-upgrade download/.test(c)
    ),
  );
  // Probe dir came first, download dir second — order preserved.
  const probeLaunch = session.calls.findIndex((c) => /makecache/.test(c));
  const dlLaunch = session.calls.findIndex((c) =>
    /system-upgrade download/.test(c)
  );
  assert(probeLaunch >= 0 && probeLaunch < dlLaunch);
});

Deno.test("download: release probe LAUNCH failure fails fast, before any download (SUP-1)", async () => {
  // The probe's OWN launch-fail branch (distinct from the download's identical
  // branch): if the detached makecache worker never comes up, the run must
  // refuse loudly BEFORE the download is ever launched — not spin, not fall
  // through to a download toward an unverified release.
  const session = fakeSession(
    downloadRoutes([ok("DONE:0")], { probePoll: [ok("LAUNCH_FAILED")] }),
  );
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "release probe for 43 failed to launch",
  );
  // The distinguishing invariant: the download launch is never reached.
  assert(session.calls.every((c) => !/system-upgrade download/.test(c)));
});

Deno.test("download: release probe TIMEOUT fails without killing, before any download (SUP-1)", async () => {
  // The probe's OWN timeout branch: a makecache whose rc never lands must fail
  // loudly at downloadMaxWaitMs WITHOUT killing the worker (out-of-band recovery
  // is operator-owned) and WITHOUT ever launching the download.
  const hooks = fakeHooks();
  const session = fakeSession(
    // Probe polls RUNNING forever (last entry repeats) → never completes.
    downloadRoutes([ok("DONE:0")], { probePoll: [ok("RUNNING")] }),
  );
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams, downloadMaxWaitMs: 60_000 },
        hooks,
      ),
    SystemUpgradeFailure,
    "metadata refresh is STILL RUNNING",
  );
  // No terminating command was issued (kill -0 liveness only), and the download
  // never launched — the probe timed out strictly before it.
  assert(session.calls.every((c) => !/\bpkill\b|\bkill\b(?!\s+-0\b)/.test(c)));
  assert(session.calls.every((c) => !/system-upgrade download/.test(c)));
});

Deno.test("download: plugin install failure aborts before download", async () => {
  // Force the dnf4 install path: the capability probe reports system-upgrade is
  // NOT available, so the method falls back to installing the plugin — which
  // then fails. (On dnf5-builtin boxes this branch is skipped entirely; see the
  // built-in-skip test below.)
  const session = fakeSession(
    downloadRoutes([ok("DONE:0")], {
      available: rc("no such command", 1),
      flavor: ok("dnf4"),
      plugin: rc("nothing provides", 1),
    }),
  );
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "system-upgrade plugin",
  );
  // The release probe (step 3) legitimately launched detached before the plugin
  // step, so assert the DOWNLOAD never launched — not `setsid` in general.
  assert(session.calls.every((c) => !/system-upgrade download/.test(c)));
});

Deno.test("download: dnf5 built-in system-upgrade SKIPS the plugin install", async () => {
  // Real-hardware regression (Banana Pi F3, dnf5 5.2.16): `dnf system-upgrade`
  // is built-in, the `dnf5-plugin-system-upgrade` package does NOT exist in the
  // riscv repos, and installing it failed the whole run. The capability probe
  // must short-circuit the install when the subcommand is already available.
  const session = fakeSession(
    downloadRoutes([ok("RUNNING"), ok("DONE:0")], { available: ok("") }),
  );
  const out = await runSystemUpgradeDownload(
    session,
    { manager: "dnf", ...baseParams },
    fakeHooks(),
  );
  assertEquals(out.staged, true);
  // No plugin install and no flavor detection when the subcommand is built-in.
  assert(
    session.calls.every((c) => !/install -y \S*plugin-system-upgrade/.test(c)),
  );
  assert(session.calls.every((c) => !/command -v dnf5/.test(c)));
  // …and the capability WAS probed before the detached DOWNLOAD launched. (The
  // release probe also uses `setsid`, so key the download launch on its command,
  // not on `setsid`.)
  const probeIdx = session.calls.findIndex((c) =>
    /system-upgrade --help/.test(c)
  );
  const launchIdx = session.calls.findIndex((c) =>
    /system-upgrade download/.test(c)
  );
  assert(probeIdx >= 0 && probeIdx < launchIdx);
});

Deno.test("download: dnf4 without the subcommand installs the plugin, then proceeds", async () => {
  const session = fakeSession(
    downloadRoutes([ok("RUNNING"), ok("DONE:0")], {
      available: rc("no such command", 1),
      flavor: ok("dnf4"),
      plugin: ok(""),
    }),
  );
  const out = await runSystemUpgradeDownload(
    session,
    { manager: "dnf", ...baseParams },
    fakeHooks(),
  );
  assertEquals(out.staged, true);
  assert(
    session.calls.some((c) => /install -y dnf-plugin-system-upgrade/.test(c)),
  );
});

Deno.test("download: a spurious first-poll WORKER_GONE is survived via the confirmation re-poll", async () => {
  // Real-hardware regression (Banana Pi F3 F42→F43, 2026-07-24): the first poll
  // over the dd-subprocess transport returned WORKER_GONE while the 953 MiB
  // download was in fact running to completion. A single bad read must NOT
  // fail-fast a healthy worker — the confirmation re-poll sees it RUNNING and the
  // transaction stages. (Shared poll loop → work item A's `upgrade` benefits too.)
  const session = fakeSession(
    downloadRoutes([ok("WORKER_GONE"), ok("RUNNING"), ok("DONE:0")]),
  );
  const out = await runSystemUpgradeDownload(
    session,
    { manager: "dnf", ...baseParams },
    fakeHooks(),
  );
  assertEquals(out.staged, true);
  assertEquals(out.downloadExitCode, 0);
});

Deno.test("download: a persistent WORKER_GONE (confirmed on re-poll) still fails fast — NOT masked", async () => {
  // The confirmation re-poll must not hide a genuine death: two consecutive
  // WORKER_GONE reads = real crash / OOM / kill → fail fast with the log tail,
  // never spin to the timeout.
  const session = fakeSession(
    downloadRoutes([ok("WORKER_GONE"), ok("WORKER_GONE")]),
  );
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "process died",
  );
});

Deno.test("download: happy path stages the transaction (staged, rc 0)", async () => {
  const session = fakeSession(downloadRoutes([ok("RUNNING"), ok("DONE:0")]));
  const out = await runSystemUpgradeDownload(
    session,
    { manager: "dnf", ...baseParams },
    fakeHooks(),
  );
  assertEquals(out.staged, true);
  assertEquals(out.rebooted, false);
  assertEquals(out.verified, false);
  assertEquals(out.downloadExitCode, 0);
  assertEquals(out.fromRelease, "42");
  assertEquals(out.targetRelease, 43);
  assertStringIncludes(out.summary, "Download complete");
  // dnf5 ships system-upgrade built-in (the default route), so NO plugin install.
  assert(
    session.calls.every((c) => !/install -y \S*plugin-system-upgrade/.test(c)),
  );
  // Staging dir cleaned on success.
  assert(session.calls.some((c) => /rm -rf \S*\.swamp-dnf/.test(c)));
});

Deno.test("download: non-zero download rc fails loudly with the log tail", async () => {
  const session = fakeSession(downloadRoutes([ok("DONE:17")]));
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "download failed (rc=17)",
  );
});

Deno.test("download: launch failure fails fast, no spin", async () => {
  const session = fakeSession(downloadRoutes([ok("LAUNCH_FAILED")]));
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams },
        fakeHooks(),
      ),
    SystemUpgradeFailure,
    "failed to launch",
  );
});

Deno.test("download: timeout fails WITHOUT killing the transaction", async () => {
  const hooks = fakeHooks();
  const session = fakeSession(downloadRoutes([ok("RUNNING")])); // never completes
  await assertRejects(
    () =>
      runSystemUpgradeDownload(
        session,
        { manager: "dnf", ...baseParams, downloadMaxWaitMs: 60_000 },
        hooks,
      ),
    SystemUpgradeFailure,
    "STILL RUNNING",
  );
  // No terminating command was ever issued (kill -0 liveness only, no pkill/kill).
  assert(session.calls.every((c) => !/\bpkill\b|\bkill\b(?!\s+-0\b)/.test(c)));
});

// ── issueReboot: fire-and-forget send ────────────────────────────────────────

Deno.test("issueReboot: sends the reboot line, no RC wait, terminates", async () => {
  const port = fakePort([]); // no bytes back — the console is dying
  const hooks = fakeHooks();
  await issueReboot(
    port,
    rebootCommand("sudo -n "),
    { lineEnding: "\n", settleIdleMs: 2000, settleMaxMs: 10_000 },
    { now: hooks.now, sleep: hooks.sleep },
  );
  assert(
    port.written.some((w) => /dnf -y system-upgrade reboot/.test(w)),
    "reboot command (with -y) must be written to the port",
  );
  // The `-y` MUST reach the wire: without it dnf5's `Is this ok [y/N]` prompt
  // defaults to N and the fire-and-forget reboot silently never fires (live
  // regression, Banana Pi F3 F42→F43).
  assert(
    port.written.some((w) =>
      /\bsystem-upgrade reboot\b/.test(w) && /-y/.test(w)
    ),
    "reboot line must carry -y to auto-confirm",
  );
  // Bounded by settleMaxMs — never hangs waiting for a prompt that isn't coming.
  assert(hooks.elapsed() <= 10_000);
});

// ── awaitLoginReturn: the reboot barrier ─────────────────────────────────────

Deno.test("barrier: returns true once login: comes back after dark polls", async () => {
  let calls = 0;
  const openPort = () => {
    calls++;
    // First two reads are dark (board applying the offline transaction), then
    // the getty banner returns.
    return Promise.resolve(
      calls < 3 ? fakePort([]) : fakePort(["\nbpif3-004 login: "]),
    );
  };
  const hooks = fakeHooks();
  const res = await awaitLoginReturn(
    openPort,
    {
      lineEnding: "\n",
      rebootMaxWaitMs: 2_400_000,
      pollIntervalMs: 15_000,
      readIdleMs: 1000,
      readMaxMs: 30_000,
    },
    hooks,
  );
  assert(res.returned);
  assertEquals(calls, 3);
  assertStringIncludes(res.transcript, "login:");
});

Deno.test("barrier: login never returns => fails loudly within the bound", async () => {
  const openPort = () => Promise.resolve(fakePort([])); // always dark
  const hooks = fakeHooks();
  const res = await awaitLoginReturn(
    openPort,
    {
      lineEnding: "\n",
      rebootMaxWaitMs: 90_000,
      pollIntervalMs: 15_000,
      readIdleMs: 1000,
      readMaxMs: 30_000,
    },
    hooks,
  );
  assertFalse(res.returned);
  // The loop honored the bound rather than spinning forever.
  assert(hooks.elapsed() >= 90_000);
});

Deno.test("barrier: a STALE pre-reboot login: is flushed, not trusted (SU-2)", async () => {
  // First read returns a login: banner BUFFERED from before the reboot (e.g. a
  // stale holder PTY). The barrier's first poll FLUSHES/discards it; only the
  // real returning login: (a later poll) is accepted.
  const seq: string[][] = [
    ["stale bpif3-004 login: "], // stale — flushed, never accepted
    [], // dark (offline transaction applying)
    ["\nbpif3-004 login: "], // the real returning banner
  ];
  let i = 0;
  const openPort = () =>
    Promise.resolve(fakePort(seq[Math.min(i++, seq.length - 1)]));
  const hooks = fakeHooks();
  const res = await awaitLoginReturn(
    openPort,
    {
      lineEnding: "\n",
      rebootMaxWaitMs: 2_400_000,
      pollIntervalMs: 15_000,
      readIdleMs: 1000,
      readMaxMs: 30_000,
    },
    hooks,
  );
  assert(res.returned);
  // Accepted on the THIRD open (stale flushed, dark, real login accepted).
  assertEquals(i, 3);
});

Deno.test("barrier: a FAST full reboot→login in the flush window still succeeds (SU-8)", async () => {
  // The entire dark→boot→getty transition lands inside the first (flush) read.
  // The flush discards it, but the next poll's nudge re-elicits the getty banner,
  // so the barrier must NOT wedge to the timeout — it accepts on the next poll.
  const seq: string[][] = [
    ["...reboot scroll...\nbpif3-004 login: "], // whole transition, flushed
    ["\nbpif3-004 login: "], // getty re-prints on the next nudge
  ];
  let i = 0;
  const openPort = () =>
    Promise.resolve(fakePort(seq[Math.min(i++, seq.length - 1)]));
  const hooks = fakeHooks();
  const res = await awaitLoginReturn(
    openPort,
    {
      lineEnding: "\n",
      rebootMaxWaitMs: 2_400_000,
      pollIntervalMs: 15_000,
      readIdleMs: 1000,
      readMaxMs: 30_000,
    },
    hooks,
  );
  assert(res.returned);
  assertEquals(i, 2); // flush, then accept — no spin to the deadline
  // Nowhere near the 40-min bound.
  assert(hooks.elapsed() < 100_000);
});

// ── The confirm gate's real call site (SU-5 source guard) ────────────────────
//
// execute() is transport-bound and not unit-invokable, but the single most
// safety-critical wiring — that the reboot is reachable ONLY through the
// shouldReboot gate — is asserted structurally against the source so a future
// refactor cannot silently introduce an ungated reboot path.
Deno.test("source: the reboot is reachable ONLY past the shouldReboot gate (SU-5)", async () => {
  const raw = await Deno.readTextFile(
    new URL("./serial_cfgmgmt_package.ts", import.meta.url),
  );
  // Collapse whitespace so the structural assertions are formatter-insensitive
  // (deno fmt may wrap a call across lines).
  const src = raw.replace(/\s+/g, " ");
  const gate = src.indexOf(
    "if (!shouldReboot(args.confirm, args.downloadOnly))",
  );
  const issue = src.indexOf("await withLoggedInRawPort( g, context.logger");
  assert(gate > 0, "shouldReboot gate must exist in execute");
  assert(issue > 0, "the reboot-issue call site must exist");
  // The reboot is issued textually AFTER (and thus only past) the gate.
  assert(gate < issue, "reboot must be gated by shouldReboot");
  // Exactly one place issues the reboot, and it hands rebootCommand to issueReboot.
  assertEquals(
    src.split("withLoggedInRawPort( g, context.logger").length - 1,
    1,
  );
  assertEquals(src.split("issueReboot(port, rebootCommand(bp)").length - 1, 1);
});

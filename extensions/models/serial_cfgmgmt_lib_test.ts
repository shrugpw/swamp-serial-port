/**
 * Unit tests for the @shrug/serial-cfgmgmt/* family.
 *
 * Drives the transport-agnostic logic — console cleaning, exit-code parsing,
 * fact gathering, package/service parsing — against a scripted fake session.
 * NO device required.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_lib_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  cleanOutput,
  type CommandResult,
  RC_RE,
  type Session,
  settle,
  splitExitCode,
} from "./serial_cfgmgmt_lib.ts";
import { type Clock, execOn, type SerialPort } from "./serial_port.ts";
import { gatherFacts } from "./serial_cfgmgmt_node.ts";
import {
  detectManager,
  installCommand,
  queryPackage,
} from "./serial_cfgmgmt_package.ts";
import { queryService } from "./serial_cfgmgmt_service.ts";

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A session that answers each command from a lookup table (regex-keyed). */
function fakeSession(
  routes: Array<[RegExp, CommandResult]>,
): Session & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run(command: string): Promise<CommandResult> {
      calls.push(command);
      for (const [re, res] of routes) {
        if (re.test(command)) return Promise.resolve(res);
      }
      return Promise.resolve({ stdout: "", exitCode: 127 });
    },
  };
}

const ok = (stdout: string): CommandResult => ({ stdout, exitCode: 0 });

/** A deterministic clock; time only moves when we advance it. */
class FakeClock implements Clock {
  ms = 0;
  now(): number {
    return this.ms;
  }
  sleep(ms: number): Promise<void> {
    this.ms += ms;
    return Promise.resolve();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/**
 * A scripted serial port (same shape as serial_port_test's fake): returns each
 * queued chunk on successive reads, then reports "no data" (0). Every read
 * advances the clock so idle/max timers make progress. `infinite` repeats the
 * last chunk forever. Records everything written.
 */
class FakePort implements SerialPort {
  writes: string[] = [];
  closed = false;
  private i = 0;
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  constructor(
    private chunks: string[],
    private clock: FakeClock,
    private opts: { readCostMs?: number; infinite?: boolean } = {},
  ) {}
  write(bytes: Uint8Array): Promise<number> {
    this.writes.push(this.dec.decode(bytes));
    return Promise.resolve(bytes.length);
  }
  read(buf: Uint8Array): Promise<number | null> {
    this.clock.advance(this.opts.readCostMs ?? 10);
    let chunk: string | undefined;
    if (this.i < this.chunks.length) chunk = this.chunks[this.i++];
    else if (this.opts.infinite) chunk = this.chunks[this.chunks.length - 1];
    if (chunk === undefined) return Promise.resolve(0);
    const bytes = this.enc.encode(chunk);
    buf.set(bytes.subarray(0, buf.length));
    return Promise.resolve(Math.min(bytes.length, buf.length));
  }
  close(): void {
    this.closed = true;
  }
}

// ── cleanOutput ──────────────────────────────────────────────────────────────

Deno.test("cleanOutput strips ANSI, echoed command, and trailing prompt", () => {
  // Real capture shape from a bracketed-paste bash console.
  const raw =
    "\x1b[?2004luname -srm\r\nLinux 6.16.4-200.spacemit.fc42.riscv64 riscv64\r\n" +
    "\x1b[?2004h\x1b[?2004l[fedora@bpif3-004 ~]$ ";
  assertEquals(
    cleanOutput(raw, "uname -srm"),
    "Linux 6.16.4-200.spacemit.fc42.riscv64 riscv64",
  );
});

Deno.test("cleanOutput keeps multi-line stdout intact", () => {
  const raw = "cat file\r\nID=fedora\r\nVERSION_ID=42\r\n[root@x ~]# ";
  assertEquals(cleanOutput(raw, "cat file"), "ID=fedora\nVERSION_ID=42");
});

// ── splitExitCode ────────────────────────────────────────────────────────────

Deno.test("splitExitCode extracts the RC sentinel and strips it from stdout", () => {
  assertEquals(splitExitCode("hello\n__RC:0:RC__"), {
    stdout: "hello",
    exitCode: 0,
  });
  assertEquals(splitExitCode("__RC:1:RC__"), { stdout: "", exitCode: 1 });
  assertEquals(splitExitCode("no sentinel here"), {
    stdout: "no sentinel here",
    exitCode: null,
  });
});

Deno.test("cleanOutput drops a residual prompt glued onto the echoed command", () => {
  // A prompt left un-drained by loginOn glues onto the pty echo of the next
  // command; the real output follows. Only "fedora" should survive.
  const raw =
    "[fedora@bpif3-004 ~]$ id -un\r\nfedora\r\n[fedora@bpif3-004 ~]$ ";
  assertEquals(cleanOutput(raw, "id -un"), "fedora");
});

// ── settle ───────────────────────────────────────────────────────────────────

Deno.test("settle drains buffered bytes to quiet, then leaves the port empty", async () => {
  const clock = new FakeClock();
  const port = new FakePort(["[fedora@bpif3-004 ~]$ "], clock);
  const swept = await settle(port, { settleMs: 300, maxMs: 5000 }, clock);
  assertEquals(swept, "[fedora@bpif3-004 ~]$ ");
  // A second settle sees nothing — the buffer was fully consumed.
  assertEquals(await settle(port, { settleMs: 300, maxMs: 5000 }, clock), "");
});

Deno.test("settle returns after settleMs of idle on a quiet line", async () => {
  const clock = new FakeClock();
  const port = new FakePort([], clock);
  assertEquals(await settle(port, { settleMs: 300, maxMs: 5000 }, clock), "");
  // Idle bound reached, hard cap not hit.
  assertEquals(clock.now() < 5000, true);
});

Deno.test("settle stops at maxMs on a console that never goes quiet", async () => {
  const clock = new FakeClock();
  const port = new FakePort(["printk noise "], clock, { infinite: true });
  const swept = await settle(port, { settleMs: 300, maxMs: 1000 }, clock);
  assertEquals(swept.length > 0, true);
  assertEquals(clock.now() >= 1000, true); // bounded, did not hang
});

// ── sentinel-synced read ─────────────────────────────────────────────────────

Deno.test("RC-synced read skips a residual prompt and stops on the sentinel", async () => {
  const clock = new FakeClock();
  const cmd = 'id -un; echo "__RC:$?:RC__"';
  // Buffer opens with a STALE prompt (what loginOn strands). A prompt stop-regex
  // would false-match it and return empty; RC_RE must read through to the real
  // sentinel. Note the pty echo carries a literal "$?" (no digit), so RC_RE
  // skips it and matches only the executed "__RC:0:RC__".
  const port = new FakePort(
    [
      "[fedora@bpif3-004 ~]$ ", // residual prompt (stale)
      `${cmd}\r\n`, // pty echo of the wrapped command
      "fedora\r\n", // real output
      "__RC:0:RC__\r\n", // sentinel (digit → matches)
      "[fedora@bpif3-004 ~]$ ", // trailing prompt (should stay unread)
    ],
    clock,
  );
  const { output, matchedPrompt } = await execOn(
    port,
    {
      command: cmd,
      lineEnding: "\n",
      prompt: RC_RE,
      idleMs: 1000,
      maxMs: 15000,
      stripEcho: true,
    },
    clock,
  );
  assertEquals(matchedPrompt, true);
  assertEquals(splitExitCode(cleanOutput(output, cmd)), {
    stdout: "fedora",
    exitCode: 0,
  });
});

// ── gatherFacts ──────────────────────────────────────────────────────────────

Deno.test("gatherFacts parses a Fedora RISC-V board", async () => {
  const run = (command: string): Promise<CommandResult> => {
    if (command.startsWith("uname")) {
      return Promise.resolve(
        ok("Linux 6.16.4-200.spacemit.fc42.riscv64 riscv64"),
      );
    }
    if (command.startsWith("cat /etc/os-release")) {
      return Promise.resolve(ok('ID=fedora\nVERSION_ID=42\nNAME="Fedora Linux"'));
    }
    if (command === "hostname") {
      return Promise.resolve(ok("bpif3-004.fedora-riscv.potato.shrug.pw"));
    }
    if (command.startsWith("for b in")) {
      return Promise.resolve(ok("PM:dnf\nPM:yum"));
    }
    return Promise.resolve({ stdout: "", exitCode: 127 });
  };

  assertEquals(await gatherFacts(run), {
    hostname: "bpif3-004.fedora-riscv.potato.shrug.pw",
    os: "fedora",
    osVersion: "42",
    arch: "riscv64",
    kernel: "6.16.4-200.spacemit.fc42.riscv64",
    packageManagers: ["dnf", "yum"],
  });
});

Deno.test("gatherFacts falls back to unknowns when probes are empty", async () => {
  const run = (): Promise<CommandResult> => Promise.resolve(ok(""));
  const facts = await gatherFacts(run);
  assertEquals(facts.os, "unknown");
  assertEquals(facts.osVersion, "unknown");
  assertEquals(facts.arch, "unknown");
  assertEquals(facts.packageManagers, []);
});

// ── package ──────────────────────────────────────────────────────────────────

Deno.test("detectManager returns the first available manager", async () => {
  const s = fakeSession([[/for b in/, ok("dnf")]]);
  assertEquals(await detectManager((c) => s.run(c)), "dnf");
});

Deno.test("queryPackage reports installed + version on rpm exit 0", async () => {
  const s = fakeSession([[/rpm -q/, ok("2.4.1-1.fc42")]]);
  assertEquals(await queryPackage(s, "dnf", "htop"), {
    installed: true,
    version: "2.4.1-1.fc42",
  });
});

Deno.test("queryPackage reports not-installed on non-zero exit", async () => {
  const s = fakeSession([[/rpm -q/, { stdout: "", exitCode: 1 }]]);
  assertEquals(await queryPackage(s, "dnf", "nope"), {
    installed: false,
    version: null,
  });
});

Deno.test("installCommand is manager-appropriate and shell-safe", () => {
  assertEquals(installCommand("dnf", "htop"), "dnf install -y htop");
  assertEquals(
    installCommand("apt-get", "htop"),
    "DEBIAN_FRONTEND=noninteractive apt-get install -y htop",
  );
  assertEquals(installCommand("pacman", "htop"), "pacman -S --noconfirm htop");
  // Metacharacters are stripped from the package name.
  assertEquals(installCommand("dnf", "htop; rm -rf /"), "dnf install -y htoprm-rf");
});

// ── service ──────────────────────────────────────────────────────────────────

Deno.test("queryService parses is-active / is-enabled", async () => {
  const s = fakeSession([
    [/is-active/, ok("active")],
    [/is-enabled/, ok("enabled")],
  ]);
  assertEquals(await queryService(s, "sshd.service"), {
    activeState: "active",
    enabledState: "enabled",
  });
});

Deno.test("queryService tolerates non-zero exits (inactive/disabled)", async () => {
  const s = fakeSession([
    [/is-active/, { stdout: "inactive", exitCode: 3 }],
    [/is-enabled/, { stdout: "disabled", exitCode: 1 }],
  ]);
  assertEquals(await queryService(s, "nginx.service"), {
    activeState: "inactive",
    enabledState: "disabled",
  });
});

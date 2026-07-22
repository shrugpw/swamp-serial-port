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
  type Session,
  splitExitCode,
} from "./serial_cfgmgmt_lib.ts";
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

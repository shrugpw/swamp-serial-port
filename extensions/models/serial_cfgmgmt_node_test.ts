/**
 * Unit tests for `@shrug/serial-cfgmgmt/node` — `gatherFacts`.
 *
 * Drives fact gathering against a scripted `run` function (os-release, uname,
 * hostname, package-manager probes). NO device required.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_node_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { type CommandResult } from "./serial_cfgmgmt_lib.ts";
import { gatherFacts } from "./serial_cfgmgmt_node.ts";

const ok = (stdout: string): CommandResult => ({ stdout, exitCode: 0 });

Deno.test("gatherFacts parses a Fedora RISC-V board", async () => {
  const run = (command: string): Promise<CommandResult> => {
    if (command.startsWith("uname")) {
      return Promise.resolve(
        ok("Linux 6.16.4-200.spacemit.fc42.riscv64 riscv64"),
      );
    }
    if (command.startsWith("cat /etc/os-release")) {
      return Promise.resolve(
        ok('ID=fedora\nVERSION_ID=42\nNAME="Fedora Linux"'),
      );
    }
    if (command === "hostname") {
      return Promise.resolve(ok("host-01.example.test"));
    }
    if (command.startsWith("for b in")) {
      return Promise.resolve(ok("PM:dnf\nPM:yum"));
    }
    return Promise.resolve({ stdout: "", exitCode: 127 });
  };

  assertEquals(await gatherFacts(run), {
    hostname: "host-01.example.test",
    os: "fedora",
    osVersion: "42",
    arch: "riscv64",
    kernel: "6.16.4-200.spacemit.fc42.riscv64",
    packageManagers: ["dnf", "yum"],
  });
});

Deno.test("gatherFacts trims console residue trailing the hostname probe", async () => {
  // The first probe over a held/bracketed-paste shell can pick up a prompt tail
  // right after the value; the resource key is derived from hostname, so it must
  // survive that. `\n\n[fe` mimics a stripped-escape prompt fragment seen live.
  const run = (command: string): Promise<CommandResult> => {
    if (command === "hostname") {
      return Promise.resolve(ok("host-01.example.test\n\n[fe"));
    }
    return Promise.resolve(ok(""));
  };
  assertEquals((await gatherFacts(run)).hostname, "host-01.example.test");
});

Deno.test("gatherFacts falls back to unknowns when probes are empty", async () => {
  const run = (): Promise<CommandResult> => Promise.resolve(ok(""));
  const facts = await gatherFacts(run);
  assertEquals(facts.os, "unknown");
  assertEquals(facts.osVersion, "unknown");
  assertEquals(facts.arch, "unknown");
  assertEquals(facts.packageManagers, []);
});

/**
 * Unit tests for `@shrug/serial-cfgmgmt/package` — manager detection, package
 * queries, and install-command construction. Drives the logic against a scripted
 * fake session (regex-keyed lookup). NO device required.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_package_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { type CommandResult, type Session } from "./serial_cfgmgmt_lib.ts";
import {
  detectManager,
  installCommand,
  queryPackage,
} from "./serial_cfgmgmt_package.ts";

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
  assertEquals(
    installCommand("dnf", "htop; rm -rf /"),
    "dnf install -y htoprm-rf",
  );
});

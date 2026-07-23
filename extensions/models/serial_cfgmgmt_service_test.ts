/**
 * Unit tests for `@shrug/serial-cfgmgmt/service` — `queryService` active/enabled
 * parsing, including tolerance for the non-zero exits systemctl returns for
 * inactive/disabled units. Drives against a scripted fake session. NO device
 * required.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_service_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { type CommandResult, type Session } from "./serial_cfgmgmt_lib.ts";
import { queryService } from "./serial_cfgmgmt_service.ts";

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

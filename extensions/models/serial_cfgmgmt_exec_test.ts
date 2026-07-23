/**
 * Unit tests for `@shrug/serial-cfgmgmt/exec`.
 *
 * Covers `resourceKey` — the sanitizer that derives the resource instance name
 * from a command line. The command is attacker-influenced, so the key must stay
 * filesystem/instance-safe (no slashes, dots, or shell metacharacters) and
 * bounded in length. NO device required.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_exec_test.ts`
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { resourceKey } from "./serial_cfgmgmt_exec.ts";

Deno.test("resourceKey collapses metacharacters and separators to underscores", () => {
  assertEquals(
    resourceKey("systemctl restart sshd.service"),
    "systemctl_restart_sshd_service",
  );
  assertEquals(resourceKey("cat /etc/os-release"), "cat_etc_os_release");
});

Deno.test("resourceKey neutralizes a path-traversal / injection attempt", () => {
  // No '..' or '/' survives into the key — every non-word run becomes one '_'.
  assertEquals(resourceKey("../../etc/passwd; rm -rf /"), "_etc_passwd_rm_rf_");
});

Deno.test("resourceKey bounds the key at 60 characters", () => {
  const long = "echo " + "a".repeat(200);
  const key = resourceKey(long);
  assertEquals(key.length, 60);
  assertEquals(key, ("echo_" + "a".repeat(200)).slice(0, 60));
});

Deno.test("resourceKey handles the empty command without throwing", () => {
  assertEquals(resourceKey(""), "");
});

/**
 * Unit tests for `@shrug/serial-cfgmgmt/storage`. Every parser and planner is a
 * pure function of (command output | facts, args), so the whole collector +
 * provisioning-preview surface is exercised against canned fixtures with NO
 * hardware. Only the mutating tail (real mkfs/mount/send-receive) is live-only.
 *
 * Fixtures model a three-eMMC board (mmcblk0 boot / mmcblk1 root-btrfs with a
 * /var subvol / mmcblk2 empty spare) — the topology the storage feature targets,
 * with depersonalized hostname + serials.
 *
 * Run: `~/.swamp/deno/deno test extensions/models/serial_cfgmgmt_storage_test.ts`
 *
 * @module
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { type CommandResult, type Session } from "./serial_cfgmgmt_lib.ts";
import {
  assertSafe,
  b64encode,
  becomePrefix,
  buildFstabLine,
  collectStorage,
  confirmMatches,
  ConfirmDeviceSchema,
  deriveSnapshotPath,
  ensureNofail,
  findDevice,
  findDiskFor,
  identityMismatches,
  isEmpty,
  isMounted,
  mergeFstab,
  parseBtrfs,
  persistFstab,
  parseFindmnt,
  parseLsblk,
  partitionPath,
  planFormatMount,
  planRelocateSubvol,
  SAFE_LABEL_RE,
  SAFE_MKFS_ARGS_RE,
  SAFE_OPTS_RE,
  SAFE_PATH_RE,
  type StorageFacts,
} from "./serial_cfgmgmt_storage.ts";

// ————————————————————————————————————————————————————————————————
// Fixtures
// ————————————————————————————————————————————————————————————————

const LSBLK = JSON.stringify({
  blockdevices: [
    {
      name: "mmcblk0",
      path: "/dev/mmcblk0",
      size: 7818182656,
      type: "disk",
      tran: "",
      rota: "0",
      model: "eMMC-boot",
      serial: "0xaaaa0001",
      mountpoints: [null],
      children: [
        {
          name: "mmcblk0p1",
          path: "/dev/mmcblk0p1",
          size: 268435456,
          type: "part",
          fstype: "vfat",
          uuid: "AAAA-1111",
          mountpoints: ["/boot/efi"],
        },
      ],
    },
    {
      name: "mmcblk1",
      path: "/dev/mmcblk1",
      size: 31268536320,
      type: "disk",
      serial: "0xbbbb0002",
      model: "eMMC-root",
      mountpoints: [null],
      children: [
        {
          name: "mmcblk1p1",
          path: "/dev/mmcblk1p1",
          size: 31000000000,
          type: "part",
          fstype: "btrfs",
          uuid: "bbbbbbbb-2222-2222-2222-222222222222",
          label: "fedora",
          mountpoints: ["/", "/var", "/home"],
        },
      ],
    },
    {
      name: "mmcblk2",
      path: "/dev/mmcblk2",
      size: 15678832640,
      type: "disk",
      serial: "0xcccc0003",
      model: "eMMC-spare",
      mountpoints: [null],
      children: [],
    },
  ],
});

const FINDMNT = JSON.stringify({
  filesystems: [
    {
      target: "/",
      source: "/dev/mmcblk1p1",
      fstype: "btrfs",
      options: "rw,relatime,subvol=/root",
      size: 31000000000,
      used: 5000000000,
      avail: 26000000000,
      children: [
        {
          target: "/var",
          source: "/dev/mmcblk1p1[/var]",
          fstype: "btrfs",
          options: "rw,relatime,subvol=/var",
          size: 31000000000,
          used: 2000000000,
          avail: 26000000000,
        },
        {
          target: "/boot/efi",
          source: "/dev/mmcblk0p1",
          fstype: "vfat",
          options: "rw,relatime",
          size: 268435456,
          used: 10000000,
          avail: 258435456,
        },
      ],
    },
  ],
});

const BTRFS_SHOW =
  `Label: 'fedora'  uuid: bbbbbbbb-2222-2222-2222-222222222222\n` +
  `\tTotal devices 1 FS bytes used 7000000000\n` +
  `\tdevid    1 size 31000000000 used 8000000000 path /dev/mmcblk1p1\n`;

const BTRFS_SUBVOL =
  `ID 256 gen 30 top level 5 path root\n` +
  `ID 257 gen 42 top level 5 path var\n` +
  `ID 258 gen 12 top level 5 path home\n`;

/** A session that answers each command from a regex→result table. */
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
      return Promise.resolve({ stdout: "", exitCode: 0 });
    },
  };
}

const ok = (stdout: string): CommandResult => ({ stdout, exitCode: 0 });

const FULL_ROUTES: Array<[RegExp, CommandResult]> = [
  [/^hostname$/, ok("board-01")],
  [/lsblk/, ok(LSBLK)],
  [/findmnt/, ok(FINDMNT)],
  [/btrfs filesystem show/, ok(BTRFS_SHOW)],
  [/btrfs subvolume list/, ok(BTRFS_SUBVOL)],
];

// ————————————————————————————————————————————————————————————————
// Parsers
// ————————————————————————————————————————————————————————————————

Deno.test("parseLsblk maps the three-eMMC tree with bytes + serials", () => {
  const devs = parseLsblk(LSBLK);
  assertEquals(devs.map((d) => d.name), ["mmcblk0", "mmcblk1", "mmcblk2"]);
  const spare = devs[2];
  assertEquals(spare.sizeBytes, 15678832640);
  assertEquals(spare.serial, "0xcccc0003");
  assertEquals(spare.children.length, 0);
  const root = devs[1].children[0];
  assertEquals(root.fstype, "btrfs");
  assertEquals(root.mountpoints, ["/", "/var", "/home"]);
  assertEquals(devs[0].rota, false); // rota:"0" (string) coerced to false
});

Deno.test("parseLsblk coerces string sizes (old util-linux)", () => {
  const devs = parseLsblk(
    JSON.stringify({
      blockdevices: [{
        name: "sda",
        size: "1000",
        type: "disk",
        mountpoint: "/data",
      }],
    }),
  );
  assertEquals(devs[0].sizeBytes, 1000);
  assertEquals(devs[0].path, "/dev/sda"); // synthesised when absent
  assertEquals(devs[0].mountpoints, ["/data"]); // singular mountpoint form
});

Deno.test("parseLsblk survives trailing console noise after the JSON", () => {
  const devs = parseLsblk(LSBLK + "\n[  1234.5] printk: something\n[root@board-01 ~]# ");
  assertEquals(devs.length, 3);
});

Deno.test("parseLsblk returns [] on junk", () => {
  assertEquals(parseLsblk("no json here"), []);
  assertEquals(parseLsblk('{"blockdevices": not-json'), []);
});

Deno.test("parseFindmnt flattens the mount tree with byte columns", () => {
  const mounts = parseFindmnt(FINDMNT);
  assertEquals(mounts.map((m) => m.target), ["/", "/var", "/boot/efi"]);
  assertEquals(mounts[0].source, "/dev/mmcblk1p1");
  assertEquals(mounts[1].availBytes, 26000000000);
});

Deno.test("parseBtrfs parses fs + dedups subvols across per-mount lists", () => {
  // Same subvol list probed for both `/` and `/var` — must not duplicate.
  const fss = parseBtrfs(BTRFS_SHOW, [
    { mount: "/", stdout: BTRFS_SUBVOL },
    { mount: "/var", stdout: BTRFS_SUBVOL },
  ]);
  assertEquals(fss.length, 1);
  assertEquals(fss[0].uuid, "bbbbbbbb-2222-2222-2222-222222222222");
  assertEquals(fss[0].label, "fedora");
  assertEquals(fss[0].devices, ["/dev/mmcblk1p1"]);
  assertEquals(fss[0].subvolumes.map((s) => s.path).sort(), ["home", "root", "var"]);
});

Deno.test("parseBtrfs tolerates empty output (no btrfs)", () => {
  assertEquals(parseBtrfs("", []), []);
});

Deno.test("parseBtrfs attributes subvols to the right fs by device (multi-fs board)", () => {
  // The bpif3-004 shape: a boot btrfs + a separate nvme-var btrfs.
  const show =
    "Label: 'fedora'  uuid: aaaa-1\n\tTotal devices 1 FS bytes used 100\n" +
    "\tdevid    1 size 1000 used 500 path /dev/mmcblk0p3\n" +
    "Label: 'nvme-var'  uuid: bbbb-2\n\tTotal devices 1 FS bytes used 200\n" +
    "\tdevid    1 size 2000 used 800 path /dev/nvme0n1p1\n";
  const rootList = "ID 256 gen 5 top level 5 path root\nID 258 gen 6 top level 5 path home\n";
  const varList = "ID 257 gen 7 top level 5 path var\n";
  const fss = parseBtrfs(show, [
    { mount: "/", device: "/dev/mmcblk0p3", stdout: rootList },
    { mount: "/home", device: "/dev/mmcblk0p3", stdout: rootList },
    { mount: "/var", device: "/dev/nvme0n1p1", stdout: varList },
  ]);
  assertEquals(fss.length, 2);
  const fedora = fss.find((f) => f.label === "fedora")!;
  const nvme = fss.find((f) => f.label === "nvme-var")!;
  // subvols land on their OWN fs (not all dumped on the first one), deduped.
  assertEquals(fedora.subvolumes.map((s) => s.path).sort(), ["home", "root"]);
  assertEquals(nvme.subvolumes.map((s) => s.path), ["var"]);
});

// ————————————————————————————————————————————————————————————————
// Collector
// ————————————————————————————————————————————————————————————————

Deno.test("collectStorage assembles host + all facets over a session", async () => {
  const s = fakeSession(FULL_ROUTES);
  const facts = await collectStorage((c) => s.run(c));
  assertEquals(facts.host, "board-01");
  assertEquals(facts.blockDevices.length, 3);
  assertEquals(facts.mounts.length, 3);
  assertEquals(facts.btrfs.length, 1);
  assertEquals(facts.btrfs[0].subvolumes.length, 3);
});

Deno.test("collectStorage degrades btrfs facet when binary is missing", async () => {
  const s = fakeSession([
    [/^hostname$/, ok("board-01")],
    [/lsblk/, ok(LSBLK)],
    [/findmnt/, ok(FINDMNT)],
    [/btrfs/, { stdout: "sh: btrfs: command not found", exitCode: 127 }],
  ]);
  const facts = await collectStorage((c) => s.run(c));
  assertEquals(facts.btrfs, []); // no throw, empty facet
  assertEquals(facts.blockDevices.length, 3);
});

// ————————————————————————————————————————————————————————————————
// Device lookup + emptiness
// ————————————————————————————————————————————————————————————————

function facts(): StorageFacts {
  return {
    host: "board-01",
    blockDevices: parseLsblk(LSBLK),
    mounts: parseFindmnt(FINDMNT),
    btrfs: parseBtrfs(BTRFS_SHOW, [{ mount: "/", stdout: BTRFS_SUBVOL }]),
    gatheredAt: "",
  };
}

Deno.test("findDevice / isEmpty / isMounted", () => {
  const f = facts();
  const spare = findDevice(f.blockDevices, "/dev/mmcblk2")!;
  assert(isEmpty(spare));
  assert(!isMounted(spare));
  const root = findDevice(f.blockDevices, "/dev/mmcblk1")!;
  assert(!isEmpty(root)); // has a partition
  assert(isMounted(root)); // child mounted at /
  assertEquals(findDevice(f.blockDevices, "/dev/nope"), null);
});

// ————————————————————————————————————————————————————————————————
// confirmMatches — every refusal case
// ————————————————————————————————————————————————————————————————

Deno.test("confirmMatches accepts the empty spare on matching identity", () => {
  const spare = findDevice(facts().blockDevices, "/dev/mmcblk2");
  const r = confirmMatches(
    spare,
    { serial: "0xcccc0003", sizeBytes: 15678832640, empty: true },
    "/dev/mmcblk2",
  );
  assertEquals(r, { ok: true, reasons: [] });
});

Deno.test("confirmMatches refuses a missing device", () => {
  const r = confirmMatches(null, { serial: "x" }, "/dev/ghost");
  assert(!r.ok);
  assertStringIncludes(r.reasons[0], "not found");
});

Deno.test("confirmMatches refuses on serial / size mismatch", () => {
  const spare = findDevice(facts().blockDevices, "/dev/mmcblk2");
  const r = confirmMatches(spare, { serial: "WRONG", sizeBytes: 1 }, "/dev/mmcblk2");
  assert(!r.ok);
  assertEquals(r.reasons.length, 2);
});

Deno.test("confirmMatches refuses a non-empty device asserted empty", () => {
  const root = findDevice(facts().blockDevices, "/dev/mmcblk1");
  const r = confirmMatches(root, { empty: true }, "/dev/mmcblk1");
  assert(!r.ok);
  assert(r.reasons.some((x) => x.includes("not empty")));
});

Deno.test("confirmMatches always refuses a mounted device", () => {
  const root = findDevice(facts().blockDevices, "/dev/mmcblk1");
  const r = confirmMatches(root, {}, "/dev/mmcblk1"); // no fields asserted
  assert(!r.ok);
  assert(r.reasons.some((x) => x.includes("currently mounted")));
});

// ————————————————————————————————————————————————————————————————
// fstab helpers
// ————————————————————————————————————————————————————————————————

Deno.test("ensureNofail forces nofail + device-timeout, idempotently", () => {
  assertEquals(ensureNofail("defaults"), "defaults,nofail,x-systemd.device-timeout=30s");
  assertEquals(
    ensureNofail("defaults,nofail,x-systemd.device-timeout=30s"),
    "defaults,nofail,x-systemd.device-timeout=30s",
  );
});

Deno.test("buildFstabLine is UUID-keyed and nofail-forced", () => {
  const line = buildFstabLine({
    uuid: "dead-beef",
    mountpoint: "/mnt/scratch",
    fstype: "btrfs",
    options: "defaults",
  });
  assertEquals(line, "UUID=dead-beef /mnt/scratch btrfs defaults,nofail,x-systemd.device-timeout=30s 0 0");
});

Deno.test("mergeFstab replaces a stale entry for the same mountpoint (idempotent)", () => {
  const existing =
    "UUID=old /mnt/scratch btrfs defaults,nofail 0 0\n" +
    "UUID=keep / btrfs defaults 0 0\n";
  const line = buildFstabLine({ uuid: "new", mountpoint: "/mnt/scratch", fstype: "btrfs", options: "defaults" });
  const first = mergeFstab(existing, "/mnt/scratch", line);
  assertEquals(first.replaced, 1);
  assertStringIncludes(first.content, "UUID=keep / btrfs");
  assertStringIncludes(first.content, "UUID=new /mnt/scratch");
  assert(!first.content.includes("UUID=old"));
  // Re-applying the same line is a no-op-shaped single entry (still idempotent).
  const second = mergeFstab(first.content, "/mnt/scratch", line);
  assertEquals(second.replaced, 1);
  assertEquals(second.content.match(/\/mnt\/scratch/g)!.length, 1);
});

Deno.test("mergeFstab preserves comments and other mounts", () => {
  const existing = "# my fstab\nUUID=a /home ext4 defaults 0 0\n";
  const line = buildFstabLine({ uuid: "b", mountpoint: "/data", fstype: "btrfs", options: "defaults" });
  const r = mergeFstab(existing, "/data", line);
  assertEquals(r.replaced, 0);
  assertStringIncludes(r.content, "# my fstab");
  assertStringIncludes(r.content, "UUID=a /home");
});

// ————————————————————————————————————————————————————————————————
// partition path + planners
// ————————————————————————————————————————————————————————————————

Deno.test("partitionPath inserts p for mmcblk/nvme/loop, bare for sd", () => {
  assertEquals(partitionPath("/dev/mmcblk2"), "/dev/mmcblk2p1");
  assertEquals(partitionPath("/dev/nvme0n1"), "/dev/nvme0n1p1");
  assertEquals(partitionPath("/dev/sda"), "/dev/sda1");
});

Deno.test("planFormatMount previews wipe→partition→mkfs→fstab→mount, nofail-forced", () => {
  const plan = planFormatMount(facts(), {
    device: "/dev/mmcblk2",
    partition: true,
    fstype: "btrfs",
    label: "scratch",
    mountpoint: "/mnt/scratch",
    wipe: true,
  });
  assertEquals(plan.target, "/dev/mmcblk2p1");
  assertStringIncludes(plan.orderedCommands[0], "wipefs -a /dev/mmcblk2");
  assert(plan.orderedCommands.some((c) => c.includes("parted -s /dev/mmcblk2")));
  assert(plan.orderedCommands.some((c) => c.includes("mkfs.btrfs -L scratch /dev/mmcblk2p1")));
  assert(plan.orderedCommands.some((c) => c.includes("blkid -c /dev/null -s UUID")));
  assertStringIncludes(plan.fstabLine, "{{NEW_UUID}}");
  assertStringIncludes(plan.fstabLine, "nofail");
  // No mkfs before the guard is expressed — the plan never mutates on its own.
  assert(plan.orderedCommands.some((c) => c.startsWith("mount ")));
});

Deno.test("planFormatMount without partition formats the device directly", () => {
  const plan = planFormatMount(facts(), {
    device: "/dev/mmcblk2",
    partition: false,
    fstype: "ext4",
    mountpoint: "/mnt/x",
    wipe: false,
  });
  assertEquals(plan.target, "/dev/mmcblk2");
  assert(!plan.orderedCommands.some((c) => c.includes("wipefs")));
  assert(!plan.orderedCommands.some((c) => c.includes("parted")));
  assert(plan.orderedCommands.some((c) => c.includes("mkfs.ext4 /dev/mmcblk2")));
});

Deno.test("deriveSnapshotPath builds a sibling .swamp-reloc path", () => {
  assertEquals(deriveSnapshotPath("/var"), "/.swamp-reloc-var");
  assertEquals(deriveSnapshotPath("/srv/data"), "/srv/.swamp-reloc-data");
  assertEquals(deriveSnapshotPath("/var", "snap1"), "/.swamp-reloc-snap1");
  assertEquals(deriveSnapshotPath("/var", "/tmp/abs"), "/tmp/abs");
});

Deno.test("planRelocateSubvol is additive: snapshot→send|receive→verify, no delete", () => {
  const plan = planRelocateSubvol(facts(), {
    sourceSubvol: "/var",
    targetMount: "/mnt/newdisk",
    repoint: false,
  });
  const joined = plan.orderedCommands.join("\n");
  assertStringIncludes(joined, "btrfs subvolume snapshot -r /var /.swamp-reloc-var");
  assertStringIncludes(joined, "btrfs send /.swamp-reloc-var | btrfs receive /mnt/newdisk");
  assertStringIncludes(joined, "btrfs subvolume show");
  // The source is never deleted.
  assert(!joined.includes("subvolume delete"));
  assert(!joined.includes("rm -rf"));
  assertEquals(plan.fstabLine, null);
});

Deno.test("planRelocateSubvol repoint emits a nofail subvol fstab line", () => {
  const plan = planRelocateSubvol(facts(), {
    sourceSubvol: "/var",
    targetMount: "/mnt/newdisk",
    repoint: true,
    finalMountpoint: "/var",
  });
  assert(plan.fstabLine !== null);
  assertStringIncludes(plan.fstabLine!, "/var btrfs");
  assertStringIncludes(plan.fstabLine!, "subvol=.swamp-reloc-var");
  assertStringIncludes(plan.fstabLine!, "nofail");
});

Deno.test("planRelocateSubvol send|receive is pipefail-guarded", () => {
  const plan = planRelocateSubvol(facts(), {
    sourceSubvol: "/var",
    targetMount: "/mnt/newdisk",
    repoint: false,
  });
  assert(plan.orderedCommands.some((c) =>
    c.includes("set -o pipefail;") && c.includes("btrfs send") && c.includes("btrfs receive")
  ));
});

// ————————————————————————————————————————————————————————————————
// Review-fix regression tests (cycle 2)
// ————————————————————————————————————————————————————————————————

Deno.test("F1: b64encode round-trips fstab content (no heredoc write)", () => {
  const content = "UUID=x / btrfs defaults,nofail 0 0\n# tab\there\n";
  assertEquals(atob(b64encode(content)), content);
  // base64 alphabet only — safe to single-quote into a shell command.
  assert(/^[A-Za-z0-9+/=]+$/.test(b64encode(content)));
});

Deno.test("F2: confirmDevice needs a device-unique field; {} and {empty:*} alone are rejected", () => {
  assertEquals(ConfirmDeviceSchema.safeParse({}).success, false);
  // `empty` alone (true OR false) can't distinguish a device — rejected.
  assertEquals(ConfirmDeviceSchema.safeParse({ empty: true }).success, false);
  assertEquals(ConfirmDeviceSchema.safeParse({ empty: false }).success, false);
  // A device-unique field is required; empty may accompany it.
  assertEquals(ConfirmDeviceSchema.safeParse({ serial: "x" }).success, true);
  assertEquals(ConfirmDeviceSchema.safeParse({ sizeBytes: 1 }).success, true);
  assertEquals(ConfirmDeviceSchema.safeParse({ serial: "x", empty: true }).success, true);
});

Deno.test("F2: empty is a bidirectional assertion (empty:false must NOT be empty)", () => {
  const f = facts();
  const spare = findDevice(f.blockDevices, "/dev/mmcblk2")!; // empty
  const root = findDevice(f.blockDevices, "/dev/mmcblk1")!; // not empty
  // empty:false against a genuinely-empty device is now a REAL mismatch (was a
  // no-op that defeated verify-before-destroy).
  assert(identityMismatches(spare, { serial: "0xcccc0003", empty: false }, "/dev/mmcblk2").length > 0);
  // empty:false against a non-empty device agrees.
  assertEquals(
    identityMismatches(root, { serial: "0xbbbb0002", empty: false }, "/dev/mmcblk1"),
    [],
  );
});

Deno.test("F2: identityMismatches has NO mounted-refusal and matches on the DISK node", () => {
  const f = facts();
  const disk = findDevice(f.blockDevices, "/dev/mmcblk1")!; // mounted disk
  // A mounted disk with a matching serial passes identity (no mount refusal).
  assertEquals(identityMismatches(disk, { serial: "0xbbbb0002" }, "/dev/mmcblk1"), []);
  // The partition node carries no serial — matching the disk serial here fails,
  // which is exactly why relocate must resolve the parent disk.
  const part = findDevice(f.blockDevices, "/dev/mmcblk1p1")!;
  assert(identityMismatches(part, { serial: "0xbbbb0002" }, "/dev/mmcblk1p1").length > 0);
});

Deno.test("F2: findDiskFor resolves a partition (and [/subvol] suffix) to its disk", () => {
  const f = facts();
  assertEquals(findDiskFor(f.blockDevices, "/dev/mmcblk1p1")?.path, "/dev/mmcblk1");
  assertEquals(findDiskFor(f.blockDevices, "/dev/mmcblk1p1[/var]")?.path, "/dev/mmcblk1");
  assertEquals(findDiskFor(f.blockDevices, "/dev/nope"), null);
});

Deno.test("F3: a partitioned-but-unmounted disk is NOT empty (wipe=false would refuse)", () => {
  const [disk] = parseLsblk(JSON.stringify({
    blockdevices: [{
      name: "sdb",
      path: "/dev/sdb",
      size: 1000,
      type: "disk",
      serial: "S1",
      mountpoints: [null],
      children: [{
        name: "sdb1",
        path: "/dev/sdb1",
        size: 900,
        type: "part",
        fstype: "ext4", // has data, but not mounted
        mountpoints: [null],
      }],
    }],
  }));
  assert(!isMounted(disk)); // nothing mounted
  assert(!isEmpty(disk)); // ...but not empty — the fix keys on this, not disk.fstype
});

Deno.test("F4: assertSafe blocks shell metacharacters; SAFE_* regexes are strict", () => {
  assertThrows(() => assertSafe("/mnt/x; rm -rf /", SAFE_PATH_RE, "mountpoint"));
  assertThrows(() => assertSafe("/mnt/$(id)", SAFE_PATH_RE, "mountpoint"));
  assertThrows(() => assertSafe("/mnt/a b", SAFE_PATH_RE, "mountpoint")); // whitespace
  assertThrows(() => assertSafe("a`b`", SAFE_LABEL_RE, "label"));
  // leading-dash flag injection is rejected (e.g. `--reference=/etc/shadow`).
  assertThrows(() => assertSafe("--reference=/etc/shadow", SAFE_PATH_RE, "device"));
  assertThrows(() => assertSafe("-rf", SAFE_PATH_RE, "mountpoint"));
  assertThrows(() => assertSafe("--help", SAFE_LABEL_RE, "label"));
  assert(!SAFE_OPTS_RE.test("-o"));
  // clean values pass
  assertSafe("/dev/mmcblk2", SAFE_PATH_RE, "device");
  assertSafe("scratch", SAFE_LABEL_RE, "label");
  assertSafe("defaults,nofail,x-systemd.device-timeout=30s", SAFE_OPTS_RE, "opts");
  assert(!SAFE_OPTS_RE.test("defaults;evil"));
  assertSafe("", SAFE_OPTS_RE, "opts"); // empty opts still allowed
  // mkfsArgs must allow LEADING-dash flags (real mkfs options) but no metachars.
  assertSafe("-b 4096", SAFE_MKFS_ARGS_RE, "mkfsArgs");
  assertSafe("-O extref -m dup", SAFE_MKFS_ARGS_RE, "mkfsArgs");
  assertThrows(() => assertSafe("-b 4096; rm -rf /", SAFE_MKFS_ARGS_RE, "mkfsArgs"));
  assert(!SAFE_MKFS_ARGS_RE.test("$(evil)"));
});

Deno.test("F8: mergeFstab treats /mnt/x and /mnt/x/ as the same mountpoint", () => {
  const existing = "UUID=old /mnt/x/ btrfs defaults 0 0\n";
  const line = buildFstabLine({ uuid: "new", mountpoint: "/mnt/x", fstype: "btrfs", options: "defaults" });
  const r = mergeFstab(existing, "/mnt/x", line);
  assertEquals(r.replaced, 1); // trailing-slash variant is matched + replaced
  assert(!r.content.includes("UUID=old"));
});

Deno.test("F11: extractJson skips a leading stray brace in console residue", () => {
  const noisy = "[root@board-01 ~]# lsblk -J\n{stray prompt brace}\n" + LSBLK;
  const devs = parseLsblk(noisy);
  assertEquals(devs.length, 3); // finds the real payload past the junk brace group
});

Deno.test("F11: extractJson skips a stray VALID-but-wrong object (requireKey)", () => {
  // A valid `{}` in residue must not shadow the real lsblk payload.
  const noisy = 'echo {}\n{}\n' + LSBLK;
  assertEquals(parseLsblk(noisy).length, 3);
});

// ————————————————————————————————————————————————————————————————
// become (privilege escalation) — surfaced by live proof on bpif3-004
// ————————————————————————————————————————————————————————————————

Deno.test("becomePrefix: off is empty, sudo is non-interactive, doas is doas", () => {
  assertEquals(becomePrefix(false, "sudo"), "");
  assertEquals(becomePrefix(true, "sudo"), "sudo -n ");
  assertEquals(becomePrefix(true, "doas"), "doas ");
});

Deno.test("become: planners prefix privileged commands (btrfs/mkfs/wipefs/find/du)", () => {
  const fm = planFormatMount(facts(), {
    device: "/dev/mmcblk2",
    partition: true,
    fstype: "btrfs",
    mountpoint: "/mnt/scratch",
    wipe: true,
  }, "sudo -n ");
  assert(fm.orderedCommands.some((c) => c.startsWith("sudo -n wipefs")));
  assert(fm.orderedCommands.some((c) => c.startsWith("sudo -n parted")));
  assert(fm.orderedCommands.some((c) => c.startsWith("sudo -n mkfs.btrfs")));
  assert(fm.orderedCommands.some((c) => c.startsWith("sudo -n blkid")));
  assert(fm.orderedCommands.some((c) => c.startsWith("sudo -n mount ")));

  const rel = planRelocateSubvol(facts(), {
    sourceSubvol: "/var",
    targetMount: "/mnt/newdisk",
    repoint: false,
  }, "sudo -n ");
  // both pipeline stages escalated, inside the pipefail subshell
  assert(rel.orderedCommands.some((c) =>
    c.includes("( set -o pipefail; sudo -n btrfs send") && c.includes("| sudo -n btrfs receive")
  ));
  assert(rel.orderedCommands.some((c) => c.startsWith("sudo -n btrfs subvolume snapshot")));
  assert(rel.orderedCommands.some((c) => c.startsWith("sudo -n find")));
  assert(rel.orderedCommands.some((c) => c.startsWith("sudo -n du")));
});

Deno.test("become: collectStorage escalates the btrfs probes only", async () => {
  const s = fakeSession(FULL_ROUTES);
  await collectStorage((c) => s.run(c), "sudo -n ");
  // btrfs probes carry the prefix; lsblk/findmnt do not (work unprivileged).
  assert(s.calls.some((c) => c.startsWith("sudo -n btrfs filesystem show")));
  assert(s.calls.some((c) => c.startsWith("sudo -n btrfs subvolume list")));
  assert(s.calls.some((c) => c.startsWith("lsblk")));
  assert(!s.calls.some((c) => c.startsWith("sudo -n lsblk")));
});

Deno.test("become: persistFstab writes via `sudo -n tee` (privileged file write)", async () => {
  const s = fakeSession([
    [/cat \/etc\/fstab$/, ok("UUID=keep / btrfs defaults 0 0\n")],
    [/cp -a \/etc\/fstab/, ok("")],
    [/tee \/etc\/fstab/, ok("")],
  ]);
  const line = buildFstabLine({ uuid: "u", mountpoint: "/mnt/x", fstype: "btrfs", options: "defaults" });
  await persistFstab(s, "/mnt/x", line, "sudo -n ");
  assert(s.calls.some((c) => c.startsWith("sudo -n cat /etc/fstab")));
  assert(s.calls.some((c) => c.startsWith("sudo -n cp -a /etc/fstab")));
  assert(s.calls.some((c) => c.includes("| sudo -n tee /etc/fstab > /dev/null")));
  assert(s.calls.some((c) => c.includes("base64 -d"))); // decode still happens
});

Deno.test("F1: persistFstab writes via base64 (no heredoc) and reports rc failure", async () => {
  const routes: Array<[RegExp, CommandResult]> = [
    [/^cat \/etc\/fstab$/, ok("UUID=keep / btrfs defaults 0 0\n")],
    [/^cp -a \/etc\/fstab \/etc\/fstab\.swamp-bak\./, ok("")],
    [/tee \/etc\/fstab/, ok("")],
  ];
  const s = fakeSession(routes);
  const line = buildFstabLine({ uuid: "u", mountpoint: "/mnt/x", fstype: "btrfs", options: "defaults" });
  const r = await persistFstab(s, "/mnt/x", line);
  assertEquals(r.replaced, 0);
  assertStringIncludes(r.backup, "/etc/fstab.swamp-bak.");
  // The write is a single base64 pipeline — NO heredoc delimiter to break.
  const write = s.calls.find((c) => c.includes("tee /etc/fstab"))!;
  assertStringIncludes(write, "printf '%s' '");
  assertStringIncludes(write, "base64 -d");
  assert(!s.calls.some((c) => c.includes("<<")));
  // A nonzero write rc must throw (not silently leave fstab wrong).
  const bad = fakeSession([
    [/^cat \/etc\/fstab$/, ok("")],
    [/^cp -a/, ok("")],
    [/tee \/etc\/fstab/, { stdout: "no space", exitCode: 1 }],
  ]);
  let threw = false;
  try {
    await persistFstab(bad, "/mnt/x", line);
  } catch {
    threw = true;
  }
  assert(threw);
});

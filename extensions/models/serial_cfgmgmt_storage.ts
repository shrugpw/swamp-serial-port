/**
 * `@shrug/serial-cfgmgmt/storage` — inspect and provision block storage over the
 * serial console. The disk counterpart to `node/gather`: a read-only collector
 * (`disks` → the `storage` resource) plus two verify-before-destroy provisioners
 * (`format_mount`, `relocate_subvol`) that replace the ad-hoc `exec` sequences
 * previously used to lay out disks on a network-less board.
 *
 * Built purely on the family's session/exec lib (`withSession` / `session.run`
 * → `{ stdout, exitCode }`) — every probe and every mutation is a shell command
 * run on the target over the console; nothing shells out from the host.
 *
 * Safety contract for the two mutating methods (design/serial-storage.md §4):
 *   - `dryRun=true` is the DEFAULT — a dry run re-collects the target's facts,
 *     builds the exact ordered command plan (+ fstab line), writes the `plan`
 *     resource, and executes NOTHING.
 *   - A live run (`dryRun=false`) requires a `confirmDevice` block; the method
 *     re-collects topology and refuses unless the live target matches it (stable
 *     serial/model/size, emptiness) and is not currently mounted — the in-code
 *     counterpart to CLAUDE.md rule 5 and the factory's human-approval gate.
 *   - Every persisted fstab line is UUID-keyed and carries `nofail`, so a
 *     missing/renamed device degrades to a skipped mount, never a wedged boot.
 *     fstab edits are idempotent (replace, never duplicate) and back up first.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  ConnectionGlobals,
  type Ctx,
  type Session,
  withSession,
} from "./serial_cfgmgmt_lib.ts";
import { deviceAllowlistCheck } from "./serial_port.ts";

// ————————————————————————————————————————————————————————————————
// Schemas / types
// ————————————————————————————————————————————————————————————————

/** One node of the lsblk device tree (a disk or a partition), sizes in bytes. */
export interface BlockDevice {
  name: string;
  path: string;
  sizeBytes: number | null;
  type: string;
  tran?: string;
  rota?: boolean;
  model?: string;
  serial?: string;
  fstype?: string;
  uuid?: string;
  partuuid?: string;
  label?: string;
  mountpoints: string[];
  children: BlockDevice[];
}

const BlockDeviceSchema: z.ZodType<BlockDevice> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    sizeBytes: z.number().nullable(),
    type: z.string(),
    tran: z.string().optional(),
    rota: z.boolean().optional(),
    model: z.string().optional(),
    serial: z.string().optional(),
    fstype: z.string().optional(),
    uuid: z.string().optional(),
    partuuid: z.string().optional(),
    label: z.string().optional(),
    mountpoints: z.array(z.string()),
    children: z.array(BlockDeviceSchema),
  })
);

const MountSchema = z.object({
  target: z.string(),
  source: z.string(),
  fstype: z.string(),
  options: z.string(),
  sizeBytes: z.number().nullable().optional(),
  usedBytes: z.number().nullable().optional(),
  availBytes: z.number().nullable().optional(),
});

const BtrfsSchema = z.object({
  uuid: z.string(),
  label: z.string().optional(),
  devices: z.array(z.string()),
  subvolumes: z.array(z.object({
    id: z.number(),
    parentId: z.number().optional(),
    path: z.string(),
  })),
});

const StorageSchema = z.object({
  host: z.string(),
  blockDevices: z.array(BlockDeviceSchema),
  mounts: z.array(MountSchema),
  btrfs: z.array(BtrfsSchema),
  gatheredAt: z.string(),
});

export type StorageFacts = z.infer<typeof StorageSchema>;
export type Mount = z.infer<typeof MountSchema>;
export type BtrfsFs = z.infer<typeof BtrfsSchema>;

/** Preview product of a mutating method (written as the `plan` resource). */
const PlanSchema = z.object({
  method: z.string(),
  dryRun: z.literal(true),
  orderedCommands: z.array(z.string()),
  fstabLine: z.string().nullable(),
  resolvedTarget: z.record(z.string(), z.unknown()).nullable(),
  notes: z.array(z.string()),
});

const MountResultSchema = z.object({
  method: z.string(),
  mountpoint: z.string().nullable(),
  source: z.string().nullable(),
  uuid: z.string().nullable(),
  fstype: z.string().nullable(),
  options: z.string().nullable(),
  verifiedAt: z.string(),
  details: z.record(z.string(), z.unknown()),
});

/**
 * Expected identity of a target device, asserted before any live write. Must
 * carry at least one device-**unique** field (serial/model/sizeBytes): `empty`
 * alone can't distinguish two different empty devices, and a bare `{}` (or a
 * no-op `{ empty: false }`) would confirm nothing — all are rejected rather than
 * silently letting a live write through unverified.
 */
export const ConfirmDeviceSchema = z.object({
  serial: z.string().optional(),
  model: z.string().optional(),
  sizeBytes: z.number().optional(),
  empty: z.boolean().optional(),
}).refine(
  (o) => o.serial !== undefined || o.model !== undefined || o.sizeBytes !== undefined,
  {
    message:
      "confirmDevice must assert at least one device-unique field " +
      "(serial, model, or sizeBytes) — `empty` alone cannot distinguish which " +
      "physical device you are touching, and would defeat verify-before-destroy.",
  },
);
export type ConfirmDevice = z.infer<typeof ConfirmDeviceSchema>;

/**
 * Shell-safety guards for values interpolated into commands run as root on the
 * target. A plain path/label has no shell metacharacters or whitespace; mount
 * options / mkfs args allow a slightly wider set but still no shell control
 * characters. These are enforced both at the zod schema layer (early, friendly
 * error) and again in-method as a hard backstop.
 */
// The leading char must not be `-`, so a value can't smuggle an extra flag into
// a command where it's a bare positional argument (e.g. `--reference=/etc/shadow`).
export const SAFE_PATH_RE = /^[A-Za-z0-9._@:+/=][A-Za-z0-9._@:+/=-]*$/;
export const SAFE_LABEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
/** fstab options: space/comma allowed, no shell control chars, no leading `-`. */
export const SAFE_OPTS_RE = /^(?:[A-Za-z0-9._@:+/=,][A-Za-z0-9._@:+/=, -]*)?$/;
/**
 * mkfs args: same character set but a LEADING dash IS allowed — real mkfs flags
 * (`-b 4096`, `-O extref`, `-U <uuid>`) start with one, and this value is never
 * the first positional token of its command (`mkfs.<fstype> [-L label] <args>
 * <target>`), so a leading dash can't smuggle a flag into a different position.
 * Still no shell metacharacters, so no command injection.
 */
export const SAFE_MKFS_ARGS_RE = /^[A-Za-z0-9._@:+/=, -]*$/;

/** Privilege-escalation methods for `become` (the login user is unprivileged). */
export type BecomeMethod = "sudo" | "doas";

/**
 * Command prefix that escalates privilege when `become` is set. `sudo -n` is
 * non-interactive (fails fast rather than hanging on a password prompt over the
 * console); `doas` is non-interactive by configuration. Empty when `become` is
 * false (the session is already privileged, e.g. a root console).
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

/** Throw unless `value` matches `re`; used as an in-method backstop. */
export function assertSafe(value: string, re: RegExp, kind: string): void {
  if (!re.test(value)) {
    throw new Error(
      `refusing ${kind} "${value}": contains characters that are not allowed ` +
        `in a value interpolated into a root shell command (shell metacharacters ` +
        `or whitespace). This guards against command injection.`,
    );
  }
}

/** Find the top-level disk whose subtree contains `path` (or IS `path`). */
export function findDiskFor(
  devices: BlockDevice[],
  path: string,
): BlockDevice | null {
  // Strip a findmnt `[/subvol]` suffix, e.g. /dev/mmcblk1p1[/var] → /dev/mmcblk1p1.
  const clean = path.replace(/\[.*$/, "");
  for (const disk of devices) {
    if (findDevice([disk], clean)) return disk;
  }
  return null;
}

// ————————————————————————————————————————————————————————————————
// Pure parsers — fixture-testable, no port
// ————————————————————————————————————————————————————————————————

/** Coerce lsblk's size/`-b` field (number on new util-linux, string on old). */
function toBytes(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && /^\d+$/.test(v.trim())) {
    return Number(v.trim());
  }
  return null;
}

/** Normalise lsblk's mountpoint(s): array (new) or singular string (old). */
function toMountpoints(node: Record<string, unknown>): string[] {
  const mps = node["mountpoints"];
  if (Array.isArray(mps)) {
    return mps.filter((m): m is string => typeof m === "string" && m !== "");
  }
  const mp = node["mountpoint"];
  return typeof mp === "string" && mp !== "" ? [mp] : [];
}

function mapBlockNode(node: Record<string, unknown>): BlockDevice {
  const name = String(node["name"] ?? "");
  const path = typeof node["path"] === "string" && node["path"]
    ? node["path"] as string
    : `/dev/${name}`;
  const str = (k: string): string | undefined => {
    const v = node[k];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const rotaRaw = node["rota"];
  const children = Array.isArray(node["children"])
    ? (node["children"] as Record<string, unknown>[]).map(mapBlockNode)
    : [];
  return {
    name,
    path,
    sizeBytes: toBytes(node["size"]),
    type: String(node["type"] ?? "unknown"),
    tran: str("tran"),
    rota: rotaRaw === true || rotaRaw === "1" || rotaRaw === 1
      ? true
      : rotaRaw === false || rotaRaw === "0" || rotaRaw === 0
      ? false
      : undefined,
    model: str("model"),
    serial: str("serial"),
    fstype: str("fstype"),
    uuid: str("uuid"),
    partuuid: str("partuuid"),
    label: str("label"),
    mountpoints: toMountpoints(node),
    children,
  };
}

/** Parse `lsblk -J -O -b` JSON into the block-device tree. Tolerates junk. */
export function parseLsblk(raw: string): BlockDevice[] {
  const json = extractJson(raw, "blockdevices");
  if (!json || !Array.isArray(json["blockdevices"])) return [];
  return (json["blockdevices"] as Record<string, unknown>[]).map(mapBlockNode);
}

/** Parse `findmnt --real -J -b …` JSON into a flat mount list. */
export function parseFindmnt(raw: string): Mount[] {
  const json = extractJson(raw, "filesystems");
  if (!json || !Array.isArray(json["filesystems"])) return [];
  const out: Mount[] = [];
  const walk = (n: Record<string, unknown>) => {
    if (typeof n["target"] === "string") {
      out.push({
        target: n["target"] as string,
        source: String(n["source"] ?? ""),
        fstype: String(n["fstype"] ?? ""),
        options: String(n["options"] ?? ""),
        sizeBytes: toBytes(n["size"]),
        usedBytes: toBytes(n["used"]),
        availBytes: toBytes(n["avail"]),
      });
    }
    if (Array.isArray(n["children"])) {
      for (const c of n["children"] as Record<string, unknown>[]) walk(c);
    }
  };
  for (const fs of json["filesystems"] as Record<string, unknown>[]) walk(fs);
  return out;
}

/** Parse the subvolumes out of one `btrfs subvolume list` stdout. */
function parseSubvolLines(
  stdout: string,
): Array<{ id: number; parentId?: number; path: string }> {
  const out: Array<{ id: number; parentId?: number; path: string }> = [];
  for (const l of stdout.split("\n")) {
    const m = l.match(/^ID\s+(\d+)\s+gen\s+\d+\s+top level\s+(\d+)\s+path\s+(.+)$/);
    if (m) out.push({ id: Number(m[1]), parentId: Number(m[2]), path: m[3].trim() });
  }
  return out;
}

/**
 * Parse `btrfs filesystem show --raw` + per-mount `btrfs subvolume list -o`
 * output into the btrfs facet. Each `subvolLists` entry carries the mount's
 * backing `device` so subvolumes are attributed to the right filesystem when a
 * board has more than one btrfs (e.g. a boot fs plus a data fs) — the list
 * output alone doesn't name its fs. Best-effort: unparseable lines are skipped.
 */
export function parseBtrfs(
  showRaw: string,
  subvolLists: Array<{ mount: string; device?: string; stdout: string }>,
): BtrfsFs[] {
  const fss: BtrfsFs[] = [];
  let cur: BtrfsFs | null = null;
  for (const line of showRaw.split("\n")) {
    const label = line.match(/^Label:\s+(?:'([^']*)'|none)\s+uuid:\s+(\S+)/i);
    if (label) {
      cur = {
        uuid: label[2],
        label: label[1] || undefined,
        devices: [],
        subvolumes: [],
      };
      fss.push(cur);
      continue;
    }
    const dev = line.match(/^\s*devid\s+\d+.*\bpath\s+(\S+)/);
    if (dev && cur) cur.devices.push(dev[1]);
  }
  // Attribute each subvol list to its filesystem by matching the mount's backing
  // device to the fs's member devices. Dedup by id within a fs (the same subvol
  // shows up in the list for every mount of that fs, e.g. `/` and `/home`).
  for (const fs of fss) {
    const byId = new Map<number, { id: number; parentId?: number; path: string }>();
    for (const entry of subvolLists) {
      // Match by device; if no device was supplied and there's exactly one fs,
      // fall back to attaching (single-fs boards / callers without a device).
      const belongs = entry.device
        ? fs.devices.includes(entry.device)
        : fss.length === 1;
      if (!belongs) continue;
      for (const sv of parseSubvolLines(entry.stdout)) {
        if (!byId.has(sv.id)) byId.set(sv.id, sv);
      }
    }
    fs.subvolumes = [...byId.values()];
  }
  return fss;
}

/**
 * Pull the first well-formed top-level JSON object out of noisy console text.
 * Scans for the matching closing brace so trailing prompt/printk noise after the
 * JSON can't defeat the parse; and if a `{` turns out to start non-JSON (e.g. a
 * stray brace in a prompt/printk line before the real payload), advances to the
 * next `{` and retries rather than giving up.
 */
function extractJson(
  raw: string,
  requireKey?: string,
): Record<string, unknown> | null {
  let from = raw.indexOf("{");
  while (from >= 0) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = from; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end >= 0) {
      try {
        const obj = JSON.parse(raw.slice(from, end + 1)) as Record<string, unknown>;
        // Skip a stray but valid object (e.g. `{}` in prompt residue) that
        // lacks the payload key the caller expects — keep scanning for the real
        // one rather than degrading the facet to empty.
        if (!requireKey || requireKey in obj) return obj;
      } catch {
        // This brace group wasn't valid JSON — try the next `{`.
      }
    }
    from = raw.indexOf("{", from + 1);
  }
  return null;
}

// ————————————————————————————————————————————————————————————————
// Pure helpers — device lookup, fstab, planners, guard
// ————————————————————————————————————————————————————————————————

/** Depth-first find of a device by its path anywhere in the tree. */
export function findDevice(
  devices: BlockDevice[],
  path: string,
): BlockDevice | null {
  for (const d of devices) {
    if (d.path === path) return d;
    const hit = findDevice(d.children, path);
    if (hit) return hit;
  }
  return null;
}

/** A device is mounted if it or any descendant carries a mountpoint. */
export function isMounted(dev: BlockDevice): boolean {
  return dev.mountpoints.length > 0 || dev.children.some(isMounted);
}

/** Empty = no filesystem, no partitions, nothing mounted (safe to format). */
export function isEmpty(dev: BlockDevice): boolean {
  return !dev.fstype && dev.children.length === 0 && !isMounted(dev);
}

/**
 * Identity-only comparison of a live device against `confirmDevice` (stable
 * serial/model/size, and optional emptiness). Returns every failing reason. Does
 * NOT include the mounted-device refusal — that is a separate precondition,
 * because `relocate_subvol` legitimately targets a *mounted* filesystem while
 * `format_mount` must refuse one.
 */
export function identityMismatches(
  dev: BlockDevice | null,
  confirm: ConfirmDevice,
  targetPath: string,
): string[] {
  if (!dev) return [`target device "${targetPath}" not found in live topology`];
  const reasons: string[] = [];
  if (confirm.serial != null && dev.serial !== confirm.serial) {
    reasons.push(
      `serial mismatch: confirmDevice=${confirm.serial} live=${dev.serial ?? "(none)"}`,
    );
  }
  if (confirm.model != null && dev.model !== confirm.model) {
    reasons.push(
      `model mismatch: confirmDevice=${confirm.model} live=${dev.model ?? "(none)"}`,
    );
  }
  if (confirm.sizeBytes != null && dev.sizeBytes !== confirm.sizeBytes) {
    reasons.push(
      `size mismatch: confirmDevice=${confirm.sizeBytes} live=${dev.sizeBytes ?? "(unknown)"}`,
    );
  }
  // `empty` is a real bidirectional assertion: empty:true must be empty,
  // empty:false must NOT be empty. (Treating false as a no-op would let
  // `{ empty: false }` pass while asserting nothing.)
  if (confirm.empty != null && confirm.empty !== isEmpty(dev)) {
    reasons.push(
      `emptiness mismatch: confirmDevice.empty=${confirm.empty} but live device ${
        isEmpty(dev) ? "is empty" : "is not empty"
      }`,
    );
  }
  return reasons;
}

/**
 * `format_mount`'s guard: identity match AND a hard refusal to touch a mounted
 * device (never format a live filesystem). Returns every failing reason.
 */
export function confirmMatches(
  dev: BlockDevice | null,
  confirm: ConfirmDevice,
  targetPath: string,
): { ok: boolean; reasons: string[] } {
  const reasons = identityMismatches(dev, confirm, targetPath);
  if (dev && isMounted(dev)) {
    reasons.push(
      `device "${targetPath}" (or a partition of it) is currently mounted — refusing to format a live filesystem`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/** Force `nofail` + a bounded device timeout into a mount-options string. */
export function ensureNofail(options: string): string {
  const parts = options.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.includes("nofail")) parts.push("nofail");
  if (!parts.some((p) => p.startsWith("x-systemd.device-timeout"))) {
    parts.push("x-systemd.device-timeout=30s");
  }
  return parts.join(",");
}

/** Build a UUID-keyed, nofail-forced fstab line. */
export function buildFstabLine(o: {
  uuid: string;
  mountpoint: string;
  fstype: string;
  options: string;
}): string {
  return `UUID=${o.uuid} ${o.mountpoint} ${o.fstype} ${
    ensureNofail(o.options)
  } 0 0`;
}

/**
 * Idempotently merge a new fstab line: drop any existing non-comment entry for
 * the same mountpoint (2nd field), then append the new line. Returns the new
 * content plus how many stale lines were replaced.
 */
export function mergeFstab(
  existing: string,
  mountpoint: string,
  newLine: string,
): { content: string; replaced: number } {
  // Normalise a trailing slash (except for root "/") so "/mnt/x" and "/mnt/x/"
  // are treated as the same mountpoint and never accrue duplicate entries.
  const norm = (m: string) => (m.length > 1 ? m.replace(/\/+$/, "") : m);
  const target = norm(mountpoint);
  const lines = existing.replace(/\n+$/, "").split("\n");
  const kept: string[] = [];
  let replaced = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const fields = trimmed.split(/\s+/);
      if (fields[1] !== undefined && norm(fields[1]) === target) {
        replaced++;
        continue;
      }
    }
    kept.push(line);
  }
  kept.push(newLine);
  return { content: kept.join("\n") + "\n", replaced };
}

/** Device node for partition N of `device` (mmcblk/nvme/loop need a `p`). */
export function partitionPath(device: string, n = 1): string {
  const base = device.replace(/^\/dev\//, "");
  return `${device}${/[0-9]$/.test(base) ? "p" : ""}${n}`;
}

export interface FormatMountArgs {
  device: string;
  partition: boolean;
  fstype: string;
  label?: string;
  mkfsArgs?: string;
  mountpoint: string;
  fstabOptions?: string;
  wipe: boolean;
}

/**
 * Pure preview of `format_mount`: the ordered shell commands and the fstab line.
 * The new filesystem's UUID isn't known until mkfs runs, so the fstab step uses
 * the `{{NEW_UUID}}` token (the live executor substitutes the UUID it reads back
 * with `blkid`). This is a faithful preview of what the live path does; the two
 * are kept in step by tests asserting the plan's contents — not by the executor
 * literally replaying this array (the UUID/fstab-merge steps aren't plain
 * commands), so treat it as an audit preview, not a byte-for-byte script.
 */
export function planFormatMount(
  _facts: StorageFacts,
  args: FormatMountArgs,
  bp = "",
): { orderedCommands: string[]; fstabLine: string; target: string } {
  const target = args.partition
    ? partitionPath(args.device)
    : args.device;
  const cmds: string[] = [];
  if (args.wipe) cmds.push(`${bp}wipefs -a ${args.device}`);
  if (args.partition) {
    cmds.push(
      `${bp}parted -s ${args.device} mklabel gpt mkpart primary 0% 100%`,
    );
  }
  const mkfs = [`${bp}mkfs.${args.fstype}`];
  if (args.label) mkfs.push(`-L ${args.label}`);
  if (args.mkfsArgs) mkfs.push(args.mkfsArgs);
  mkfs.push(target);
  cmds.push(mkfs.join(" "));
  // `-c /dev/null` bypasses the blkid cache so a reformat never reads a stale
  // (previous-filesystem) UUID and writes it into fstab.
  cmds.push(`${bp}blkid -c /dev/null -s UUID -o value ${target}`);
  cmds.push(`${bp}mkdir -p ${args.mountpoint}`);
  const fstabLine = buildFstabLine({
    uuid: "{{NEW_UUID}}",
    mountpoint: args.mountpoint,
    fstype: args.fstype,
    options: args.fstabOptions ?? "defaults",
  });
  cmds.push(
    `# back up /etc/fstab (timestamped), then idempotently add via base64: ${fstabLine}`,
  );
  cmds.push(`${bp}mount ${args.mountpoint}`);
  cmds.push(`${bp}findmnt --real -n ${args.mountpoint}`);
  return { orderedCommands: cmds, fstabLine, target };
}

export interface RelocateArgs {
  sourceSubvol: string;
  targetMount: string;
  snapshotName?: string;
  repoint: boolean;
  finalMountpoint?: string;
}

/** Snapshot destination for a subvol relocation (sibling `.swamp-reloc-*`). */
export function deriveSnapshotPath(
  sourceSubvol: string,
  snapshotName?: string,
): string {
  const clean = sourceSubvol.replace(/\/+$/, "");
  const base = clean.slice(clean.lastIndexOf("/") + 1) || "root";
  const dir = clean.slice(0, clean.lastIndexOf("/")) || "";
  return snapshotName && snapshotName.startsWith("/")
    ? snapshotName
    : `${dir}/.swamp-reloc-${snapshotName ?? base}`;
}

/**
 * Pure preview of `relocate_subvol`. Additive: it snapshots + sends the source,
 * verifies the received copy, and (optionally) repoints fstab — it NEVER deletes
 * the source, so a bad reboot rolls back by reverting one fstab line. The target
 * filesystem UUID is taken from the collected facts for the fstab repoint.
 */
export function planRelocateSubvol(
  facts: StorageFacts,
  args: RelocateArgs,
  bp = "",
): { orderedCommands: string[]; fstabLine: string | null; snapPath: string } {
  const snapPath = deriveSnapshotPath(args.sourceSubvol, args.snapshotName);
  const snapBase = snapPath.slice(snapPath.lastIndexOf("/") + 1);
  const received = `${args.targetMount.replace(/\/+$/, "")}/${snapBase}`;
  const cmds = [
    `${bp}btrfs subvolume snapshot -r ${args.sourceSubvol} ${snapPath}`,
    `sync`,
    // pipefail so a failing `send` isn't masked by a succeeding `receive`
    // (bash `$?` is the last stage's status without it). Scoped to a SUBSHELL so
    // it doesn't persist into later commands of the held session shell. Each
    // stage is privilege-escalated independently.
    `( set -o pipefail; ${bp}btrfs send ${snapPath} | ${bp}btrfs receive ${args.targetMount} )`,
    `${bp}btrfs subvolume show ${snapPath}`,
    `${bp}btrfs subvolume show ${received}`,
    `${bp}find ${snapPath} -xdev | wc -l`,
    `${bp}find ${received} -xdev | wc -l`,
    `${bp}du -sb ${snapPath} | cut -f1`,
    `${bp}du -sb ${received} | cut -f1`,
  ];
  let fstabLine: string | null = null;
  if (args.repoint) {
    const targetMount = facts.mounts.find((m) => m.target === args.targetMount);
    const targetSource = targetMount?.source ?? `${args.targetMount}(device)`;
    const targetFs = facts.btrfs.find((b) =>
      b.devices.some((d) => targetSource.includes(d))
    );
    const uuid = targetFs?.uuid ?? "{{TARGET_FS_UUID}}";
    fstabLine = buildFstabLine({
      uuid,
      mountpoint: args.finalMountpoint ?? args.sourceSubvol,
      fstype: "btrfs",
      options: `subvol=${snapBase}`,
    });
    cmds.push(
      `# back up /etc/fstab, then idempotently add: ${fstabLine}`,
    );
  }
  return { orderedCommands: cmds, fstabLine, snapPath };
}

// ————————————————————————————————————————————————————————————————
// Collector — orchestrates the probes over a live session
// ————————————————————————————————————————————————————————————————

/** Leading valid-hostname run, mirroring node/gather's residue-tolerant probe. */
async function probeHost(run: Session["run"]): Promise<string> {
  const raw = (await run("hostname")).stdout.trim().replace(/[^A-Za-z0-9.-].*$/s, "");
  return raw || "unknown";
}

/**
 * Collect the full storage picture over a session. Each facet is independently
 * failure-tolerant: a missing `btrfs` binary or an old `lsblk` degrades that
 * facet to empty rather than failing the method.
 */
export async function collectStorage(
  run: Session["run"],
  bp = "",
): Promise<Omit<StorageFacts, "gatheredAt">> {
  const host = await probeHost(run);
  // lsblk/findmnt read fine as an unprivileged user (incl. serial/model); only
  // the btrfs inspection needs privilege (it opens the raw device nodes).
  const blockDevices = parseLsblk((await run("lsblk -J -O -b")).stdout);
  const mounts = parseFindmnt(
    (await run(
      "findmnt --real -J -b -o TARGET,SOURCE,FSTYPE,OPTIONS,SIZE,USED,AVAIL",
    )).stdout,
  );

  const btrfsMounts = mounts.filter((m) => m.fstype === "btrfs");
  let btrfs: BtrfsFs[] = [];
  if (btrfsMounts.length) {
    const show = (await run(`${bp}btrfs filesystem show --raw 2>/dev/null`)).stdout;
    const subvolLists: Array<{ mount: string; device: string; stdout: string }> = [];
    for (const m of btrfsMounts) {
      // No `-o`: list ALL subvolumes of the filesystem containing this mount
      // (paths fs-root-relative). `-o` would only show subvols *below* the mount
      // in the subvol tree, missing siblings like root/home/var.
      const out =
        (await run(`${bp}btrfs subvolume list ${m.target} 2>/dev/null`)).stdout;
      // strip findmnt's `[/subvol]` suffix → the backing partition device.
      subvolLists.push({
        mount: m.target,
        device: m.source.replace(/\[.*$/, ""),
        stdout: out,
      });
    }
    btrfs = parseBtrfs(show, subvolLists);
  }

  return { host, blockDevices, mounts, btrfs };
}

// ————————————————————————————————————————————————————————————————
// Model
// ————————————————————————————————————————————————————————————————

/** base64-encode UTF-8 text (fstab is ASCII, but encode bytes to be safe). */
export function b64encode(text: string): string {
  let bin = "";
  for (const byte of new TextEncoder().encode(text)) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
}

/**
 * Read /etc/fstab, back it up (timestamped), and write the idempotently-merged
 * content. The write goes through a single base64 pipeline — NOT a heredoc:
 * `session.run` appends a `; echo <sentinel>` to every command, which would land
 * on the heredoc terminator line and stop it from ever closing (truncating the
 * file and wedging the shell). The base64 form is one command with no delimiter
 * to break and no shell-metacharacter exposure (base64 is `[A-Za-z0-9+/=]`).
 */
export async function persistFstab(
  session: Session,
  mountpoint: string,
  line: string,
  bp = "",
): Promise<{ replaced: number; backup: string }> {
  const existing = (await session.run(`${bp}cat /etc/fstab`)).stdout;
  const { content, replaced } = mergeFstab(existing, mountpoint, line);
  const backup = `/etc/fstab.swamp-bak.${Date.now()}`;
  const bk = await session.run(`${bp}cp -a /etc/fstab ${backup}`);
  if (bk.exitCode !== 0) {
    throw new Error(`could not back up /etc/fstab (rc=${bk.exitCode})`);
  }
  // Decode then `tee` so the privileged write owns the file (a `> /etc/fstab`
  // redirect happens in the caller's shell, which isn't root under `become`);
  // pipefail in a subshell so a decode failure isn't masked by tee's success.
  const wr = await session.run(
    `( set -o pipefail; printf '%s' '${b64encode(content)}' | base64 -d | ${bp}tee /etc/fstab > /dev/null )`,
  );
  if (wr.exitCode !== 0) {
    throw new Error(`could not write /etc/fstab (rc=${wr.exitCode})`);
  }
  return { replaced, backup };
}

export const model = {
  type: "@shrug/serial-cfgmgmt/storage",
  version: "2026.07.22.2",
  globalArguments: z.object({
    ...ConnectionGlobals,
    become: z.boolean().default(false).describe(
      "Escalate privilege for the btrfs probes and every mutating command (the login user is unprivileged, e.g. a `fedora` serial console with sudo). Leave false when the session is already root.",
    ),
    becomeMethod: z.enum(["sudo", "doas"]).default("sudo").describe(
      "Privilege-escalation command used when `become` is true. `sudo` runs as `sudo -n` (non-interactive).",
    ),
  }),
  resources: {
    storage: {
      description:
        "Block devices, filesystems, mounts and btrfs subvolumes gathered from the target over the serial console.",
      schema: StorageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    plan: {
      description:
        "Dry-run preview of a mutating storage method: the exact ordered command plan and fstab line. Executes nothing.",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    mount: {
      description:
        "Result of a live format_mount / relocate_subvol: the persisted mount, its UUID, and verification details.",
      schema: MountResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  // format_mount / relocate_subvol are mutating (assume a privileged shell) and
  // must fail before opening the port on a non-tty path. disks is read-only.
  checks: deviceAllowlistCheck(["format_mount", "relocate_subvol"]),

  methods: {
    disks: {
      description:
        "Collect block devices, filesystems, mounts and btrfs subvolumes over the serial console (lsblk/findmnt/btrfs). Read-only. Writes the `storage` resource.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const g = context.globalArgs;
        const bp = becomeOf(g);
        const facts = await withSession(
          g,
          context.logger,
          (session) => collectStorage((cmd) => session.run(cmd), bp),
        );
        context.logger.info(
          "disks on {device}: {host} — {devs} block device(s), {mounts} mount(s), {btrfs} btrfs fs",
          {
            device: g.device,
            host: facts.host,
            devs: facts.blockDevices.length,
            mounts: facts.mounts.length,
            btrfs: facts.btrfs.length,
          },
        );
        const storage = { ...facts, gatheredAt: new Date().toISOString() };
        StorageSchema.parse(storage);
        const key = facts.host !== "unknown"
          ? facts.host
          : g.device.replace(/\W+/g, "_");
        const handle = await context.writeResource("storage", key, storage);
        return { dataHandles: [handle] };
      },
    },

    format_mount: {
      description:
        "Format a device (optionally partition it first) and persist a nofail mount. MUTATING. Defaults to dryRun=true (writes a `plan`, executes nothing); a live run requires `confirmDevice` and refuses on any identity mismatch, a mounted target, or an existing filesystem signature (unless wipe=true).",
      arguments: z.object({
        device: z.string().min(1).regex(SAFE_PATH_RE).describe(
          "Target block device, e.g. /dev/mmcblk2.",
        ),
        partition: z.boolean().default(false).describe(
          "Create a single GPT partition spanning the device, then format that partition.",
        ),
        fstype: z.string().regex(SAFE_LABEL_RE).default("btrfs").describe(
          "Filesystem type to create.",
        ),
        label: z.string().regex(SAFE_LABEL_RE).optional().describe("Filesystem label."),
        mkfsArgs: z.string().regex(SAFE_MKFS_ARGS_RE).optional().describe(
          "Extra args passed to mkfs.<fstype>, e.g. '-b 4096' (no shell metacharacters).",
        ),
        mountpoint: z.string().min(1).regex(SAFE_PATH_RE).describe(
          "Mount path, e.g. /mnt/data.",
        ),
        fstabOptions: z.string().regex(SAFE_OPTS_RE).optional().describe(
          "fstab mount options; `nofail` and a device timeout are always forced on.",
        ),
        wipe: z.boolean().default(false).describe(
          "wipefs -a before mkfs. When false, a non-empty device (any existing fs or partition) is a hard refusal.",
        ),
        dryRun: z.boolean().default(true).describe(
          "Preview only: write the plan, execute nothing. Default true.",
        ),
        confirmDevice: ConfirmDeviceSchema.optional().describe(
          "Expected target identity (serial/model/sizeBytes/empty). Required when dryRun=false.",
        ),
      }),
      execute: async (
        args: {
          device: string;
          partition: boolean;
          fstype: string;
          label?: string;
          mkfsArgs?: string;
          mountpoint: string;
          fstabOptions?: string;
          wipe: boolean;
          dryRun: boolean;
          confirmDevice?: ConfirmDevice;
        },
        context: Ctx,
      ) => {
        const g = context.globalArgs;
        const bp = becomeOf(g);
        const fmArgs: FormatMountArgs = {
          device: args.device,
          partition: args.partition,
          fstype: args.fstype,
          label: args.label,
          mkfsArgs: args.mkfsArgs,
          mountpoint: args.mountpoint,
          fstabOptions: args.fstabOptions,
          wipe: args.wipe,
        };

        if (args.dryRun) {
          const facts = await withSession(
            g,
            context.logger,
            (s) => collectStorage((c) => s.run(c), bp),
          );
          const dev = findDevice(facts.blockDevices, args.device);
          const plan = planFormatMount(
            { ...facts, gatheredAt: "" },
            fmArgs,
            bp,
          );
          const record = {
            method: "format_mount",
            dryRun: true as const,
            orderedCommands: plan.orderedCommands,
            fstabLine: plan.fstabLine,
            resolvedTarget: dev
              ? {
                path: dev.path,
                sizeBytes: dev.sizeBytes,
                model: dev.model ?? null,
                serial: dev.serial ?? null,
                fstype: dev.fstype ?? null,
                mounted: isMounted(dev),
                empty: isEmpty(dev),
              }
              : null,
            notes: [
              "DRY RUN — nothing was executed.",
              dev
                ? "Set dryRun=false with a matching confirmDevice to apply."
                : `Target ${args.device} not present in live topology.`,
            ],
          };
          PlanSchema.parse(record);
          const handle = await context.writeResource(
            "plan",
            `format_${args.device.replace(/\W+/g, "_")}`,
            record,
          );
          context.logger.info(
            "format_mount DRY RUN for {device} → {mount} ({n} steps planned)",
            {
              device: args.device,
              mount: args.mountpoint,
              n: plan.orderedCommands.length,
            },
          );
          return { dataHandles: [handle] };
        }

        // ——— live path ———
        if (!args.confirmDevice) {
          throw new Error(
            "format_mount live run (dryRun=false) requires `confirmDevice` — " +
              "run a dry run first, then pass the target's identity to confirm.",
          );
        }
        // In-method shell-safety backstop (the schema already rejects these,
        // but never interpolate an unchecked value into a root command).
        assertSafe(args.device, SAFE_PATH_RE, "device");
        assertSafe(args.mountpoint, SAFE_PATH_RE, "mountpoint");
        assertSafe(args.fstype, SAFE_LABEL_RE, "fstype");
        if (args.label) assertSafe(args.label, SAFE_LABEL_RE, "label");
        if (args.mkfsArgs) assertSafe(args.mkfsArgs, SAFE_MKFS_ARGS_RE, "mkfsArgs");
        if (args.fstabOptions) assertSafe(args.fstabOptions, SAFE_OPTS_RE, "fstabOptions");

        const result = await withSession(g, context.logger, async (session) => {
          const facts = await collectStorage((c) => session.run(c), bp);
          const dev = findDevice(facts.blockDevices, args.device);
          const guard = confirmMatches(dev, args.confirmDevice!, args.device);
          if (!guard.ok) {
            throw new Error(
              `format_mount refused for ${args.device}: ${guard.reasons.join("; ")}`,
            );
          }
          // dev is non-null here (guard would have failed otherwise). Refuse a
          // device that isn't empty (any existing fs OR partition table OR
          // mount) unless wipe — checking the whole subtree, not just the
          // whole-disk fstype, so a partitioned disk can't be silently clobbered.
          if (!args.wipe && !isEmpty(dev!)) {
            const why = dev!.fstype
              ? `carries a ${dev!.fstype} filesystem`
              : dev!.children.length
              ? `has ${dev!.children.length} partition(s)`
              : `is in use`;
            throw new Error(
              `format_mount refused: ${args.device} ${why} and wipe=false. ` +
                `Pass wipe=true to overwrite deliberately.`,
            );
          }
          const target = args.partition
            ? partitionPath(args.device)
            : args.device;

          // `step` privilege-escalates every mutating command with `bp` (they all
          // need root); mirrors what the dry-run plan previews.
          const step = async (cmd: string) => {
            const r = await session.run(`${bp}${cmd}`);
            if (r.exitCode !== 0) {
              throw new Error(`\`${bp}${cmd}\` failed (rc=${r.exitCode}): ${r.stdout.slice(-300)}`);
            }
            return r;
          };
          if (args.wipe) await step(`wipefs -a ${args.device}`);
          if (args.partition) {
            await step(`parted -s ${args.device} mklabel gpt mkpart primary 0% 100%`);
            await session.run(`${bp}udevadm settle 2>/dev/null; sleep 1`);
          }
          const mkfs = [`mkfs.${args.fstype}`];
          if (args.label) mkfs.push(`-L ${args.label}`);
          if (args.mkfsArgs) mkfs.push(args.mkfsArgs);
          mkfs.push(target);
          await step(mkfs.join(" "));

          const uuid =
            (await step(`blkid -c /dev/null -s UUID -o value ${target}`)).stdout.trim();
          if (!/^[0-9a-fA-F-]{8,}$/.test(uuid)) {
            throw new Error(`could not read a UUID for ${target} after mkfs (got "${uuid}")`);
          }
          await step(`mkdir -p ${args.mountpoint}`);
          const line = buildFstabLine({
            uuid,
            mountpoint: args.mountpoint,
            fstype: args.fstype,
            options: args.fstabOptions ?? "defaults",
          });
          const fstab = await persistFstab(session, args.mountpoint, line, bp);
          await step(`mount ${args.mountpoint}`);
          const verify = (await step(`findmnt --real -n ${args.mountpoint}`)).stdout.trim();

          return {
            method: "format_mount",
            mountpoint: args.mountpoint,
            source: target,
            uuid,
            fstype: args.fstype,
            options: ensureNofail(args.fstabOptions ?? "defaults"),
            verifiedAt: new Date().toISOString(),
            details: {
              fstabLine: line,
              fstabReplaced: fstab.replaced,
              fstabBackup: fstab.backup,
              findmnt: verify,
            },
          };
        });
        MountResultSchema.parse(result);
        context.logger.info(
          "format_mount LIVE {device} → {mount} uuid={uuid}",
          { device: args.device, mount: args.mountpoint, uuid: result.uuid },
        );
        const handle = await context.writeResource(
          "mount",
          args.mountpoint.replace(/\W+/g, "_"),
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    relocate_subvol: {
      description:
        "Copy a btrfs subvolume to another (already-formatted) btrfs via `btrfs send | receive`, verify the received copy, and optionally repoint fstab (nofail). MUTATING but ADDITIVE — never deletes the source. Defaults to dryRun=true; a live run requires `confirmDevice`.",
      arguments: z.object({
        sourceSubvol: z.string().min(1).regex(SAFE_PATH_RE).describe(
          "Live subvolume path to copy, e.g. /var.",
        ),
        targetMount: z.string().min(1).regex(SAFE_PATH_RE).describe(
          "Mounted destination btrfs, e.g. /mnt/newdisk.",
        ),
        snapshotName: z.string().regex(SAFE_LABEL_RE).optional().describe(
          "Read-only snapshot name to send (a leaf name, not a path).",
        ),
        repoint: z.boolean().default(false).describe(
          "Rewrite fstab so finalMountpoint mounts the received subvol (nofail).",
        ),
        finalMountpoint: z.string().regex(SAFE_PATH_RE).optional().describe(
          "Where the received subvol should mount after reboot (defaults to sourceSubvol).",
        ),
        dryRun: z.boolean().default(true).describe(
          "Preview only: write the plan, execute nothing. Default true.",
        ),
        confirmDevice: ConfirmDeviceSchema.optional().describe(
          "Expected identity of the target btrfs device. Required when dryRun=false.",
        ),
      }),
      execute: async (
        args: {
          sourceSubvol: string;
          targetMount: string;
          snapshotName?: string;
          repoint: boolean;
          finalMountpoint?: string;
          dryRun: boolean;
          confirmDevice?: ConfirmDevice;
        },
        context: Ctx,
      ) => {
        const g = context.globalArgs;
        const bp = becomeOf(g);
        const relArgs: RelocateArgs = {
          sourceSubvol: args.sourceSubvol,
          targetMount: args.targetMount,
          snapshotName: args.snapshotName,
          repoint: args.repoint,
          finalMountpoint: args.finalMountpoint,
        };

        if (args.dryRun) {
          const facts = await withSession(
            g,
            context.logger,
            (s) => collectStorage((c) => s.run(c), bp),
          );
          const plan = planRelocateSubvol({ ...facts, gatheredAt: "" }, relArgs, bp);
          const targetMount = facts.mounts.find((m) => m.target === args.targetMount);
          const record = {
            method: "relocate_subvol",
            dryRun: true as const,
            orderedCommands: plan.orderedCommands,
            fstabLine: plan.fstabLine,
            resolvedTarget: {
              targetMount: args.targetMount,
              targetMounted: Boolean(targetMount),
              targetFstype: targetMount?.fstype ?? null,
              snapshot: plan.snapPath,
            },
            notes: [
              "DRY RUN — nothing was executed.",
              "ADDITIVE: the source subvolume is never deleted; rollback = revert the fstab line.",
              targetMount
                ? "Set dryRun=false with a matching confirmDevice to apply."
                : `Target mount ${args.targetMount} is not mounted — format_mount it first.`,
            ],
          };
          PlanSchema.parse(record);
          const handle = await context.writeResource(
            "plan",
            `relocate_${args.sourceSubvol.replace(/\W+/g, "_")}`,
            record,
          );
          context.logger.info(
            "relocate_subvol DRY RUN {src} → {dst} ({n} steps)",
            {
              src: args.sourceSubvol,
              dst: args.targetMount,
              n: plan.orderedCommands.length,
            },
          );
          return { dataHandles: [handle] };
        }

        // ——— live path ———
        if (!args.confirmDevice) {
          throw new Error(
            "relocate_subvol live run (dryRun=false) requires `confirmDevice`.",
          );
        }
        assertSafe(args.sourceSubvol, SAFE_PATH_RE, "sourceSubvol");
        assertSafe(args.targetMount, SAFE_PATH_RE, "targetMount");
        if (args.snapshotName) assertSafe(args.snapshotName, SAFE_LABEL_RE, "snapshotName");
        if (args.finalMountpoint) {
          assertSafe(args.finalMountpoint, SAFE_PATH_RE, "finalMountpoint");
        }
        const result = await withSession(g, context.logger, async (session) => {
          const facts = await collectStorage((c) => session.run(c), bp);
          const targetMount = facts.mounts.find((m) => m.target === args.targetMount);
          if (!targetMount || targetMount.fstype !== "btrfs") {
            throw new Error(
              `relocate_subvol refused: ${args.targetMount} is not a mounted btrfs filesystem.`,
            );
          }
          // Confirm the identity of the DISK backing the target mount. The mount
          // source is a partition (serial/size live on the disk node, not the
          // partition), so identity must be compared against the parent disk;
          // and we compare identity ONLY (the target is required to be mounted,
          // so the mounted-device refusal doesn't apply here).
          const targetDisk = findDiskFor(facts.blockDevices, targetMount.source);
          const identityReasons = identityMismatches(
            targetDisk,
            args.confirmDevice!,
            targetMount.source,
          );
          if (identityReasons.length) {
            throw new Error(
              `relocate_subvol refused for ${targetMount.source} (disk ${
                targetDisk?.path ?? "?"
              }): ${identityReasons.join("; ")}`,
            );
          }

          const plan = planRelocateSubvol({ ...facts, gatheredAt: "" }, relArgs, bp);
          const snapPath = plan.snapPath;
          const snapBase = snapPath.slice(snapPath.lastIndexOf("/") + 1);
          const received = `${args.targetMount.replace(/\/+$/, "")}/${snapBase}`;

          // `step` privilege-escalates every command with `bp` (all need root).
          const step = async (cmd: string) => {
            const r = await session.run(`${bp}${cmd}`);
            if (r.exitCode !== 0) {
              throw new Error(`\`${cmd}\` failed (rc=${r.exitCode}): ${r.stdout.slice(-300)}`);
            }
            return r;
          };
          await step(`btrfs subvolume snapshot -r ${args.sourceSubvol} ${snapPath}`);
          await step("sync");
          // send|receive is a single local pipeline; it can run long with no
          // intermediate output — the session's maxMs bound applies. pipefail so
          // a failing `send` isn't masked by a succeeding `receive`; in a
          // subshell so the option doesn't leak into later session commands. Run
          // directly (NOT via `step`, which would prefix the subshell as a whole,
          // i.e. `sudo -n ( … )`) — `bp` goes on each pipeline stage instead.
          const pipe = `( set -o pipefail; ${bp}btrfs send ${snapPath} | ${bp}btrfs receive ${args.targetMount} )`;
          const sr = await session.run(pipe);
          if (sr.exitCode !== 0) {
            throw new Error(`\`${pipe}\` failed (rc=${sr.exitCode}): ${sr.stdout.slice(-300)}`);
          }

          // Verify (never trust the exit code alone):
          //  1. the received copy's `Received UUID` links the source snapshot's
          //     own `UUID` (line-anchored so `Parent UUID:` can't false-match),
          //  2. file counts match, and
          //  3. byte totals match.
          const srcShow = (await step(`btrfs subvolume show ${snapPath}`)).stdout;
          const dstShow = (await step(`btrfs subvolume show ${received}`)).stdout;
          const srcUuid = srcShow.match(/^\s*UUID:\s*([0-9a-f-]+)/im)?.[1];
          const rcvUuid = dstShow.match(/^\s*Received UUID:\s*([0-9a-f-]+)/im)?.[1];
          if (!srcUuid || !rcvUuid || srcUuid !== rcvUuid) {
            throw new Error(
              `relocate verify FAILED: received subvol's Received UUID (${rcvUuid ?? "none"}) ` +
                `does not match the source snapshot UUID (${srcUuid ?? "none"}).`,
            );
          }
          const srcCount = (await step(`find ${snapPath} -xdev | wc -l`)).stdout.trim();
          const dstCount = (await step(`find ${received} -xdev | wc -l`)).stdout.trim();
          if (srcCount !== dstCount) {
            throw new Error(
              `relocate verify FAILED: file count differs (source ${srcCount}, received ${dstCount}).`,
            );
          }
          const srcBytes = (await step(`du -sb ${snapPath} | cut -f1`)).stdout.trim();
          const dstBytes = (await step(`du -sb ${received} | cut -f1`)).stdout.trim();
          if (srcBytes !== dstBytes) {
            throw new Error(
              `relocate verify FAILED: byte total differs (source ${srcBytes}, received ${dstBytes}).`,
            );
          }

          let fstab: { replaced: number; backup: string } | null = null;
          let fstabLine: string | null = null;
          // The received subvol's fs-root-relative path (btrfs subvolume show
          // prints it as the first, colon-free line) — correct even if the
          // target isn't mounted at the btrfs top level. Falls back to the
          // basename for the top-level-mount case.
          const subvolFsPath = dstShow.split("\n")
            .map((l) => l.trim())
            .find((l) => l !== "" && !l.includes(":")) ?? snapBase;
          if (args.repoint) {
            const mp = args.finalMountpoint ?? args.sourceSubvol;
            const src0 = targetMount.source.replace(/\[.*$/, "");
            const fsUuid =
              (await step(`blkid -c /dev/null -s UUID -o value ${src0}`)).stdout.trim();
            fstabLine = buildFstabLine({
              uuid: fsUuid,
              mountpoint: mp,
              fstype: "btrfs",
              options: `subvol=${subvolFsPath}`,
            });
            fstab = await persistFstab(session, mp, fstabLine, bp);
          }

          return {
            method: "relocate_subvol",
            mountpoint: args.repoint ? (args.finalMountpoint ?? args.sourceSubvol) : null,
            source: received,
            uuid: rcvUuid,
            fstype: "btrfs",
            options: fstabLine ? ensureNofail(`subvol=${subvolFsPath}`) : null,
            verifiedAt: new Date().toISOString(),
            details: {
              snapshot: snapPath,
              received,
              fileCount: Number(dstCount),
              byteTotal: Number(dstBytes),
              repointed: args.repoint,
              fstabLine,
              fstabReplaced: fstab?.replaced ?? null,
              fstabBackup: fstab?.backup ?? null,
              sourcePreserved: true,
            },
          };
        });
        MountResultSchema.parse(result);
        context.logger.info(
          "relocate_subvol LIVE {src} → {dst} (source preserved)",
          { src: args.sourceSubvol, dst: args.targetMount },
        );
        const handle = await context.writeResource(
          "mount",
          `relocate_${args.sourceSubvol.replace(/\W+/g, "_")}`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
  reports: [],
};

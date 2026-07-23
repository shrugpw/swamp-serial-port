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

/** Expected identity of a target device, asserted before any live write. */
const ConfirmDeviceSchema = z.object({
  serial: z.string().optional(),
  model: z.string().optional(),
  sizeBytes: z.number().optional(),
  empty: z.boolean().optional(),
});
export type ConfirmDevice = z.infer<typeof ConfirmDeviceSchema>;

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
  const json = extractJson(raw);
  if (!json || !Array.isArray(json["blockdevices"])) return [];
  return (json["blockdevices"] as Record<string, unknown>[]).map(mapBlockNode);
}

/** Parse `findmnt --real -J -b …` JSON into a flat mount list. */
export function parseFindmnt(raw: string): Mount[] {
  const json = extractJson(raw);
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

/**
 * Parse `btrfs filesystem show --raw` + per-mount `btrfs subvolume list -o`
 * output into the btrfs facet. `subvolLists` maps a mountpoint to that mount's
 * `subvolume list` stdout. Best-effort: unparseable lines are skipped.
 */
export function parseBtrfs(
  showRaw: string,
  subvolLists: Array<{ mount: string; stdout: string }>,
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
  // Subvolumes aren't tied to a specific fs by the list output alone; attach all
  // parsed subvols to the single fs when there is exactly one, else leave them
  // off (the block-device tree already carries the mount topology). Dedup by id:
  // `subvolume list -o` is probed once per btrfs mount, so the same subvol shows
  // up in several lists (e.g. both `/` and `/var`).
  const byId = new Map<number, { id: number; parentId?: number; path: string }>();
  for (const { stdout } of subvolLists) {
    for (const l of stdout.split("\n")) {
      const m = l.match(/^ID\s+(\d+)\s+gen\s+\d+\s+top level\s+(\d+)\s+path\s+(.+)$/);
      if (m) {
        const id = Number(m[1]);
        if (!byId.has(id)) {
          byId.set(id, { id, parentId: Number(m[2]), path: m[3].trim() });
        }
      }
    }
  }
  const subvols = [...byId.values()];
  if (fss.length === 1 && subvols.length) fss[0].subvolumes = subvols;
  return fss;
}

/** Pull the first well-formed top-level JSON object out of noisy console text. */
function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  // Scan for the matching closing brace so trailing prompt/printk noise after
  // the JSON can't defeat the parse.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
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
        try {
          return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
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
 * Assert a live target device matches the caller's `confirmDevice`. Compares
 * only the fields the caller supplied (stable serial/model/size), plus an
 * always-on refusal to touch a mounted device. Returns every failing reason so
 * the caller can surface exactly why the write was refused.
 */
export function confirmMatches(
  dev: BlockDevice | null,
  confirm: ConfirmDevice,
  targetPath: string,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!dev) {
    return {
      ok: false,
      reasons: [`target device "${targetPath}" not found in live topology`],
    };
  }
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
  if (confirm.empty === true && !isEmpty(dev)) {
    reasons.push(
      `device is not empty (has ${
        dev.fstype ? `fstype=${dev.fstype}` : `${dev.children.length} partition(s)`
      } or is mounted) but confirmDevice.empty=true`,
    );
  }
  if (isMounted(dev)) {
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
  const lines = existing.replace(/\n+$/, "").split("\n");
  const kept: string[] = [];
  let replaced = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const fields = trimmed.split(/\s+/);
      if (fields[1] === mountpoint) {
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
 * the `{{NEW_UUID}}` token; the live executor reuses this exact list and
 * substitutes the UUID it reads back with `blkid`, so plan ≡ execution.
 */
export function planFormatMount(
  _facts: StorageFacts,
  args: FormatMountArgs,
): { orderedCommands: string[]; fstabLine: string; target: string } {
  const target = args.partition
    ? partitionPath(args.device)
    : args.device;
  const cmds: string[] = [];
  if (args.wipe) cmds.push(`wipefs -a ${args.device}`);
  if (args.partition) {
    cmds.push(
      `parted -s ${args.device} mklabel gpt mkpart primary 0% 100%`,
    );
  }
  const mkfs = [`mkfs.${args.fstype}`];
  if (args.label) mkfs.push(`-L ${args.label}`);
  if (args.mkfsArgs) mkfs.push(args.mkfsArgs);
  mkfs.push(target);
  cmds.push(mkfs.join(" "));
  cmds.push(`blkid -s UUID -o value ${target}`);
  cmds.push(`mkdir -p ${args.mountpoint}`);
  const fstabLine = buildFstabLine({
    uuid: "{{NEW_UUID}}",
    mountpoint: args.mountpoint,
    fstype: args.fstype,
    options: args.fstabOptions ?? "defaults",
  });
  cmds.push(`# back up /etc/fstab, then idempotently add: ${fstabLine}`);
  cmds.push(`mount ${args.mountpoint}`);
  cmds.push(`findmnt --real ${args.mountpoint}`);
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
): { orderedCommands: string[]; fstabLine: string | null; snapPath: string } {
  const snapPath = deriveSnapshotPath(args.sourceSubvol, args.snapshotName);
  const snapBase = snapPath.slice(snapPath.lastIndexOf("/") + 1);
  const received = `${args.targetMount.replace(/\/+$/, "")}/${snapBase}`;
  const cmds = [
    `btrfs subvolume snapshot -r ${args.sourceSubvol} ${snapPath}`,
    `sync`,
    `btrfs send ${snapPath} | btrfs receive ${args.targetMount}`,
    `btrfs subvolume show ${snapPath}`,
    `btrfs subvolume show ${received}`,
    `find ${snapPath} -xdev | wc -l`,
    `find ${received} -xdev | wc -l`,
    `du -sb ${snapPath} ${received}`,
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
): Promise<Omit<StorageFacts, "gatheredAt">> {
  const host = await probeHost(run);
  const blockDevices = parseLsblk((await run("lsblk -J -O -b")).stdout);
  const mounts = parseFindmnt(
    (await run(
      "findmnt --real -J -b -o TARGET,SOURCE,FSTYPE,OPTIONS,SIZE,USED,AVAIL",
    )).stdout,
  );

  const btrfsMounts = mounts.filter((m) => m.fstype === "btrfs");
  let btrfs: BtrfsFs[] = [];
  if (btrfsMounts.length) {
    const show = (await run("btrfs filesystem show --raw 2>/dev/null")).stdout;
    const subvolLists: Array<{ mount: string; stdout: string }> = [];
    for (const m of btrfsMounts) {
      const out =
        (await run(`btrfs subvolume list -o ${m.target} 2>/dev/null`)).stdout;
      subvolLists.push({ mount: m.target, stdout: out });
    }
    btrfs = parseBtrfs(show, subvolLists);
  }

  return { host, blockDevices, mounts, btrfs };
}

// ————————————————————————————————————————————————————————————————
// Model
// ————————————————————————————————————————————————————————————————

const HEREDOC = "SWAMP_FSTAB_EOF";

/** Read /etc/fstab, back it up, and write the idempotently-merged content. */
async function persistFstab(
  session: Session,
  mountpoint: string,
  line: string,
): Promise<{ replaced: number; backup: string }> {
  const existing = (await session.run("cat /etc/fstab")).stdout;
  const { content, replaced } = mergeFstab(existing, mountpoint, line);
  const backup = "/etc/fstab.swamp-bak";
  const bk = await session.run(`cp -a /etc/fstab ${backup}`);
  if (bk.exitCode !== 0) {
    throw new Error(`could not back up /etc/fstab (rc=${bk.exitCode})`);
  }
  const wr = await session.run(
    `cat > /etc/fstab <<'${HEREDOC}'\n${content}${HEREDOC}`,
  );
  if (wr.exitCode !== 0) {
    throw new Error(`could not write /etc/fstab (rc=${wr.exitCode})`);
  }
  return { replaced, backup };
}

export const model = {
  type: "@shrug/serial-cfgmgmt/storage",
  version: "2026.07.22.2",
  globalArguments: z.object({ ...ConnectionGlobals }),
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
        const facts = await withSession(
          g,
          context.logger,
          (session) => collectStorage((cmd) => session.run(cmd)),
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
        device: z.string().min(1).describe("Target block device, e.g. /dev/mmcblk2."),
        partition: z.boolean().default(false).describe(
          "Create a single GPT partition spanning the device, then format that partition.",
        ),
        fstype: z.string().default("btrfs").describe("Filesystem type to create."),
        label: z.string().optional().describe("Filesystem label."),
        mkfsArgs: z.string().optional().describe("Extra args passed to mkfs.<fstype>."),
        mountpoint: z.string().min(1).describe("Mount path, e.g. /mnt/data."),
        fstabOptions: z.string().optional().describe(
          "fstab mount options; `nofail` and a device timeout are always forced on.",
        ),
        wipe: z.boolean().default(false).describe(
          "wipefs -a before mkfs. When false, an existing fs signature is a hard refusal.",
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
            (s) => collectStorage((c) => s.run(c)),
          );
          const dev = findDevice(facts.blockDevices, args.device);
          const plan = planFormatMount(
            { ...facts, gatheredAt: "" },
            fmArgs,
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
        const result = await withSession(g, context.logger, async (session) => {
          const facts = await collectStorage((c) => session.run(c));
          const dev = findDevice(facts.blockDevices, args.device);
          const guard = confirmMatches(dev, args.confirmDevice!, args.device);
          if (!guard.ok) {
            throw new Error(
              `format_mount refused for ${args.device}: ${guard.reasons.join("; ")}`,
            );
          }
          // dev is non-null here (guard would have failed otherwise).
          if (!args.wipe && dev!.fstype) {
            throw new Error(
              `format_mount refused: ${args.device} already carries a ${dev!.fstype} ` +
                `filesystem and wipe=false. Pass wipe=true to overwrite deliberately.`,
            );
          }
          const target = args.partition
            ? partitionPath(args.device)
            : args.device;

          const step = async (cmd: string) => {
            const r = await session.run(cmd);
            if (r.exitCode !== 0) {
              throw new Error(`\`${cmd}\` failed (rc=${r.exitCode}): ${r.stdout.slice(-300)}`);
            }
            return r;
          };
          if (args.wipe) await step(`wipefs -a ${args.device}`);
          if (args.partition) {
            await step(`parted -s ${args.device} mklabel gpt mkpart primary 0% 100%`);
            await session.run("udevadm settle 2>/dev/null; sleep 1");
          }
          const mkfs = [`mkfs.${args.fstype}`];
          if (args.label) mkfs.push(`-L ${args.label}`);
          if (args.mkfsArgs) mkfs.push(args.mkfsArgs);
          mkfs.push(target);
          await step(mkfs.join(" "));

          const uuid = (await step(`blkid -s UUID -o value ${target}`)).stdout.trim();
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
          const fstab = await persistFstab(session, args.mountpoint, line);
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
        sourceSubvol: z.string().min(1).describe("Live subvolume path to copy, e.g. /var."),
        targetMount: z.string().min(1).describe("Mounted destination btrfs, e.g. /mnt/newdisk."),
        snapshotName: z.string().optional().describe("Read-only snapshot name/path to send."),
        repoint: z.boolean().default(false).describe(
          "Rewrite fstab so finalMountpoint mounts the received subvol (nofail).",
        ),
        finalMountpoint: z.string().optional().describe(
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
            (s) => collectStorage((c) => s.run(c)),
          );
          const plan = planRelocateSubvol({ ...facts, gatheredAt: "" }, relArgs);
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
        const result = await withSession(g, context.logger, async (session) => {
          const facts = await collectStorage((c) => session.run(c));
          const targetMount = facts.mounts.find((m) => m.target === args.targetMount);
          if (!targetMount || targetMount.fstype !== "btrfs") {
            throw new Error(
              `relocate_subvol refused: ${args.targetMount} is not a mounted btrfs filesystem.`,
            );
          }
          // Confirm the identity of the device backing the target mount.
          const targetDev = findDevice(facts.blockDevices, targetMount.source);
          const guard = confirmMatches(
            targetDev ?? {
              name: "",
              path: targetMount.source,
              sizeBytes: null,
              type: "",
              mountpoints: [args.targetMount],
              children: [],
            },
            args.confirmDevice!,
            targetMount.source,
          );
          // The target IS mounted (we require it), so drop the always-on
          // "mounted" refusal and judge only the identity fields.
          const identityReasons = guard.reasons.filter((r) => !r.includes("currently mounted"));
          if (identityReasons.length) {
            throw new Error(
              `relocate_subvol refused for ${targetMount.source}: ${identityReasons.join("; ")}`,
            );
          }

          const plan = planRelocateSubvol({ ...facts, gatheredAt: "" }, relArgs);
          const snapPath = plan.snapPath;
          const snapBase = snapPath.slice(snapPath.lastIndexOf("/") + 1);
          const received = `${args.targetMount.replace(/\/+$/, "")}/${snapBase}`;

          const step = async (cmd: string) => {
            const r = await session.run(cmd);
            if (r.exitCode !== 0) {
              throw new Error(`\`${cmd}\` failed (rc=${r.exitCode}): ${r.stdout.slice(-300)}`);
            }
            return r;
          };
          await step(`btrfs subvolume snapshot -r ${args.sourceSubvol} ${snapPath}`);
          await step("sync");
          // send|receive is a single local pipeline; it can run long with no
          // intermediate output — the session's maxMs bound applies.
          await step(`btrfs send ${snapPath} | btrfs receive ${args.targetMount}`);

          // Verify: received_uuid of the copy must link the snapshot's uuid.
          const srcShow = (await step(`btrfs subvolume show ${snapPath}`)).stdout;
          const dstShow = (await step(`btrfs subvolume show ${received}`)).stdout;
          const srcUuid = srcShow.match(/\bUUID:\s*([0-9a-f-]+)/i)?.[1];
          const rcvUuid = dstShow.match(/Received UUID:\s*([0-9a-f-]+)/i)?.[1];
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

          let fstab: { replaced: number; backup: string } | null = null;
          if (args.repoint && plan.fstabLine) {
            const mp = args.finalMountpoint ?? args.sourceSubvol;
            fstab = await persistFstab(session, mp, plan.fstabLine);
          }

          return {
            method: "relocate_subvol",
            mountpoint: args.repoint ? (args.finalMountpoint ?? args.sourceSubvol) : null,
            source: received,
            uuid: rcvUuid,
            fstype: "btrfs",
            options: plan.fstabLine ? ensureNofail(`subvol=${snapBase}`) : null,
            verifiedAt: new Date().toISOString(),
            details: {
              snapshot: snapPath,
              received,
              fileCount: Number(dstCount),
              repointed: args.repoint,
              fstabLine: plan.fstabLine,
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

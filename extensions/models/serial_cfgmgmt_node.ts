/**
 * `@shrug/serial-cfgmgmt/node` — gather system facts over a serial console.
 *
 * The serial-transport counterpart to `@adam/cfgmgmt/node`'s SSH `gather`. It
 * writes the same `info` shape, so reports and CEL wiring are transport-blind:
 * a networked host gathered over SSH and a network-less board gathered over
 * serial produce identical fact records.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type CommandResult,
  ConnectionGlobals,
  type Ctx,
  withSession,
} from "./serial_cfgmgmt_lib.ts";

/** Facts written to `info`. Byte-compatible with `@adam/cfgmgmt/node`. */
const InfoSchema = z.object({
  hostname: z.string(),
  os: z.string(),
  osVersion: z.string(),
  arch: z.string(),
  kernel: z.string(),
  packageManagers: z.array(z.string()),
  gatheredAt: z.string(),
});

/** Facts before the timestamp is stamped on. */
export type Facts = Omit<z.infer<typeof InfoSchema>, "gatheredAt">;

/** Package managers to probe, as `[fact name, executable]`. */
const PROBES: ReadonlyArray<readonly [string, string]> = [
  ["pacman", "pacman"],
  ["apt", "apt-get"],
  ["dnf", "dnf"],
  ["yum", "yum"],
  ["homebrew", "brew"],
  ["nix", "nix-env"],
  ["zypper", "zypper"],
  ["apk", "apk"],
];

/**
 * Parse system facts using an injected command runner. Pure w.r.t. transport —
 * the runner is a real serial session in production and a fake in tests.
 */
export async function gatherFacts(
  run: (command: string) => Promise<CommandResult>,
): Promise<Facts> {
  const uname = (await run("uname -srm")).stdout.trim();
  const unameParts = uname.split(/\s+/);
  const kernel = unameParts[1] || unameParts[0] || "unknown";
  const arch = unameParts[2] || "unknown";

  const osRaw =
    (await run("cat /etc/os-release 2>/dev/null || echo ID=unknown")).stdout;
  const osRelease = new Map<string, string>();
  for (const line of osRaw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      osRelease.set(
        line.slice(0, eq).trim(),
        line.slice(eq + 1).replace(/^"|"$/g, "").trim(),
      );
    }
  }

  // Keep only the leading valid-hostname run. `hostname` is the first probe and
  // so the most exposed to residue trailing in from the login/prompt transition
  // over a dumb console (e.g. a bracketed-paste-mode prompt tail that arrives
  // right after the value); left raw it would poison the resource key, which is
  // derived from this field. A hostname is only `[A-Za-z0-9.-]`, so truncating
  // at the first foreign byte is lossless for a real value and byte-compatible
  // with `@adam/cfgmgmt/node` (whose SSH output never carries such residue).
  const hostname = (await run("hostname")).stdout
    .trim()
    .replace(/[^A-Za-z0-9.-].*$/s, "");

  // One round-trip: each present executable prints `PM:<bin>`.
  const bins = PROBES.map(([, bin]) => bin).join(" ");
  const pmRaw = (await run(
    `for b in ${bins}; do command -v "$b" >/dev/null 2>&1 && echo "PM:$b"; done`,
  )).stdout;
  const found = new Set(
    pmRaw.split("\n").map((l) => l.match(/^PM:(\S+)$/)?.[1]).filter(Boolean),
  );
  const packageManagers = PROBES
    .filter(([, bin]) => found.has(bin))
    .map(([name]) => name);

  return {
    hostname: hostname || "unknown",
    os: osRelease.get("ID") || "unknown",
    osVersion: osRelease.get("VERSION_ID") || "unknown",
    arch,
    kernel,
    packageManagers,
  };
}

export const model = {
  type: "@shrug/serial-cfgmgmt/node",
  version: "2026.07.22.1",
  globalArguments: z.object({ ...ConnectionGlobals }),
  resources: {
    info: {
      description: "System facts gathered from the node over the serial console.",
      schema: InfoSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    gather: {
      description:
        "Log in over the serial console (if credentials are set) and gather system facts (hostname, OS, arch, kernel, package managers). Writes the `info` resource.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const g = context.globalArgs;
        const facts = await withSession(
          g,
          context.logger,
          (session) => gatherFacts((cmd) => session.run(cmd)),
        );

        context.logger.info(
          "gather on {device}: {hostname} ({os} {osVersion}, {arch})",
          {
            device: g.device,
            hostname: facts.hostname,
            os: facts.os,
            osVersion: facts.osVersion,
            arch: facts.arch,
          },
        );

        const info = { ...facts, gatheredAt: new Date().toISOString() };
        InfoSchema.parse(info);
        const key = facts.hostname !== "unknown"
          ? facts.hostname
          : g.device.replace(/\W+/g, "_");
        const handle = await context.writeResource("info", key, info);
        return { dataHandles: [handle] };
      },
    },
  },
  reports: [],
};

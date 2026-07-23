/**
 * `@shrug/serial-cfgmgmt/package` — query and install packages over the serial
 * console. Serial counterpart to `@adam/cfgmgmt/{dnf,apt,pacman,…}`.
 *
 * `query` is read-only and safe. `install` mutates the target and assumes a
 * privileged (root) shell — it is scaffolding: exercise it deliberately, never
 * against a device without confirming the target first.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type CommandResult,
  ConnectionGlobals,
  type Ctx,
  type Session,
  withSession,
} from "./serial_cfgmgmt_lib.ts";
import { deviceAllowlistCheck } from "./serial_port.ts";

const PackageSchema = z.object({
  name: z.string(),
  manager: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  checkedAt: z.string(),
});

/** Supported managers and the `command -v` binary that detects each. */
const MANAGERS = ["dnf", "yum", "apt-get", "pacman", "apk", "zypper"] as const;
type Manager = (typeof MANAGERS)[number];

/** Detect the target's package manager over the console (first match wins). */
export async function detectManager(
  run: (command: string) => Promise<CommandResult>,
): Promise<Manager> {
  const list = MANAGERS.join(" ");
  const out = (await run(
    `for b in ${list}; do command -v "$b" >/dev/null 2>&1 && { echo "$b"; break; }; done`,
  )).stdout.trim();
  const found = out.split("\n")[0]?.trim();
  if (found && (MANAGERS as readonly string[]).includes(found)) {
    return found as Manager;
  }
  throw new Error(
    `No supported package manager found on target (looked for: ${list}).`,
  );
}

/** Query whether `name` is installed and, if so, its version. */
export async function queryPackage(
  session: Session,
  manager: Manager,
  name: string,
): Promise<{ installed: boolean; version: string | null }> {
  const q = (name: string) => name.replace(/[^\w.+-]/g, "");
  const pkg = q(name);
  const cmd = manager === "apt-get"
    ? `dpkg-query -W -f='\${Version}' ${pkg} 2>/dev/null`
    : manager === "pacman"
    ? `pacman -Q ${pkg} 2>/dev/null | awk '{print $2}'`
    : manager === "apk"
    ? `apk info -e ${pkg} >/dev/null 2>&1 && apk version ${pkg} 2>/dev/null | awk 'NR==2{print $1}'`
    : `rpm -q --qf '%{VERSION}-%{RELEASE}' ${pkg} 2>/dev/null`; // dnf/yum/zypper
  const res = await session.run(cmd);
  const installed = res.exitCode === 0 && res.stdout.trim() !== "";
  return { installed, version: installed ? res.stdout.trim() : null };
}

/** The install command line for a manager (assumes a privileged shell). */
export function installCommand(manager: Manager, name: string): string {
  const pkg = name.replace(/[^\w.+-]/g, "");
  switch (manager) {
    case "apt-get":
      return `DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg}`;
    case "pacman":
      return `pacman -S --noconfirm ${pkg}`;
    case "apk":
      return `apk add ${pkg}`;
    case "zypper":
      return `zypper --non-interactive install ${pkg}`;
    default:
      return `${manager} install -y ${pkg}`; // dnf/yum
  }
}

export const model = {
  type: "@shrug/serial-cfgmgmt/package",
  version: "2026.07.22.2",
  globalArguments: z.object({ ...ConnectionGlobals }),
  resources: {
    package: {
      description: "State of a package on the target.",
      schema: PackageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  // install is mutating (assumes a privileged shell); fail before opening the
  // port if the device is not an allowed tty path. query is read-only, unscoped.
  checks: deviceAllowlistCheck(["install"]),

  methods: {
    query: {
      description:
        "Check whether a package is installed on the target (read-only) and record its version.",
      arguments: z.object({
        name: z.string().min(1).describe("Package name."),
      }),
      execute: async (args: { name: string }, context: Ctx) => {
        const g = context.globalArgs;
        const state = await withSession(g, context.logger, async (session) => {
          const manager = await detectManager((c) => session.run(c));
          const q = await queryPackage(session, manager, args.name);
          return { manager, ...q };
        });
        context.logger.info(
          "package query {name} on {device}: installed={installed} version={version}",
          {
            name: args.name,
            device: g.device,
            installed: state.installed,
            version: state.version ?? "-",
          },
        );
        const handle = await context.writeResource(
          "package",
          args.name.replace(/\W+/g, "_"),
          {
            name: args.name,
            manager: state.manager,
            installed: state.installed,
            version: state.version,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    install: {
      description:
        "Install a package on the target (MUTATING; assumes a privileged shell). Idempotent: no-op when already installed.",
      arguments: z.object({
        name: z.string().min(1).describe("Package name."),
      }),
      execute: async (args: { name: string }, context: Ctx) => {
        const g = context.globalArgs;
        const state = await withSession(g, context.logger, async (session) => {
          const manager = await detectManager((c) => session.run(c));
          const before = await queryPackage(session, manager, args.name);
          if (!before.installed) {
            const res = await session.run(installCommand(manager, args.name));
            if (res.exitCode !== 0) {
              throw new Error(
                `Install of "${args.name}" via ${manager} failed (rc=${res.exitCode}): ${
                  res.stdout.slice(-400)
                }`,
              );
            }
          }
          const after = await queryPackage(session, manager, args.name);
          return { manager, ...after };
        });
        context.logger.info(
          "package install {name} on {device}: installed={installed} version={version}",
          {
            name: args.name,
            device: g.device,
            installed: state.installed,
            version: state.version ?? "-",
          },
        );
        const handle = await context.writeResource(
          "package",
          args.name.replace(/\W+/g, "_"),
          {
            name: args.name,
            manager: state.manager,
            installed: state.installed,
            version: state.version,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
  reports: [],
};

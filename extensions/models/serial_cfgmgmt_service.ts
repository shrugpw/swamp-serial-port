/**
 * `@shrug/serial-cfgmgmt/service` — inspect and control systemd services over
 * the serial console. Serial counterpart to `@adam/cfgmgmt/systemd`.
 *
 * `status` is read-only. `start`/`stop`/`enable`/`disable` mutate the target and
 * assume a privileged (root) shell — scaffolding: exercise deliberately.
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

const ServiceSchema = z.object({
  name: z.string(),
  /** systemctl is-active: active | inactive | failed | unknown | … */
  activeState: z.string(),
  /** systemctl is-enabled: enabled | disabled | static | unknown | … */
  enabledState: z.string(),
  checkedAt: z.string(),
});

/** Read `is-active` / `is-enabled` for a unit (both tolerate non-zero exits). */
export async function queryService(
  session: Session,
  name: string,
): Promise<{ activeState: string; enabledState: string }> {
  const unit = name.replace(/[^\w.@:-]/g, "");
  const active = (await session.run(`systemctl is-active ${unit} 2>/dev/null`))
    .stdout.trim() || "unknown";
  const enabled = (await session.run(`systemctl is-enabled ${unit} 2>/dev/null`))
    .stdout.trim() || "unknown";
  return { activeState: active, enabledState: enabled };
}

type Action = "start" | "stop" | "enable" | "disable";

async function control(
  session: Session,
  action: Action,
  name: string,
): Promise<CommandResult> {
  const unit = name.replace(/[^\w.@:-]/g, "");
  return await session.run(`systemctl ${action} ${unit}`);
}

/** Build a mutating method definition for one systemctl action. */
function actionMethod(action: Action) {
  return {
    description:
      `${action[0].toUpperCase()}${action.slice(1)} a systemd unit on the target (MUTATING; assumes a privileged shell). Records resulting state.`,
    arguments: z.object({
      name: z.string().min(1).describe("systemd unit name, e.g. sshd.service."),
    }),
    execute: async (args: { name: string }, context: Ctx) => {
      const g = context.globalArgs;
      const state = await withSession(g, context.logger, async (session) => {
        const res = await control(session, action, args.name);
        if (res.exitCode !== 0) {
          throw new Error(
            `systemctl ${action} ${args.name} failed (rc=${res.exitCode}): ${res.stdout.slice(-400)}`,
          );
        }
        return await queryService(session, args.name);
      });
      context.logger.info(
        "service {action} {name} on {device}: active={active} enabled={enabled}",
        {
          action,
          name: args.name,
          device: g.device,
          active: state.activeState,
          enabled: state.enabledState,
        },
      );
      const handle = await context.writeResource(
        "service",
        args.name.replace(/\W+/g, "_"),
        {
          name: args.name,
          activeState: state.activeState,
          enabledState: state.enabledState,
          checkedAt: new Date().toISOString(),
        },
      );
      return { dataHandles: [handle] };
    },
  };
}

export const model = {
  type: "@shrug/serial-cfgmgmt/service",
  version: "2026.07.22.1",
  globalArguments: z.object({ ...ConnectionGlobals }),
  resources: {
    service: {
      description: "State of a systemd unit on the target.",
      schema: ServiceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    status: {
      description:
        "Read a systemd unit's active and enabled state (read-only).",
      arguments: z.object({
        name: z.string().min(1).describe("systemd unit name, e.g. sshd.service."),
      }),
      execute: async (args: { name: string }, context: Ctx) => {
        const g = context.globalArgs;
        const state = await withSession(
          g,
          context.logger,
          (session) => queryService(session, args.name),
        );
        context.logger.info(
          "service status {name} on {device}: active={active} enabled={enabled}",
          {
            name: args.name,
            device: g.device,
            active: state.activeState,
            enabled: state.enabledState,
          },
        );
        const handle = await context.writeResource(
          "service",
          args.name.replace(/\W+/g, "_"),
          {
            name: args.name,
            activeState: state.activeState,
            enabledState: state.enabledState,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    start: actionMethod("start"),
    stop: actionMethod("stop"),
    enable: actionMethod("enable"),
    disable: actionMethod("disable"),
  },
  reports: [],
};

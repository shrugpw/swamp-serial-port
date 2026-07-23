/**
 * `@shrug/serial-cfgmgmt/exec` — run an arbitrary command over the serial
 * console and capture stdout + exit code.
 *
 * The serial counterpart to `@adam/cfgmgmt/exec`. This is the escape hatch for
 * operations the typed surface (package/service/…) does not yet cover.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  ConnectionGlobals,
  type Ctx,
  withSession,
} from "./serial_cfgmgmt_lib.ts";

const ResultSchema = z.object({
  command: z.string(),
  stdout: z.string(),
  exitCode: z.number().nullable(),
  ranAt: z.string(),
});

export const model = {
  type: "@shrug/serial-cfgmgmt/exec",
  version: "2026.07.22.2",
  globalArguments: z.object({ ...ConnectionGlobals }),
  resources: {
    result: {
      description: "Result of a command run over the serial console.",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description:
        "Run a single command line over the serial console and record its stdout and exit code.",
      arguments: z.object({
        command: z.string().min(1).describe("Command line to run."),
      }),
      execute: async (args: { command: string }, context: Ctx) => {
        const g = context.globalArgs;
        const res = await withSession(
          g,
          context.logger,
          (session) => session.run(args.command),
        );
        context.logger.info("exec on {device}: {cmd} -> rc={rc}", {
          device: g.device,
          cmd: args.command,
          rc: res.exitCode,
        });
        const handle = await context.writeResource(
          "result",
          args.command.replace(/\W+/g, "_").slice(0, 60),
          {
            command: args.command,
            stdout: res.stdout,
            exitCode: res.exitCode,
            ranAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
  reports: [],
};

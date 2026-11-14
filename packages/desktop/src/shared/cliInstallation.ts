import { z } from "zod";

export const cliInstallCommand = "npm install -g @planweave-ai/cli";

export const commandInstallationSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("available"), path: z.string().min(1), version: z.string().min(1) })
    .strict(),
  z.object({ status: z.literal("missing") }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
  z
    .object({ status: z.literal("unavailable"), path: z.string().min(1), error: z.string().min(1) })
    .strict()
]);

export const cliInstallationSchema = z
  .object({
    cli: commandInstallationSchema,
    node: commandInstallationSchema,
    npm: commandInstallationSchema,
    nodeSupported: z.boolean(),
    shellEnvironmentError: z.string().min(1).nullable()
  })
  .strict();

export type CommandInstallation = z.infer<typeof commandInstallationSchema>;
export type CliInstallation = z.infer<typeof cliInstallationSchema>;
export type PlanWeaveCliInstallationApi = {
  detect: () => Promise<CliInstallation>;
  copyInstallCommand: () => Promise<void>;
};

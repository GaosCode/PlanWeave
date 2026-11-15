import { z } from "zod";

export const deploymentArchiveInputSchema = z.strictObject({
  resourceDirectory: z.string().min(1),
  serverJson: z.string(),
  operatorTokenFile: z.string(),
  connectionScript: z.string(),
  restoreScript: z.string()
});

export type DeploymentArchiveInput = z.infer<typeof deploymentArchiveInputSchema>;

export const deploymentArchiveReplySchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    bytes: z.instanceof(ArrayBuffer).refine((bytes) => bytes.byteLength > 0)
  }),
  z.strictObject({ state: z.literal("invalid_project") }),
  z.strictObject({ state: z.literal("failed") })
]);

export type DeploymentArchiveReply = z.infer<typeof deploymentArchiveReplySchema>;

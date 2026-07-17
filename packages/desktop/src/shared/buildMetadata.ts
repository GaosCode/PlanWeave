import { z } from "zod";

export const PLANWEAVE_BUILD_METADATA_FILE = "planweave-build-metadata.json";

export const desktopBuildChannelSchema = z.enum(["development", "release"]);
export const desktopBuildVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "Expected a semantic version."
  );

export const desktopBuildMetadataSchema = z
  .object({
    signedDistribution: z.boolean(),
    channel: desktopBuildChannelSchema,
    version: desktopBuildVersionSchema
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.signedDistribution && metadata.channel !== "release") {
      context.addIssue({
        code: "custom",
        path: ["signedDistribution"],
        message: "Signed distributions must use the release channel."
      });
    }
  });

export type DesktopBuildMetadata = z.infer<typeof desktopBuildMetadataSchema>;

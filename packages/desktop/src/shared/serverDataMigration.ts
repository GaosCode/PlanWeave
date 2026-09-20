import { z } from "zod";

export const serverDataExportSourceIdSchema = z.enum(["this_computer"]);
export type ServerDataExportSourceId = z.infer<typeof serverDataExportSourceIdSchema>;

export const serverDataExportSourceSchema = z
  .object({
    id: serverDataExportSourceIdSchema,
    occupied: z.boolean(),
    running: z.boolean()
  })
  .strict();
export type ServerDataExportSource = z.infer<typeof serverDataExportSourceSchema>;

export const listServerDataExportSourcesResultSchema = z
  .object({
    sources: z.array(serverDataExportSourceSchema)
  })
  .strict();
export type ListServerDataExportSourcesResult = z.infer<
  typeof listServerDataExportSourcesResultSchema
>;

export const exportServerDataArchiveInputSchema = z
  .object({
    sourceId: serverDataExportSourceIdSchema
  })
  .strict();
export type ExportServerDataArchiveInput = z.infer<typeof exportServerDataArchiveInputSchema>;

const serverDataIdentitySnapshotFailureReasonSchema = z.enum([
  "missing_identity",
  "nonpersistent_credentials",
  "snapshot_failed"
]);

export const serverDataIdentitySnapshotResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved") }).strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: serverDataIdentitySnapshotFailureReasonSchema
    })
    .strict()
]);
export type ServerDataIdentitySnapshotResult = z.infer<
  typeof serverDataIdentitySnapshotResultSchema
>;

export const exportServerDataArchiveResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("exported"), fileCount: z.number().int().nonnegative() }).strict(),
  z
    .object({
      status: z.literal("exported_without_identity"),
      fileCount: z.number().int().nonnegative(),
      reason: serverDataIdentitySnapshotFailureReasonSchema
    })
    .strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("running") }).strict(),
  z.object({ status: z.literal("empty") }).strict(),
  z.object({ status: z.literal("resource_limit") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict()
]);
export type ExportServerDataArchiveResult = z.infer<typeof exportServerDataArchiveResultSchema>;

export const restoreServerDataArchiveInputSchema = z
  .object({
    overwrite: z.boolean().optional()
  })
  .strict();
export type RestoreServerDataArchiveInput = z.infer<typeof restoreServerDataArchiveInputSchema>;

export const restoreServerDataArchiveResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("restored"), fileCount: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal("not_restored") }).strict(),
  z.object({ status: z.literal("recovery_required") }).strict(),
  z.object({ status: z.literal("restored_cleanup_failed") }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("running") }).strict(),
  z.object({ status: z.literal("needs_overwrite") }).strict(),
  z.object({ status: z.literal("invalid_archive") }).strict(),
  z.object({ status: z.literal("resource_limit") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict()
]);
export type RestoreServerDataArchiveResult = z.infer<typeof restoreServerDataArchiveResultSchema>;

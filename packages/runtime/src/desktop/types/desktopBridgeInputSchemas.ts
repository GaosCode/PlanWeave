import { z } from "zod";

/**
 * Shared Desktop canvas reference used by graph/layout/run IPC mutators.
 * Path existence and canvas resolution remain runtime domain ownership.
 */
export const desktopCanvasReferenceSchema = z
  .object({
    projectRoot: z.string().min(1),
    canvasId: z.string().min(1).nullable().optional()
  })
  .strict();

export type DesktopCanvasReferenceInput = z.infer<typeof desktopCanvasReferenceSchema>;

export const desktopWatchRegistrationSchema = desktopCanvasReferenceSchema
  .extend({
    workspaceRoot: z.string().min(1),
    registrationId: z.string().min(1)
  })
  .strict();

export type DesktopWatchRegistration = z.infer<typeof desktopWatchRegistrationSchema>;

/**
 * Renderer-to-runtime project identity for project-scoped Desktop operations.
 * The runtime resolves this identity from the registered project store instead
 * of trusting a renderer-provided filesystem path.
 */
export const desktopRegisteredProjectIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((projectId) => projectId === projectId.trim() && !projectId.includes("\0"), {
    message: "must not contain leading or trailing whitespace or NUL characters"
  })
  .refine(
    (projectId) =>
      projectId !== "." &&
      projectId !== ".." &&
      !projectId.includes("/") &&
      !projectId.includes("\\"),
    { message: "must be a registered project directory name" }
  );

export const desktopProjectReferenceSchema = z
  .object({
    projectId: desktopRegisteredProjectIdSchema
  })
  .strict();

export type DesktopProjectReference = z.infer<typeof desktopProjectReferenceSchema>;
export type DesktopProjectReferenceInput = DesktopProjectReference;

export const desktopProjectDoctorRepairConfirmationSchema = z
  .object({
    confirmation: z.literal("repair_project_runtime_drift")
  })
  .strict();

export type DesktopProjectDoctorRepairConfirmation = z.infer<
  typeof desktopProjectDoctorRepairConfirmationSchema
>;
export type DesktopProjectDoctorRepairConfirmationInput = DesktopProjectDoctorRepairConfirmation;

export const desktopPromptSaveOptionsSchema = z
  .object({
    baseGraphVersion: z.string().optional(),
    basePromptHash: z.string().optional()
  })
  .strict();

export type DesktopPromptSaveOptionsInput = z.infer<typeof desktopPromptSaveOptionsSchema>;

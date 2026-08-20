import { z } from "zod";
import { capabilitiesSchema } from "./capabilities.js";
import { opaqueIdentifierSchema } from "./identifiers.js";

export const hostCapacitySchema = z.number().int().min(1).max(128);
export const HOST_RUNTIME_PROJECT_OBSERVATION_MAX_COUNT = 256 as const;

export const hostWorkspaceMappingObservationSchema = z
  .object({
    workspaceId: opaqueIdentifierSchema,
    status: z.enum(["ready", "missing", "invalid"])
  })
  .strict();

export const hostAcpProfileObservationSchema = z
  .object({
    profileId: opaqueIdentifierSchema,
    agentId: opaqueIdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    status: z.enum(["ready", "missing", "invalid"]),
    capabilities: capabilitiesSchema
  })
  .strict();

export const hostReadinessObservationSchema = z
  .object({
    workspaceMappings: z.array(hostWorkspaceMappingObservationSchema).max(128),
    acpProfiles: z.array(hostAcpProfileObservationSchema).max(128),
    runtimeProjects: z
      .array(
        z
          .object({
            workspaceId: opaqueIdentifierSchema,
            projectId: opaqueIdentifierSchema,
            status: z.enum(["ready", "missing", "invalid"])
          })
          .strict()
      )
      .max(HOST_RUNTIME_PROJECT_OBSERVATION_MAX_COUNT)
      .refine(
        (values) =>
          new Set(values.map((value) => `${value.workspaceId}\0${value.projectId}`)).size ===
          values.length,
        "Runtime project observations must be unique."
      )
      .optional()
  })
  .strict();

export type HostAcpProfileObservation = z.infer<typeof hostAcpProfileObservationSchema>;
export type HostReadinessObservation = z.infer<typeof hostReadinessObservationSchema>;
export type HostWorkspaceMappingObservation = z.infer<typeof hostWorkspaceMappingObservationSchema>;
export type HostRuntimeProjectObservation = NonNullable<
  z.infer<typeof hostReadinessObservationSchema>["runtimeProjects"]
>[number];

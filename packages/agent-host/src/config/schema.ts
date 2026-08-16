import { isAbsolute } from "node:path";
import {
  capabilitiesSchema,
  deploymentEndpointSchema,
  hostCapacitySchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol";
import { acpEnvironmentRequirementsSchema } from "@planweave-ai/runtime";
import { z } from "zod";

const relativeWorkspacePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Workspace path must be a safe relative path."
  );

const uniqueBy = <T>(values: readonly T[], key: (value: T) => string) =>
  new Set(values.map(key)).size === values.length;

const sessionValueSchema = z
  .object({
    id: opaqueIdentifierSchema,
    value: z.union([z.string().min(1).max(1024), z.boolean()])
  })
  .strict();
const sessionOptionSchema = z
  .object({
    id: opaqueIdentifierSchema,
    configId: opaqueIdentifierSchema,
    values: z
      .array(sessionValueSchema)
      .max(128)
      .refine((values) => uniqueBy(values, (value) => value.id))
  })
  .strict();

export const agentHostConfigSchema = z
  .object({
    version: z.literal("agent-host-config/v1"),
    coordinator: z
      .object({
        url: z.url(),
        caCertificatePath: z
          .string()
          .min(1)
          .max(4096)
          .refine(isAbsolute, "caCertificatePath must be absolute.")
          .optional(),
        allowInsecureDevelopment: z.boolean().default(false),
        endpoint: deploymentEndpointSchema.optional()
      })
      .strict(),
    dataDirectory: z.string().min(1).refine(isAbsolute, "dataDirectory must be absolute."),
    workspaceRoot: z.string().min(1).refine(isAbsolute, "workspaceRoot must be absolute."),
    host: z
      .object({
        displayName: z.string().trim().min(1).max(128),
        capacity: hostCapacitySchema,
        capabilities: capabilitiesSchema
      })
      .strict(),
    workspaces: z
      .array(z.object({ id: opaqueIdentifierSchema, path: relativeWorkspacePathSchema }).strict())
      .max(128)
      .refine((values) => uniqueBy(values, (value) => value.id), "Workspace ids must be unique."),
    agentProfiles: z
      .array(
        z
          .object({
            id: opaqueIdentifierSchema,
            agentId: opaqueIdentifierSchema,
            command: z
              .string()
              .min(1)
              .max(4096)
              .refine(isAbsolute, "ACP command must be absolute."),
            args: z.array(z.string().max(4096)).max(128),
            environment: acpEnvironmentRequirementsSchema,
            session: z
              .object({
                modes: z
                  .array(
                    z
                      .object({ id: opaqueIdentifierSchema, modeId: opaqueIdentifierSchema })
                      .strict()
                  )
                  .max(128)
                  .refine((values) => uniqueBy(values, (value) => value.id)),
                configOptions: z
                  .array(sessionOptionSchema)
                  .max(128)
                  .refine((values) => uniqueBy(values, (value) => value.id))
              })
              .strict()
              .optional()
          })
          .strict()
      )
      .max(128)
      .refine(
        (values) => uniqueBy(values, (value) => value.id),
        "Agent profile ids must be unique."
      )
  })
  .strict()
  .superRefine((config, context) => {
    const url = new URL(config.coordinator.url);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      context.addIssue({
        code: "custom",
        path: ["coordinator", "url"],
        message: "Coordinator URL must be an origin without credentials, query, or fragment."
      });
    }
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    const development =
      config.coordinator.allowInsecureDevelopment &&
      (url.protocol === "http:" || url.protocol === "ws:") &&
      (config.coordinator.endpoint?.topology === "lan_http" ||
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]");
    if (!secure && !development) {
      context.addIssue({
        code: "custom",
        path: ["coordinator", "url"],
        message:
          "Coordinator URL requires secure transport unless explicit development mode is enabled."
      });
    }
    if (development && config.coordinator.caCertificatePath) {
      context.addIssue({
        code: "custom",
        path: ["coordinator", "caCertificatePath"],
        message: "A custom CA is only supported with secure coordinator transport."
      });
    }
    if (
      config.coordinator.endpoint &&
      transportOrigin(new URL(config.coordinator.endpoint.serverOrigin)) !== transportOrigin(url)
    ) {
      context.addIssue({
        code: "custom",
        path: ["coordinator", "endpoint"],
        message: "Coordinator endpoint origin must match coordinator.url."
      });
    }
  });

function transportOrigin(url: URL): string {
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.origin;
}

export type AgentHostConfig = z.infer<typeof agentHostConfigSchema>;

export function parseAgentHostConfig(input: unknown): AgentHostConfig {
  return agentHostConfigSchema.parse(input);
}

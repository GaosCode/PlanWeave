import { z } from "zod";
import { acpAgentIdSchema, executionHostSchema } from "../types/executor.js";
import { runnerCapabilitySchema } from "../autoRun/runnerContractSchemas.js";

const MAX_PROFILE_COUNT = 128;
const MAX_ENVIRONMENT_COUNT = 128;
const MAX_ARGUMENT_COUNT = 128;
const MIN_SHUTDOWN_STAGE_MS = 10;
const MAX_SHUTDOWN_STAGE_MS = 30_000;
export const ACP_FORCE_EXIT_CONFIRM_MS = 250;
const MAX_CLEANUP_DEADLINE_MS = 120_000;

/** `@deepseek-ai/dsh-subagent-acp` `DEFAULT_DISPOSE_EOF_GRACE_MS`. */
export const ACP_EOF_DRAIN_MS = 6_000;
/** `@deepseek-ai/dsh-subagent-acp` `DEFAULT_DISPOSE_GRACE_MS`. */
export const ACP_TERMINATE_GRACE_MS = 3_000;

const uniqueBy = <T>(values: readonly T[], key: (value: T) => string): boolean =>
  new Set(values.map(key)).size === values.length;

export const acpProfileIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .transform((profileId) => profileId.toLowerCase());

export function acpProfileCanonicalKey(profileId: string): string {
  return acpProfileIdSchema.parse(profileId);
}

export { acpAgentIdSchema };

export const forbiddenAgentEnvironmentNames = new Set([
  "BASH_ENV",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_PATH",
  "NODE_OPTIONS",
  "PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYLIB",
  "RUBYOPT",
  "PERL5LIB",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "DOTNET_STARTUP_HOOKS"
]);

export const agentEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
  .refine(
    (name) => !forbiddenAgentEnvironmentNames.has(name),
    "Reserved path, process loader, and injection environment variables are not allowed."
  );

export const acpEnvironmentRequirementSchema = z
  .object({
    name: agentEnvironmentNameSchema,
    required: z.boolean()
  })
  .strict();
export type AcpEnvironmentRequirement = z.infer<typeof acpEnvironmentRequirementSchema>;

export const acpEnvironmentRequirementsSchema = z
  .array(acpEnvironmentRequirementSchema)
  .max(MAX_ENVIRONMENT_COUNT)
  .refine(
    (variables) => uniqueBy(variables, (variable) => variable.name.toUpperCase()),
    "Environment variable names must be unique."
  )
  .readonly();

export const agentEnvironmentContractSchema = z
  .object({
    variables: acpEnvironmentRequirementsSchema
  })
  .strict();
export type AgentEnvironmentContract = z.infer<typeof agentEnvironmentContractSchema>;

export const acpShutdownPolicySchema = z
  .object({
    eofDrainMs: z.number().int().min(MIN_SHUTDOWN_STAGE_MS).max(MAX_SHUTDOWN_STAGE_MS),
    terminateGraceMs: z.number().int().min(MIN_SHUTDOWN_STAGE_MS).max(MAX_SHUTDOWN_STAGE_MS),
    cleanupDeadlineMs: z.number().int().min(ACP_FORCE_EXIT_CONFIRM_MS).max(MAX_CLEANUP_DEADLINE_MS)
  })
  .strict()
  .superRefine((policy, context) => {
    const minimumDeadline = policy.eofDrainMs + policy.terminateGraceMs + ACP_FORCE_EXIT_CONFIRM_MS;
    if (policy.cleanupDeadlineMs < minimumDeadline) {
      context.addIssue({
        code: "custom",
        path: ["cleanupDeadlineMs"],
        message: `cleanupDeadlineMs must cover eofDrainMs, terminateGraceMs, and ${ACP_FORCE_EXIT_CONFIRM_MS}ms for force-exit confirmation.`
      });
    }
  });
export type AcpShutdownPolicy = z.infer<typeof acpShutdownPolicySchema>;

export const DEFAULT_ACP_SHUTDOWN_POLICY: AcpShutdownPolicy = Object.freeze(
  acpShutdownPolicySchema.parse({
    eofDrainMs: ACP_EOF_DRAIN_MS,
    terminateGraceMs: ACP_TERMINATE_GRACE_MS,
    cleanupDeadlineMs: ACP_EOF_DRAIN_MS + ACP_TERMINATE_GRACE_MS + ACP_FORCE_EXIT_CONFIRM_MS
  })
);

export const acpCapabilityPolicySchema = z
  .object({
    required: z.array(runnerCapabilitySchema).max(32).readonly(),
    optional: z.array(runnerCapabilitySchema).max(32).readonly()
  })
  .strict()
  .superRefine((policy, context) => {
    for (const field of ["required", "optional"] as const) {
      if (!uniqueBy(policy[field], (capability) => capability)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} capabilities must be unique.`
        });
      }
    }
    const required = new Set(policy.required);
    for (const capability of policy.optional) {
      if (required.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["optional"],
          message: `Capability '${capability}' cannot be both required and optional.`
        });
      }
    }
  });
export type AcpCapabilityPolicy = z.infer<typeof acpCapabilityPolicySchema>;

export const acpConnectionModeSchema = z.enum(["dedicated", "shared-project"]);
export type AcpConnectionMode = z.infer<typeof acpConnectionModeSchema>;

export const acpConnectionPolicySchema = z
  .object({ mode: acpConnectionModeSchema.default("dedicated") })
  .strict();
export type AcpConnectionPolicy = z.infer<typeof acpConnectionPolicySchema>;

const acpSessionValueSchema = z.union([z.string().max(1_024), z.boolean()]);
function isCredentialLikeKey(value: string): boolean {
  const compactKey = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const semanticKey = ["value", "raw", "data"].reduce(
    (key, suffix) => (key.endsWith(suffix) ? key.slice(0, -suffix.length) : key),
    compactKey
  );
  return [
    "apikey",
    "accesskey",
    "authtoken",
    "accesstoken",
    "refreshtoken",
    "bearertoken",
    "clientsecret",
    "credential",
    "password",
    "passwd",
    "privatekey",
    "secret",
    "token"
  ].some((marker) => semanticKey.endsWith(marker));
}

const acpSessionConfigOptionsSchema = z
  .record(z.string().min(1).max(256), acpSessionValueSchema)
  .superRefine((options, context) => {
    for (const key of Object.keys(options)) {
      if (isCredentialLikeKey(key)) {
        context.addIssue({
          code: "custom",
          message:
            "ACP session default keys must not carry credentials; reference authentication material through environment names."
        });
      }
    }
  });

export const acpSessionDefaultsSchema = z
  .object({
    modeId: z.string().min(1).max(256).nullable(),
    configOptions: acpSessionConfigOptionsSchema
  })
  .strict();
export type AcpSessionDefaults = z.infer<typeof acpSessionDefaultsSchema>;

const nonNullStringSchema = z
  .string()
  .max(4_096)
  .refine((value) => !value.includes("\0"), "Null bytes are not allowed.");

const acpLaunchArgumentsSchema = z
  .array(nonNullStringSchema)
  .max(MAX_ARGUMENT_COUNT)
  .superRefine((args, context) => {
    args.forEach((argument, index) => {
      const structuredKey = argument.startsWith("-")
        ? argument.replace(/^-+/, "").split("=", 1)[0]
        : argument.includes("=")
          ? argument.split("=", 1)[0]
          : null;
      if (structuredKey && isCredentialLikeKey(structuredKey)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message:
            "ACP launch arguments must not carry credentials in flags; reference authentication material through environment names."
        });
      }
    });
  })
  .readonly();

export const acpProfileDescriptorSchema = z
  .object({
    version: z.literal("planweave.acp-profile/v1"),
    id: acpProfileIdSchema,
    agentId: acpAgentIdSchema,
    displayName: z.string().trim().min(1).max(128),
    host: executionHostSchema,
    launch: z
      .object({
        command: nonNullStringSchema.refine(
          (command) => command.trim().length > 0,
          "ACP command must not be blank."
        ),
        args: acpLaunchArgumentsSchema
      })
      .strict(),
    environment: acpEnvironmentRequirementsSchema,
    sessionDefaults: acpSessionDefaultsSchema.optional(),
    shutdown: acpShutdownPolicySchema,
    capabilities: acpCapabilityPolicySchema,
    connection: acpConnectionPolicySchema
  })
  .strict();
export type AcpProfileDescriptor = z.infer<typeof acpProfileDescriptorSchema>;

export const acpProfileCatalogSchema = z
  .object({
    version: z.literal("planweave.acp-profile-catalog/v1"),
    revision: z.number().int().nonnegative().safe(),
    profiles: z
      .array(acpProfileDescriptorSchema)
      .max(MAX_PROFILE_COUNT)
      .refine(
        (profiles) => uniqueBy(profiles, (profile) => acpProfileCanonicalKey(profile.id)),
        "ACP profile ids must be unique by canonical key."
      )
      .readonly()
  })
  .strict();
export type AcpProfileCatalog = z.infer<typeof acpProfileCatalogSchema>;

export const emptyAcpProfileCatalog = (): AcpProfileCatalog => ({
  version: "planweave.acp-profile-catalog/v1",
  revision: 0,
  profiles: []
});

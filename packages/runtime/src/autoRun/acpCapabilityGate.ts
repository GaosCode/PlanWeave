import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { AcpCapabilityPolicy } from "../acpProfile/schema.js";
import { executorAgentInfoSchema } from "./executorAgentInfo.js";
import { runnerCapabilitySchema, type RunnerCapability } from "./runnerContractSchemas.js";
import { hasAdvertisedAcpAuthenticationMethods } from "./acpAuthentication.js";

export const RUNTIME_REQUIRED_ACP_CAPABILITIES = Object.freeze([
  "session",
  "prompt",
  "cancel",
  "streaming",
  "tool-updates"
] as const satisfies readonly RunnerCapability[]);

const uniqueCapabilitiesSchema = z
  .array(runnerCapabilitySchema)
  .max(32)
  .superRefine((capabilities, context) => {
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({ code: "custom", message: "ACP capabilities must be unique." });
    }
  });

export const acpCapabilitySnapshotSchema = z
  .object({
    version: z.literal("planweave.acp-capabilities/v1"),
    protocolVersion: z.number().int().nonnegative(),
    agentInfo: executorAgentInfoSchema.nullable(),
    required: uniqueCapabilitiesSchema,
    optional: uniqueCapabilitiesSchema,
    available: uniqueCapabilitiesSchema,
    negotiated: uniqueCapabilitiesSchema,
    missing: uniqueCapabilitiesSchema
  })
  .strict()
  .superRefine((snapshot, context) => {
    const required = new Set(snapshot.required);
    const optional = new Set(snapshot.optional);
    const available = new Set(snapshot.available);
    const negotiated = new Set(snapshot.negotiated);
    const missing = new Set(snapshot.missing);
    for (const capability of RUNTIME_REQUIRED_ACP_CAPABILITIES) {
      if (!required.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["required"],
          message: `Runtime baseline capability '${capability}' is required.`
        });
      }
      if (!available.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["available"],
          message: `Runtime baseline capability '${capability}' must be available.`
        });
      }
      if (!negotiated.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["negotiated"],
          message: `Runtime baseline capability '${capability}' must be negotiated.`
        });
      }
      if (missing.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["missing"],
          message: `Runtime baseline capability '${capability}' cannot be missing.`
        });
      }
    }
    for (const capability of optional) {
      if (required.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["optional"],
          message: `Capability '${capability}' cannot be both required and optional.`
        });
      }
    }
    for (const capability of snapshot.required) {
      if (available.has(capability) === missing.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["missing"],
          message: `Required capability '${capability}' must be exactly one of available or missing.`
        });
      }
    }
    for (const capability of snapshot.missing) {
      if (!required.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["missing"],
          message: `Missing capability '${capability}' is not required.`
        });
      }
    }
    for (const capability of snapshot.negotiated) {
      if (!available.has(capability) || !(required.has(capability) || optional.has(capability))) {
        context.addIssue({
          code: "custom",
          path: ["negotiated"],
          message: `Negotiated capability '${capability}' was not both requested and available.`
        });
      }
    }
    for (const capability of [...required, ...optional]) {
      if (available.has(capability) !== negotiated.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["negotiated"],
          message: `Capability '${capability}' must be negotiated exactly when it is requested and available.`
        });
      }
    }
  });
export type AcpCapabilitySnapshot = z.infer<typeof acpCapabilitySnapshotSchema>;

export type AcpCapabilityOperation = {
  readonly sessionStart: "new" | "load";
  /** Contract-only future policy. Persisted profile schema remains dedicated-only. */
  readonly connectionMode: "dedicated" | "shared-project";
};

function orderedUnion(...groups: readonly (readonly RunnerCapability[])[]): RunnerCapability[] {
  return [...new Set(groups.flat())];
}

export function capabilitiesFromInitialize(initialized: InitializeResponse): RunnerCapability[] {
  const capabilities: RunnerCapability[] = [...RUNTIME_REQUIRED_ACP_CAPABILITIES];
  const advertised = initialized.agentCapabilities;
  if (advertised?.promptCapabilities?.image === true) capabilities.push("image");
  if (advertised?.promptCapabilities?.embeddedContext === true) {
    capabilities.push("embedded-context");
  }
  if (advertised?.sessionCapabilities?.close != null) capabilities.push("session-close");
  if (advertised?.loadSession === true) capabilities.push("history-load");
  if (hasAdvertisedAcpAuthenticationMethods(initialized)) capabilities.push("authentication");
  return uniqueCapabilitiesSchema.parse(capabilities);
}

function agentInfoFromInitialize(initialized: InitializeResponse) {
  if (initialized.agentInfo == null) return null;
  return executorAgentInfoSchema.parse({
    name: initialized.agentInfo.name,
    version: initialized.agentInfo.version
  });
}

export function negotiateAcpCapabilities(
  policy: AcpCapabilityPolicy,
  initialized: InitializeResponse,
  operation: AcpCapabilityOperation = { sessionStart: "new", connectionMode: "dedicated" }
): AcpCapabilitySnapshot {
  const dynamicRequired: RunnerCapability[] = [];
  if (operation.sessionStart === "load") dynamicRequired.push("history-load");
  if (operation.connectionMode === "shared-project") dynamicRequired.push("session-close");
  const required = orderedUnion(
    RUNTIME_REQUIRED_ACP_CAPABILITIES,
    policy.required,
    dynamicRequired
  );
  const requiredSet = new Set(required);
  const optional = policy.optional.filter((capability) => !requiredSet.has(capability));
  const available = capabilitiesFromInitialize(initialized);
  const availableSet = new Set(available);
  const negotiated = [...required, ...optional].filter((capability) =>
    availableSet.has(capability)
  );
  const missing = required.filter((capability) => !availableSet.has(capability));
  return acpCapabilitySnapshotSchema.parse({
    version: "planweave.acp-capabilities/v1",
    protocolVersion: initialized.protocolVersion,
    agentInfo: agentInfoFromInitialize(initialized),
    required,
    optional,
    available,
    negotiated,
    missing
  });
}

export class AcpRequiredCapabilityError extends Error {
  constructor(readonly snapshot: AcpCapabilitySnapshot) {
    super(`ACP agent is missing required capabilities: ${snapshot.missing.join(", ")}.`);
    this.name = "AcpRequiredCapabilityError";
  }
}

export function gateAcpCapabilities(
  policy: AcpCapabilityPolicy,
  initialized: InitializeResponse,
  operation?: AcpCapabilityOperation
): AcpCapabilitySnapshot {
  const snapshot = negotiateAcpCapabilities(policy, initialized, operation);
  if (snapshot.missing.length > 0) throw new AcpRequiredCapabilityError(snapshot);
  return snapshot;
}

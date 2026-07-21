import type { AuthMethod, InitializeResponse } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { AcpConnection, AcpOperationOptions } from "./acpConnection.js";

const MAX_AUTH_METHODS = 64;
const MAX_AUTH_METHOD_ID_LENGTH = 256;
const MAX_AUTH_METHOD_NAME_LENGTH = 1024;
const MAX_AUTH_LINK_LENGTH = 4096;
const MAX_ENVIRONMENT_VARIABLES = 128;
const MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH = 256;

export const acpAuthMethodIdSchema = z.string().min(1).max(MAX_AUTH_METHOD_ID_LENGTH);
const acpAuthMethodNameSchema = z.string().min(1).max(MAX_AUTH_METHOD_NAME_LENGTH);
const acpAuthWebLinkSchema = z
  .string()
  .max(MAX_AUTH_LINK_LENGTH)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "ACP authentication link must be a valid HTTP or HTTPS URL."
      });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "ACP authentication link must use the HTTP or HTTPS scheme."
      });
    }
    if (url.username !== "" || url.password !== "") {
      context.addIssue({
        code: "custom",
        message: "ACP authentication link must not contain URL credentials."
      });
    }
  });
const acpEnvironmentVariableNameSchema = z
  .string()
  .min(1)
  .max(MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH);
const acpEnvironmentVariableNamesSchema = z
  .array(acpEnvironmentVariableNameSchema)
  .max(MAX_ENVIRONMENT_VARIABLES)
  .superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "ACP authentication environment variable names must be unique."
      });
    }
  })
  .readonly();

export const acpAuthenticationHintsSchema = z
  .object({
    preferredMethodIds: z.array(acpAuthMethodIdSchema).max(MAX_AUTH_METHODS).readonly(),
    headlessSafeMethodIds: z.array(acpAuthMethodIdSchema).max(MAX_AUTH_METHODS).readonly()
  })
  .strict()
  .superRefine((hints, context) => {
    for (const field of ["preferredMethodIds", "headlessSafeMethodIds"] as const) {
      if (new Set(hints[field]).size !== hints[field].length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must contain unique ACP authentication method ids.`
        });
      }
    }
  });
export type AcpAuthenticationHints = z.infer<typeof acpAuthenticationHintsSchema>;

export const acpAuthMethodSummarySchema = z.discriminatedUnion("type", [
  z
    .object({
      id: acpAuthMethodIdSchema,
      name: acpAuthMethodNameSchema,
      type: z.literal("agent")
    })
    .strict(),
  z
    .object({
      id: acpAuthMethodIdSchema,
      name: acpAuthMethodNameSchema,
      type: z.literal("env_var"),
      requiredVariables: acpEnvironmentVariableNamesSchema,
      missingVariables: acpEnvironmentVariableNamesSchema,
      link: acpAuthWebLinkSchema.nullable()
    })
    .strict(),
  z
    .object({
      id: acpAuthMethodIdSchema,
      name: acpAuthMethodNameSchema,
      type: z.literal("terminal")
    })
    .strict()
]);
export type AcpAuthMethodSummary = z.infer<typeof acpAuthMethodSummarySchema>;

export const acpAuthMethodSummariesSchema = z
  .array(acpAuthMethodSummarySchema)
  .max(MAX_AUTH_METHODS)
  .superRefine((methods, context) => {
    const ids = methods.map((method) => method.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Advertised ACP authentication method ids must be unique."
      });
    }
  })
  .readonly();

export const acpAuthenticationActionReasonSchema = z.enum([
  "missing_credentials",
  "interactive_method",
  "no_safe_method"
]);

export const acpAuthenticationPlanSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("proceed"),
      reason: z.literal("no_auth_methods_advertised")
    })
    .strict(),
  z
    .object({
      kind: z.literal("authenticate"),
      methodId: acpAuthMethodIdSchema,
      method: acpAuthMethodSummarySchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("user_action_required"),
      reason: acpAuthenticationActionReasonSchema,
      methods: acpAuthMethodSummariesSchema
    })
    .strict()
]);
export type AcpAuthenticationPlan = z.infer<typeof acpAuthenticationPlanSchema>;

export const acpAuthenticationOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proceed") }).strict(),
  z
    .object({
      kind: z.literal("authenticated"),
      methodId: acpAuthMethodIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("auth_required"),
      reason: acpAuthenticationActionReasonSchema,
      methods: acpAuthMethodSummariesSchema
    })
    .strict()
]);
export type AcpAuthenticationOutcome = z.infer<typeof acpAuthenticationOutcomeSchema>;

type AcpAuthenticationRequiredOutcome = Extract<
  AcpAuthenticationOutcome,
  { kind: "auth_required" }
>;

function authenticationRequiredMessage(outcome: AcpAuthenticationRequiredOutcome): string {
  if (outcome.reason === "missing_credentials") {
    const missingVariables = [
      ...new Set(
        outcome.methods.flatMap((method) =>
          method.type === "env_var" ? method.missingVariables : []
        )
      )
    ];
    return missingVariables.length > 0
      ? `ACP authentication requires credentials. Configure environment variables ${missingVariables.join(", ")}, then retry.`
      : "ACP authentication requires credentials. Configure the advertised authentication method, then retry.";
  }
  if (outcome.reason === "interactive_method") {
    return "ACP authentication requires user interaction. Complete authentication with the agent, then retry.";
  }
  return "ACP agent did not advertise a headless-safe authentication method. Complete authentication with the agent, then retry.";
}

export class AcpAuthenticationRequiredError extends Error {
  readonly reason: AcpAuthenticationRequiredOutcome["reason"];
  readonly methods: AcpAuthenticationRequiredOutcome["methods"];

  constructor(outcome: AcpAuthenticationRequiredOutcome) {
    super(authenticationRequiredMessage(outcome));
    this.name = "AcpAuthenticationRequiredError";
    this.reason = outcome.reason;
    this.methods = outcome.methods;
  }
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function normalizeAcpAuthMethods(
  authMethods: readonly AuthMethod[] | undefined,
  availableEnvironmentVariables: ReadonlySet<string>
): readonly AcpAuthMethodSummary[] {
  const summaries = (authMethods ?? []).map((method): AcpAuthMethodSummary => {
    if ("type" in method && method.type === "env_var") {
      const requiredVariables = stableUnique(
        method.vars
          .filter((variable) => variable.optional !== true)
          .map((variable) => variable.name)
      );
      return acpAuthMethodSummarySchema.parse({
        id: method.id,
        name: method.name,
        type: "env_var",
        requiredVariables,
        missingVariables: requiredVariables.filter(
          (name) => !availableEnvironmentVariables.has(name)
        ),
        link: method.link ?? null
      });
    }
    if ("type" in method && method.type === "terminal") {
      return acpAuthMethodSummarySchema.parse({
        id: method.id,
        name: method.name,
        type: "terminal"
      });
    }
    return acpAuthMethodSummarySchema.parse({
      id: method.id,
      name: method.name,
      type: "agent"
    });
  });
  return acpAuthMethodSummariesSchema.parse(summaries);
}

function orderMethods(
  methods: readonly AcpAuthMethodSummary[],
  preferredMethodIds: readonly string[]
): readonly AcpAuthMethodSummary[] {
  const methodsById = new Map(methods.map((method) => [method.id, method]));
  const preferred = preferredMethodIds.flatMap((id) => {
    const method = methodsById.get(id);
    if (!method) {
      return [];
    }
    return [method];
  });
  const preferredIds = new Set(preferred.map((method) => method.id));
  return [...preferred, ...methods.filter((method) => !preferredIds.has(method.id))];
}

export function planAcpAuthentication(
  methods: readonly AcpAuthMethodSummary[],
  hints?: AcpAuthenticationHints
): AcpAuthenticationPlan {
  const advertisedMethods = acpAuthMethodSummariesSchema.parse(methods);
  if (advertisedMethods.length === 0) {
    return acpAuthenticationPlanSchema.parse({
      kind: "proceed",
      reason: "no_auth_methods_advertised"
    });
  }

  const parsedHints = acpAuthenticationHintsSchema.parse(
    hints ?? { preferredMethodIds: [], headlessSafeMethodIds: [] }
  );
  const orderedMethods = orderMethods(advertisedMethods, parsedHints.preferredMethodIds);
  const headlessSafeMethodIds = new Set(parsedHints.headlessSafeMethodIds);
  const automaticMethod = orderedMethods.find(
    (method) =>
      (method.type === "env_var" && method.missingVariables.length === 0) ||
      (method.type === "agent" && headlessSafeMethodIds.has(method.id))
  );
  if (automaticMethod) {
    return acpAuthenticationPlanSchema.parse({
      kind: "authenticate",
      methodId: automaticMethod.id,
      method: automaticMethod
    });
  }

  let reason: "missing_credentials" | "interactive_method" | "no_safe_method" = "no_safe_method";
  if (
    orderedMethods.some((method) => method.type === "env_var" && method.missingVariables.length > 0)
  ) {
    reason = "missing_credentials";
  } else if (orderedMethods.some((method) => method.type === "terminal")) {
    reason = "interactive_method";
  }
  return acpAuthenticationPlanSchema.parse({
    kind: "user_action_required",
    reason,
    methods: orderedMethods
  });
}

export function hasAdvertisedAcpAuthenticationMethods(
  initialized: Pick<InitializeResponse, "authMethods">
): boolean {
  return (initialized.authMethods?.length ?? 0) > 0;
}

export interface CoordinateAcpAuthenticationInput {
  connection: Pick<AcpConnection, "authenticate">;
  initialized: Pick<InitializeResponse, "authMethods">;
  hints?: AcpAuthenticationHints;
  availableEnvironmentVariables: ReadonlySet<string>;
  operationOptions?: AcpOperationOptions;
}

export async function coordinateAcpAuthentication(
  input: CoordinateAcpAuthenticationInput
): Promise<AcpAuthenticationOutcome> {
  const methods = normalizeAcpAuthMethods(
    input.initialized.authMethods,
    input.availableEnvironmentVariables
  );
  const plan = planAcpAuthentication(methods, input.hints);
  if (plan.kind === "proceed") {
    return acpAuthenticationOutcomeSchema.parse({ kind: "proceed" });
  }
  if (plan.kind === "user_action_required") {
    return acpAuthenticationOutcomeSchema.parse({
      kind: "auth_required",
      reason: plan.reason,
      methods: plan.methods
    });
  }
  await input.connection.authenticate({ methodId: plan.methodId }, input.operationOptions);
  return acpAuthenticationOutcomeSchema.parse({
    kind: "authenticated",
    methodId: plan.methodId
  });
}

/**
 * Interactive/agent methods often mean "login outside PlanWeave once".
 * Callers may still open a session; if the agent already has credentials, session succeeds.
 * Env-var missing credentials remain hard failures (nothing to probe).
 */
export function mayProbeSessionDespiteAuthRequired(outcome: AcpAuthenticationOutcome): boolean {
  return (
    outcome.kind === "auth_required" &&
    (outcome.reason === "interactive_method" || outcome.reason === "no_safe_method")
  );
}

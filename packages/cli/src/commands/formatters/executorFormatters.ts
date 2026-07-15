import {
  producedExecutorPreflightResultSchema,
  type ExecutorProfileSummary,
  type ProducedExecutorPreflightResult
} from "@planweave-ai/runtime";

function formatAuthenticationHuman(result: ProducedExecutorPreflightResult): string[] {
  const { authentication } = result;
  if (authentication === null) {
    return [];
  }
  if (authentication.status === "not_advertised") {
    return ["authentication: not advertised; protocol authentication was not invoked."];
  }
  if (authentication.status === "authenticated") {
    return [`authentication: authenticated with method '${authentication.methodId}'.`];
  }

  const lines = [`authentication: action required (${authentication.reason}).`];
  for (const method of authentication.methods) {
    lines.push(`method: ${method.name} id=${method.id} type=${method.type}`);
    if (method.type === "env_var") {
      if (method.missingVariables.length > 0) {
        lines.push(`  missing environment variables: ${method.missingVariables.join(", ")}`);
      }
      if (method.link !== null) {
        lines.push(`  authentication link: ${method.link}`);
      }
    }
  }

  if (authentication.reason === "missing_credentials") {
    lines.push(
      "next: configure the missing environment variables, restart the PlanWeave process if needed, then run executor preflight again."
    );
  } else if (authentication.reason === "interactive_method") {
    lines.push(
      "next: complete authentication in the agent's terminal or interactive login outside PlanWeave, then run executor preflight again."
    );
  } else {
    lines.push(
      "next: complete authentication with the agent outside PlanWeave, then run executor preflight again."
    );
  }
  return lines;
}

export function formatExecutorTestJson(result: ProducedExecutorPreflightResult): string {
  return JSON.stringify(producedExecutorPreflightResultSchema.parse(result), null, 2);
}

export function formatExecutorTestHuman(result: ProducedExecutorPreflightResult): string {
  const failedCheck = result.checks.find((check) => check.status === "failed");
  let status = "failed";
  if (result.ok) {
    status = "ok";
  }
  return [
    `${status} ${result.name} agent=${result.agentId ?? "none"} runner=${result.runnerKind ?? "none"}: ${failedCheck?.message ?? result.message}`,
    ...formatAuthenticationHuman(result)
  ].join("\n");
}

export function formatExecutorProfilesHuman(result: ExecutorProfileSummary[]): string {
  return result
    .map(
      (profile) =>
        `${profile.name}\t${profile.adapter}\t${profile.agentId ?? "none"}\t${profile.runnerKind ?? "none"}\t${profile.source}`
    )
    .join("\n");
}

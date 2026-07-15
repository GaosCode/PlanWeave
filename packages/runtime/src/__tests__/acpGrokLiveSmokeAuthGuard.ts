import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { AcpConnection } from "../autoRun/acpConnection.js";

interface CreateGrokLiveSmokeAuthGuardInput {
  connection: Pick<AcpConnection, "authenticate">;
  authMethods: readonly AuthMethod[] | undefined;
  availableEnvironmentVariables: ReadonlySet<string>;
  reject: (status: string) => Error;
}

interface GrokLiveSmokeAuthGuard {
  connection: Pick<AcpConnection, "authenticate">;
  delegatedMethodId: () => string | null;
}

function isExistingXaiApiKeyMethod(
  method: AuthMethod,
  availableEnvironmentVariables: ReadonlySet<string>
): boolean {
  if (!("type" in method) || method.type !== "env_var") {
    return false;
  }
  const requiredVariables = method.vars.filter((variable) => variable.optional !== true);
  return (
    requiredVariables.some((variable) => variable.name === "XAI_API_KEY") &&
    requiredVariables.every((variable) => availableEnvironmentVariables.has(variable.name))
  );
}

function isAgentOwnedCachedTokenMethod(method: AuthMethod): boolean {
  return method.id === "cached_token" && !("type" in method);
}

export function createGrokLiveSmokeAuthGuard(
  input: CreateGrokLiveSmokeAuthGuardInput
): GrokLiveSmokeAuthGuard {
  let delegatedMethodId: string | null = null;
  return {
    connection: {
      authenticate: (request, options) => {
        if (delegatedMethodId !== null) {
          throw input.reject("multiple_authenticate_requests");
        }
        const method = input.authMethods?.find((advertised) => advertised.id === request.methodId);
        if (!method) {
          throw input.reject("requested_method_not_advertised");
        }
        const safeMethod =
          isAgentOwnedCachedTokenMethod(method) ||
          isExistingXaiApiKeyMethod(method, input.availableEnvironmentVariables);
        if (!safeMethod) {
          throw input.reject("requested_method_not_live_smoke_safe");
        }
        delegatedMethodId = request.methodId;
        return input.connection.authenticate(request, options);
      }
    },
    delegatedMethodId: () => delegatedMethodId
  };
}

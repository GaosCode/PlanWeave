import {
  setupCodeRedeemHostResponseSchema,
  type SetupCodeRedeemHostResponse
} from "@planweave-ai/collaboration-protocol/setup";

import { EnrollmentHttpError, requestEnrollmentJson } from "./enrollmentHttpRequest.js";

export type HostSetupCodeRedeemRequest = {
  schemaVersion: "workspace-setup/v1";
  setupCode: string;
  purpose: "host_enrollment";
  displayName: string;
  capabilities: string[];
  capacity: number;
  enrollmentAttemptId: string;
  hostCredentialToken: string;
};

export function resolveSetupCodeRedeemEndpoint(
  coordinatorUrl: string,
  allowInsecureDevelopment = false
): URL {
  const endpoint = new URL(coordinatorUrl);
  if (endpoint.protocol === "wss:") endpoint.protocol = "https:";
  else if (endpoint.protocol === "ws:") {
    if (!allowInsecureDevelopment) throw new Error("agent_host_enrollment_transport_insecure");
    endpoint.protocol = "http:";
  } else if (endpoint.protocol === "http:") {
    if (!allowInsecureDevelopment) throw new Error("agent_host_enrollment_transport_insecure");
  } else if (endpoint.protocol !== "https:") {
    throw new Error("agent_host_enrollment_transport_unsupported");
  }
  endpoint.pathname = "/api/v1/setup-codes/redeem";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

export class HttpAgentHostSetupCodeRedeem {
  private readonly request: typeof fetch;

  constructor(
    private readonly coordinatorUrl: string,
    private readonly options: {
      allowInsecureDevelopment?: boolean;
      request?: typeof fetch;
    } = {}
  ) {
    this.request = options.request ?? fetch;
  }

  async redeem(
    input: HostSetupCodeRedeemRequest,
    signal?: AbortSignal
  ): Promise<SetupCodeRedeemHostResponse> {
    return requestEnrollmentJson(
      this.request,
      () =>
        resolveSetupCodeRedeemEndpoint(
          this.coordinatorUrl,
          this.options.allowInsecureDevelopment === true
        ),
      input,
      (response, payload) => {
        if (!response.ok) throw new EnrollmentHttpError("rejected");
        return setupCodeRedeemHostResponseSchema.parse(payload);
      },
      signal
    );
  }
}

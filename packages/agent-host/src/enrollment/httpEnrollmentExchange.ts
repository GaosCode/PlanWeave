import {
  hostEnrollmentCompletedSchema,
  hostEnrollmentErrorSchema,
  type HostEnrollmentCompleted,
  type HostEnrollmentRequest
} from "@planweave-ai/agent-host-protocol";
import type { AgentHostEnrollmentExchange } from "./enrollmentService.js";

import { EnrollmentHttpError, requestEnrollmentJson } from "./enrollmentHttpRequest.js";

export function resolveHostEnrollmentEndpoint(
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
  endpoint.pathname = "/agent-hosts/enrollments/exchange";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

export class HttpAgentHostEnrollmentExchange implements AgentHostEnrollmentExchange {
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

  async exchange(
    input: HostEnrollmentRequest,
    signal?: AbortSignal
  ): Promise<HostEnrollmentCompleted> {
    return requestEnrollmentJson(
      this.request,
      () =>
        resolveHostEnrollmentEndpoint(
          this.coordinatorUrl,
          this.options.allowInsecureDevelopment === true
        ),
      input,
      (response, payload) => {
        if (!response.ok) {
          hostEnrollmentErrorSchema.parse(payload);
          throw new EnrollmentHttpError("rejected");
        }
        return hostEnrollmentCompletedSchema.parse(payload);
      },
      signal
    );
  }
}

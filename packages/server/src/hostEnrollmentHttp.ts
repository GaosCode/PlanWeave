import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  hostEnrollmentErrorSchema,
  type HostEnrollmentErrorCode
} from "@planweave-ai/agent-host-protocol";
import { HostEnrollmentError, HostEnrollmentService } from "./hostEnrollment.js";
import {
  humanNetworkTransportAllowed,
  type TransportAdmissionPolicy
} from "./insecureTransport.js";

const MAX_BODY_BYTES = 16_384;

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function errorBody(code: HostEnrollmentErrorCode) {
  return hostEnrollmentErrorSchema.parse({
    type: "host.enrollment.error",
    protocolVersion: agentHostProtocolVersion,
    code,
    message: "Agent Host enrollment was rejected.",
    retryable: false
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export type HostEnrollmentHttpOptions = {
  service: HostEnrollmentService;
  transportAdmission: TransportAdmissionPolicy;
};

export async function handleHostEnrollmentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HostEnrollmentHttpOptions
): Promise<boolean> {
  if (request.url !== "/agent-hosts/enrollments/exchange") return false;
  if (!humanNetworkTransportAllowed(request.socket, options.transportAdmission)) {
    send(response, 426, errorBody("insecure_transport"));
    return true;
  }
  if (
    request.method !== "POST" ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")
  ) {
    send(response, 400, errorBody("malformed"));
    return true;
  }
  try {
    send(response, 200, options.service.exchange(await readJson(request)));
  } catch (error) {
    const code = error instanceof HostEnrollmentError ? error.code : "malformed";
    const status =
      code === "conflict" ? 409 : code === "expired" ? 410 : code === "revoked" ? 403 : 400;
    send(response, status, errorBody(code));
  }
  return true;
}

export function attachHostEnrollmentHttp(server: Server, options: HostEnrollmentHttpOptions) {
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handleHostEnrollmentRequest(request, response, options).catch(() => {
      if (!response.headersSent) send(response, 400, errorBody("malformed"));
      else response.destroy();
    });
  };
  server.on("request", listener);
  return { close: () => server.off("request", listener) };
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  managementAuthorizeRequestSchema,
  managementRecoverRequestSchema
} from "@planweave-ai/agent-host-protocol/operator-control";
import type { OperatorTokenRegistry } from "./operatorAuth.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";

function respond(response: ServerResponse, status: number, body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": bytes.length,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

export async function handleOperatorAuthorizationHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: { authorization: OperatorTokenRegistry; transportAdmission: TransportAdmissionPolicy }
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://planweave.invalid").pathname;
  const action = /^\/api\/v1\/management-authorization\/(maintain|authorize|recover)$/.exec(
    pathname
  )?.[1];
  if (!action || request.method !== "POST") return false;
  try {
    if (!options.transportAdmission.allowsOperatorTransport(request.socket)) {
      request.resume();
      respond(response, 426, { error: "operator_insecure_transport" });
      return true;
    }
    const principal = options.authorization.authenticate(request.headers.authorization);
    if (action !== "recover" && !principal) {
      request.resume();
      respond(response, 401, { error: "operator_unauthorized" });
      return true;
    }
    if (action !== "recover" && !principal?.serverAdmin) {
      request.resume();
      respond(response, 403, { error: "operator_server_admin_required" });
      return true;
    }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
      request.resume();
      respond(response, 400, { error: "operator_management_input_invalid" });
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 4096) {
        respond(response, 413, { error: "operator_management_input_invalid" });
        return true;
      }
      chunks.push(bytes);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const service = options.authorization.management;
    if (action === "maintain" && principal) {
      z.object({}).strict().parse(body);
      respond(response, 200, service.maintain(principal));
    } else if (action === "authorize" && principal) {
      const input = managementAuthorizeRequestSchema.parse(body);
      respond(response, 200, service.authorize(principal, input.operatorId, input.newToken));
    } else {
      const input = managementRecoverRequestSchema.parse(body);
      respond(response, 200, service.recover(input.operatorId, input.recoveryCode, input.newToken));
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const allowed = new Set([
      "operator_recovery_invalid",
      "operator_management_authority_unavailable",
      "operator_management_token_conflict",
      "operator_unauthorized",
      "operator_server_admin_required"
    ]);
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      respond(response, 400, { error: "operator_management_input_invalid" });
    } else {
      respond(response, allowed.has(code) ? 403 : 500, {
        error: allowed.has(code) ? code : "operator_management_failed"
      });
    }
  }
  return true;
}

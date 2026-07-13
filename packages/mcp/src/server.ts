import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import type { McpConfig } from "./config.js";
import { createHealthPayload } from "./health.js";
import { createFileOAuthClientStore } from "./oauthClientStore.js";
import { createOAuthProvider, type OAuthProvider } from "./oauth.js";
import { createFileOAuthTokenStore } from "./oauthTokenStore.js";
import { mcpPackageVersion } from "./packageInfo.js";
import { registerPlanweaveTools } from "./toolRegistry.js";

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) {
    return true;
  }
  const authorization = req.headers.authorization;
  return authorization === `Bearer ${token}`;
}

function requestBodySizeStatus(req: IncomingMessage, maxRequestBodyBytes: number): { ok: true } | { ok: false; statusCode: number; error: string } {
  const contentLength = req.headers["content-length"];
  if (Array.isArray(contentLength) || !contentLength) {
    return { ok: false, statusCode: 411, error: "content_length_required" };
  }
  if (!/^\d+$/.test(contentLength)) {
    return { ok: false, statusCode: 400, error: "invalid_content_length" };
  }
  const bodyBytes = Number(contentLength);
  if (!Number.isSafeInteger(bodyBytes)) {
    return { ok: false, statusCode: 400, error: "invalid_content_length" };
  }
  if (bodyBytes > maxRequestBodyBytes) {
    return { ok: false, statusCode: 413, error: "request_body_too_large" };
  }
  return { ok: true };
}

function createPlanweaveMcpServer(config: McpConfig): McpServer {
  const server = new McpServer(
    {
      name: "planweave-mcp",
      version: mcpPackageVersion
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  registerPlanweaveTools(server, { discoveryMode: config.toolDiscoveryMode ?? "default" });
  return server;
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, config: McpConfig, oauth: OAuthProvider | null): Promise<void> {
  if (oauth && !(await oauth.isAuthorized(req))) {
    oauth.writeUnauthorized(req, res);
    return;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!oauth && !isAuthorized(req, config.token)) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const bodySizeStatus = requestBodySizeStatus(req, config.maxRequestBodyBytes);
  if (!bodySizeStatus.ok) {
    writeJson(res, bodySizeStatus.statusCode, { error: bodySizeStatus.error });
    return;
  }

  const mcpServer = createPlanweaveMcpServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on("close", () => {
    void Promise.allSettled([transport.close(), mcpServer.close()]);
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    await Promise.allSettled([transport.close(), mcpServer.close()]);
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? "Internal server error" : "Internal server error"
        },
        id: null
      });
    }
  }
}

export function createPlanweaveMcpHttpServer(config: McpConfig): Server {
  const oauth =
    config.oauth?.enabled === true
      ? createOAuthProvider({
          accessTokenTtlMs: config.oauth.accessTokenTtlMs,
          authorizationCodeTtlMs: config.oauth.authorizationCodeTtlMs,
          clientStore: createFileOAuthClientStore(config.oauth.clientStorePath ?? join(resolvePlanweaveHome(), "config", "mcp-oauth-clients.json")),
          tokenStore: createFileOAuthTokenStore(config.oauth.tokenStorePath ?? join(resolvePlanweaveHome(), "config", "mcp-oauth-tokens.json")),
          maxRequestBodyBytes: config.maxRequestBodyBytes,
          trustProxy: config.trustProxy
        })
      : null;
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", `http://${req.headers.host ?? `${config.host}:${config.port}`}`).pathname;
    if (oauth) {
      void (async () => {
        try {
          if (await oauth.handleRequest(req, res, path)) {
            return;
          }
          if (path === "/healthz" || path === "/readyz") {
            writeJson(res, 200, createHealthPayload(config));
            return;
          }
          if (path === "/mcp") {
            await handleMcpRequest(req, res, config, oauth);
            return;
          }
          writeJson(res, 404, { error: "not_found" });
        } catch (error) {
          if (!res.headersSent) {
            writeJson(res, 500, { error: "internal_server_error" });
          }
        }
      })();
      return;
    }
    if (path === "/healthz" || path === "/readyz") {
      writeJson(res, 200, createHealthPayload(config));
      return;
    }
    if (path === "/mcp") {
      void handleMcpRequest(req, res, config, null);
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  });
}

export async function listenPlanweaveMcpServer(config: McpConfig): Promise<Server> {
  const server = createPlanweaveMcpHttpServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

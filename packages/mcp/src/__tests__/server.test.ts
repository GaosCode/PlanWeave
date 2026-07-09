import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPlanweaveMcpHttpServer } from "../server.js";
import { defaultPlanweaveToolNames, planweaveToolNames } from "../tools.js";
import type { McpConfig } from "../config.js";

const require = createRequire(import.meta.url);
const mcpPackage = require("../../package.json") as { version: string };

let server: Server | undefined;

afterEach(async () => {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server = undefined;
});

async function startServer(token?: string, overrides: Partial<McpConfig> = {}): Promise<string> {
  server = createPlanweaveMcpHttpServer({
    host: "127.0.0.1",
    maxRequestBodyBytes: 1_048_576,
    // Ephemeral port: listen(0) below; config.port is only for health payload.
    port: 0,
    token,
    planweaveHomeFromEnv: true,
    ...overrides
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      server?.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readMcpResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.startsWith("event:")) {
    return JSON.parse(text);
  }
  const dataLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error("SSE response did not contain a data line.");
  }
  return JSON.parse(dataLine.slice("data:".length).trim());
}

describe("PlanWeave MCP HTTP server", () => {
  it("serves unauthenticated health checks without secrets", async () => {
    const baseUrl = await startServer("secret-token");

    const response = await fetch(`${baseUrl}/healthz`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      host: "127.0.0.1",
      port: 0,
      tokenAuthEnabled: true,
      planweaveHomeFromEnv: true
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  it("requires bearer auth on the MCP endpoint when a token is configured", async () => {
    const baseUrl = await startServer("secret-token");

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: {
        "content-type": "application/json"
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects wrong bearer tokens", async () => {
    const baseUrl = await startServer("secret-token");

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json"
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects bearer tokens with a different length", async () => {
    const baseUrl = await startServer("secret-token");

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: {
        authorization: "Bearer short",
        "content-type": "application/json"
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("accepts the configured bearer token", async () => {
    const baseUrl = await startServer("secret-token");

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer secret-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "planweave-mcp-test",
            version: "0.0.0"
          }
        }
      })
    });

    expect(response.status).toBe(200);
    await expect(readMcpResponse(response)).resolves.toMatchObject({
      result: {
        serverInfo: {
          name: "planweave-mcp",
          version: mcpPackage.version
        }
      }
    });
  });

  it("returns a generic MCP 500 without leaking error.message", async () => {
    const connectSpy = vi.spyOn(McpServer.prototype, "connect").mockRejectedValue(new Error("/secret/path leaked"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const baseUrl = await startServer(undefined);
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        headers: {
          "content-type": "application/json"
        }
      });
      const body = (await response.json()) as {
        error: { code: number; message: string; data?: { requestId?: string } };
      };

      expect(response.status).toBe(500);
      expect(body.error).toMatchObject({
        code: -32603,
        message: "internal_server_error"
      });
      expect(body.error.data?.requestId).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain("/secret/path");
      expect(JSON.stringify(body)).not.toContain("leaked");
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("rejects MCP requests above the configured request body limit", async () => {
    server = createPlanweaveMcpHttpServer({
      host: "127.0.0.1",
      maxRequestBodyBytes: 8,
      port: 0,
      planweaveHomeFromEnv: true
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => {
        server?.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: {
        "content-type": "application/json"
      }
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_body_too_large" });
  });

  it("serves basic MCP discovery over POST /mcp", async () => {
    const baseUrl = await startServer(undefined);
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    };

    const initializeResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "planweave-mcp-test",
            version: "0.0.0"
          }
        }
      })
    });

    expect(initializeResponse.status).toBe(200);
    await expect(readMcpResponse(initializeResponse)).resolves.toMatchObject({
      result: {
        serverInfo: {
          name: "planweave-mcp",
          version: mcpPackage.version
        }
      }
    });

    const toolsResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });

    expect(toolsResponse.status).toBe(200);
    const toolsPayload = await readMcpResponse(toolsResponse);
    const tools = (toolsPayload as { result: { tools: Array<{ name: string; outputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }> } }).result.tools;
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames.sort()).toEqual([...defaultPlanweaveToolNames].sort());
    expect(toolNames).not.toEqual(expect.arrayContaining(["get_block_detail", "get_project_graph", "refresh_prompts", "export_plan_package_full"]));
    expect(tools.every((tool) => tool.outputSchema && typeof tool.outputSchema === "object")).toBe(true);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "get_status", annotations: expect.objectContaining({ readOnlyHint: true }) }),
        expect.objectContaining({ name: "get_rendered_prompt", annotations: expect.objectContaining({ readOnlyHint: true }) }),
        expect.objectContaining({ name: "search_project", annotations: expect.objectContaining({ readOnlyHint: true }) }),
        expect.objectContaining({ name: "list_ready_blocks", annotations: expect.objectContaining({ readOnlyHint: true }) }),
        expect.objectContaining({ name: "get_graph_summary", annotations: expect.objectContaining({ readOnlyHint: true }) })
      ])
    );
  });

  it("serves compatibility MCP discovery only when explicitly configured", async () => {
    const baseUrl = await startServer(undefined, { toolDiscoveryMode: "compat" });
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {}
      })
    });

    expect(response.status).toBe(200);
    const payload = await readMcpResponse(response);
    const tools = (payload as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...planweaveToolNames].sort());
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "get_block_detail" }),
        expect.objectContaining({ name: "export_plan_package_full" })
      ])
    );
  });

  it("rejects MCP POSTs with a non-allowlisted Host header", async () => {
    const baseUrl = await startServer(undefined);
    const url = new URL(`${baseUrl}/mcp`);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            host: "evil.example",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    expect(response.statusCode).toBe(421);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid_host" });
  });

  it("rejects MCP POSTs with a cross-site Origin header", async () => {
    const baseUrl = await startServer(undefined);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example"
      }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid_origin" });
  });

  it("accepts MCP POSTs with the loopback Host and no Origin", async () => {
    const baseUrl = await startServer(undefined);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "planweave-mcp-no-origin-test",
            version: "0.0.0"
          }
        }
      })
    });

    expect(response.status).toBe(200);
    await expect(readMcpResponse(response)).resolves.toMatchObject({
      result: {
        serverInfo: {
          name: "planweave-mcp"
        }
      }
    });
  });
});

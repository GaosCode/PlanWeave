import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createPlanweaveMcpHttpServer } from "../server.js";
import { planweaveToolNames } from "../tools.js";

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

async function startServer(token?: string): Promise<string> {
  server = createPlanweaveMcpHttpServer({
    host: "127.0.0.1",
    maxRequestBodyBytes: 1_048_576,
    port: 8787,
    token,
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
      port: 8787,
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

  it("rejects MCP requests above the configured request body limit", async () => {
    server = createPlanweaveMcpHttpServer({
      host: "127.0.0.1",
      maxRequestBodyBytes: 8,
      port: 8787,
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
    expect(tools.map((tool) => tool.name).sort()).toEqual([...planweaveToolNames].sort());
    expect(tools.every((tool) => tool.outputSchema && typeof tool.outputSchema === "object")).toBe(true);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "get_status", annotations: expect.objectContaining({ readOnlyHint: true }) }),
        expect.objectContaining({ name: "get_prompt", annotations: expect.objectContaining({ readOnlyHint: true }) }),
        expect.objectContaining({ name: "search_project", annotations: expect.objectContaining({ readOnlyHint: true }) }),
        expect.objectContaining({ name: "list_ready_blocks", annotations: expect.objectContaining({ readOnlyHint: true }) })
      ])
    );
  });
});

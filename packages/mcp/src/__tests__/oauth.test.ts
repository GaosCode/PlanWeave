import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanweaveMcpHttpServer } from "../server.js";

let server: Server | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await closeServer();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function closeServer(): Promise<void> {
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
}

async function createTempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "planweave-oauth-test-"));
  tempDirs.push(dir);
  return join(dir, "clients.json");
}

async function startOAuthServer(options: { clientStorePath?: string; tokenStorePath?: string } = {}): Promise<string> {
  const { clientStorePath, tokenStorePath } = options;
  const storePath = clientStorePath ?? (await createTempStorePath());
  server = createPlanweaveMcpHttpServer({
    host: "127.0.0.1",
    maxRequestBodyBytes: 1_048_576,
    oauth: {
      enabled: true,
      clientStorePath: storePath,
      tokenStorePath: tokenStorePath ?? (await createTempStorePath())
    },
    port: 8787,
    planweaveHomeFromEnv: true,
    trustProxy: true
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

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
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

async function createOAuthAccessToken(baseUrl: string, resource = `${baseUrl}/mcp`): Promise<string> {
  const registerResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    body: JSON.stringify({
      client_name: "ChatGPT test client",
      redirect_uris: ["https://chat.openai.com/aip/oauth/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    }),
    headers: {
      "content-type": "application/json"
    }
  });
  expect(registerResponse.status).toBe(201);
  const registration = (await registerResponse.json()) as { client_id: string };

  const verifier = "test-verifier-for-planweave-oauth";
  const authorizeResponse = await fetch(
    `${baseUrl}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: "https://chat.openai.com/aip/oauth/callback",
      resource,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "state-1"
    })}`
  );
  expect(authorizeResponse.status).toBe(200);
  await expect(authorizeResponse.text()).resolves.toContain("Authorize PlanWeave MCP");

  const confirmResponse = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: "https://chat.openai.com/aip/oauth/callback",
      resource,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "state-1"
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    }
  });
  expect(confirmResponse.status).toBe(302);
  const location = confirmResponse.headers.get("location");
  expect(location).toBeTruthy();
  const redirectUrl = new URL(location ?? "");
  const code = redirectUrl.searchParams.get("code");
  expect(code).toBeTruthy();
  expect(redirectUrl.searchParams.get("state")).toBe("state-1");

  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: "https://chat.openai.com/aip/oauth/callback",
      resource,
      client_id: registration.client_id,
      code_verifier: verifier
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    }
  });
  expect(tokenResponse.status).toBe(200);
  const token = (await tokenResponse.json()) as { access_token: string; token_type: string };
  expect(token.token_type).toBe("Bearer");
  return token.access_token;
}

describe("PlanWeave MCP OAuth server", () => {
  it("serves protected resource and authorization server metadata", async () => {
    const baseUrl = await startOAuthServer();

    const resourceResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {
      headers: {
        "x-forwarded-host": "example.test",
        "x-forwarded-proto": "https"
      }
    });
    const resourceMetadata = await resourceResponse.json();

    expect(resourceResponse.status).toBe(200);
    expect(resourceMetadata).toMatchObject({
      resource: "https://example.test/mcp",
      authorization_servers: ["https://example.test"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["planweave:mcp"]
    });

    const authResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
      headers: {
        "x-forwarded-host": "example.test",
        "x-forwarded-proto": "https"
      }
    });
    await expect(authResponse.json()).resolves.toMatchObject({
      issuer: "https://example.test",
      authorization_endpoint: "https://example.test/oauth/authorize",
      token_endpoint: "https://example.test/oauth/token",
      registration_endpoint: "https://example.test/oauth/register",
      code_challenge_methods_supported: ["S256"]
    });
  });

  it("requires OAuth bearer tokens on /mcp and advertises resource metadata", async () => {
    const baseUrl = await startOAuthServer();

    const getResponse = await fetch(`${baseUrl}/mcp`);
    expect(getResponse.status).toBe(401);
    expect(getResponse.headers.get("www-authenticate")).toContain("resource_metadata=");
    await expect(getResponse.json()).resolves.toEqual({ error: "unauthorized" });

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: {
        "content-type": "application/json"
      }
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects authorization requests for the wrong resource", async () => {
    const baseUrl = await startOAuthServer();
    const registerResponse = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["https://chat.openai.com/aip/oauth/callback"]
      }),
      headers: {
        "content-type": "application/json"
      }
    });
    const registration = (await registerResponse.json()) as { client_id: string };

    const response = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: registration.client_id,
        redirect_uri: "https://chat.openai.com/aip/oauth/callback",
        resource: "https://wrong.example/mcp",
        code_challenge: pkceChallenge("test-verifier-for-planweave-oauth"),
        code_challenge_method: "S256"
      })}`
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("invalid_resource");
  });

  it("accepts OpenAI tunnel resources and binds the token for local MCP access", async () => {
    const baseUrl = await startOAuthServer();
    const token = await createOAuthAccessToken(baseUrl, "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6a35ec951cf48191bf6b7b899cf8842e");

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "planweave-openai-tunnel-test",
            version: "0.0.0"
          }
        }
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      }
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

  it("persists OAuth access token hashes across MCP server restarts", async () => {
    const clientStorePath = await createTempStorePath();
    const tokenStorePath = await createTempStorePath();
    const resource = "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6a35ec951cf48191bf6b7b899cf8842e";
    const firstBaseUrl = await startOAuthServer({ clientStorePath, tokenStorePath });
    const token = await createOAuthAccessToken(firstBaseUrl, resource);
    const storedTokens = await readFile(tokenStorePath, "utf8");
    expect(storedTokens).not.toContain(token);
    expect(storedTokens).toContain("tokenHash");
    await closeServer();

    const secondBaseUrl = await startOAuthServer({ clientStorePath, tokenStorePath });
    const response = await fetch(`${secondBaseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "planweave-persistent-token-test",
            version: "0.0.0"
          }
        }
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      }
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

  it("persists dynamic client registrations across MCP server restarts", async () => {
    const clientStorePath = await createTempStorePath();
    const firstBaseUrl = await startOAuthServer({ clientStorePath });
    const registerResponse = await fetch(`${firstBaseUrl}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({
        client_name: "ChatGPT persistent test client",
        redirect_uris: ["https://chatgpt.com/connector/oauth/callback"]
      }),
      headers: {
        "content-type": "application/json"
      }
    });
    expect(registerResponse.status).toBe(201);
    const registration = (await registerResponse.json()) as { client_id: string };
    await closeServer();

    const secondBaseUrl = await startOAuthServer({ clientStorePath });
    const response = await fetch(
      `${secondBaseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: registration.client_id,
        redirect_uri: "https://chatgpt.com/connector/oauth/callback",
        resource: `${secondBaseUrl}/mcp`,
        code_challenge: pkceChallenge("test-verifier-for-planweave-oauth"),
        code_challenge_method: "S256"
      })}`
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Authorize PlanWeave MCP");
  });

  it("recovers existing planweave public clients after upgrading from memory-only storage", async () => {
    const clientStorePath = await createTempStorePath();
    const baseUrl = await startOAuthServer({ clientStorePath });
    const clientId = "planweave_knEd2zhWP2HVSJqSYWKkkEQpzwL0BCkX";
    const redirectUri = "https://chatgpt.com/connector/oauth/QTOb4VcHdCsW";
    const authorizeParams = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6a35ec951cf48191bf6b7b899cf8842e",
      scope: "planweave:mcp",
      code_challenge: pkceChallenge("test-verifier-for-planweave-oauth"),
      code_challenge_method: "S256"
    };
    const response = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(authorizeParams)}`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Authorize PlanWeave MCP");
    await expect(readFile(clientStorePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const confirmResponse = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams(authorizeParams),
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      }
    });

    expect(confirmResponse.status).toBe(302);
    const stored = await readFile(clientStorePath, "utf8");
    expect(stored).not.toContain("access_token");
    expect(stored).not.toContain("code_verifier");
    expect(stored).not.toContain("code_challenge");
    expect(JSON.parse(stored)).toMatchObject({
      version: 1,
      clients: [
        {
          clientId,
          redirectUris: [redirectUri]
        }
      ]
    });
  });

  it("does not recover non-planweave public clients", async () => {
    const clientStorePath = await createTempStorePath();
    const baseUrl = await startOAuthServer({ clientStorePath });
    const response = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "external-client-id",
        redirect_uri: "https://chatgpt.com/connector/oauth/QTOb4VcHdCsW",
        resource: "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6a35ec951cf48191bf6b7b899cf8842e",
        scope: "planweave:mcp",
        code_challenge: pkceChallenge("test-verifier-for-planweave-oauth"),
        code_challenge_method: "S256"
      })}`
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("invalid_client");
    await expect(readFile(clientStorePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid redirect URIs during dynamic client registration", async () => {
    const baseUrl = await startOAuthServer();

    const response = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["javascript:alert(1)"]
      }),
      headers: {
        "content-type": "application/json"
      }
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_redirect_uris" });
  });

  it("accepts tokens from DCR authorization code flow on /mcp", async () => {
    const baseUrl = await startOAuthServer();
    const token = await createOAuthAccessToken(baseUrl);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "planweave-oauth-test",
            version: "0.0.0"
          }
        }
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      }
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

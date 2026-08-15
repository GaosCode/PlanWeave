import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function startOAuthServer(
  options: {
    clientStorePath?: string;
    clock?: { now: number };
    tokenGenerator?: (bytes: number) => string;
    tokenStorePath?: string;
    trustForwardedHeaders?: boolean;
  } = {}
): Promise<string> {
  const {
    clientStorePath,
    clock,
    tokenGenerator,
    tokenStorePath,
    trustForwardedHeaders = false
  } = options;
  const storePath = clientStorePath ?? (await createTempStorePath());
  server = createPlanweaveMcpHttpServer(
    {
      host: "127.0.0.1",
      maxRequestBodyBytes: 1_048_576,
      oauth: {
        enabled: true,
        clientStorePath: storePath,
        tokenStorePath: tokenStorePath ?? (await createTempStorePath()),
        ...(clock ? { authorizationCodeTtlMs: 1_000 } : {})
      },
      port: 0,
      planweaveHomeFromEnv: true,
      trustForwardedHeaders
    },
    {
      ...(clock ? { oauthTransientStateNow: () => clock.now } : {}),
      ...(tokenGenerator ? { oauthTransientStateToken: tokenGenerator } : {})
    }
  );
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

function extractCsrfNonce(html: string): string {
  const match = /name="csrf_nonce" value="([^"]+)"/.exec(html);
  if (!match?.[1]) {
    throw new Error("consent page did not include csrf_nonce");
  }
  return match[1];
}

async function beginTunnelConsent(
  baseUrl: string,
  publicOrigin: string
): Promise<{ authorizeParams: Record<string, string>; csrfNonce: string }> {
  const publicUrl = new URL(publicOrigin);
  const forwardedHeaders = {
    "x-forwarded-host": publicUrl.host,
    "x-forwarded-proto": publicUrl.protocol.slice(0, -1)
  };
  const registerResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    body: JSON.stringify({
      redirect_uris: ["https://chat.openai.com/aip/oauth/callback"]
    }),
    headers: {
      "content-type": "application/json",
      ...forwardedHeaders
    }
  });
  expect(registerResponse.status).toBe(201);
  const registration = (await registerResponse.json()) as { client_id: string };
  const authorizeParams = {
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: "https://chat.openai.com/aip/oauth/callback",
    resource: `${publicOrigin}/mcp`,
    code_challenge: pkceChallenge("tunnel-verifier-for-planweave-oauth"),
    code_challenge_method: "S256",
    state: "tunnel-state"
  };
  const authorizeResponse = await fetch(
    `${baseUrl}/oauth/authorize?${new URLSearchParams(authorizeParams)}`,
    { headers: forwardedHeaders }
  );
  expect(authorizeResponse.status).toBe(200);
  const authorizeHtml = await authorizeResponse.text();
  expect(authorizeHtml).toContain("Authorize PlanWeave MCP");
  return { authorizeParams, csrfNonce: extractCsrfNonce(authorizeHtml) };
}

async function createOAuthAccessToken(
  baseUrl: string,
  resource = `${baseUrl}/mcp`
): Promise<string> {
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
  const authorizeHtml = await authorizeResponse.text();
  expect(authorizeHtml).toContain("Authorize PlanWeave MCP");
  const csrfNonce = extractCsrfNonce(authorizeHtml);

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
      state: "state-1",
      csrf_nonce: csrfNonce
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
    const baseUrl = await startOAuthServer({ trustForwardedHeaders: true });

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

  it("uses one trusted forwarded origin across register, authorize, and consent confirm", async () => {
    const baseUrl = await startOAuthServer({ trustForwardedHeaders: true });
    const publicOrigin = "https://tunnel.example";
    const { authorizeParams, csrfNonce } = await beginTunnelConsent(baseUrl, publicOrigin);

    const confirmResponse = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ ...authorizeParams, csrf_nonce: csrfNonce }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: publicOrigin,
        "x-forwarded-host": "tunnel.example",
        "x-forwarded-proto": "https"
      }
    });

    expect(confirmResponse.status).toBe(302);
    expect(confirmResponse.headers.get("location")).toMatch(
      /^https:\/\/chat\.openai\.com\/aip\/oauth\/callback\?/
    );
  });

  it("rejects forwarded OAuth routes when the local server does not trust proxy headers", async () => {
    const baseUrl = await startOAuthServer();
    const response = await fetch(`${baseUrl}/oauth/authorize`, {
      headers: {
        "x-forwarded-host": "tunnel.example",
        "x-forwarded-proto": "https"
      }
    });

    expect(response.status).toBe(421);
    await expect(response.json()).resolves.toEqual({ error: "invalid_host" });
  });

  it("rejects a cross-origin consent POST against the trusted forwarded origin", async () => {
    const baseUrl = await startOAuthServer({ trustForwardedHeaders: true });
    const publicOrigin = "https://tunnel.example";
    const { authorizeParams, csrfNonce } = await beginTunnelConsent(baseUrl, publicOrigin);

    const response = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ ...authorizeParams, csrf_nonce: csrfNonce }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        "x-forwarded-host": "tunnel.example",
        "x-forwarded-proto": "https"
      }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid_origin" });
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
    const baseUrl = await startOAuthServer({ trustForwardedHeaders: true });
    const publicOrigin = "https://tunnel-service.gateway.unified-0.internal.api.openai.org";
    const token = await createOAuthAccessToken(
      baseUrl,
      `${publicOrigin}/v1/mcp/tunnel_6a35ec951cf48191bf6b7b899cf8842e`
    );

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
        "content-type": "application/json",
        "x-forwarded-proto": "https"
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
    const resource =
      "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6a35ec951cf48191bf6b7b899cf8842e";
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
      resource:
        "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6a35ec951cf48191bf6b7b899cf8842e",
      scope: "planweave:mcp",
      code_challenge: pkceChallenge("test-verifier-for-planweave-oauth"),
      code_challenge_method: "S256"
    };
    const response = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(authorizeParams)}`
    );

    expect(response.status).toBe(200);
    const authorizeHtml = await response.text();
    expect(authorizeHtml).toContain("Authorize PlanWeave MCP");
    await expect(readFile(clientStorePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const confirmResponse = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        ...authorizeParams,
        csrf_nonce: extractCsrfNonce(authorizeHtml)
      }),
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
        resource:
          "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6a35ec951cf48191bf6b7b899cf8842e",
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

  it("rejects OAuth consent confirm without a CSRF nonce", async () => {
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
    const verifier = "test-verifier-for-planweave-oauth";
    const authorizeParams = {
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: "https://chat.openai.com/aip/oauth/callback",
      resource: `${baseUrl}/mcp`,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "state-csrf"
    };
    const authorizeResponse = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(authorizeParams)}`
    );
    expect(authorizeResponse.status).toBe(200);
    await authorizeResponse.text();

    const confirmResponse = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams(authorizeParams),
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      }
    });

    expect(confirmResponse.status).toBe(400);
    await expect(confirmResponse.json()).resolves.toEqual({ error: "invalid_csrf_nonce" });
  });

  it("rejects reused OAuth consent CSRF nonces", async () => {
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
    const verifier = "test-verifier-for-planweave-oauth";
    const authorizeParams = {
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: "https://chat.openai.com/aip/oauth/callback",
      resource: `${baseUrl}/mcp`,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "state-reuse"
    };
    const authorizeResponse = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(authorizeParams)}`
    );
    const authorizeHtml = await authorizeResponse.text();
    const csrfNonce = extractCsrfNonce(authorizeHtml);
    const confirmBody = new URLSearchParams({ ...authorizeParams, csrf_nonce: csrfNonce });

    const firstConfirm = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: confirmBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      }
    });
    expect(firstConfirm.status).toBe(302);

    const reusedConfirm = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: confirmBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      }
    });
    expect(reusedConfirm.status).toBe(400);
    await expect(reusedConfirm.json()).resolves.toEqual({ error: "invalid_csrf_nonce" });
  });

  it("rejects OAuth consent confirm with a cross-site Origin", async () => {
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
    const verifier = "test-verifier-for-planweave-oauth";
    const authorizeParams = {
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: "https://chat.openai.com/aip/oauth/callback",
      resource: `${baseUrl}/mcp`,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256"
    };
    const authorizeResponse = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(authorizeParams)}`
    );
    const csrfNonce = extractCsrfNonce(await authorizeResponse.text());

    const confirmResponse = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ ...authorizeParams, csrf_nonce: csrfNonce }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example"
      }
    });

    expect(confirmResponse.status).toBe(403);
    await expect(confirmResponse.json()).resolves.toEqual({ error: "invalid_origin" });
  });

  it("bounds consent sessions without evicting live nonces and prunes expired sessions", async () => {
    const clock = { now: 10_000 };
    const baseUrl = await startOAuthServer({ clock });
    const { params } = await transientStateClient(baseUrl);
    let firstNonce = "";

    for (let index = 0; index < 128; index += 1) {
      const response = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`);
      expect(response.status).toBe(200);
      const nonce = extractCsrfNonce(await response.text());
      if (index === 0) {
        firstNonce = nonce;
      }
    }

    const unavailable = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("content-type")).toContain("text/html");
    const unavailableHtml = await unavailable.text();
    expect(unavailableHtml).toContain("temporarily_unavailable");
    expect(unavailableHtml).not.toContain(firstNonce);

    const liveConfirm = await transientStateConfirm(baseUrl, params, firstNonce);
    expect(liveConfirm.status).toBe(302);
    const reusedConfirm = await transientStateConfirm(baseUrl, params, firstNonce);
    expect(reusedConfirm.status).toBe(400);
    await expect(reusedConfirm.json()).resolves.toEqual({ error: "invalid_csrf_nonce" });

    const replacementBeforeExpiry = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`
    );
    expect(replacementBeforeExpiry.status).toBe(200);
    const expiredNonce = extractCsrfNonce(await replacementBeforeExpiry.text());
    clock.now += 1_001;

    const replacementAfterExpiry = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`
    );
    expect(replacementAfterExpiry.status).toBe(200);
    const expiredConfirm = await transientStateConfirm(baseUrl, params, expiredNonce);
    expect(expiredConfirm.status).toBe(400);
    await expect(expiredConfirm.json()).resolves.toEqual({ error: "invalid_csrf_nonce" });
  });

  it("bounds codes and preserves valid codes across malformed and mismatched exchanges", async () => {
    const clock = { now: 20_000 };
    const baseUrl = await startOAuthServer({ clock });
    const { clientId, params } = await transientStateClient(baseUrl);
    let firstCode = "";

    for (let index = 0; index < 128; index += 1) {
      const code = await transientStateCode(baseUrl, params);
      if (index === 0) {
        firstCode = code;
      }
    }

    const fullAuthorize = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`);
    expect(fullAuthorize.status).toBe(200);
    const fullNonce = extractCsrfNonce(await fullAuthorize.text());
    const unavailable = await transientStateConfirm(baseUrl, params, fullNonce);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    const unavailableRetry = await transientStateConfirm(baseUrl, params, fullNonce);
    expect(unavailableRetry.status).toBe(400);
    await expect(unavailableRetry.json()).resolves.toEqual({ error: "invalid_csrf_nonce" });

    const malformed = await transientStateExchange(baseUrl, clientId, "");
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "invalid_grant" });
    for (const overrides of [
      { client_id: "different-client" },
      { redirect_uri: "https://chat.openai.com/aip/oauth/different-callback" },
      { resource: "https://wrong.example/mcp" },
      { code_verifier: "wrong-verifier" }
    ]) {
      const mismatch = await transientStateExchange(baseUrl, clientId, firstCode, overrides);
      expect(mismatch.status).toBe(400);
      await expect(mismatch.json()).resolves.toEqual({ error: "invalid_grant" });
    }

    const validExchange = await transientStateExchange(baseUrl, clientId, firstCode);
    expect(validExchange.status).toBe(200);
    const reusedCode = await transientStateExchange(baseUrl, clientId, firstCode);
    expect(reusedCode.status).toBe(400);
    await expect(reusedCode.json()).resolves.toEqual({ error: "invalid_grant" });

    const replacementCode = await transientStateCode(baseUrl, params);
    clock.now += 1_001;
    await transientStateCode(baseUrl, params);
    const expiredExchange = await transientStateExchange(baseUrl, clientId, replacementCode);
    expect(expiredExchange.status).toBe(400);
    await expect(expiredExchange.json()).resolves.toEqual({ error: "invalid_grant" });
  });

  it("retries transient token collisions without replacing consent sessions or codes", async () => {
    const tokens = ["nonce-a", "nonce-a", "nonce-b", "code-a", "code-a", "code-b"];
    const tokenGenerator = vi.fn(() => {
      const token = tokens.shift();
      if (!token) {
        throw new Error("transient token test sequence exhausted");
      }
      return token;
    });
    const baseUrl = await startOAuthServer({ tokenGenerator });
    const { params } = await transientStateClient(baseUrl);

    const firstAuthorize = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`);
    const firstNonce = extractCsrfNonce(await firstAuthorize.text());
    const secondAuthorize = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`
    );
    const secondNonce = extractCsrfNonce(await secondAuthorize.text());
    expect([firstNonce, secondNonce]).toEqual(["nonce-a", "nonce-b"]);

    const firstConfirm = await transientStateConfirm(baseUrl, params, firstNonce);
    const secondConfirm = await transientStateConfirm(baseUrl, params, secondNonce);
    expect([
      transientStateCodeFromResponse(firstConfirm),
      transientStateCodeFromResponse(secondConfirm)
    ]).toEqual(["code-a", "code-b"]);
    expect(tokenGenerator).toHaveBeenCalledTimes(6);
  });

  it("returns 503 after bounded collision retries without overwriting either transient map", async () => {
    const repeatedToken = "repeated-transient-token";
    const tokenGenerator = vi.fn(() => repeatedToken);
    const baseUrl = await startOAuthServer({ tokenGenerator });
    const { clientId, params } = await transientStateClient(baseUrl);

    const firstAuthorize = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`);
    const firstNonce = extractCsrfNonce(await firstAuthorize.text());
    const unavailableAuthorize = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`
    );
    expect(unavailableAuthorize.status).toBe(503);
    expect(await unavailableAuthorize.text()).not.toContain(repeatedToken);
    expect(tokenGenerator).toHaveBeenCalledTimes(9);

    const firstConfirm = await transientStateConfirm(baseUrl, params, firstNonce);
    expect(firstConfirm.status).toBe(302);
    const firstCode = transientStateCodeFromResponse(firstConfirm);
    const nextAuthorize = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`);
    const nextNonce = extractCsrfNonce(await nextAuthorize.text());
    const unavailableConfirm = await transientStateConfirm(baseUrl, params, nextNonce);
    expect(unavailableConfirm.status).toBe(503);
    await expect(unavailableConfirm.json()).resolves.toEqual({
      error: "temporarily_unavailable"
    });
    expect(tokenGenerator).toHaveBeenCalledTimes(19);

    const preservedCodeExchange = await transientStateExchange(baseUrl, clientId, firstCode);
    expect(preservedCodeExchange.status).toBe(200);
  });
});

async function transientStateClient(
  baseUrl: string
): Promise<{ clientId: string; params: Record<string, string> }> {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    body: JSON.stringify({ redirect_uris: ["https://chat.openai.com/aip/oauth/callback"] }),
    headers: { "content-type": "application/json" }
  });
  expect(response.status).toBe(201);
  const clientId = ((await response.json()) as { client_id: string }).client_id;
  return {
    clientId,
    params: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://chat.openai.com/aip/oauth/callback",
      resource: `${baseUrl}/mcp`,
      code_challenge: pkceChallenge("transient-state-verifier-for-planweave-oauth"),
      code_challenge_method: "S256"
    }
  };
}

async function transientStateConfirm(
  baseUrl: string,
  params: Record<string, string>,
  csrfNonce: string
): Promise<Response> {
  return fetch(`${baseUrl}/oauth/authorize/confirm`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ ...params, csrf_nonce: csrfNonce }),
    headers: { "content-type": "application/x-www-form-urlencoded" }
  });
}

async function transientStateCode(
  baseUrl: string,
  params: Record<string, string>
): Promise<string> {
  const authorize = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(params)}`);
  expect(authorize.status).toBe(200);
  const confirm = await transientStateConfirm(
    baseUrl,
    params,
    extractCsrfNonce(await authorize.text())
  );
  expect(confirm.status).toBe(302);
  return transientStateCodeFromResponse(confirm);
}

function transientStateCodeFromResponse(response: Response): string {
  const location = response.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (!code) {
    throw new Error("authorization redirect did not include a code");
  }
  return code;
}

async function transientStateExchange(
  baseUrl: string,
  clientId: string,
  code: string,
  overrides: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chat.openai.com/aip/oauth/callback",
      resource: `${baseUrl}/mcp`,
      client_id: clientId,
      code_verifier: "transient-state-verifier-for-planweave-oauth",
      ...overrides
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" }
  });
}

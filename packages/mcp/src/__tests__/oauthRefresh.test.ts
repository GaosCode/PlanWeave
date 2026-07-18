import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanweaveMcpHttpServer } from "../server.js";

let server: Server | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startOAuthServer(): Promise<string> {
  const storeDir = await mkdtemp(join(tmpdir(), "planweave-oauth-refresh-"));
  tempDirs.push(storeDir);
  server = createPlanweaveMcpHttpServer({
    host: "127.0.0.1",
    maxRequestBodyBytes: 1_048_576,
    oauth: {
      enabled: true,
      clientStorePath: join(storeDir, "clients.json"),
      tokenStorePath: join(storeDir, "tokens.json")
    },
    port: 0,
    planweaveHomeFromEnv: true,
    trustForwardedHeaders: false
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      server?.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function extractCsrfNonce(html: string): string {
  const match = /name="csrf_nonce" value="([^"]+)"/.exec(html);
  if (!match?.[1]) {
    throw new Error("consent page did not include csrf_nonce");
  }
  return match[1];
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

describe("PlanWeave MCP OAuth refresh flow", () => {
  it("advertises offline access and rotates refresh tokens for ChatGPT", async () => {
    const baseUrl = await startOAuthServer();
    const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    await expect(metadataResponse.json()).resolves.toMatchObject({
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: ["planweave:mcp", "offline_access"]
    });

    const redirectUri = "https://chatgpt.com/connector/oauth/callback";
    const registerResponse = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      }),
      headers: { "content-type": "application/json" }
    });
    expect(registerResponse.status).toBe(201);
    const registration = (await registerResponse.json()) as {
      client_id: string;
      grant_types: string[];
    };
    expect(registration.grant_types).toEqual(["authorization_code", "refresh_token"]);

    const verifier = "chatgpt-refresh-verifier-for-planweave";
    const authorizeParams = {
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      resource: `${baseUrl}/mcp`,
      scope: "planweave:mcp offline_access",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "chatgpt-state"
    };
    const authorizeResponse = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams(authorizeParams)}`
    );
    expect(authorizeResponse.status).toBe(200);
    const authorizeHtml = await authorizeResponse.text();

    const confirmResponse = await fetch(`${baseUrl}/oauth/authorize/confirm`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        ...authorizeParams,
        csrf_nonce: extractCsrfNonce(authorizeHtml)
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
    expect(confirmResponse.status).toBe(302);
    const authorizationCode = new URL(
      confirmResponse.headers.get("location") ?? ""
    ).searchParams.get("code");
    expect(authorizationCode).toBeTruthy();

    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode ?? "",
        redirect_uri: redirectUri,
        resource: `${baseUrl}/mcp`,
        client_id: registration.client_id,
        code_verifier: verifier
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope).toBe("planweave:mcp offline_access");

    const wrongClientResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: "different-client",
        resource: `${baseUrl}/mcp`
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
    expect(wrongClientResponse.status).toBe(400);
    await expect(wrongClientResponse.json()).resolves.toEqual({ error: "invalid_grant" });

    const refreshResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: registration.client_id,
        resource: `${baseUrl}/mcp`
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    const reusedRefreshResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: registration.client_id,
        resource: `${baseUrl}/mcp`
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
    expect(reusedRefreshResponse.status).toBe(400);
    await expect(reusedRefreshResponse.json()).resolves.toEqual({ error: "invalid_grant" });

    const toolsResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${refreshed.access_token}`,
        "content-type": "application/json"
      }
    });
    expect(toolsResponse.status).toBe(200);
    await expect(readMcpResponse(toolsResponse)).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([expect.objectContaining({ name: "get_status" })])
      }
    });
  });
});

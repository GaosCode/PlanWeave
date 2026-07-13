import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpOAuthConfig } from "./config.js";
import { createMemoryOAuthClientStore, type OAuthClientStore, type RegisteredClient } from "./oauthClientStore.js";
import { createMemoryOAuthTokenStore, type OAuthTokenStore } from "./oauthTokenStore.js";
import { validateAuthorizeParams, validateAuthorizeSearchParams } from "./oauthAuthorization.js";
import { consentPage, errorPage } from "./oauthConsent.js";
import { readFormBody, readJsonBody, requestContext, writeHtml, writeJson } from "./oauthHttp.js";
import { authorizationServerMetadata, defaultOAuthScope, protectedResourceMetadata } from "./oauthMetadata.js";
import { bearerToken, randomToken, tokenHash, verifyPkce } from "./oauthSecurity.js";
import { isAllowedOAuthResource, isAllowedRedirectUri, optionalString, scopeIncludesDefault, stringArray } from "./oauthValidation.js";

const defaultAccessTokenTtlMs = 60 * 60 * 1000;
const defaultAuthorizationCodeTtlMs = 5 * 60 * 1000;

type AuthorizationCode = {
  clientId: string;
  codeChallenge: string;
  expiresAt: number;
  redirectUri: string;
  resource: string;
  scope: string;
};

type OAuthProviderOptions = Pick<McpOAuthConfig, "accessTokenTtlMs" | "authorizationCodeTtlMs"> & {
  clientStore?: OAuthClientStore;
  tokenStore?: OAuthTokenStore;
  maxRequestBodyBytes: number;
  trustProxy?: boolean;
};

export type OAuthProvider = ReturnType<typeof createOAuthProvider>;

export function createOAuthProvider(options: OAuthProviderOptions) {
  const clientStore = options.clientStore ?? createMemoryOAuthClientStore();
  const tokenStore = options.tokenStore ?? createMemoryOAuthTokenStore();
  const authorizationCodes = new Map<string, AuthorizationCode>();
  const accessTokenTtlMs = options.accessTokenTtlMs ?? defaultAccessTokenTtlMs;
  const authorizationCodeTtlMs = options.authorizationCodeTtlMs ?? defaultAuthorizationCodeTtlMs;
  const trustProxy = options.trustProxy === true;

  return {
    async handleRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
        writeJson(res, 200, protectedResourceMetadata(requestContext(req, { trustProxy })));
        return true;
      }
      if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
        writeJson(res, 200, authorizationServerMetadata(requestContext(req, { trustProxy })));
        return true;
      }
      if (req.method === "POST" && path === "/oauth/register") {
        await handleRegister(req, res, options.maxRequestBodyBytes, clientStore);
        return true;
      }
      if (req.method === "GET" && path === "/oauth/authorize") {
        await handleAuthorizePage(req, res, clientStore, trustProxy);
        return true;
      }
      if (req.method === "POST" && path === "/oauth/authorize/confirm") {
        await handleAuthorizeConfirm(req, res, options.maxRequestBodyBytes, clientStore, authorizationCodes, authorizationCodeTtlMs, trustProxy);
        return true;
      }
      if (req.method === "POST" && path === "/oauth/token") {
        await handleToken(req, res, options.maxRequestBodyBytes, authorizationCodes, tokenStore, accessTokenTtlMs);
        return true;
      }
      return false;
    },

    async isAuthorized(req: IncomingMessage): Promise<boolean> {
      const token = bearerToken(req);
      if (!token) {
        return false;
      }
      const hash = tokenHash(token);
      const stored = await tokenStore.get(hash);
      if (!stored) {
        return false;
      }
      if (stored.expiresAt <= Date.now()) {
        await tokenStore.delete(hash);
        return false;
      }
      return isAllowedOAuthResource(stored.resource, requestContext(req, { trustProxy }).resource) && scopeIncludesDefault(stored.scope);
    },

    writeUnauthorized(req: IncomingMessage, res: ServerResponse): void {
      const context = requestContext(req, { trustProxy });
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": `Bearer realm="planweave-mcp", scope="${defaultOAuthScope}", resource_metadata="${context.authorizationServer}/.well-known/oauth-protected-resource"`
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
    }
  };
}

async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  maxRequestBodyBytes: number,
  clientStore: OAuthClientStore
): Promise<void> {
  const body = await readJsonBody(req, maxRequestBodyBytes);
  if (!body.ok) {
    writeJson(res, body.statusCode, { error: body.error });
    return;
  }
  const redirectUris = stringArray(body.value.redirect_uris);
  if (redirectUris.length === 0 || redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
    writeJson(res, 400, { error: "invalid_redirect_uris" });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const client: RegisteredClient = {
    clientId: `planweave_${randomToken(24)}`,
    clientIdIssuedAt: now,
    clientName: optionalString(body.value.client_name),
    redirectUris
  };
  await clientStore.set(client);

  writeJson(res, 201, {
    client_id: client.clientId,
    client_id_issued_at: client.clientIdIssuedAt,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  });
}

async function handleAuthorizePage(req: IncomingMessage, res: ServerResponse, clientStore: OAuthClientStore, trustProxy: boolean): Promise<void> {
  const params = await validateAuthorizeParams(req, clientStore, { trustProxy });
  if (!params.ok) {
    writeHtml(res, 400, errorPage(params.error));
    return;
  }

  writeHtml(res, 200, consentPage(params.value));
}

async function handleAuthorizeConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  maxRequestBodyBytes: number,
  clientStore: OAuthClientStore,
  authorizationCodes: Map<string, AuthorizationCode>,
  authorizationCodeTtlMs: number,
  trustProxy: boolean
): Promise<void> {
  const body = await readFormBody(req, maxRequestBodyBytes);
  if (!body.ok) {
    writeJson(res, body.statusCode, { error: body.error });
    return;
  }
  const params = await validateAuthorizeSearchParams(new URLSearchParams(body.value), clientStore, requestContext(req, { trustProxy }).resource, { persistRecoveredClient: true });
  if (!params.ok) {
    writeJson(res, 400, { error: params.error });
    return;
  }

  const code = randomToken(32);
  authorizationCodes.set(code, {
    clientId: params.value.clientId,
    codeChallenge: params.value.codeChallenge,
    expiresAt: Date.now() + authorizationCodeTtlMs,
    redirectUri: params.value.redirectUri,
    resource: params.value.resource,
    scope: params.value.scope
  });

  const redirectUrl = new URL(params.value.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (params.value.state) {
    redirectUrl.searchParams.set("state", params.value.state);
  }
  res.writeHead(302, { location: redirectUrl.toString() });
  res.end();
}

async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
  maxRequestBodyBytes: number,
  authorizationCodes: Map<string, AuthorizationCode>,
  tokenStore: OAuthTokenStore,
  accessTokenTtlMs: number
): Promise<void> {
  const body = await readFormBody(req, maxRequestBodyBytes);
  if (!body.ok) {
    writeJson(res, body.statusCode, { error: body.error });
    return;
  }
  const params = new URLSearchParams(body.value);
  if (params.get("grant_type") !== "authorization_code") {
    writeJson(res, 400, { error: "unsupported_grant_type" });
    return;
  }
  const code = params.get("code") ?? "";
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const resource = params.get("resource") ?? "";
  const codeVerifier = params.get("code_verifier") ?? "";
  const stored = authorizationCodes.get(code);
  if (!stored || stored.expiresAt <= Date.now()) {
    authorizationCodes.delete(code);
    writeJson(res, 400, { error: "invalid_grant" });
    return;
  }
  if (stored.clientId !== clientId || stored.redirectUri !== redirectUri || stored.resource !== resource || !verifyPkce(codeVerifier, stored.codeChallenge)) {
    writeJson(res, 400, { error: "invalid_grant" });
    return;
  }
  authorizationCodes.delete(code);

  const token = randomToken(32);
  await tokenStore.set({
    tokenHash: tokenHash(token),
    clientId,
    expiresAt: Date.now() + accessTokenTtlMs,
    resource: stored.resource,
    scope: stored.scope
  });

  writeJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: Math.floor(accessTokenTtlMs / 1000),
    scope: stored.scope
  });
}

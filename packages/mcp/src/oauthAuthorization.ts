import type { IncomingMessage } from "node:http";
import type { OAuthClientStore, RegisteredClient } from "./oauthClientStore.js";
import { requestUrl, type OAuthRequestContext } from "./oauthHttp.js";
import { isAllowedOAuthResource, isAllowedRedirectUri, normalizeScope } from "./oauthValidation.js";

export type AuthorizeParams = {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  scope: string;
  state: string | null;
};

export async function validateAuthorizeParams(
  req: IncomingMessage,
  context: OAuthRequestContext,
  clientStore: OAuthClientStore,
  redirectUriPrefixes?: string[]
): Promise<{ ok: true; value: AuthorizeParams } | { ok: false; error: string }> {
  const url = requestUrl(req, context);
  return validateAuthorizeSearchParams(url.searchParams, clientStore, context.resource, {
    persistRecoveredClient: false,
    redirectUriPrefixes
  });
}

export async function validateAuthorizeSearchParams(
  params: URLSearchParams,
  clientStore: OAuthClientStore,
  expectedResource: string,
  options: { persistRecoveredClient: boolean; redirectUriPrefixes?: string[] }
): Promise<{ ok: true; value: AuthorizeParams } | { ok: false; error: string }> {
  if (params.get("response_type") !== "code") {
    return { ok: false, error: "unsupported_response_type" };
  }
  if (params.get("code_challenge_method") !== "S256") {
    return { ok: false, error: "invalid_code_challenge_method" };
  }
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const resource = params.get("resource") ?? "";
  if (!codeChallenge) {
    return { ok: false, error: "invalid_code_challenge" };
  }
  if (!isAllowedOAuthResource(resource, expectedResource)) {
    return { ok: false, error: "invalid_resource" };
  }
  const scope = normalizeScope(params.get("scope"));
  if (!scope) {
    return { ok: false, error: "invalid_scope" };
  }
  const client = await resolveRegisteredClient(clientStore, {
    clientId,
    persist: options.persistRecoveredClient,
    redirectUri,
    resource,
    expectedResource,
    redirectUriPrefixes: options.redirectUriPrefixes
  });
  if (!client) {
    return { ok: false, error: "invalid_client" };
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return { ok: false, error: "invalid_redirect_uri" };
  }
  return {
    ok: true,
    value: {
      clientId,
      codeChallenge,
      redirectUri,
      resource,
      scope,
      state: params.get("state")
    }
  };
}

async function resolveRegisteredClient(
  clientStore: OAuthClientStore,
  input: {
    clientId: string;
    persist: boolean;
    redirectUri: string;
    resource: string;
    expectedResource: string;
    redirectUriPrefixes?: string[];
  }
): Promise<RegisteredClient | undefined> {
  const existing = await clientStore.get(input.clientId);
  if (existing) {
    return existing;
  }
  if (
    !isRecoverablePlanweaveClientId(input.clientId) ||
    !isAllowedRedirectUri(input.redirectUri, input.redirectUriPrefixes) ||
    !isAllowedOAuthResource(input.resource, input.expectedResource)
  ) {
    return undefined;
  }
  const client: RegisteredClient = {
    clientId: input.clientId,
    clientIdIssuedAt: Math.floor(Date.now() / 1000),
    redirectUris: [input.redirectUri]
  };
  if (input.persist) {
    await clientStore.set(client);
  }
  return client;
}

function isRecoverablePlanweaveClientId(value: string): boolean {
  return /^planweave_[A-Za-z0-9_-]{16,128}$/.test(value);
}

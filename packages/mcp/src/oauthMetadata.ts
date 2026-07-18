import type { OAuthRequestContext } from "./oauthHttp.js";

export const defaultOAuthScope = "planweave:mcp";
export const offlineAccessScope = "offline_access";

export function protectedResourceMetadata(context: OAuthRequestContext): Record<string, unknown> {
  return {
    resource: context.resource,
    resource_name: "PlanWeave MCP",
    resource_type: "mcp-server",
    authorization_servers: [context.authorizationServer],
    bearer_methods_supported: ["header"],
    scopes_supported: [defaultOAuthScope]
  };
}

export function authorizationServerMetadata(context: OAuthRequestContext): Record<string, unknown> {
  return {
    issuer: context.authorizationServer,
    authorization_endpoint: `${context.authorizationServer}/oauth/authorize`,
    token_endpoint: `${context.authorizationServer}/oauth/token`,
    registration_endpoint: `${context.authorizationServer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [defaultOAuthScope, offlineAccessScope]
  };
}

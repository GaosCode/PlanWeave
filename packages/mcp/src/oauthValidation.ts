import { defaultOAuthScope, offlineAccessScope } from "./oauthMetadata.js";

const scopeSeparator = /\s+/;

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isAllowedRedirectUri(value: string, redirectUriPrefixes?: string[]): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      if (!redirectUriPrefixes || redirectUriPrefixes.length === 0) {
        return true;
      }
      return redirectUriPrefixes.some((prefix) => value.startsWith(prefix));
    }
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

export function normalizeScope(value: string | null): string | null {
  const scopes = value?.trim() ? value.trim().split(scopeSeparator) : [defaultOAuthScope];
  const uniqueScopes = new Set(scopes);
  if (
    !uniqueScopes.has(defaultOAuthScope) ||
    [...uniqueScopes].some((scope) => scope !== defaultOAuthScope && scope !== offlineAccessScope)
  ) {
    return null;
  }
  if (uniqueScopes.has(offlineAccessScope)) {
    return `${defaultOAuthScope} ${offlineAccessScope}`;
  }
  return defaultOAuthScope;
}

export function scopeIncludesDefault(value: string): boolean {
  return value.split(scopeSeparator).includes(defaultOAuthScope);
}

export function scopeIncludesOfflineAccess(value: string): boolean {
  return value.split(scopeSeparator).includes(offlineAccessScope);
}

export function isScopeSubset(value: string, grantedScope: string): boolean {
  const granted = new Set(grantedScope.split(scopeSeparator));
  return value.split(scopeSeparator).every((scope) => granted.has(scope));
}

export function isAllowedOAuthResource(value: string, localResource: string): boolean {
  if (value === localResource) {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^tunnel-service\.gateway\.unified-\d+\.internal\.api\.openai\.org$/.test(url.hostname) &&
      /^\/v1\/mcp\/tunnel_[A-Za-z0-9]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

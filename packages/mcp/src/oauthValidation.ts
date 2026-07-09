import { defaultOAuthScope } from "./oauthMetadata.js";

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
  const scopes = value?.trim() ? value.trim().split(/\s+/) : [defaultOAuthScope];
  if (scopes.length === 0 || scopes.some((scope) => scope !== defaultOAuthScope)) {
    return null;
  }
  return defaultOAuthScope;
}

export function scopeIncludesDefault(value: string): boolean {
  return value.split(/\s+/).includes(defaultOAuthScope);
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

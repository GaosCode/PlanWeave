import type { IncomingMessage } from "node:http";
import { isLoopbackHost, type McpConfig } from "./config.js";

type RequestOriginConfig = Pick<McpConfig, "host" | "port" | "trustForwardedHeaders">;

export type EffectiveRequestOriginResult =
  | { ok: true; origin: string }
  | { ok: false; error: "invalid_host" | "invalid_origin" };

function formatHostPort(hostname: string, port: number): string {
  if (hostname.includes(":") && !hostname.startsWith("[")) {
    return `[${hostname}]:${port}`;
  }
  return `${hostname}:${port}`;
}

function resolveRequestPort(req: IncomingMessage, config: Pick<McpConfig, "port">): number {
  const localPort = req.socket.localPort;
  if (typeof localPort === "number" && localPort > 0) {
    return localPort;
  }
  return config.port;
}

/** Host forms accepted for the configured bind address (DNS-rebinding defense). */
export function expectedRequestHosts(
  config: Pick<McpConfig, "host" | "port">,
  port: number
): Set<string> {
  const hosts = new Set<string>([formatHostPort(config.host, port)]);
  if (isLoopbackHost(config.host)) {
    hosts.add(formatHostPort("127.0.0.1", port));
    hosts.add(formatHostPort("localhost", port));
    hosts.add(formatHostPort("::1", port));
  }
  return hosts;
}

function requestProtocol(req: IncomingMessage): "http:" | "https:" {
  if ("encrypted" in req.socket && req.socket.encrypted === true) {
    return "https:";
  }
  return "http:";
}

function authorityOrigin(authority: string, protocol: "http:" | "https:"): string | null {
  if (!authority || authority.includes(",")) {
    return null;
  }
  try {
    const url = new URL(`${protocol}//${authority}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function singleHeader(value: string | string[] | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) || value.includes(",")) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }
  const normalized = remoteAddress.toLowerCase();
  return (
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function directRequestOrigin(
  req: IncomingMessage,
  config: Pick<McpConfig, "host" | "port">
): string | null {
  const protocol = requestProtocol(req);
  const host = singleHeader(req.headers.host);
  if (!host) {
    return null;
  }
  const origin = authorityOrigin(host, protocol);
  if (!origin) {
    return null;
  }
  const port = resolveRequestPort(req, config);
  const allowedOrigins = new Set(
    [...expectedRequestHosts(config, port)]
      .map((allowedHost) => authorityOrigin(allowedHost, protocol))
      .filter((allowedOrigin): allowedOrigin is string => allowedOrigin !== null)
  );
  return allowedOrigins.has(origin) ? origin : null;
}

function forwardedRequestOrigin(
  req: IncomingMessage,
  config: RequestOriginConfig
): { present: false } | { present: true; origin: string | null } {
  const forwardedHost = singleHeader(req.headers["x-forwarded-host"]);
  const forwardedProto = singleHeader(req.headers["x-forwarded-proto"]);
  if (forwardedHost === undefined && forwardedProto === undefined) {
    return { present: false };
  }
  if (
    !config.trustForwardedHeaders ||
    !isLoopbackHost(config.host) ||
    !isLoopbackPeer(req.socket.remoteAddress)
  ) {
    return { present: true, origin: null };
  }
  if (forwardedHost === undefined && (forwardedProto === "http" || forwardedProto === "https")) {
    // A trusted tunnel may forward only the original scheme; it cannot replace the authority.
    return { present: false };
  }
  if (
    !forwardedHost ||
    !forwardedProto ||
    (forwardedProto !== "http" && forwardedProto !== "https")
  ) {
    return { present: true, origin: null };
  }
  return {
    present: true,
    origin: authorityOrigin(forwardedHost, `${forwardedProto}:`)
  };
}

function originHeaderMatches(req: IncomingMessage, effectiveOrigin: string): boolean {
  const origin = singleHeader(req.headers.origin);
  if (origin === undefined) {
    return true;
  }
  if (!origin) {
    return false;
  }
  try {
    const url = new URL(origin);
    return (
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.origin === effectiveOrigin
    );
  } catch {
    return false;
  }
}

/**
 * Resolves the request origin after validating the direct Host against the actual listening socket.
 * Forwarded headers are accepted only from an explicitly trusted loopback proxy boundary.
 */
export function resolveEffectiveRequestOrigin(
  req: IncomingMessage,
  config: RequestOriginConfig
): EffectiveRequestOriginResult {
  const directOrigin = directRequestOrigin(req, config);
  if (!directOrigin) {
    return { ok: false, error: "invalid_host" };
  }

  const forwarded = forwardedRequestOrigin(req, config);
  const effectiveOrigin = forwarded.present ? forwarded.origin : directOrigin;
  if (!effectiveOrigin) {
    return { ok: false, error: "invalid_host" };
  }
  if (!originHeaderMatches(req, effectiveOrigin)) {
    return { ok: false, error: "invalid_origin" };
  }
  return { ok: true, origin: effectiveOrigin };
}

/**
 * Validates Host (always) and Origin (when present). Absent Origin remains valid for non-browser
 * MCP clients.
 */
export function isRequestOriginAllowed(
  req: IncomingMessage,
  config: RequestOriginConfig
): { ok: true } | { ok: false; error: "invalid_host" | "invalid_origin" } {
  const result = resolveEffectiveRequestOrigin(req, config);
  return result.ok ? { ok: true } : result;
}

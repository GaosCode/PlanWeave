import type { IncomingMessage } from "node:http";
import { isLoopbackHost, type McpConfig } from "./config.js";

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
export function expectedRequestHosts(config: Pick<McpConfig, "host" | "port">, port: number): Set<string> {
  const hosts = new Set<string>([formatHostPort(config.host, port)]);
  if (isLoopbackHost(config.host)) {
    hosts.add(formatHostPort("127.0.0.1", port));
    hosts.add(formatHostPort("localhost", port));
    hosts.add(formatHostPort("::1", port));
  }
  return hosts;
}

function requestHostHeader(req: IncomingMessage): string | undefined {
  const host = req.headers.host;
  return Array.isArray(host) ? host[0] : host;
}

function requestOriginHeader(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

/**
 * Validates Host (always) and Origin (when present) against the expected loopback/bind set.
 * Absent Origin is allowed so non-browser MCP clients keep working.
 */
export function isRequestOriginAllowed(
  req: IncomingMessage,
  config: Pick<McpConfig, "host" | "port">
): { ok: true } | { ok: false; error: "invalid_host" | "invalid_origin" } {
  const port = resolveRequestPort(req, config);
  const allowedHosts = expectedRequestHosts(config, port);
  const host = requestHostHeader(req);
  if (!host || !allowedHosts.has(host)) {
    return { ok: false, error: "invalid_host" };
  }

  const origin = requestOriginHeader(req);
  if (!origin) {
    return { ok: true };
  }
  try {
    const originUrl = new URL(origin);
    const originPort = originUrl.port ? Number(originUrl.port) : originUrl.protocol === "https:" ? 443 : 80;
    const originHost = formatHostPort(originUrl.hostname, originPort);
    if (!allowedHosts.has(originHost)) {
      return { ok: false, error: "invalid_origin" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "invalid_origin" };
  }
}

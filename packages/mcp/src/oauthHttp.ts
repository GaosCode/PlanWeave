import type { IncomingMessage, ServerResponse } from "node:http";

const formContentType = "application/x-www-form-urlencoded";
const jsonContentType = "application/json";

export type OAuthRequestContext = {
  authorizationServer: string;
  resource: string;
};

export type OAuthRequestContextOptions = {
  trustProxy?: boolean;
};

export function requestContext(req: IncomingMessage, options?: OAuthRequestContextOptions): OAuthRequestContext {
  const trustProxy = options?.trustProxy === true;
  const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
  const proto = (trustProxy ? firstHeader(req.headers["x-forwarded-proto"]) : undefined) ?? (encrypted ? "https" : "http");
  const host = (trustProxy ? firstHeader(req.headers["x-forwarded-host"]) : undefined) ?? firstHeader(req.headers.host) ?? "127.0.0.1";
  const authorizationServer = `${proto}://${host}`;
  return {
    authorizationServer,
    resource: `${authorizationServer}/mcp`
  };
}

export function requestUrl(req: IncomingMessage, options?: OAuthRequestContextOptions): URL {
  const context = requestContext(req, options);
  return new URL(req.url ?? "/", context.authorizationServer);
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; statusCode: number; error: string }> {
  if (!contentType(req).startsWith(jsonContentType)) {
    return { ok: false, statusCode: 415, error: "unsupported_media_type" };
  }
  const raw = await readBody(req, maxBytes);
  if (!raw.ok) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, statusCode: 400, error: "invalid_json" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, statusCode: 400, error: "invalid_json" };
  }
}

export async function readFormBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ ok: true; value: string } | { ok: false; statusCode: number; error: string }> {
  if (!contentType(req).startsWith(formContentType)) {
    return { ok: false, statusCode: 415, error: "unsupported_media_type" };
  }
  return readBody(req, maxBytes);
}

export function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function writeHtml(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; value: string } | { ok: false; statusCode: number; error: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      return { ok: false, statusCode: 413, error: "request_body_too_large" };
    }
    chunks.push(buffer);
  }
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function contentType(req: IncomingMessage): string {
  return (firstHeader(req.headers["content-type"]) ?? "").toLowerCase();
}
